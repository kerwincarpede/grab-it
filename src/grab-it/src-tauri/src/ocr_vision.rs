//! Text recognition with the system's own on-device engine on macOS
//! (Vision's `VNRecognizeTextRequest`), which reads ordinary UI text far
//! better than ocrs. [`read`] gives `None` where Vision is unavailable
//! (other platforms, and macOS before 10.15), and [`crate::ocr::Ocr`] then
//! reads the image with ocrs instead.
//!
//! Vision reports boxes normalised to the image, with the origin at the
//! bottom left; [`pixel_rect`] turns them into the top-left image pixels
//! every other OCR box uses. Short lines Vision is unsure of are mostly
//! icons read as letters, so [`keep_line`] leaves them out.

use image::RgbImage;

#[cfg(any(target_os = "macos", test))]
use crate::capture::Rect;
use crate::ocr::OcrLine;

/// Lines of at most this many characters are left out when Vision's
/// confidence in them is below [`MIN_SHORT_CONFIDENCE`]: they are mostly
/// icons (a search box's magnifier and clear button read as `xQ`).
#[cfg(any(target_os = "macos", test))]
const SHORT_LINE_CHARS: usize = 2;
/// The confidence a short line needs to be kept.
#[cfg(any(target_os = "macos", test))]
const MIN_SHORT_CONFIDENCE: f32 = 0.5;

/// The lines of text in `image` as Vision reads them, top-left boxes in the
/// image's pixels. `None` when Vision cannot be used here, so the caller
/// reads the image with ocrs; an error when Vision failed on it.
#[cfg(target_os = "macos")]
pub fn read(image: &RgbImage) -> Option<Result<Vec<OcrLine>, String>> {
    mac::read(image)
}

/// Vision exists only on macOS: other platforms always read with ocrs.
#[cfg(not(target_os = "macos"))]
pub fn read(_image: &RgbImage) -> Option<Result<Vec<OcrLine>, String>> {
    None
}

/// Whether a line Vision read is worth keeping: single characters never
/// are (as with ocrs), and lines of [`SHORT_LINE_CHARS`] or fewer only when
/// Vision is fairly sure of them.
#[cfg(any(target_os = "macos", test))]
fn keep_line(text: &str, confidence: f32) -> bool {
    let chars = text.chars().count();
    chars > 1 && (chars > SHORT_LINE_CHARS || confidence >= MIN_SHORT_CONFIDENCE)
}

/// A Vision box (normalised, origin at the bottom left) as a box in the
/// pixels of an image of `size` (origin at the top left), grown outwards to
/// whole pixels and clipped to the image.
#[cfg(any(target_os = "macos", test))]
fn pixel_rect(x: f64, y: f64, width: f64, height: f64, (w, h): (u32, u32)) -> Rect {
    let (w, h) = (f64::from(w), f64::from(h));
    let left = (x * w).floor().clamp(0.0, w);
    let right = ((x + width) * w).ceil().clamp(0.0, w);
    let top = ((1.0 - (y + height)) * h).floor().clamp(0.0, h);
    let bottom = ((1.0 - y) * h).ceil().clamp(0.0, h);
    // NaN from a malformed box casts to 0: an empty box at the corner.
    Rect {
        x: left as i32,
        y: top as i32,
        width: (right - left).max(0.0) as u32,
        height: (bottom - top).max(0.0) as u32,
    }
}

/// The words of `text`, split at whitespace, each with its start and length
/// in UTF-16 code units: the `NSRange` Vision takes for a word's box.
#[cfg(any(target_os = "macos", test))]
fn word_ranges(text: &str) -> Vec<(&str, usize, usize)> {
    let mut words = Vec::new();
    let mut utf16 = 0;
    // The byte and UTF-16 offsets of the word being read.
    let mut start: Option<(usize, usize)> = None;
    for (byte, ch) in text.char_indices() {
        if ch.is_whitespace() {
            if let Some((from, from16)) = start.take() {
                words.push((&text[from..byte], from16, utf16 - from16));
            }
        } else if start.is_none() {
            start = Some((byte, utf16));
        }
        utf16 += ch.len_utf16();
    }
    if let Some((from, from16)) = start {
        words.push((&text[from..], from16, utf16 - from16));
    }
    words
}

