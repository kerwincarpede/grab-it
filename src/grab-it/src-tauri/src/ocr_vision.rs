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
//! as overlapping tiles ([`tiles`]). Each tile offers the lines whose box
//! centre lies in or just past its core ([`tile_lines`]), and
//! [`merge_tiles`] keeps one of each line two tiles both read, so the
//! overlaps give no duplicates and a line on a seam is never lost.

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
/// The minimum confidence a 1-character structural code candidate (`}`, `{`,
/// `)`, `]`, `;`) needs before post-collection alignment filtering.
#[cfg(any(target_os = "macos", test))]
const MIN_STRUCTURAL_CONFIDENCE: f32 = 0.3;

/// Compact crops whose width and height are both at most this many pixels are
/// upscaled 2x before Vision OCR so small 11-13 px UI text and dark monospace
/// lines are not dropped or mangled.
#[cfg(any(target_os = "macos", test))]
const UPSCALE_MAX_EDGE: u32 = 2048;

/// The largest tile Vision reads at once, in pixels either way: larger
/// images are read in tiles of at most this size.
#[cfg(any(target_os = "macos", test))]
const MAX_TILE: u32 = 4096;
/// How far neighbouring tiles overlap at least, in pixels, so a line cut at
/// one tile's edge is whole in its neighbour.
#[cfg(any(target_os = "macos", test))]
const TILE_OVERLAP: u32 = 128;
/// How far past its core a tile still offers a line. Each tile measures a
/// line on its own, a pixel or two apart, so a line centred on a seam
/// could otherwise fall just outside both cores and be lost.
#[cfg(any(target_os = "macos", test))]
const SEAM_SLACK: u32 = TILE_OVERLAP / 4;

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

/// A line one tile read, in the image's pixels.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug)]
struct TileLine {
    line: OcrLine,
    /// The tile that read it.
    tile: Tile,
    /// Whether its box's centre lies in the tile's core, rather than just
    /// past it.
    in_core: bool,
}

/// The `lines` Vision read in `tile`, boxes in the tile's pixels, moved
/// into the image's pixels, keeping only those whose box's centre lies in
/// the tile's core or within [`SEAM_SLACK`] of it.
#[cfg(any(target_os = "macos", test))]
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
#[cfg(any(target_os = "macos", test))]
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
#[cfg(any(target_os = "macos", test))]
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

/// `lines` gathered from several tiles in reading order: multi-line columns
/// (2+ vertically stacked lines across a wide gutter) are clustered left to
/// right and read top to bottom within each column, while single-row layouts
/// keep top-to-bottom then left-to-right order.
#[cfg(any(target_os = "macos", test))]
fn reading_order(lines: Vec<OcrLine>) -> Vec<OcrLine> {
    if lines.len() <= 1 {
        return lines;
    }
    let ref_h = median_height(&lines).unwrap_or(20);
    order_block(lines, ref_h)
}

#[cfg(any(target_os = "macos", test))]
fn median_height(lines: &[OcrLine]) -> Option<u32> {
    let mut heights: Vec<u32> = lines
        .iter()
        .map(|l| l.rect.height)
        .filter(|&h| h > 0)
        .collect();
    if heights.is_empty() {
        return None;
    }
    heights.sort_unstable();
    Some(heights[heights.len() / 2])
}

#[cfg(any(target_os = "macos", test))]
fn order_block(lines: Vec<OcrLine>, ref_h: u32) -> Vec<OcrLine> {
    if lines.len() <= 1 {
        return lines;
    }
    // Split on clear vertical section gaps (> 1.5x line height) first so a
    // toolbar or header row above two columns is not absorbed into them.
    if let Some(bands) = split_section_bands(&lines, ref_h)
        && bands
            .iter()
            .any(|band| split_multiline_columns(band, ref_h).is_some())
    {
        return bands
            .into_iter()
            .flat_map(|band| order_block(band, ref_h))
            .collect();
    }
    if let Some(columns) = split_multiline_columns(&lines, ref_h) {
        return columns
            .into_iter()
            .flat_map(|col| order_block(col, ref_h))
            .collect();
    }
    // If a full-width banner or footer bridges the gutter without a large gap,
    // peel off the bridging rows and cluster the multi-line columns between them.
    if let Some((before, middle, after)) = split_around_multiline_columns(&lines, ref_h) {
        let mut ordered = Vec::with_capacity(lines.len());
        ordered.extend(order_block(before, ref_h));
        ordered.extend(order_block(middle, ref_h));
        ordered.extend(order_block(after, ref_h));
        return ordered;
    }
    row_order(lines)
}

