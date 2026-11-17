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
//!
//! Vision scales a very large image down until ordinary UI text is too
//! small to read (a capture across two displays gave 2 lines where one
//! display gave 97), so images over [`MAX_TILE`] pixels either way are read
//! as overlapping tiles ([`tiles`]). Each line is kept only from the tile
//! whose core holds the centre of its box ([`tile_lines`]), so the overlaps
//! give no duplicates.

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

/// The largest tile Vision reads at once, in pixels either way: larger
/// images are read in tiles of at most this size.
#[cfg(any(target_os = "macos", test))]
const MAX_TILE: u32 = 4096;
/// How far neighbouring tiles overlap at least, in pixels, so a line cut at
/// one tile's edge is whole in its neighbour.
#[cfg(any(target_os = "macos", test))]
const TILE_OVERLAP: u32 = 128;

/// A part of an image Vision reads on its own, in the image's pixels.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Tile {
    /// The pixels read.
    rect: Rect,
    /// The part of `rect` this tile alone owns: `[left, right)` and
    /// `[top, bottom)`. The cores of all tiles cover the image once.
    core: (u32, u32, u32, u32),
}

/// One axis of the tile layout: `(start, length, core start, core end)` of
/// each span of an axis `length` pixels long. One span when it fits in
/// [`MAX_TILE`]; else the fewest spans of [`MAX_TILE`] that overlap by at
/// least [`TILE_OVERLAP`], evenly spread, the last ending at the edge, and
/// each core ending halfway through the overlap with the next.
#[cfg(any(target_os = "macos", test))]
fn spans(length: u32) -> Vec<(u32, u32, u32, u32)> {
    if length <= MAX_TILE {
        return vec![(0, length, 0, length)];
    }
    let extra = length - MAX_TILE;
    let count = 1 + extra.div_ceil(MAX_TILE - TILE_OVERLAP);
    let step = extra.div_ceil(count - 1);
    let starts: Vec<u32> = (0..count).map(|i| (i * step).min(extra)).collect();
    let boundary = |i: usize| -> u32 {
        if i == 0 {
            0
        } else if i == starts.len() {
            length
        } else {
            // Halfway between where this span starts and the last one ends.
            (starts[i] + starts[i - 1] + MAX_TILE) / 2
        }
    };
    starts
        .iter()
        .enumerate()
        .map(|(i, &start)| (start, MAX_TILE, boundary(i), boundary(i + 1)))
        .collect()
}

/// The tiles to read an image of `size` in, row by row: the whole image
/// when it fits in [`MAX_TILE`] both ways.
#[cfg(any(target_os = "macos", test))]
fn tiles((width, height): (u32, u32)) -> Vec<Tile> {
    let columns = spans(width);
    spans(height)
        .into_iter()
        .flat_map(|(y, h, top, bottom)| {
            columns.iter().map(move |&(x, w, left, right)| Tile {
                rect: Rect {
                    x: x as i32,
                    y: y as i32,
                    width: w,
                    height: h,
                },
                core: (left, right, top, bottom),
            })
        })
        .collect()
}