/// The languages to read, from the system's preferred `preferred` (BCP 47,
/// such as `en-GB`), each matched to one Vision `supported`: the same tag,
/// else the longest supported tag it starts with (`zh-Hans` for
/// `zh-Hans-CN`), else the first with the same language (`en-US` for
/// `en-GB`). In order of preference, without repeats.
#[cfg(any(target_os = "macos", test))]
fn pick_languages(preferred: &[String], supported: &[String]) -> Vec<String> {
    let language = |tag: &str| tag.split(['-', '_']).next().unwrap_or("").to_lowercase();
    let mut picked: Vec<String> = Vec::new();
    for tag in preferred {
        let tag_lower = tag.replace('_', "-").to_lowercase();
        let exact = supported
            .iter()
            .find(|s| s.replace('_', "-").to_lowercase() == tag_lower);
        let prefix = || {
            supported
                .iter()
                .filter(|s| {
                    let s = s.replace('_', "-").to_lowercase();
                    tag_lower.starts_with(&format!("{s}-"))
                })
                .max_by_key(|s| s.len())
        };
        let same_language = || {
            supported
                .iter()
                .find(|s| language(s.as_str()) == language(tag.as_str()))
        };
        if let Some(found) = exact.or_else(prefix).or_else(same_language)
            && !picked.contains(found)
        {
            picked.push(found.clone());
        }
    }
    picked
}