/// Splits `lines` left-to-right across vertical gutters of at least
/// `max(2 * ref_h, 24)` px when at least two resulting groups are vertically
/// overlapping multi-line columns (each containing 2+ stacked rows).
#[cfg(any(target_os = "macos", test))]
fn split_multiline_columns(lines: &[OcrLine], ref_h: u32) -> Option<Vec<Vec<OcrLine>>> {
    if lines.len() < 4 {
        return None;
    }
    let gutter_min = i64::from((ref_h * 2).max(24));
    let mut indices: Vec<usize> = (0..lines.len()).collect();
    indices.sort_by_key(|&i| (lines[i].rect.x, lines[i].rect.y));

    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = vec![indices[0]];
    let mut max_right =
        i64::from(lines[indices[0]].rect.x) + i64::from(lines[indices[0]].rect.width);
    for &idx in &indices[1..] {
        let left = i64::from(lines[idx].rect.x);
        let right = left + i64::from(lines[idx].rect.width);
        if left - max_right >= gutter_min {
            groups.push(current);
            current = vec![idx];
            max_right = right;
        } else {
            current.push(idx);
            max_right = max_right.max(right);
        }
    }
    groups.push(current);

    if groups.len() < 2 {
        return None;
    }

    let is_multiline = |group: &[usize]| -> bool {
        if group.len() < 2 {
            return false;
        }
        let mut ys: Vec<i64> = group
            .iter()
            .map(|&i| 2 * i64::from(lines[i].rect.y) + i64::from(lines[i].rect.height))
            .collect();
        ys.sort_unstable();
        ys.last().copied().unwrap_or(0) - ys.first().copied().unwrap_or(0)
            >= 2 * i64::from(ref_h.max(1))
    };

    let multiline_groups: Vec<&Vec<usize>> = groups.iter().filter(|g| is_multiline(g)).collect();
    if multiline_groups.len() < 2 {
        return None;
    }

    // Confirm at least two multi-line groups overlap vertically (side-by-side).
    let y_span = |group: &[usize]| -> (i64, i64) {
        let min_y = group
            .iter()
            .map(|&i| i64::from(lines[i].rect.y))
            .min()
            .unwrap_or(0);
        let max_y = group
            .iter()
            .map(|&i| i64::from(lines[i].rect.y) + i64::from(lines[i].rect.height))
            .max()
            .unwrap_or(0);
        (min_y, max_y)
    };
    let spans: Vec<(i64, i64)> = multiline_groups.iter().map(|g| y_span(g)).collect();
    let any_overlap = spans.iter().enumerate().any(|(i, &(a0, a1))| {
        spans[i + 1..]
            .iter()
            .any(|&(b0, b1)| a0.max(b0) < a1.min(b1))
    });
    if !any_overlap {
        return None;
    }

    Some(
        groups
            .into_iter()
            .map(|group| group.into_iter().map(|i| lines[i].clone()).collect())
            .collect(),
    )
}

/// Splits `lines` top-to-bottom into vertical section bands only where there
/// is a clear gap (> 1.5x `ref_h`), so normal line spacing inside stacked
/// columns stays intact.
#[cfg(any(target_os = "macos", test))]
fn split_section_bands(lines: &[OcrLine], ref_h: u32) -> Option<Vec<Vec<OcrLine>>> {
    if lines.len() < 2 {
        return None;
    }
    let gap_threshold = i64::from(ref_h.max(1)) * 3;
    let mut indices: Vec<usize> = (0..lines.len()).collect();
    indices.sort_by_key(|&i| (lines[i].rect.y, lines[i].rect.x));

    let mut bands: Vec<Vec<usize>> = Vec::new();
    let mut current = vec![indices[0]];
    let mut max_bottom =
        i64::from(lines[indices[0]].rect.y) + i64::from(lines[indices[0]].rect.height);
    for &idx in &indices[1..] {
        let top = i64::from(lines[idx].rect.y);
        let bottom = top + i64::from(lines[idx].rect.height);
        if (top - max_bottom) * 2 > gap_threshold {
            bands.push(current);
            current = vec![idx];
            max_bottom = bottom;
        } else {
            current.push(idx);
            max_bottom = max_bottom.max(bottom);
        }
    }
    bands.push(current);

    if bands.len() < 2 {
        return None;
    }
    Some(
        bands
            .into_iter()
            .map(|band| band.into_iter().map(|i| lines[i].clone()).collect())
            .collect(),
    )
}

/// Groups `lines` into visual rows and finds a maximal contiguous slice of
/// rows that splits into multi-line columns when full-width banner or footer
/// rows sit directly above or below them.
#[cfg(any(target_os = "macos", test))]
fn split_around_multiline_columns(
    lines: &[OcrLine],
    ref_h: u32,
) -> Option<(Vec<OcrLine>, Vec<OcrLine>, Vec<OcrLine>)> {
    let mut indices: Vec<usize> = (0..lines.len()).collect();
    indices.sort_by_key(|&i| (lines[i].rect.y, lines[i].rect.x));
    let mut rows: Vec<Vec<usize>> = Vec::new();
    let mut rest = indices.into_iter().peekable();
    while let Some(first) = rest.next() {
        let bottom = i64::from(lines[first].rect.y) + i64::from(lines[first].rect.height);
        let mut row = vec![first];
        while let Some(next) = rest.next_if(|&i| {
            2 * i64::from(lines[i].rect.y) + i64::from(lines[i].rect.height) < 2 * bottom
        }) {
            row.push(next);
        }
        rows.push(row);
    }
    if rows.len() < 3 {
        return None;
    }
    for start in 0..rows.len() {
        for end in ((start + 2)..=rows.len()).rev() {
            if start == 0 && end == rows.len() {
                continue;
            }
            let middle: Vec<OcrLine> = rows[start..end]
                .iter()
                .flatten()
                .map(|&i| lines[i].clone())
                .collect();
            if split_multiline_columns(&middle, ref_h).is_some() {
                let before: Vec<OcrLine> = rows[..start]
                    .iter()
                    .flatten()
                    .map(|&i| lines[i].clone())
                    .collect();
                let after: Vec<OcrLine> = rows[end..]
                    .iter()
                    .flatten()
                    .map(|&i| lines[i].clone())
                    .collect();
                return Some((before, middle, after));
            }
        }
    }
    None
}