/// The `lines` Vision read in `tile`, boxes in the tile's pixels, moved
/// into the image's pixels, keeping only those whose box's centre lies in
/// the tile's core.
#[cfg(any(target_os = "macos", test))]
fn tile_lines(lines: Vec<OcrLine>, tile: &Tile) -> Vec<OcrLine> {
    let shift = |rect: &mut Rect| {
        rect.x += tile.rect.x;
        rect.y += tile.rect.y;
    };
    let (left, right, top, bottom) = tile.core;
    // Twice the centre, to stay in whole pixels.
    let inside = |rect: &Rect| {
        let cx = 2 * i64::from(rect.x) + i64::from(rect.width);
        let cy = 2 * i64::from(rect.y) + i64::from(rect.height);
        (2 * i64::from(left)..2 * i64::from(right)).contains(&cx)
            && (2 * i64::from(top)..2 * i64::from(bottom)).contains(&cy)
    };
    lines
        .into_iter()
        .filter_map(|mut line| {
            shift(&mut line.rect);
            for word in &mut line.words {
                shift(&mut word.rect);
            }
            inside(&line.rect).then_some(line)
        })
        .collect()
}

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

    use super::{keep_line, pick_languages, pixel_rect, tile_lines, tiles, word_ranges};
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

    /// The lines in `image`, read in one go when it is small enough, else
    /// tile by tile.
    fn recognize(image: &RgbImage) -> Result<Vec<OcrLine>, String> {
        let tiles = tiles(image.dimensions());
        if let [_] = tiles.as_slice() {
            return recognize_one(image);
        }
        let mut lines = Vec::new();
        for tile in &tiles {
            let rect = tile.rect;
            let part = image::imageops::crop_imm(
                image,
                rect.x.unsigned_abs(),
                rect.y.unsigned_abs(),
                rect.width,
                rect.height,
            )
            .to_image();
            // Each tile's objects go before the next is read.
            let read = autoreleasepool(|_| recognize_one(&part))?;
            lines.extend(tile_lines(read, tile));
        }
        Ok(lines)
    }

    /// The lines in `image`, read with one Vision request.
    fn recognize_one(image: &RgbImage) -> Result<Vec<OcrLine>, String> {
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

    #[test]
    fn a_small_image_is_one_tile() {
        let tiles = tiles((4096, 2000));
        assert_eq!(
            tiles,
            vec![Tile {
                rect: Rect {
                    x: 0,
                    y: 0,
                    width: 4096,
                    height: 2000,
                },
                core: (0, 4096, 0, 2000),
            }]
        );
    }

    /// Checks the spans of an axis `length` long against the layout's
    /// promises.
    fn check_spans(length: u32) -> Vec<(u32, u32, u32, u32)> {
        let spans = spans(length);
        assert_eq!(spans[0].0, 0, "{spans:?}");
        assert_eq!(spans[0].2, 0, "{spans:?}");
        let last = spans[spans.len() - 1];
        assert_eq!(last.0 + last.1, length, "{spans:?}");
        assert_eq!(last.3, length, "{spans:?}");
        for &(start, len, core_start, core_end) in &spans {
            assert!(len <= MAX_TILE, "{spans:?}");
            // The core lies inside the span.
            assert!(start <= core_start && core_end <= start + len, "{spans:?}");
            assert!(core_start < core_end, "{spans:?}");
        }
        for pair in spans.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            assert!(a.0 + a.1 >= b.0 + TILE_OVERLAP, "overlap {spans:?}");
            // The cores meet without a gap or overlap.
            assert_eq!(a.3, b.2, "{spans:?}");
        }
        spans
    }

    #[test]
    fn a_wide_image_is_read_in_overlapping_tiles() {
        // The full-screen capture of two displays that Vision misread.
        let spans = check_spans(10832);
        assert_eq!(spans.len(), 3, "{spans:?}");
        for length in [4097, 4224, 7000, 8064, 8065, 12000, 40000] {
            check_spans(length);
        }
    }

    #[test]
    fn tiles_cover_both_directions_row_by_row() {
        let tiles = tiles((10832, 5000));
        assert_eq!(tiles.len(), 3 * 2);
        assert_eq!((tiles[0].rect.x, tiles[0].rect.y), (0, 0));
        assert_eq!((tiles[1].rect.y, tiles[3].rect.x), (0, 0));
        assert!(tiles[3].rect.y > 0);
        for tile in &tiles {
            assert!(tile.rect.width <= MAX_TILE && tile.rect.height <= MAX_TILE);
        }
    }

    fn boxed(text: &str, x: i32, y: i32, width: u32, height: u32) -> OcrLine {
        let rect = Rect {
            x,
            y,
            width,
            height,
        };
        OcrLine {
            text: text.to_owned(),
            rect,
            words: vec![crate::ocr::OcrWord {
                text: text.to_owned(),
                rect,
            }],
        }
    }

    #[test]
    fn tile_lines_move_into_image_pixels() {
        let tile = Tile {
            rect: Rect {
                x: 1000,
                y: 500,
                width: 4096,
                height: 4096,
            },
            core: (1064, 5000, 500, 4596),
        };
        let kept = tile_lines(vec![boxed("Newest", 100, 20, 60, 10)], &tile);
        assert_eq!(kept, vec![boxed("Newest", 1100, 520, 60, 10)]);
    }

    #[test]
    fn a_line_in_the_overlap_is_kept_by_one_tile_only() {
        let spans = spans(10832);
        let make = |(x, w, left, right): (u32, u32, u32, u32)| Tile {
            rect: Rect {
                x: x as i32,
                y: 0,
                width: w,
                height: 3780,
            },
            core: (left, right, 0, 3780),
        };
        let (first, second) = (make(spans[0]), make(spans[1]));
        // A line in both tiles: the same place in the image, seen from each.
        let image_x = second.rect.x + 10;
        let from_first = vec![boxed("Labels", image_x - first.rect.x, 40, 50, 12)];
        let from_second = vec![boxed("Labels", image_x - second.rect.x, 40, 50, 12)];
        let kept = tile_lines(from_first, &first).len() + tile_lines(from_second, &second).len();
        assert_eq!(kept, 1);
        // A line whose centre sits exactly on the boundary goes to the
        // second tile.
        let boundary = first.core.1 as i32;
        let on_edge = |tile: &Tile| {
            tile_lines(
                vec![boxed("Issues", boundary - 20 - tile.rect.x, 0, 40, 10)],
                tile,
            )
            .len()
        };
        assert_eq!((on_edge(&first), on_edge(&second)), (0, 1));
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
    fn vision_reads_text_across_a_wide_image_once() {
        use crate::ocr::tests::{FIXTURE_WORD, fixture_png};
        // The fixture three times along a canvas wider than one tile,
        // the middle copy straddling the first seam.
        let fixture = image::open(fixture_png()).unwrap().into_rgb8();
        let mut wide = RgbImage::from_pixel(9000, 400, image::Rgb([255, 255, 255]));
        let seam = spans(9000)[0].3;
        for x in [200, seam - fixture.width() / 2, 8000] {
            image::imageops::overlay(&mut wide, &fixture, i64::from(x), 120);
        }
        let Some(read) = read(&wide) else {
            return;
        };
        let lines = read.unwrap();
        let found = lines
            .iter()
            .flat_map(|line| &line.words)
            .filter(|word| word.text.to_lowercase() == FIXTURE_WORD)
            .count();
        assert_eq!(found, 3, "{lines:?}");
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