#[cfg(target_os = "macos")]
mod mac {
    use image::RgbImage;
    use objc2::{
        AnyThread, msg_send,
        rc::{Retained, autoreleasepool},
        runtime::{AnyClass, NSObjectProtocol},
        sel,
    };
    use objc2_core_foundation::{CFData, CGRect};
    use objc2_core_graphics::{
        CGBitmapInfo, CGColorRenderingIntent, CGColorSpace, CGDataProvider, CGImage,
        CGImageAlphaInfo,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSError, NSLocale, NSRange, NSString};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedText, VNRectangleObservation,
        VNRequest, VNRequestTextRecognitionLevel,
    };

    use super::{keep_line, pick_languages, pixel_rect, word_ranges};
    use crate::ocr::{OcrLine, OcrWord};

    pub fn read(image: &RgbImage) -> Option<Result<Vec<OcrLine>, String>> {
        // Vision has text recognition from macOS 10.15; Grab-it sets no
        // minimum, so look the class up before touching it.
        AnyClass::get(c"VNRecognizeTextRequest")?;
        Some(autoreleasepool(|_| recognize(image)))
    }

    fn error_text(err: &NSError) -> String {
        err.localizedDescription().to_string()
    }

    /// `image` as a Core Graphics image over a copy of its pixels.
    fn cg_image(image: &RgbImage) -> Result<objc2_core_foundation::CFRetained<CGImage>, String> {
        let (width, height) = image.dimensions();
        let (width, height) = (width as usize, height as usize);
        let data = CFData::from_bytes(image.as_raw());
        let provider = CGDataProvider::with_cf_data(Some(&data))
            .ok_or("could not hand the image to Vision")?;
        let space = CGColorSpace::new_device_rgb().ok_or("no RGB colour space")?;
        // SAFETY: the provider holds width × height packed 8-bit RGB pixels,
        // three bytes each, and `decode` may be null.
        unsafe {
            CGImage::new(
                width,
                height,
                8,
                24,
                width * 3,
                Some(&space),
                CGBitmapInfo(CGImageAlphaInfo::None.0),
                Some(&provider),
                std::ptr::null(),
                false,
                CGColorRenderingIntent::RenderingIntentDefault,
            )
        }
        .ok_or_else(|| "could not make an image for Vision".to_owned())
    }

    /// The system's preferred languages that Vision can read, or none to
    /// keep Vision's default (before macOS 12, which cannot list them).
    fn languages(request: &VNRecognizeTextRequest) -> Option<Retained<NSArray<NSString>>> {
        if !request.respondsToSelector(sel!(supportedRecognitionLanguagesAndReturnError:)) {
            return None;
        }
        // SAFETY: the selector exists, checked above.
        let supported = unsafe { request.supportedRecognitionLanguagesAndReturnError() }.ok()?;
        let supported: Vec<String> = supported.iter().map(|tag| tag.to_string()).collect();
        let preferred: Vec<String> = NSLocale::preferredLanguages()
            .iter()
            .map(|tag| tag.to_string())
            .collect();
        let picked = pick_languages(&preferred, &supported);
        if picked.is_empty() {
            return None;
        }
        let picked: Vec<Retained<NSString>> =
            picked.iter().map(|tag| NSString::from_str(tag)).collect();
        Some(NSArray::from_retained_slice(&picked))
    }

    fn recognize(image: &RgbImage) -> Result<Vec<OcrLine>, String> {
        let size = image.dimensions();
        let cg_image = cg_image(image)?;

        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        if let Some(languages) = languages(&request) {
            request.setRecognitionLanguages(&languages);
        }

        // SAFETY: a fresh handler over a valid image, with no options.
        let handler = unsafe {
            VNImageRequestHandler::initWithCGImage_options(
                VNImageRequestHandler::alloc(),
                &cg_image,
                &NSDictionary::new(),
            )
        };
        let requests: &VNRequest = &request;
        handler
            .performRequests_error(&NSArray::from_slice(&[requests]))
            .map_err(|err| error_text(&err))?;

        let Some(observations) = request.results() else {
            return Ok(Vec::new());
        };
        let mut lines = Vec::new();
        for observation in observations.iter() {
            let Some(candidate) = observation.topCandidates(1).firstObject() else {
                continue;
            };
            let full = candidate.string().to_string();
            let text = full.trim();
            if !keep_line(text, candidate.confidence()) {
                continue;
            }
            // SAFETY: a plain property read on a finished observation.
            let rect = to_pixels(unsafe { observation.boundingBox() }, size);
            let words = word_ranges(&full)
                .into_iter()
                .map(|(word, start, length)| OcrWord {
                    text: word.to_owned(),
                    rect: word_box(&candidate, start, length)
                        .map_or(rect, |found| to_pixels(found, size)),
                })
                .collect();
            lines.push(OcrLine {
                text: text.to_owned(),
                rect,
                words,
            });
        }
        Ok(lines)
    }

    fn to_pixels(rect: CGRect, size: (u32, u32)) -> crate::capture::Rect {
        pixel_rect(
            rect.origin.x,
            rect.origin.y,
            rect.size.width,
            rect.size.height,
            size,
        )
    }

    /// The normalised box of the characters `start..start + length` (UTF-16)
    /// of `text`, or `None` when Vision cannot give one.
    fn word_box(text: &VNRecognizedText, start: usize, length: usize) -> Option<CGRect> {
        let range = NSRange::new(start, length);
        // objc2-vision does not bind `boundingBoxForRange:error:`.
        // SAFETY: the method exists wherever VNRecognizedText does, takes
        // an NSRange and returns a VNRectangleObservation or nil with an
        // error.
        let found: Result<Retained<VNRectangleObservation>, Retained<NSError>> =
            unsafe { msg_send![text, boundingBoxForRange: range, error: _] };
        // SAFETY: a plain property read.
        found
            .ok()
            .map(|observation| unsafe { observation.boundingBox() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_box_at_the_bottom_left_lands_at_the_bottom_left_in_pixels() {
        // The bottom-left quarter of a 200 × 100 image.
        assert_eq!(
            pixel_rect(0.0, 0.0, 0.5, 0.5, (200, 100)),
            Rect {
                x: 0,
                y: 50,
                width: 100,
                height: 50,
            }
        );
    }

    #[test]
    fn a_box_near_the_top_is_measured_from_the_top() {
        // An eighth from the left, a quarter from the top, a quarter wide
        // and a quarter tall.
        assert_eq!(
            pixel_rect(0.125, 0.5, 0.25, 0.25, (800, 400)),
            Rect {
                x: 100,
                y: 100,
                width: 200,
                height: 100,
            }
        );
    }

    #[test]
    fn a_box_grows_to_whole_pixels() {
        let rect = pixel_rect(0.101, 0.5, 0.2, 0.101, (10, 10));
        assert_eq!(
            rect,
            Rect {
                x: 1,
                y: 3,
                width: 3,
                height: 2,
            }
        );
    }

    #[test]
    fn a_box_past_the_edges_is_clipped_to_the_image() {
        assert_eq!(
            pixel_rect(-0.2, -0.2, 1.5, 1.5, (100, 50)),
            Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 50,
            }
        );
        // Wholly outside: empty, at the nearest edge.
        let outside = pixel_rect(1.5, 0.2, 0.2, 0.2, (100, 50));
        assert_eq!((outside.x, outside.width), (100, 0));
    }

    #[test]
    fn a_malformed_box_is_empty() {
        let rect = pixel_rect(f64::NAN, 0.0, 0.5, 0.5, (100, 100));
        assert_eq!(rect.width, 0);
    }

    #[test]
    fn short_lines_need_confidence() {
        assert!(!keep_line("xQ", 0.3));
        assert!(!keep_line("xQ", 0.49));
        assert!(keep_line("OK", 0.5));
        assert!(keep_line("OK", 0.9));
    }

    #[test]
    fn single_characters_are_always_dropped() {
        assert!(!keep_line("x", 1.0));
        assert!(!keep_line("", 1.0));
    }

    #[test]
    fn longer_lines_are_kept_however_unsure() {
        assert!(keep_line("New", 0.1));
        assert!(keep_line("Newest", 0.0));
    }

    #[test]
    fn characters_not_bytes_count_towards_a_short_line() {
        // Two characters, four bytes: still a short line.
        assert!(!keep_line("éé", 0.2));
        assert!(keep_line("éé", 0.8));
    }

    #[test]
    fn words_carry_their_utf16_ranges() {
        assert_eq!(
            word_ranges("is:issue  state:open"),
            vec![("is:issue", 0, 8), ("state:open", 10, 10)]
        );
        assert_eq!(word_ranges("  Newest "), vec![("Newest", 2, 6)]);
        assert_eq!(word_ranges(""), vec![]);
    }

    #[test]
    fn word_ranges_count_utf16_units() {
        // "é" is one UTF-16 unit, the emoji two.
        assert_eq!(
            word_ranges("café 😀 ok"),
            vec![("café", 0, 4), ("😀", 5, 2), ("ok", 8, 2)]
        );
    }

    fn tags(tags: &[&str]) -> Vec<String> {
        tags.iter().map(|tag| (*tag).to_owned()).collect()
    }

    #[test]
    fn preferred_languages_are_matched_to_supported_ones() {
        let supported = tags(&["en-US", "fr-FR", "zh-Hans", "zh-Hant", "pt-BR"]);
        assert_eq!(
            pick_languages(&tags(&["fr-FR", "en-GB"]), &supported),
            tags(&["fr-FR", "en-US"])
        );
        assert_eq!(
            pick_languages(&tags(&["zh-Hant-TW", "zh-Hans-CN"]), &supported),
            tags(&["zh-Hant", "zh-Hans"])
        );
        assert_eq!(
            pick_languages(&tags(&["pt_PT", "en", "en-AU"]), &supported),
            tags(&["pt-BR", "en-US"])
        );
    }

    #[test]
    fn unsupported_languages_are_left_out() {
        let supported = tags(&["en-US"]);
        assert_eq!(pick_languages(&tags(&["tlh"]), &supported), tags(&[]));
        assert_eq!(
            pick_languages(&tags(&["tlh", "en-NZ"]), &supported),
            tags(&["en-US"])
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vision_reads_the_fixture_word() {
        use crate::ocr::{lines_text, tests::FIXTURE_WORD, tests::fixture_png};
        let image = image::open(fixture_png()).unwrap().into_rgb8();
        let Some(read) = read(&image) else {
            // macOS before 10.15 has no text recognition.
            return;
        };
        let lines = read.unwrap();
        let text = lines_text(&lines);
        assert!(
            text.to_lowercase().contains(FIXTURE_WORD),
            "Vision read {text:?}"
        );
        let (width, height) = image.dimensions();
        let word = lines
            .iter()
            .flat_map(|line| &line.words)
            .find(|word| word.text.to_lowercase() == FIXTURE_WORD)
            .unwrap_or_else(|| panic!("no word {FIXTURE_WORD:?} in {lines:?}"));
        // The word sits in the middle of the fixture, inside it.
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

    #[cfg(target_os = "macos")]
    #[test]
    fn vision_finds_no_text_in_a_blank_image() {
        let blank = RgbImage::from_pixel(200, 80, image::Rgb([255, 255, 255]));
        if let Some(read) = read(&blank) {
            assert_eq!(read.unwrap(), vec![]);
        }
    }
}
