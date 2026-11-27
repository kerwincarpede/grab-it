//! Text recognition with the system's own on-device engine on Windows
//! (`Windows.Media.Ocr`), which reads ordinary UI text far better than
//! ocrs. [`read`] gives `None` where it cannot be used (other platforms,
//! and Windows with no OCR language for the user's languages), and
//! [`crate::ocr::Ocr`] then reads the image with ocrs instead.
//!
//! Windows OCR reports top-left pixel boxes per word; a line's box is the
//! union of its words' boxes ([`union`]), grown to whole pixels and clipped
//! to the image ([`pixel_rect`]). It exposes no confidence score, so only
//! single-character lines are left out ([`keep_line`]), as with ocrs.
//!
//! The engine refuses images with a side over `OcrEngine::MaxImageDimension`,
//! so larger ones are read at full resolution as overlapping tiles
//! ([`tiles`]). Each tile offers the lines whose box centre lies in or just
//! past its core ([`tile_lines`]), [`merge_tiles`] keeps one of each line
//! two tiles both read, and [`reading_order`] restores top-to-bottom,
//! left-to-right order across tiles so the overlaps give no duplicates and
//! a line on a seam is never lost.

use image::RgbImage;

#[cfg(any(target_os = "windows", test))]
use crate::capture::Rect;
use crate::ocr::OcrLine;

/// How far neighbouring tiles overlap at least, in pixels, so a line cut at
/// one tile's edge is whole in its neighbour.
#[cfg(any(target_os = "windows", test))]
const TILE_OVERLAP: u32 = 128;
/// How far past its core a tile still offers a line. Each tile measures a
/// line on its own, a pixel or two apart, so a line centred on a seam
/// could otherwise fall just outside both cores and be lost.
#[cfg(any(target_os = "windows", test))]
const SEAM_SLACK: u32 = TILE_OVERLAP / 4;

/// A part of an image Windows OCR reads on its own, in the image's pixels.
#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Tile {
    /// The pixels read.
    rect: Rect,
    /// The part of `rect` this tile alone owns: `[left, right)` and
    /// `[top, bottom)`. The cores of all tiles cover the image once.
    core: (u32, u32, u32, u32),
}

/// One axis of the tile layout: `(start, length, core start, core end)` of
/// each span of an axis `length` pixels long. One span when `max` is zero
/// or it fits in `max`; else the fewest spans of `max` that overlap by at
/// least [`TILE_OVERLAP`] (capped to half of `max`), evenly spread, the
/// last ending at the edge, and each core ending halfway through the
/// overlap with the next.
#[cfg(any(target_os = "windows", test))]
fn spans(length: u32, max: u32) -> Vec<(u32, u32, u32, u32)> {
    if max == 0 || length <= max {
        return vec![(0, length, 0, length)];
    }
    let overlap = TILE_OVERLAP.min(max / 2);
    let extra = length - max;
    let count = 1 + extra.div_ceil(max - overlap);
    let step = extra.div_ceil(count - 1);
    let starts: Vec<u32> = (0..count)
        .map(|i| i.saturating_mul(step).min(extra))
        .collect();
    let boundary = |i: usize| -> u32 {
        if i == 0 {
            0
        } else if i == starts.len() {
            length
        } else {
            // Halfway between where this span starts and the last one ends.
            ((u64::from(starts[i]) + u64::from(starts[i - 1]) + u64::from(max)) / 2) as u32
        }
    };
    starts
        .iter()
        .enumerate()
        .map(|(i, &start)| (start, max, boundary(i), boundary(i + 1)))
        .collect()
}

