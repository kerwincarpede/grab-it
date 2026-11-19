//! Text recognition with the system's own on-device engine on Windows
//! (`Windows.Media.Ocr`), which reads ordinary UI text far better than
//! ocrs. [`read`] gives `None` where it cannot be used (other platforms,
//! and Windows with no OCR language for the user's languages), and
//! [`crate::ocr::Ocr`] then reads the image with ocrs instead.
//!
//! The engine refuses images with a side over `OcrEngine::MaxImageDimension`,
//! so larger ones are read shrunk to fit and their boxes scaled back up to
//! the image's own pixels with [`image_rect`]. It reports no confidence, so
//! only single characters are left out, as with ocrs.

use image::RgbImage;

#[cfg(any(target_os = "windows", test))]
use crate::capture::Rect;
use crate::ocr::OcrLine;

/// The lines of text in `image` as Windows reads them, top-left boxes in
/// the image's pixels. `None` when Windows OCR cannot be used here, so the
/// caller reads the image with ocrs; an error when it failed on the image.
#[cfg(target_os = "windows")]
pub fn read(image: &RgbImage) -> Option<Result<Vec<OcrLine>, String>> {
    win::read(image)
}

/// Windows OCR exists only on Windows: other platforms read with Vision or
/// ocrs.
#[cfg(not(target_os = "windows"))]
pub fn read(_image: &RgbImage) -> Option<Result<Vec<OcrLine>, String>> {
    None
}

/// The size to read an image of `size` at so neither side is over `max`:
/// `size` itself when it already fits, else shrunk keeping its shape, at
/// least one pixel each way.
#[cfg(any(target_os = "windows", test))]
fn fitted_size((width, height): (u32, u32), max: u32) -> (u32, u32) {
    let longest = width.max(height);
    if max == 0 || longest <= max {
        return (width, height);
    }
    let factor = f64::from(max) / f64::from(longest);
    let side = |length: u32| ((f64::from(length) * factor).floor() as u32).clamp(1, max);
    (side(width), side(height))
}

/// A box in the pixels of the image as read, at `read_size`, as a box in
/// the pixels of the original image of `size`: scaled back up, grown
/// outwards to whole pixels and clipped to the image.
#[cfg(any(target_os = "windows", test))]
fn image_rect(
    (x, y, width, height): (f32, f32, f32, f32),
    read_size: (u32, u32),
    size: (u32, u32),
) -> Rect {
    let (w, h) = (f64::from(size.0), f64::from(size.1));
    let scale_x = w / f64::from(read_size.0.max(1));
    let scale_y = h / f64::from(read_size.1.max(1));
    let (x, y) = (f64::from(x), f64::from(y));
    let (width, height) = (f64::from(width), f64::from(height));
    let left = (x * scale_x).floor().clamp(0.0, w);
    let right = ((x + width) * scale_x).ceil().clamp(0.0, w);
    let top = (y * scale_y).floor().clamp(0.0, h);
    let bottom = ((y + height) * scale_y).ceil().clamp(0.0, h);
    // NaN from a malformed box casts to 0: an empty box at the corner.
    Rect {
        x: left as i32,
        y: top as i32,
        width: (right - left).max(0.0) as u32,
        height: (bottom - top).max(0.0) as u32,
    }
}

/// The box around every one of `boxes` (x, y, width, height), or `None`
/// when there are none.
#[cfg(any(target_os = "windows", test))]
fn union(boxes: &[(f32, f32, f32, f32)]) -> Option<(f32, f32, f32, f32)> {
    let (first, rest) = boxes.split_first()?;
    let (mut left, mut top) = (first.0, first.1);
    let (mut right, mut bottom) = (first.0 + first.2, first.1 + first.3);
    for &(x, y, width, height) in rest {
        left = left.min(x);
        top = top.min(y);
        right = right.max(x + width);
        bottom = bottom.max(y + height);
    }
    Some((left, top, right - left, bottom - top))
}

#[cfg(target_os = "windows")]
mod win {
    use image::{RgbImage, imageops};
    use windows::{
        Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
        Media::Ocr::OcrEngine,
        Storage::Streams::DataWriter,
    };

    use super::{fitted_size, image_rect, union};
    use crate::ocr::{OcrLine, OcrWord};

    pub fn read(image: &RgbImage) -> Option<Result<Vec<OcrLine>, String>> {
        // No engine when none of the user's languages has OCR installed
        // (the call gives null, which the bindings turn into an error).
        let engine = OcrEngine::TryCreateFromUserProfileLanguages().ok()?;
        Some(recognize(&engine, image).map_err(|err| err.message()))
    }