/// Top-to-bottom, same-row left-to-right ordering. A line joins the row of the
/// line above it when its centre lies within that line's height.
#[cfg(any(target_os = "macos", test))]
fn row_order(mut lines: Vec<OcrLine>) -> Vec<OcrLine> {
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
/// Vision is fairly sure of them. Structural 1-character code lines (`}`, `{`,
/// `)`, `]`, `;`) are collected separately and filtered against neighbouring
/// line boxes by [`filter_structural_lines`].
#[cfg(any(target_os = "macos", test))]
fn keep_line(text: &str, confidence: f32) -> bool {
    let chars = text.chars().count();
    chars > 1 && (chars > SHORT_LINE_CHARS || confidence >= MIN_SHORT_CONFIDENCE)
}

/// Whether `text` is a single structural code character that may legitimately
/// stand on its own line (`}`, `{`, `)`, `]`, `;`).
#[cfg(any(target_os = "macos", test))]
fn is_structural_char(text: &str) -> bool {
    matches!(text, "}" | "{" | ")" | "]" | ";")
}

/// Whether an observation should be collected before post-collection
/// structural alignment filtering.
#[cfg(any(target_os = "macos", test))]
fn keep_candidate(text: &str, confidence: f32) -> bool {
    keep_line(text, confidence)
        || (is_structural_char(text) && confidence >= MIN_STRUCTURAL_CONFIDENCE)
}

/// Whether an image of `size` should be upscaled 2x before Vision OCR.
#[cfg(any(target_os = "macos", test))]
fn should_upscale((width, height): (u32, u32)) -> bool {
    width > 0 && height > 0 && width <= UPSCALE_MAX_EDGE && height <= UPSCALE_MAX_EDGE
}

/// Whether `line` looks like a line of source code or a shell command.
#[cfg(any(target_os = "macos", test))]
fn line_looks_like_code(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.ends_with('{') || trimmed.ends_with('}') || trimmed.ends_with(';') {
        return true;
    }
    if trimmed.contains('{') || trimmed.contains('}') {
        return true;
    }
    for token in [
        "::", "->", "=>", "!=", "==", "&&", "||", "()", "[]", "//", "/*", "~/", "% ./", "$ ./",
    ] {
        if trimmed.contains(token) {
            return true;
        }
    }
    // CLI flags like `--strict` or `--dry-run` (two dashes followed by a letter).
    let bytes = trimmed.as_bytes();
    for window in bytes.windows(3) {
        if window[0] == b'-' && window[1] == b'-' && window[2].is_ascii_alphabetic() {
            return true;
        }
    }
    // snake_case identifier such as `load_config` or `is_empty`.
    for window in bytes.windows(3) {
        if window[0].is_ascii_alphanumeric()
            && window[1] == b'_'
            && window[2].is_ascii_alphanumeric()
        {
            return true;
        }
    }
    for keyword in [
        "fn ",
        "let ",
        "pub ",
        "match ",
        "return ",
        "impl ",
        "struct ",
        "enum ",
        "const ",
        "def ",
        "class ",
        "import ",
        "function ",
        "async ",
    ] {
        if trimmed.starts_with(keyword) {
            return true;
        }
    }
    false
}

/// Whether `lines` represent a code or terminal block that should be retried
/// without language correction.
#[cfg(any(target_os = "macos", test))]
fn is_code_like(lines: &[OcrLine]) -> bool {
    if lines.is_empty() {
        return false;
    }
    let code_lines = lines
        .iter()
        .filter(|line| line_looks_like_code(&line.text))
        .count();
    if code_lines >= 2 && code_lines * 5 >= lines.len() * 2 {
        return true;
    }
    if lines.len() == 1 && code_lines == 1 {
        let t = lines[0].text.trim();
        return t.contains("::")
            || t.contains("=>")
            || t.contains("->")
            || t.ends_with('{')
            || t.ends_with(';');
    }
    false
}

/// Retains 1-character structural code lines (`}`, `{`, `)`, `]`, `;`) only
/// when their box size is plausible and they align vertically and horizontally
/// with neighbouring non-structural lines; isolated noise is dropped.
#[cfg(any(target_os = "macos", test))]
fn filter_structural_lines(lines: Vec<OcrLine>) -> Vec<OcrLine> {
    let anchors: Vec<Rect> = lines
        .iter()
        .filter(|line| !is_structural_char(&line.text) && line.rect.height > 0)
        .map(|line| line.rect)
        .collect();
    if anchors.is_empty() {
        return lines
            .into_iter()
            .filter(|line| !is_structural_char(&line.text))
            .collect();
    }
    let mut heights: Vec<u32> = anchors.iter().map(|rect| rect.height).collect();
    heights.sort_unstable();
    let median_h = heights[heights.len() / 2].max(1);
    let max_dim = median_h * 2 + 4;
    let x_tol = i64::from(median_h.max(16));
    let near_y = i64::from((median_h * 5).max(40));

    lines
        .into_iter()
        .filter(|line| {
            if !is_structural_char(&line.text) {
                return true;
            }
            if line.rect.height == 0 || line.rect.height > max_dim || line.rect.width > max_dim {
                return false;
            }
            let top = i64::from(line.rect.y);
            let bottom = top + i64::from(line.rect.height);
            let left = i64::from(line.rect.x);
            let right = left + i64::from(line.rect.width);

            // Must sit vertically near at least one non-structural line in the
            // same horizontal span so isolated margin/toolbar noise is dropped.
            let has_nearby_anchor = anchors.iter().any(|anchor| {
                let a_top = i64::from(anchor.y);
                let a_bottom = a_top + i64::from(anchor.height);
                let v_gap = if bottom < a_top {
                    a_top - bottom
                } else if a_bottom < top {
                    top - a_bottom
                } else {
                    0
                };
                if v_gap > near_y {
                    return false;
                }
                let a_left = i64::from(anchor.x);
                let a_right = a_left + i64::from(anchor.width);
                right + x_tol * 4 >= a_left && left <= a_right + x_tol * 4
            });
            if !has_nearby_anchor {
                return false;
            }

            // Must align with some non-structural line's left margin (closing
            // brace aligned with its opening line) or sit on the same baseline
            // right beside an anchor (split trailing `{` or `;`).
            anchors.iter().any(|anchor| {
                let a_left = i64::from(anchor.x);
                let a_right = a_left + i64::from(anchor.width);
                if (left - a_left).abs() <= x_tol {
                    return true;
                }
                let a_top = i64::from(anchor.y);
                let a_bottom = a_top + i64::from(anchor.height);
                let overlap_y = (bottom.min(a_bottom) - top.max(a_top)).max(0);
                overlap_y > 0 && left >= a_right - x_tol && left <= a_right + x_tol * 2
            })
        })
        .collect()
}

/// Whether `ch` is a non-alphanumeric symbol that icons commonly decode as
/// (`•`, `@`, `§`, geometric shapes, dingbats) rather than meaningful text or
/// code punctuation (`-`, `+`, `#`, `$`, `/`, `(`, `>`, etc.).
#[cfg(any(target_os = "macos", test))]
fn is_icon_symbol(ch: char) -> bool {
    if ch.is_alphanumeric() {
        return false;
    }
    !matches!(
        ch,
        '-' | '+'
            | '*'
            | '#'
            | '$'
            | '%'
            | '/'
            | '~'
            | '('
            | ')'
            | '['
            | ']'
            | '{'
            | '}'
            | '"'
            | '\''
            | '>'
            | '<'
            | '!'
            | '&'
            | '_'
            | '|'
            | '='
            | ':'
            | ';'
            | ','
            | '.'
            | '?'
            | '\\'
            | '€'
            | '£'
            | '¥'
    )
}

/// Whether `line` is a short UI label starting with a single-character token
/// followed by an alphanumeric word (e.g. `• Save`, `Q Search`, `v OK`),
/// excluding meaningful punctuation prefixes (`-`, `+`, `*`, `#`, `$`, `>`,
/// etc.).
#[cfg(any(target_os = "macos", test))]
fn is_short_icon_candidate(line: &OcrLine) -> bool {
    if line.words.len() < 2 || line.words.len() > 4 {
        return false;
    }
    let mut chars = line.words[0].text.chars();
    let Some(ch) = chars.next() else {
        return false;
    };
    if chars.next().is_some() {
        return false;
    }
    // Preserve meaningful non-alphanumeric prefixes such as `-`, `$`, `#`, `>`.
    if !ch.is_alphanumeric() && !is_icon_symbol(ch) {
        return false;
    }
    if !line.words[1]
        .text
        .chars()
        .next()
        .is_some_and(char::is_alphanumeric)
    {
        return false;
    }
    !line_looks_like_code(&line.text)
}

/// Whether word 0's bounding box or horizontal gap to word 1 marks it as a
/// leading icon glyph (wide/square icon box or unusually wide gap).
#[cfg(any(target_os = "macos", test))]
fn has_icon_box_geometry(line: &OcrLine) -> bool {
    let first = &line.words[0];
    let second = &line.words[1];
    if first.rect.height == 0 || second.rect.height == 0 || second.rect.width == 0 {
        return false;
    }
    let h = first.rect.height.max(second.rect.height) as f32;
    let gap = second.rect.x - (first.rect.x + first.rect.width as i32);
    if gap >= 6 && (gap as f32) >= h * 0.35 {
        return true;
    }
    let second_chars = second.text.chars().count().max(1) as f32;
    let avg_char_w = second.rect.width as f32 / second_chars;
    let aspect = first.rect.width as f32 / first.rect.height as f32;
    let width_ratio = first.rect.width as f32 / avg_char_w;
    aspect >= 1.15 || (aspect >= 0.95 && width_ratio >= 1.85)
}

/// Whether `chars` look like a real numbered or lettered list rather than
/// heterogeneous icon glyphs (e.g. all ASCII digits, or sequential letters).
#[cfg(any(target_os = "macos", test))]
fn is_list_markers(chars: &[char]) -> bool {
    if chars.len() < 2 {
        return false;
    }
    if chars.iter().all(|c| c.is_ascii_digit()) {
        return true;
    }
    chars
        .windows(2)
        .all(|w| (w[1] as u32) == (w[0] as u32) + 1 && w[0].is_ascii_alphabetic())
}

/// Checks whether candidate `lines[idx]` sits in a contiguous vertical icon
/// column next to sibling stacked short labels. Returns `Some(Some(label_x))`
/// when clean sibling labels anchor the text column, `Some(None)` for an
/// all-prefixed icon column, and `None` otherwise.
#[cfg(any(target_os = "macos", test))]
fn vertical_icon_column(idx: usize, lines: &[OcrLine]) -> Option<Option<i32>> {
    let line = &lines[idx];
    let first = &line.words[0];
    let second = &line.words[1];
    if line.rect.height == 0 {
        return None;
    }
    let h = i64::from(line.rect.height);
    let first_x = i64::from(first.rect.x);
    let second_x = i64::from(second.rect.x);
    let max_step_gap = (h * 3).max(40);

    // Collect every short label in the same horizontal column band, then walk
    // only the contiguous vertical stack around `idx` (consecutive gaps <= 3*h)
    // so separate sections or lists never contaminate one another.
    let mut column_items: Vec<(usize, bool)> = Vec::new();
    for (j, other) in lines.iter().enumerate() {
        if other.rect.height == 0 || other.words.is_empty() || other.words.len() > 4 {
            continue;
        }
        if other.rect.height * 2 < line.rect.height || line.rect.height * 2 < other.rect.height {
            continue;
        }
        if j == idx {
            column_items.push((j, true));
            continue;
        }
        if is_short_icon_candidate(other) {
            let o_first_x = i64::from(other.words[0].rect.x);
            let o_second_x = i64::from(other.words[1].rect.x);
            if (o_first_x - first_x).abs() <= (h / 2).max(8)
                && (o_second_x - second_x).abs() <= h.max(16)
            {
                column_items.push((j, true));
            }
        } else {
            let o_x = i64::from(other.rect.x);
            let shift = o_x - first_x;
            if shift >= (h * 3) / 5
                && shift <= (h * 7) / 2
                && (second_x - o_x).abs() < (first_x - o_x).abs()
            {
                column_items.push((j, false));
            }
        }
    }

    column_items.sort_by_key(|&(j, _)| (lines[j].rect.y, lines[j].rect.x));
    let pos = column_items.iter().position(|&(j, _)| j == idx)?;

    let mut start = pos;
    while start > 0 {
        let prev = &lines[column_items[start - 1].0];
        let curr = &lines[column_items[start].0];
        let gap = i64::from(curr.rect.y) - (i64::from(prev.rect.y) + i64::from(prev.rect.height));
        if gap > max_step_gap {
            break;
        }
        start -= 1;
    }
    let mut end = pos + 1;
    while end < column_items.len() {
        let prev = &lines[column_items[end - 1].0];
        let curr = &lines[column_items[end].0];
        let gap = i64::from(curr.rect.y) - (i64::from(prev.rect.y) + i64::from(prev.rect.height));
        if gap > max_step_gap {
            break;
        }
        end += 1;
    }

    let mut clean_label_xs: Vec<i32> = Vec::new();
    let mut aligned_candidates: Vec<usize> = Vec::new();
    for &(j, is_cand) in &column_items[start..end] {
        if j != idx {
            let line_top = i64::from(line.rect.y);
            let line_bottom = line_top + h;
            let o_top = i64::from(lines[j].rect.y);
            let o_bottom = o_top + i64::from(lines[j].rect.height);
            let overlap_y = (line_bottom.min(o_bottom) - line_top.max(o_top)).max(0);
            if overlap_y * 2 >= i64::from(line.rect.height.min(lines[j].rect.height)) {
                continue;
            }
        }
        if is_cand {
            aligned_candidates.push(j);
        } else {
            clean_label_xs.push(lines[j].rect.x);
        }
    }

    if !clean_label_xs.is_empty() {
        clean_label_xs.sort_unstable();
        let median_x = clean_label_xs[clean_label_xs.len() / 2];
        if clean_label_xs.len() >= 2 || aligned_candidates.len() >= 2 {
            return Some(Some(median_x));
        }
    }

    if aligned_candidates.len() >= 3 {
        let chars: Vec<char> = aligned_candidates
            .iter()
            .filter_map(|&j| lines[j].words[0].text.chars().next())
            .collect();
        let has_strong_icon = aligned_candidates.iter().any(|&j| {
            lines[j].words[0]
                .text
                .chars()
                .next()
                .is_some_and(is_icon_symbol)
                || has_icon_box_geometry(&lines[j])
        });
        if has_strong_icon && !is_list_markers(&chars) {
            return Some(None);
        }
    }

    None
}

/// Strips stray leading icon glyphs (such as `•`, `@`, `§`, `o`, `Q`, `v`, `1`)
/// attached to short UI labels, updating each stripped line's text, words, and
/// bounding box.
#[cfg(any(target_os = "macos", test))]
fn strip_leading_icons(mut lines: Vec<OcrLine>) -> Vec<OcrLine> {
    let mut decisions: Vec<Option<Option<i32>>> = Vec::with_capacity(lines.len());
    for idx in 0..lines.len() {
        let line = &lines[idx];
        if !is_short_icon_candidate(line) {
            decisions.push(None);
            continue;
        }
        let Some(ch) = line.words[0].text.chars().next() else {
            decisions.push(None);
            continue;
        };
        let column = vertical_icon_column(idx, &lines);
        let is_common_word = matches!(ch, 'a' | 'A' | 'I');
        let strip = if is_icon_symbol(ch) {
            true
        } else if is_common_word {
            column.is_some()
        } else {
            column.is_some() || has_icon_box_geometry(line)
        };
        if strip {
            decisions.push(Some(column.flatten()));
        } else {
            decisions.push(None);
        }
    }

    for (line, decision) in lines.iter_mut().zip(decisions) {
        let Some(anchor_x) = decision else {
            continue;
        };
        if line.words.len() < 2 {
            continue;
        }
        let removed = line.words.remove(0);
        if let Some(rest) = line.text.strip_prefix(&removed.text) {
            line.text = rest.trim_start().to_owned();
        } else {
            line.text = line
                .words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
        }
        let mut rect = words_union(&line.words);
        // Vision linearly interpolates `boundingBoxForRange` across a line, so
        // word 1's box can start left of clean sibling labels when an icon sat
        // before it. Clamp its left edge to the sibling label column if it
        // still leaves a positive width so `lines_text` does not infer bogus
        // indentation on the clean siblings.
        if let Some(label_x) = anchor_x
            && rect.x < label_x
            && rect.x + rect.width as i32 > label_x
        {
            let shift = (label_x - rect.x) as u32;
            rect.x = label_x;
            rect.width = rect.width.saturating_sub(shift);
        }
        line.rect = rect;
    }

    lines
}

/// Smallest box holding every word in `words`.
#[cfg(any(target_os = "macos", test))]
fn words_union(words: &[crate::ocr::OcrWord]) -> Rect {
    let Some(first) = words.first() else {
        return Rect {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
    };
    let mut left = first.rect.x;
    let mut top = first.rect.y;
    let mut right = i64::from(first.rect.x) + i64::from(first.rect.width);
    let mut bottom = i64::from(first.rect.y) + i64::from(first.rect.height);
    for word in &words[1..] {
        left = left.min(word.rect.x);
        top = top.min(word.rect.y);
        right = right.max(i64::from(word.rect.x) + i64::from(word.rect.width));
        bottom = bottom.max(i64::from(word.rect.y) + i64::from(word.rect.height));
    }
    Rect {
        x: left,
        y: top,
        width: (right - i64::from(left)).max(0) as u32,
        height: (bottom - i64::from(top)).max(0) as u32,
    }
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

    use super::{
        filter_structural_lines, is_code_like, keep_candidate, merge_tiles, pick_languages,
        pixel_rect, reading_order, should_upscale, strip_leading_icons, tile_lines, tiles,
        word_ranges,
    };
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
    /// tile by tile and put back into reading order.
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
        Ok(reading_order(merge_tiles(lines)))
    }

    /// The lines in `image`, read with Vision: compact crops are upscaled 2x
    /// (with boxes mapped back into the original image's pixels), and blocks
    /// that look like code are retried without language correction.
    fn recognize_one(image: &RgbImage) -> Result<Vec<OcrLine>, String> {
        let orig_size = image.dimensions();
        let upscaled;
        let source = if should_upscale(orig_size) {
            upscaled = image::imageops::resize(
                image,
                orig_size.0 * 2,
                orig_size.1 * 2,
                image::imageops::FilterType::CatmullRom,
            );
            &upscaled
        } else {
            image
        };
        let cg_image = cg_image(source)?;

        let first = run_text_request(&cg_image, orig_size, true)?;
        let lines = if is_code_like(&first) {
            match run_text_request(&cg_image, orig_size, false) {
                Ok(raw) if !raw.is_empty() => raw,
                _ => first,
            }
        } else {
            first
        };
        Ok(strip_leading_icons(lines))
    }

    /// Runs one `VNRecognizeTextRequest` on `cg_image`, mapping normalised
    /// boxes into `orig_size` pixels and filtering 1-character structural
    /// candidates against neighbouring line boxes.
    fn run_text_request(
        cg_image: &CGImage,
        orig_size: (u32, u32),
        use_language_correction: bool,
    ) -> Result<Vec<OcrLine>, String> {
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(use_language_correction);
        if let Some(languages) = languages(&request) {
            request.setRecognitionLanguages(&languages);
        }

        // SAFETY: a fresh handler over a valid image, with no options.
        let handler = unsafe {
            VNImageRequestHandler::initWithCGImage_options(
                VNImageRequestHandler::alloc(),
                cg_image,
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
            let confidence = candidate.confidence();
            if !keep_candidate(text, confidence) {
                continue;
            }
            // SAFETY: a plain property read on a finished observation.
            let rect = to_pixels(unsafe { observation.boundingBox() }, orig_size);
            let words = word_ranges(&full)
                .into_iter()
                .map(|(word, start, length)| OcrWord {
                    text: word.to_owned(),
                    rect: word_box(&candidate, start, length)
                        .map_or(rect, |found| to_pixels(found, orig_size)),
                })
                .collect();
            lines.push(OcrLine {
                text: text.to_owned(),
                rect,
                words,
            });
        }
        Ok(filter_structural_lines(lines))
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
        let kept = merge_tiles(tile_lines(vec![boxed("Newest", 100, 20, 60, 10)], &tile));
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
        let mut lines = tile_lines(from_first, &first);
        lines.extend(tile_lines(from_second, &second));
        assert_eq!(merge_tiles(lines).len(), 1);
    }

    #[test]
    fn a_line_on_a_seam_is_kept_once_however_each_tile_measures_it() {
        let spans = spans(9000);
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
        let spans = spans(9000);
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
        // Tiles overlapping by the least they may, their cores meeting
        // halfway through the overlap.
        let tile = |x: i32, core: (u32, u32, u32, u32)| Tile {
            rect: Rect {
                x,
                y: 0,
                width: MAX_TILE,
                height: 400,
            },
            core,
        };
        let seam = MAX_TILE - TILE_OVERLAP / 2;
        let first = tile(0, (0, seam, 0, 400));
        let second = tile((MAX_TILE - TILE_OVERLAP) as i32, (seam, 8000, 0, 400));
        // A line from 4000 to 4200: the first tile's edge cuts it at 4096,
        // which puts the centre of what it reads just past its core.
        let mut lines = tile_lines(vec![boxed("pine", 4000, 40, 96, 12)], &first);
        assert_eq!(lines.len(), 1);
        lines.extend(tile_lines(
            vec![boxed("pineapple", 4000 - second.rect.x, 40, 200, 12)],
            &second,
        ));
        let kept = merge_tiles(lines);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(kept[0].text, "pineapple");
    }

    #[test]
    fn lines_from_side_by_side_tiles_read_top_to_bottom() {
        let spans = spans(6400);
        let make = |(x, w, left, right): (u32, u32, u32, u32)| Tile {
            rect: Rect {
                x: x as i32,
                y: 0,
                width: w,
                height: 3600,
            },
            core: (left, right, 0, 3600),
        };
        let (left, right) = (make(spans[0]), make(spans[1]));
        let at = |tile: &Tile, text: &str, image_x: i32, y: i32| {
            boxed(text, image_x - tile.rect.x, y, 80, 20)
        };
        // Each tile reads its own lines top to bottom, as Vision does.
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
                at(&right, "Newest", 6000, 39),
                at(&right, "Assignee", 6000, 200),
            ],
            &right,
        ));
        let text: Vec<String> = reading_order(merge_tiles(lines))
            .into_iter()
            .map(|line| line.text)
            .collect();
        assert_eq!(text, ["New issue", "Labels", "Newest", "Assignee"]);
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

    fn line_with_words(text: &str, words: &[(&str, i32, i32, u32, u32)]) -> OcrLine {
        let ocr_words: Vec<crate::ocr::OcrWord> = words
            .iter()
            .map(|&(w, x, y, width, height)| crate::ocr::OcrWord {
                text: w.to_owned(),
                rect: Rect {
                    x,
                    y,
                    width,
                    height,
                },
            })
            .collect();
        let rect = words_union(&ocr_words);
        OcrLine {
            text: text.to_owned(),
            rect,
            words: ocr_words,
        }
    }

    #[test]
    fn upscale_applies_only_to_compact_non_empty_crops() {
        assert!(should_upscale((1544, 654)));
        assert!(should_upscale((1664, 706)));
        assert!(should_upscale((UPSCALE_MAX_EDGE, UPSCALE_MAX_EDGE)));
        assert!(!should_upscale((3360, 1890)));
        assert!(!should_upscale((0, 100)));
        assert!(!should_upscale((100, 0)));
    }

    #[test]
    fn code_detection_separates_code_from_ui_and_prose() {
        let code = vec![
            boxed("fn load_config(path: &std::path::Path) {", 67, 70, 800, 33),
            boxed("let items = vec![\"--dry-run\"];", 99, 110, 500, 33),
            boxed("return Ok(items);", 99, 150, 300, 33),
        ];
        assert!(is_code_like(&code));

        let ui = vec![
            boxed(
                "Status: Active (98.5% uptime) — @ops-team #release-2026",
                69,
                71,
                632,
                26,
            ),
            boxed("Export CSV (UTF-8) — 12.5% faster", 98, 264, 407, 26),
            boxed(
                "Filter: status:open, tag:#ocr-test & author:@alex",
                98,
                319,
                549,
                34,
            ),
            boxed(
                "Path: /Users/demo/notes — 3 items (100% synced)",
                64,
                550,
                625,
                34,
            ),
        ];
        assert!(!is_code_like(&ui));

        let prose = vec![
            boxed("Grab-it reads screenshots locally.", 69, 73, 500, 32),
            boxed("Keeping paragraph breaks intact helps.", 69, 117, 520, 31),
        ];
        assert!(!is_code_like(&prose));
    }

    #[test]
    fn structural_lines_are_kept_when_aligned_and_dropped_when_isolated() {
        let kept = filter_structural_lines(vec![
            boxed("fn demo() {", 67, 70, 200, 32),
            boxed("if ready {", 99, 110, 180, 32),
            boxed("work();", 131, 150, 120, 32),
            boxed("}", 99, 190, 16, 32),
            boxed("}", 67, 230, 16, 32),
            // Isolated stray punctuation far away from the block.
            boxed(";", 900, 900, 12, 30),
            // Oversized border glyph.
            boxed("]", 67, 270, 120, 120),
        ]);
        let texts: Vec<&str> = kept.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["fn demo() {", "if ready {", "work();", "}", "}"]);

        // Without any non-structural anchor lines, lone structural noise drops.
        assert!(filter_structural_lines(vec![boxed("}", 50, 50, 16, 30)]).is_empty());
        assert!(keep_candidate("}", 0.3));
        assert!(!keep_candidate("}", 0.29));
        assert!(!keep_candidate("x", 1.0));
    }

    #[test]
    fn icon_stripping_removes_leading_glyphs_without_touching_real_labels() {
        let stripped = strip_leading_icons(vec![
            // Symbol prefixes on toolbar buttons.
            line_with_words(
                "• Save",
                &[("•", 97, 81, 24, 31), ("Save", 124, 81, 79, 32)],
            ),
            line_with_words(
                "@ Share link",
                &[
                    ("@", 278, 83, 21, 30),
                    ("Share", 302, 83, 88, 30),
                    ("link", 393, 83, 49, 30),
                ],
            ),
            // Wide icon box read as lowercase `o`.
            line_with_words(
                "o Settings",
                &[("o", 515, 84, 38, 28), ("Settings", 555, 84, 112, 28)],
            ),
            // Vertical SVG icon column beside clean sibling labels.
            boxed("Save", 147, 249, 59, 23),
            boxed("Share link", 147, 313, 122, 24),
            boxed("Settings", 145, 375, 106, 27),
            line_with_words(
                "Q Search",
                &[("Q", 102, 436, 25, 29), ("Search", 129, 436, 105, 29)],
            ),
            line_with_words("v OK", &[("v", 104, 506, 17, 22), ("OK", 123, 506, 63, 22)]),
            // Wide gap between icon digit and label.
            line_with_words(
                "1 Save",
                &[("1", 731, 252, 10, 19), ("Save", 750, 251, 65, 20)],
            ),
        ]);
        let texts: Vec<&str> = stripped.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "Save",
                "Share link",
                "Settings",
                "Save",
                "Share link",
                "Settings",
                "Search",
                "OK",
                "Save",
            ]
        );
        // Word 0 and line rect updated for stripped lines.
        assert_eq!(stripped[0].words.len(), 1);
        assert_eq!(stripped[0].words[0].text, "Save");
        assert_eq!(stripped[0].rect.x, 124);

        // Real short labels and numbered lists stay intact.
        let preserved = strip_leading_icons(vec![
            line_with_words(
                "I agree",
                &[("I", 40, 20, 8, 24), ("agree", 52, 20, 65, 24)],
            ),
            line_with_words("A note", &[("A", 40, 60, 14, 24), ("note", 58, 60, 52, 24)]),
            line_with_words(
                "- Save",
                &[("-", 40, 100, 10, 24), ("Save", 54, 100, 56, 24)],
            ),
            line_with_words(
                "1 First",
                &[("1", 40, 200, 12, 24), ("First", 56, 200, 54, 24)],
            ),
            line_with_words(
                "2 Second",
                &[("2", 40, 240, 12, 24), ("Second", 56, 240, 74, 24)],
            ),
            line_with_words(
                "3 Third",
                &[("3", 40, 280, 12, 24), ("Third", 56, 280, 60, 24)],
            ),
        ]);
        let kept_texts: Vec<&str> = preserved.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(
            kept_texts,
            [
                "I agree", "A note", "- Save", "1 First", "2 Second", "3 Third"
            ]
        );

        // Vertical dash bullets and shell prompts with wide gaps stay intact.
        let bullets_and_prompts = strip_leading_icons(vec![
            line_with_words("- Save", &[("-", 40, 20, 10, 24), ("Save", 62, 20, 56, 24)]),
            line_with_words(
                "- Share link",
                &[
                    ("-", 40, 60, 10, 24),
                    ("Share", 62, 60, 64, 24),
                    ("link", 130, 60, 40, 24),
                ],
            ),
            line_with_words(
                "- Settings",
                &[("-", 40, 100, 10, 24), ("Settings", 62, 100, 88, 24)],
            ),
            line_with_words("$ ls", &[("$", 40, 200, 12, 24), ("ls", 64, 200, 24, 24)]),
            line_with_words("$ pwd", &[("$", 40, 240, 12, 24), ("pwd", 64, 240, 36, 24)]),
            line_with_words("$ id", &[("$", 40, 280, 12, 24), ("id", 64, 280, 24, 24)]),
        ]);
        let kept_bp: Vec<&str> = bullets_and_prompts
            .iter()
            .map(|l| l.text.as_str())
            .collect();
        assert_eq!(
            kept_bp,
            [
                "- Save",
                "- Share link",
                "- Settings",
                "$ ls",
                "$ pwd",
                "$ id"
            ]
        );
    }

    #[test]
    fn reading_order_keeps_header_row_above_two_multiline_columns() {
        let lines = vec![
            boxed("Right Two", 600, 140, 120, 24),
            boxed("Toolbar Right", 400, 20, 120, 24),
            boxed("Left Two", 40, 140, 120, 24),
            boxed("Right One", 600, 100, 120, 24),
            boxed("Toolbar Left", 40, 20, 120, 24),
            boxed("Left One", 40, 100, 120, 24),
        ];
        let ordered: Vec<String> = reading_order(lines).into_iter().map(|l| l.text).collect();
        assert_eq!(
            ordered,
            [
                "Toolbar Left",
                "Toolbar Right",
                "Left One",
                "Left Two",
                "Right One",
                "Right Two",
            ]
        );

        // Full-width banner tightly above two columns (normal line spacing).
        let with_banner = vec![
            boxed("Full Width Banner Across Columns", 40, 20, 680, 24),
            boxed("Right Two", 600, 96, 120, 24),
            boxed("Left One", 40, 60, 120, 24),
            boxed("Right One", 600, 60, 120, 24),
            boxed("Left Two", 40, 96, 120, 24),
        ];
        let ordered_banner: Vec<String> = reading_order(with_banner)
            .into_iter()
            .map(|l| l.text)
            .collect();
        assert_eq!(
            ordered_banner,
            [
                "Full Width Banner Across Columns",
                "Left One",
                "Left Two",
                "Right One",
                "Right Two",
            ]
        );
    }

    #[cfg(target_os = "macos")]
    fn fixture_image(name: &str) -> RgbImage {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name);
        image::open(path).unwrap().into_rgb8()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vision_reads_small_ui_fixture_cleanly() {
        let image = fixture_image("ocr-small-ui.png");
        let Some(res) = read(&image) else {
            return;
        };
        let text = crate::ocr::lines_text(&res.unwrap());
        assert!(text.contains("100% synced"), "small UI read:\n{text}");
        assert!(!text.contains("svnced"), "small UI read:\n{text}");
        assert!(!text.contains("….."), "malformed ellipsis:\n{text}");
        assert!(text.contains("Confirm & Save"), "small UI read:\n{text}");
        assert!(text.contains("Cancel (Esc)"), "small UI read:\n{text}");
        assert!(
            text.contains("More options…") || text.contains("More options..."),
            "small UI read:\n{text}"
        );
        // Distinct button labels stay on separate lines.
        assert!(
            !text.contains("Confirm & Save Cancel (Esc)"),
            "buttons collapsed onto one line:\n{text}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vision_reads_dark_code_fixture_with_lines_braces_and_indent() {
        let image = fixture_image("ocr-dark-code.png");
        let Some(res) = read(&image) else {
            return;
        };
        let text = crate::ocr::lines_text(&res.unwrap());
        assert!(
            text.contains("--dry-run") && text.contains("--max-width=1280"),
            "missing line 2:\n{text}"
        );
        assert!(
            text.contains("if !items.is_empty() {"),
            "if line split or mangled:\n{text}"
        );
        let standalone_braces = text.lines().filter(|line| line.trim() == "}").count();
        assert!(
            standalone_braces >= 3,
            "closing braces dropped ({standalone_braces}):\n{text}"
        );
        let indented_lines = text
            .lines()
            .filter(|line| line.starts_with("  ") && !line.trim().is_empty())
            .count();
        assert!(
            indented_lines >= 5,
            "indentation lost ({indented_lines}):\n{text}"
        );
        assert!(
            text.contains("check.sh") && text.contains("--strict"),
            "missing terminal prompt:\n{text}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vision_reads_two_columns_fixture_with_column_break() {
        let image = fixture_image("ocr-two-columns.png");
        let Some(res) = read(&image) else {
            return;
        };
        let text = crate::ocr::lines_text(&res.unwrap());
        let left_pos = text.find("Third line finishes the left block.");
        let right_pos = text.find("Right Column Heading");
        assert!(
            left_pos.is_some() && right_pos.is_some() && left_pos < right_pos,
            "columns out of order:\n{text}"
        );
        assert!(
            text.contains("Third line finishes the left block.\n\nRight Column Heading"),
            "missing blank line between columns:\n{text}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vision_reads_two_paragraphs_fixture_with_blank_line() {
        let image = fixture_image("ocr-two-paragraphs.png");
        let Some(res) = read(&image) else {
            return;
        };
        let text = crate::ocr::lines_text(&res.unwrap());
        assert!(
            text.contains("documents.\n\nThis second paragraph"),
            "missing blank line between paragraphs:\n{text}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vision_reads_svg_icons_fixture_without_stray_icon_glyphs() {
        let image = fixture_image("ocr-svg-icons.png");
        let Some(res) = read(&image) else {
            return;
        };
        let text = crate::ocr::lines_text(&res.unwrap());
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(
            lines,
            ["Save", "Share link", "Settings", "Search", "OK"],
            "SVG icon list had stray glyphs:\n{text}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vision_reads_icons_toolbar_fixture_without_stray_glyphs() {
        let image = fixture_image("ocr-icons-toolbar.png");
        let Some(res) = read(&image) else {
            return;
        };
        let text = crate::ocr::lines_text(&res.unwrap());
        for bad in [
            "• Save",
            "@ Share link",
            "o Settings",
            "§ Settings",
            "Q Search",
            "v OK",
            "1 Save",
        ] {
            assert!(!text.contains(bad), "stray icon glyph {bad:?} in:\n{text}");
        }
        for expected in ["Save", "Share link", "Settings", "Search", "OK", "Delete"] {
            assert!(text.contains(expected), "missing {expected:?} in:\n{text}");
        }
    }
}