/// The tiles to read an image of `size` in, row by row: the whole image
/// when `max` is zero or it fits in `max` both ways.
#[cfg(any(target_os = "windows", test))]
fn tiles((width, height): (u32, u32), max: u32) -> Vec<Tile> {
    let columns = spans(width, max);
    spans(height, max)
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

/// A line one tile read, in the image's pixels.
#[cfg(any(target_os = "windows", test))]
#[derive(Debug)]
struct TileLine {
    line: OcrLine,
    /// The tile that read it.
    tile: Tile,
    /// Whether its box's centre lies in the tile's core, rather than just
    /// past it.
    in_core: bool,
}

/// The `lines` Windows OCR read in `tile`, boxes in the tile's pixels,
/// moved into the image's pixels, keeping only those whose box's centre
/// lies in the tile's core or within [`SEAM_SLACK`] of it.
#[cfg(any(target_os = "windows", test))]
fn tile_lines(lines: Vec<OcrLine>, tile: &Tile) -> Vec<TileLine> {
    let shift = |rect: &mut Rect| {
        rect.x += tile.rect.x;
        rect.y += tile.rect.y;
    };
    let (left, right, top, bottom) = tile.core;
    // Twice the centre, to stay in whole pixels.
    let within = |rect: &Rect, slack: u32| {
        let cx = 2 * i64::from(rect.x) + i64::from(rect.width);
        let cy = 2 * i64::from(rect.y) + i64::from(rect.height);
        let slack = 2 * i64::from(slack);
        (2 * i64::from(left) - slack..2 * i64::from(right) + slack).contains(&cx)
            && (2 * i64::from(top) - slack..2 * i64::from(bottom) + slack).contains(&cy)
    };
    lines
        .into_iter()
        .filter_map(|mut line| {
            shift(&mut line.rect);
            for word in &mut line.words {
                shift(&mut word.rect);
            }
            within(&line.rect, SEAM_SLACK).then(|| TileLine {
                in_core: within(&line.rect, 0),
                line,
                tile: *tile,
            })
        })
        .collect()
}

/// The area two boxes share.
#[cfg(any(target_os = "windows", test))]
fn shared_area(a: &Rect, b: &Rect) -> i64 {
    let span = |a0: i32, a1: u32, b0: i32, b1: u32| {
        let start = i64::from(a0.max(b0));
        let end = (i64::from(a0) + i64::from(a1)).min(i64::from(b0) + i64::from(b1));
        (end - start).max(0)
    };
    span(a.x, a.width, b.x, b.width) * span(a.y, a.height, b.y, b.height)
}

/// The lines of all tiles, each line two tiles both read kept once: a line
/// is dropped when another tile's kept line covers at least half of the
/// smaller of their boxes. Lines centred in their tile's core are kept
/// first, then larger boxes, so a line whole in one tile wins over the
/// part of it cut at another tile's edge.
#[cfg(any(target_os = "windows", test))]
fn merge_tiles(mut lines: Vec<TileLine>) -> Vec<OcrLine> {
    let area = |rect: &Rect| i64::from(rect.width) * i64::from(rect.height);
    lines.sort_by_key(|l| (!l.in_core, std::cmp::Reverse(area(&l.line.rect))));
    let mut kept: Vec<TileLine> = Vec::with_capacity(lines.len());
    for line in lines {
        let repeated = kept.iter().any(|other| {
            other.tile != line.tile
                && 2 * shared_area(&other.line.rect, &line.line.rect)
                    >= area(&other.line.rect).min(area(&line.line.rect))
        });
        if !repeated {
            kept.push(line);
        }
    }
    kept.into_iter().map(|l| l.line).collect()
}

/// `lines` gathered from several tiles in reading order: rows top to
/// bottom, and the lines of a row left to right. A line joins the row of
/// the line above it when its centre lies within that line's height, so
/// text on one row whose boxes start a pixel or two apart stays together.
#[cfg(any(target_os = "windows", test))]
fn reading_order(mut lines: Vec<OcrLine>) -> Vec<OcrLine> {
    lines.sort_by_key(|line| (line.rect.y, line.rect.x));
    let mut ordered = Vec::with_capacity(lines.len());
    let mut rest = lines.into_iter().peekable();
    while let Some(first) = rest.next() {
        let bottom = i64::from(first.rect.y) + i64::from(first.rect.height);
        let mut row = vec![first];
        // Twice the centre, to stay in whole pixels.
        while let Some(next) = rest
            .next_if(|line| 2 * i64::from(line.rect.y) + i64::from(line.rect.height) < 2 * bottom)
        {
            row.push(next);
        }
        row.sort_by_key(|line| line.rect.x);
        ordered.extend(row);
    }
    ordered
}

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

/// Whether a line Windows OCR read is worth keeping: single characters are
/// mostly noise (icons, borders), as with ocrs.
#[cfg(any(target_os = "windows", test))]
fn keep_line(text: &str) -> bool {
    text.chars().count() > 1
}

/// A Windows OCR box (top-left pixels, floating point) as a box in the
/// pixels of an image of `size`, grown outwards to whole pixels and clipped
/// to the image.
#[cfg(any(target_os = "windows", test))]
fn pixel_rect((x, y, width, height): (f32, f32, f32, f32), (w, h): (u32, u32)) -> Rect {
    let (w, h) = (f64::from(w), f64::from(h));
    let (x, y) = (f64::from(x), f64::from(y));
    let (width, height) = (f64::from(width), f64::from(height));
    let left = x.floor().clamp(0.0, w);
    let right = (x + width).ceil().clamp(0.0, w);
    let top = y.floor().clamp(0.0, h);
    let bottom = (y + height).ceil().clamp(0.0, h);
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

    use super::{keep_line, merge_tiles, pixel_rect, reading_order, tile_lines, tiles, union};
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
        // Each tile fits MaxImageDimension; a side too long for an i32 no
        // longer matches the buffer, and Windows refuses it.
        let side = |length: u32| i32::try_from(length).unwrap_or(i32::MAX);
        SoftwareBitmap::CreateCopyFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            side(width),
            side(height),
        )
    }

    /// The lines in `image`, read in one go when it fits `MaxImageDimension`,
    /// else tile by tile and put back into reading order.
    fn recognize(engine: &OcrEngine, image: &RgbImage) -> windows::core::Result<Vec<OcrLine>> {
        let tiles = tiles(image.dimensions(), OcrEngine::MaxImageDimension()?);
        if let [_] = tiles.as_slice() {
            return recognize_one(engine, image);
        }
        let mut lines = Vec::new();
        for tile in &tiles {
            let rect = tile.rect;
            let part = imageops::crop_imm(
                image,
                rect.x.unsigned_abs(),
                rect.y.unsigned_abs(),
                rect.width,
                rect.height,
            )
            .to_image();
            let read = recognize_one(engine, &part)?;
            lines.extend(tile_lines(read, tile));
        }
        Ok(reading_order(merge_tiles(lines)))
    }

    /// The lines in `image`, read with one Windows OCR request.
    fn recognize_one(engine: &OcrEngine, image: &RgbImage) -> windows::core::Result<Vec<OcrLine>> {
        let size = image.dimensions();
        let result = engine.RecognizeAsync(&bitmap(image)?)?.get()?;

        let mut lines = Vec::new();
        for line in &result.Lines()? {
            let text = line.Text()?.to_string_lossy().trim().to_owned();
            // Single characters are mostly noise (icons, borders).
            if !keep_line(&text) {
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
                    rect: pixel_rect(found, size),
                });
            }
            let Some(line_box) = union(&boxes) else {
                continue;
            };
            lines.push(OcrLine {
                text,
                rect: pixel_rect(line_box, size),
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
    fn a_box_inside_the_image_is_unchanged() {
        assert_eq!(
            pixel_rect((10.0, 20.0, 30.0, 40.0), (640, 160)),
            Rect {
                x: 10,
                y: 20,
                width: 30,
                height: 40,
            }
        );
    }

    #[test]
    fn a_box_grows_to_whole_pixels() {
        assert_eq!(
            pixel_rect((1.2, 2.8, 3.1, 4.1), (100, 100)),
            Rect {
                x: 1,
                y: 2,
                width: 4,
                height: 5,
            }
        );
    }

    #[test]
    fn a_box_past_the_edges_is_clipped_to_the_image() {
        assert_eq!(
            pixel_rect((-10.0, -5.0, 200.0, 100.0), (100, 50)),
            Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 50,
            }
        );
        // Wholly outside: empty, at the nearest edge.
        let outside = pixel_rect((150.0, 10.0, 20.0, 10.0), (100, 50));
        assert_eq!((outside.x, outside.width), (100, 0));
    }

    #[test]
    fn a_malformed_box_is_empty() {
        let nan = pixel_rect((f32::NAN, 0.0, 5.0, 5.0), (100, 100));
        assert_eq!(nan.width, 0);
        let negative = pixel_rect((10.0, 10.0, -5.0, -5.0), (100, 100));
        assert_eq!((negative.width, negative.height), (0, 0));
    }

    #[test]
    fn a_line_box_covers_its_words() {
        assert_eq!(
            union(&[(10.0, 20.0, 30.0, 10.0), (50.0, 18.0, 20.0, 14.0)]),
            Some((10.0, 18.0, 60.0, 14.0))
        );
        assert_eq!(
            union(&[(15.0, 25.0, 10.0, 12.0)]),
            Some((15.0, 25.0, 10.0, 12.0))
        );
        assert_eq!(union(&[]), None);
    }

    #[test]
    fn single_characters_are_dropped() {
        assert!(!keep_line(""));
        assert!(!keep_line("x"));
        // One multi-byte character is still a single character.
        assert!(!keep_line("é"));
        assert!(keep_line("OK"));
        assert!(keep_line("éé"));
        assert!(keep_line("Newest"));
    }

    #[test]
    fn a_small_image_is_one_tile() {
        assert_eq!(
            tiles((2600, 1600), 2600),
            vec![Tile {
                rect: Rect {
                    x: 0,
                    y: 0,
                    width: 2600,
                    height: 1600,
                },
                core: (0, 2600, 0, 1600),
            }]
        );
    }

    #[test]
    fn no_limit_reads_the_image_in_one_tile() {
        assert_eq!(
            tiles((6400, 3600), 0),
            vec![Tile {
                rect: Rect {
                    x: 0,
                    y: 0,
                    width: 6400,
                    height: 3600,
                },
                core: (0, 6400, 0, 3600),
            }]
        );
    }

    /// Checks the spans of an axis `length` long against the layout's
    /// promises.
    fn check_spans(length: u32, max: u32) -> Vec<(u32, u32, u32, u32)> {
        let spans = spans(length, max);
        let min_overlap = TILE_OVERLAP.min(max / 2);
        assert_eq!(spans[0].0, 0, "{spans:?}");
        assert_eq!(spans[0].2, 0, "{spans:?}");
        let last = spans[spans.len() - 1];
        assert_eq!(last.0 + last.1, length, "{spans:?}");
        assert_eq!(last.3, length, "{spans:?}");
        for &(start, len, core_start, core_end) in &spans {
            assert!(len <= max, "{spans:?}");
            // The core lies inside the span.
            assert!(start <= core_start && core_end <= start + len, "{spans:?}");
            assert!(core_start < core_end, "{spans:?}");
        }
        for pair in spans.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            assert!(a.0 + a.1 >= b.0 + min_overlap, "overlap {spans:?}");
            // The cores meet without a gap or overlap.
            assert_eq!(a.3, b.2, "{spans:?}");
        }
        spans
    }

    #[test]
    fn a_wide_image_is_read_in_overlapping_tiles() {
        let spans = check_spans(6400, 2600);
        assert_eq!(spans.len(), 3, "{spans:?}");
        for length in [2601, 2728, 5072, 5073, 10832, 40000] {
            check_spans(length, 2600);
        }
        // Small max caps overlap to half of max rather than underflowing.
        check_spans(250, 100);
    }

    #[test]
    fn tiles_cover_both_directions_row_by_row() {
        let tiles = tiles((6400, 3600), 2600);
        assert_eq!(tiles.len(), 3 * 2);
        assert_eq!((tiles[0].rect.x, tiles[0].rect.y), (0, 0));
        assert_eq!((tiles[1].rect.y, tiles[3].rect.x), (0, 0));
        assert!(tiles[3].rect.y > 0);
        for tile in &tiles {
            assert!(tile.rect.width <= 2600 && tile.rect.height <= 2600);
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
                width: 2600,
                height: 2600,
            },
            core: (1064, 3500, 500, 3100),
        };
        let kept = merge_tiles(tile_lines(vec![boxed("Newest", 100, 20, 60, 10)], &tile));
        assert_eq!(kept, vec![boxed("Newest", 1100, 520, 60, 10)]);
    }

    #[test]
    fn a_line_in_the_overlap_is_kept_by_one_tile_only() {
        let spans = spans(6400, 2600);
        let make = |(x, w, left, right): (u32, u32, u32, u32)| Tile {
            rect: Rect {
                x: x as i32,
                y: 0,
                width: w,
                height: 1600,
            },
            core: (left, right, 0, 1600),
        };
        let (first, second) = (make(spans[0]), make(spans[1]));
        // A line near the seam, seen from both tiles.
        let image_x = first.core.1 as i32 - 20;
        let from_first = vec![boxed("Labels", image_x - first.rect.x, 40, 50, 12)];
        let from_second = vec![boxed("Labels", image_x - second.rect.x, 40, 50, 12)];
        let mut lines = tile_lines(from_first, &first);
        lines.extend(tile_lines(from_second, &second));
        assert_eq!(lines.len(), 2);
        assert_eq!(merge_tiles(lines).len(), 1);
    }

    #[test]
    fn a_line_on_a_seam_is_kept_once_however_each_tile_measures_it() {
        let spans = spans(6400, 2600);
        let make = |(x, w, left, right): (u32, u32, u32, u32)| Tile {
            rect: Rect {
                x: x as i32,
                y: 0,
                width: w,
                height: 400,
            },
            core: (left, right, 0, 400),
        };
        let (first, second) = (make(spans[0]), make(spans[1]));
        let boundary = first.core.1 as i32;
        // The first tile sees the centre just past its core, the second
        // just before its own: neither core holds it.
        let seen = |tile: &Tile, centre: i32| {
            tile_lines(
                vec![boxed("pineapple", centre - 224 - tile.rect.x, 58, 448, 49)],
                tile,
            )
        };
        let mut lines = seen(&first, boundary + 1);
        lines.extend(seen(&second, boundary - 2));
        assert_eq!(merge_tiles(lines).len(), 1);
    }

    #[test]
    fn a_line_well_past_a_tile_core_is_left_to_its_neighbour() {
        let spans = spans(6400, 2600);
        let (x, w, left, right) = spans[0];
        let first = Tile {
            rect: Rect {
                x: x as i32,
                y: 0,
                width: w,
                height: 400,
            },
            core: (left, right, 0, 400),
        };
        let past = (right + SEAM_SLACK) as i32;
        let lines = tile_lines(vec![boxed("Labels", past, 40, 50, 12)], &first);
        assert!(lines.is_empty(), "{lines:?}");
    }

    #[test]
    fn a_whole_line_wins_over_its_part_cut_at_a_tile_edge() {
        let max = 2600;
        // Tiles overlapping by the least they may, their cores meeting
        // halfway through the overlap.
        let tile = |x: i32, core: (u32, u32, u32, u32)| Tile {
            rect: Rect {
                x,
                y: 0,
                width: max,
                height: 400,
            },
            core,
        };
        let seam = max - TILE_OVERLAP / 2;
        let first = tile(0, (0, seam, 0, 400));
        let second = tile((max - TILE_OVERLAP) as i32, (seam, 5000, 0, 400));
        // A line from 2500 to 2700: the first tile's edge cuts it at 2600,
        // which puts the centre of what it reads just past its core.
        let mut lines = tile_lines(vec![boxed("pine", 2500, 40, 100, 12)], &first);
        assert_eq!(lines.len(), 1);
        lines.extend(tile_lines(
            vec![boxed("pineapple", 2500 - second.rect.x, 40, 200, 12)],
            &second,
        ));
        let kept = merge_tiles(lines);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(kept[0].text, "pineapple");
    }

    #[test]
    fn lines_from_side_by_side_tiles_read_top_to_bottom() {
        let spans = spans(5000, 2600);
        let make = |(x, w, left, right): (u32, u32, u32, u32)| Tile {
            rect: Rect {
                x: x as i32,
                y: 0,
                width: w,
                height: 2000,
            },
            core: (left, right, 0, 2000),
        };
        let (left, right) = (make(spans[0]), make(spans[1]));
        let at = |tile: &Tile, text: &str, image_x: i32, y: i32| {
            boxed(text, image_x - tile.rect.x, y, 80, 20)
        };
        let mut lines = tile_lines(
            vec![
                at(&left, "New issue", 100, 40),
                at(&left, "Labels", 100, 400),
            ],
            &left,
        );
        lines.extend(tile_lines(
            vec![
                // On the first row, its box a pixel higher.
                at(&right, "Newest", 4600, 39),
                at(&right, "Assignee", 4600, 200),
            ],
            &right,
        ));
        let text: Vec<String> = reading_order(merge_tiles(lines))
            .into_iter()
            .map(|line| line.text)
            .collect();
        assert_eq!(text, ["New issue", "Newest", "Assignee", "Labels"]);
    }

    #[test]
    fn lines_on_one_row_read_left_to_right() {
        let lines = vec![
            boxed("right", 300, 10, 50, 20),
            boxed("below", 0, 40, 50, 20),
            boxed("left", 0, 12, 50, 20),
        ];
        let text: Vec<String> = reading_order(lines)
            .into_iter()
            .map(|line| line.text)
            .collect();
        assert_eq!(text, ["left", "right", "below"]);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_gives_none() {
        let blank = RgbImage::from_pixel(16, 16, image::Rgb([255, 255, 255]));
        assert!(read(&blank).is_none());
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

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_reads_text_across_a_wide_image_once() {
        use crate::ocr::tests::{FIXTURE_WORD, fixture_png};
        let Ok(max) = windows::Media::Ocr::OcrEngine::MaxImageDimension() else {
            return;
        };
        let fixture = image::open(fixture_png()).unwrap().into_rgb8();
        if max < fixture.width() * 2 {
            return;
        }
        // The fixture three times along a canvas wider than one tile,
        // the middle copy straddling the first seam.
        let width = max * 2 + 400;
        let mut wide = RgbImage::from_pixel(width, 400, image::Rgb([255, 255, 255]));
        let seam = spans(width, max)[0].3;
        for x in [
            200,
            seam - fixture.width() / 2,
            width - fixture.width() - 200,
        ] {
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

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_finds_no_text_in_a_blank_image() {
        let blank = RgbImage::from_pixel(200, 80, image::Rgb([255, 255, 255]));
        if let Some(read) = read(&blank) {
            assert_eq!(read.unwrap(), vec![]);
        }
    }
}