    /// `image` as a Bgra8 bitmap, the format Windows OCR reads.
    fn bitmap(image: &RgbImage) -> windows::core::Result<SoftwareBitmap> {
        let (width, height) = image.dimensions();
        let mut bgra = Vec::with_capacity(image.as_raw().len() / 3 * 4);
        for pixel in image.pixels() {
            let [r, g, b] = pixel.0;
            bgra.extend_from_slice(&[b, g, r, 255]);
        }
        let writer = DataWriter::new()?;
        writer.WriteBytes(&bgra)?;
        let buffer = writer.DetachBuffer()?;
        // The image fits MaxImageDimension by now; a side too long for an
        // i32 no longer matches the buffer, and Windows refuses it.
        let side = |length: u32| i32::try_from(length).unwrap_or(i32::MAX);
        SoftwareBitmap::CreateCopyFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            side(width),
            side(height),
        )
    }

    fn recognize(engine: &OcrEngine, image: &RgbImage) -> windows::core::Result<Vec<OcrLine>> {
        let size = image.dimensions();
        let read_size = fitted_size(size, OcrEngine::MaxImageDimension()?);
        let shrunk;
        let read_image = if read_size == size {
            image
        } else {
            shrunk = imageops::resize(
                image,
                read_size.0,
                read_size.1,
                imageops::FilterType::Triangle,
            );
            &shrunk
        };
        let result = engine.RecognizeAsync(&bitmap(read_image)?)?.get()?;

        let mut lines = Vec::new();
        for line in &result.Lines()? {
            let text = line.Text()?.to_string_lossy().trim().to_owned();
            // Single characters are mostly noise (icons, borders).
            if text.chars().count() <= 1 {
                continue;
            }
            let mut boxes = Vec::new();
            let mut words = Vec::new();
            for word in &line.Words()? {
                let rect = word.BoundingRect()?;
                let found = (rect.X, rect.Y, rect.Width, rect.Height);
                boxes.push(found);
                words.push(OcrWord {
                    text: word.Text()?.to_string_lossy(),
                    rect: image_rect(found, read_size, size),
                });
            }
            let Some(line_box) = union(&boxes) else {
                continue;
            };
            lines.push(OcrLine {
                text,
                rect: image_rect(line_box, read_size, size),
                words,
            });
        }
        Ok(lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_that_fits_is_read_as_it_is() {
        assert_eq!(fitted_size((640, 160), 2600), (640, 160));
        assert_eq!(fitted_size((2600, 2600), 2600), (2600, 2600));
    }

    #[test]
    fn a_large_image_shrinks_to_fit_keeping_its_shape() {
        // A 6400 × 3600 display read at most 2600 pixels a side.
        assert_eq!(fitted_size((6400, 3600), 2600), (2600, 1462));
        assert_eq!(fitted_size((1000, 5200), 2600), (500, 2600));
    }

    #[test]
    fn a_thin_image_keeps_at_least_a_pixel() {
        assert_eq!(fitted_size((10_000, 1), 2600), (2600, 1));
    }

    #[test]
    fn no_limit_reads_the_image_as_it_is() {
        assert_eq!(fitted_size((6400, 3600), 0), (6400, 3600));
    }

    #[test]
    fn a_box_in_an_image_read_as_it_is_is_unchanged() {
        assert_eq!(
            image_rect((10.0, 20.0, 30.0, 40.0), (640, 160), (640, 160)),
            Rect {
                x: 10,
                y: 20,
                width: 30,
                height: 40,
            }
        );
    }

    #[test]
    fn a_box_in_a_shrunk_image_is_scaled_back_up() {
        // Read at half size: every measure doubles.
        assert_eq!(
            image_rect((100.0, 50.0, 200.0, 25.0), (1600, 900), (3200, 1800)),
            Rect {
                x: 200,
                y: 100,
                width: 400,
                height: 50,
            }
        );
    }

    #[test]
    fn a_scaled_box_grows_to_whole_pixels() {
        // Read at 2600 of 6400: a factor of 6400 / 2600 across, and
        // 3600 / 1462 down.
        let rect = image_rect((1.0, 1.0, 1.0, 1.0), (2600, 1462), (6400, 3600));
        assert_eq!((rect.x, rect.y), (2, 2));
        assert_eq!((rect.width, rect.height), (3, 3));
    }

    #[test]
    fn a_scaled_box_past_the_edges_is_clipped_to_the_image() {
        assert_eq!(
            image_rect((-10.0, -10.0, 2000.0, 2000.0), (1600, 900), (3200, 1800)),
            Rect {
                x: 0,
                y: 0,
                width: 3200,
                height: 1800,
            }
        );
    }

    #[test]
    fn a_malformed_box_is_empty() {
        let rect = image_rect((f32::NAN, 0.0, 5.0, 5.0), (100, 100), (200, 200));
        assert_eq!(rect.width, 0);
    }

    #[test]
    fn a_line_box_covers_its_words() {
        assert_eq!(
            union(&[(10.0, 20.0, 30.0, 10.0), (50.0, 18.0, 20.0, 14.0)]),
            Some((10.0, 18.0, 60.0, 14.0))
        );
        assert_eq!(union(&[]), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_reads_the_fixture_word() {
        use crate::ocr::{lines_text, tests::FIXTURE_WORD, tests::fixture_png};
        let image = image::open(fixture_png()).unwrap().into_rgb8();
        let Some(read) = read(&image) else {
            // No OCR language installed for the user's languages.
            return;
        };
        let lines = read.unwrap();
        let text = lines_text(&lines);
        assert!(
            text.to_lowercase().contains(FIXTURE_WORD),
            "Windows OCR read {text:?}"
        );
        let (width, height) = image.dimensions();
        let word = lines
            .iter()
            .flat_map(|line| &line.words)
            .find(|word| word.text.to_lowercase() == FIXTURE_WORD)
            .unwrap_or_else(|| panic!("no word {FIXTURE_WORD:?} in {lines:?}"));
        let rect = word.rect;
        assert!(rect.width > 0 && rect.height > 0, "{rect:?}");
        assert!(rect.x.unsigned_abs() + rect.width <= width, "{rect:?}");
        assert!(rect.y.unsigned_abs() + rect.height <= height, "{rect:?}");
        let middle_y = rect.y.unsigned_abs() + rect.height / 2;
        assert!(
            middle_y > height / 4 && middle_y < height * 3 / 4,
            "{rect:?}"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_finds_no_text_in_a_blank_image() {
        let blank = RgbImage::from_pixel(200, 80, image::Rgb([255, 255, 255]));
        if let Some(read) = read(&blank) {
            assert_eq!(read.unwrap(), vec![]);
        }
    }
}
