//! Joins scrolled frames into one long image by following what moves.
//!
//! Each frame is cut into strips across the scroll axis. Every strip votes
//! for how far its rows moved; the largest group of strips that agree is the
//! page, and the rest (sidebars, sticky headers, a changing tab title) count
//! as fixed for that pair. Frames are placed on a canvas by position, so every
//! row of the page is written once.
use image::{Rgba, RgbaImage, imageops};
use std::{collections::HashMap, sync::Arc};

pub const MAX_LENGTH: u32 = 30_000;
const STRIPS: u32 = 48;
/// A strip needs this many feature rows to vote or to count as fixed.
const TEXTURED: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Axis {
    Vertical,
    Horizontal,
}
fn other(a: Axis) -> Axis {
    if a == Axis::Vertical {
        Axis::Horizontal
    } else {
        Axis::Vertical
    }
}
pub(crate) fn length(i: &RgbaImage, a: Axis) -> u32 {
    if a == Axis::Vertical {
        i.height()
    } else {
        i.width()
    }
}
pub(crate) fn pixel(i: &RgbaImage, a: Axis, along: u32, across: u32) -> &Rgba<u8> {
    if a == Axis::Vertical {
        i.get_pixel(across, along)
    } else {
        i.get_pixel(along, across)
    }
}
fn dims(axis: Axis, across: u32, along: u32) -> (u32, u32) {
    if axis == Axis::Vertical {
        (across, along)
    } else {
        (along, across)
    }
}
fn strip_count(image: &RgbaImage, axis: Axis) -> u32 {
    STRIPS.min(length(image, other(axis))).max(1)
}
/// The span across the axis that strip `s` of `strips` covers.
fn strip_span(cross: u32, strips: u32, s: u32) -> (u32, u32) {
    (s * cross / strips, (s + 1) * cross / strips)
}

/// One hash per (strip, row along the axis): `sig[strip][row]`.
fn signatures(image: &RgbaImage, axis: Axis) -> Vec<Vec<u64>> {
    let n = length(image, axis);
    let cross = length(image, other(axis));
    let strips = strip_count(image, axis);
    let w = image.width() as usize;
    let raw = image.as_raw();
    (0..strips)
        .map(|s| {
            let (c0, c1) = strip_span(cross, strips, s);
            (0..n)
                .map(|p| {
                    let mut hash = 0xcbf2_9ce4_8422_2325u64;
                    for c in c0..c1 {
                        let (x, y) = if axis == Axis::Vertical {
                            (c, p)
                        } else {
                            (p, c)
                        };
                        let i = (y as usize * w + x as usize) * 4;
                        for k in 0..3 {
                            hash = (hash ^ u64::from(raw[i + k])).wrapping_mul(0x100_0000_01b3);
                        }
                    }
                    hash
                })
                .collect()
        })
        .collect()
}

#[derive(Debug, Clone)]
struct Match {
    /// Rows the content moved toward the start by (negative: toward the end).
    offset: i64,
    head: u32,
    tail: u32,
    /// Rows at the end of the reference frame the page moved away from that
    /// do not line up with the new frame: a window's translucent outline, a
    /// fade or a sticky bar drawn over the page.
    edge: u32,
    /// Textured strips that stayed where they were while the page moved.
    fixed: Vec<bool>,
    /// Strips with enough feature rows to vote.
    textured: Vec<bool>,
    support: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Miss {
    /// The frame shows the same content where it was: the page has stopped.
    Still,
    /// Something moved, but no offset explains it.
    Lost,
}

/// Finds how far `next` scrolled from `last`. `hint` is the step that was
/// asked for (automatic mode), used only to break ties.
fn estimate(last: &[Vec<u64>], next: &[Vec<u64>], hint: Option<i64>) -> Result<Match, Miss> {
    let strips = last.len();
    let h = last.first().map_or(0, Vec::len);
    if strips == 0 || h < 2 || next.len() != strips {
        return Err(Miss::Lost);
    }
    let max = (h * 3 / 4) as i64;
    // A feature is a row that differs from the row before it, keyed by both:
    // text edges, rules, and the boundary between two plain bands.
    let key = |sig: &[u64], y: usize| (sig[y - 1], sig[y]);
    let mut votes: HashMap<i64, u32> = HashMap::new();
    let mut per_strip: Vec<HashMap<i64, u32>> = vec![HashMap::new(); strips];
    let mut features: Vec<Vec<usize>> = vec![vec![]; strips];
    for s in 0..strips {
        let mut rows: HashMap<(u64, u64), Vec<u32>> = HashMap::new();
        for y in 1..h {
            if last[s][y] != last[s][y - 1] {
                rows.entry(key(&last[s], y)).or_default().push(y as u32);
            }
        }
        for y in 1..h {
            if next[s][y] == next[s][y - 1] {
                continue;
            }
            features[s].push(y);
            let Some(found) = rows.get(&key(&next[s], y)) else {
                continue;
            };
            if found.len() > 4 {
                continue;
            }
            for &from in found {
                let d = i64::from(from) - y as i64;
                if d.abs() <= max {
                    *per_strip[s].entry(d).or_default() += 1;
                    if d != 0 {
                        *votes.entry(d).or_default() += 1;
                    }
                }
            }
        }
    }
    // Each strip names the offset most of its features moved by. Strips
    // agree in groups: the page, and anything that moves differently or not
    // at all (sidebars, a banner scrolling away, a sticky header).
    let best: Vec<Option<(i64, u32)>> = (0..strips)
        .map(|s| {
            per_strip[s]
                .iter()
                .filter(|(d, c)| **d != 0 && **c >= 6)
                .max_by(|a, b| a.1.cmp(b.1).then(b.0.abs().cmp(&a.0.abs())))
                .map(|(d, c)| (*d, *c))
        })
        .collect();
    let stay = |s: usize| *per_strip[s].get(&0).unwrap_or(&0);
    let follows = |s: usize, offset: i64| {
        best[s].is_some_and(|(d, c)| (d - offset).abs() <= 1 && c * 3 > stay(s))
    };
    let textured: Vec<bool> = (0..strips).map(|s| features[s].len() >= TEXTURED).collect();
    let textured_count = textured.iter().filter(|t| **t).count();
    let needed = 2
        .max((textured_count as f64 * 0.08).ceil() as usize)
        .min(strips);
    let mut groups: Vec<(i64, usize, u32)> = vec![];
    for (s, strip_best) in best.iter().enumerate() {
        if let Some((d, _)) = strip_best.filter(|(d, _)| follows(s, *d))
            && !groups.iter().any(|g| g.0 == d)
        {
            let members = (0..strips).filter(|&t| follows(t, d)).count();
            let rows = *votes.get(&d).unwrap_or(&0);
            groups.push((d, members, rows));
        }
    }
    groups.retain(|g| g.1 >= needed && g.2 >= 24);
    groups.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.abs().cmp(&a.0.abs())));
    #[derive(PartialEq)]
    enum Why {
        Vote,
        Hint,
        Pooled,
        HintOnly,
    }
    let mut why = Why::Vote;
    let mut chosen = groups.first().copied();
    // Ties go to the automatic step asked for: a group near it wins only
    // when it has nearly as many strips as the largest one. Its rival is
    // then that near-equal group, so the ambiguity check is skipped.
    let top_members = groups.first().map_or(0, |g| g.1);
    if let Some(hint) = hint
        && let Some(g) = groups
            .iter()
            .find(|g| (g.0 - hint).abs() <= 2 && g.1 * 5 >= top_members * 4)
    {
        if Some(g.0) != chosen.map(|c| c.0) {
            why = Why::Hint;
        }
        chosen = Some(*g);
    }
    let still: u32 = (0..strips).map(stay).sum();
    // Sparse pages: no strip has enough features of its own, but together
    // they can still agree (the edge between two plain bands).
    if chosen.is_none() {
        let mut ranked: Vec<(i64, u32)> = votes
            .iter()
            .map(|(d, c)| (*d, *c))
            .filter(|(_, c)| *c >= 24)
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.abs().cmp(&a.0.abs())));
        let near = hint.and_then(|hint| {
            ranked
                .iter()
                .find(|(d, c)| (d - hint).abs() <= 2 && *c * 10 >= ranked[0].1 * 6)
        });
        if let Some(&(d, c)) = near.or(ranked.first())
            && still <= c * 3
        {
            chosen = Some((d, 0, c));
            why = Why::Pooled;
        }
    }
    let offset = match chosen {
        Some((offset, _, _)) => offset,
        None => {
            let moved: u32 = votes.values().copied().max().unwrap_or(0);
            // Still only when the textured strips mostly stayed: a blinking
            // caret or an animation is still, a page that jumped too far is not.
            let changed = (0..strips)
                .filter(|&s| textured[s] && (stay(s) as usize) * 2 < features[s].len())
                .count();
            if still > moved * 3 && still >= 24 && changed < needed {
                return Err(Miss::Still);
            }
            // Nothing to vote with (a plain band): the step asked for stands
            // if every row agrees with it.
            let Some(hint) = hint.filter(|h| *h != 0) else {
                return Err(Miss::Lost);
            };
            let (mut hit, mut total) = (0u64, 0u64);
            for (last_strip, next_strip) in last.iter().zip(next) {
                for (y, row) in next_strip.iter().enumerate() {
                    let from = y as i64 + hint;
                    if from >= 0 && (from as usize) < h {
                        total += 1;
                        hit += u64::from(last_strip[from as usize] == *row);
                    }
                }
            }
            if total == 0 || hit * 100 < total * 99 {
                return Err(Miss::Lost);
            }
            why = Why::HintOnly;
            hint
        }
    };
    // Textured strips that do not follow the page are fixed for this pair.
    let fixed: Vec<bool> = (0..strips)
        .map(|s| {
            if why == Why::Pooled {
                let with = *per_strip[s].get(&offset).unwrap_or(&0);
                textured[s] && stay(s) as usize * 2 > features[s].len() && with * 5 < stay(s)
            } else {
                why != Why::HintOnly && textured[s] && !follows(s, offset)
            }
        })
        .collect();
    let moving: Vec<usize> = (0..strips).filter(|&s| !fixed[s]).collect();
    if moving.is_empty() {
        return Err(Miss::Lost);
    }
    if why == Why::Vote {
        let rows = |d: i64| {
            moving
                .iter()
                .map(|&s| *per_strip[s].get(&d).unwrap_or(&0))
                .sum::<u32>()
        };
        let mine = rows(offset);
        let rival = groups
            .iter()
            .filter(|g| (g.0 - offset).abs() > 1)
            .map(|g| rows(g.0))
            .max()
            .unwrap_or(0);
        if f64::from(rival) > f64::from(mine) * 0.8 {
            return Err(Miss::Lost);
        }
    }
    let same = |y: usize| {
        let equal = moving.iter().filter(|&&s| last[s][y] == next[s][y]).count();
        equal * 20 >= moving.len() * 19
    };
    let head = (0..h).take_while(|&y| same(y)).count();
    let tail = (0..h - head).take_while(|&y| same(h - 1 - y)).count();
    // Verify on features only: plain rows agree with any offset.
    let (mut hit, mut total) = (0u64, 0u64);
    for &s in &moving {
        for &y in &features[s] {
            let from = y as i64 + offset;
            if y < head || y >= h - tail || from < head as i64 + 1 || from >= (h - tail) as i64 {
                continue;
            }
            total += 1;
            hit += u64::from(key(&last[s], from as usize) == key(&next[s], y));
        }
    }
    let support = if total == 0 {
        1.0
    } else {
        hit as f64 / total as f64
    };
    // Under 60% of the moving strips' feature rows lining up is a guess.
    if support < 0.6 {
        return Err(Miss::Lost);
    }
    let edge = unmatched_rows(last, next, offset, offset > 0, &moving);
    Ok(Match {
        offset,
        head: head as u32,
        tail: tail as u32,
        edge: edge.min(h / 8) as u32,
        fixed,
        textured,
        support,
    })
}

/// What one frame did to the stitched image.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Push {
    /// The frame added new rows.
    Grew,
    /// The frame lined up but showed nothing new (scrolled back).
    Placed,
    /// The content did not move.
    Still,
    /// Something moved, but the frame could not be placed.
    Lost,
    /// The image has reached its length limit.
    Capped,
}

/// The most common colour of each strip, read from one frame.
fn strip_colours(image: &RgbaImage, axis: Axis) -> Vec<Rgba<u8>> {
    let n = length(image, axis);
    let cross = length(image, other(axis));
    let strips = strip_count(image, axis);
    (0..strips)
        .map(|s| {
            let (c0, c1) = strip_span(cross, strips, s);
            let mut counts: HashMap<[u8; 4], u32> = HashMap::new();
            for p in (0..n).step_by((n / 256).max(1) as usize) {
                for c in c0..c1 {
                    let (x, y) = if axis == Axis::Vertical {
                        (c, p)
                    } else {
                        (p, c)
                    };
                    *counts.entry(image.get_pixel(x, y).0).or_default() += 1;
                }
            }
            Rgba(
                counts
                    .into_iter()
                    .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
                    .map_or([0, 0, 0, 255], |(c, _)| c),
            )
        })
        .collect()
}

/// Rows at one end of `reference` (its end when `at_end`) that do not line
/// up with `next` placed `offset` rows further along: a held window's
/// outline, which is not the page. Only the `moving` strips are compared.
fn unmatched_rows(
    reference: &[Vec<u64>],
    next: &[Vec<u64>],
    offset: i64,
    at_end: bool,
    moving: &[usize],
) -> usize {
    let h = reference.first().map_or(0, Vec::len);
    let lines_up = |y: usize| {
        let from = y as i64 - offset;
        (0..h as i64).contains(&from) && {
            let from = from as usize;
            let equal = moving
                .iter()
                .filter(|&&s| reference[s][y] == next[s][from])
                .count();
            equal * 20 >= moving.len() * 19
        }
    };
    if at_end {
        (0..h).rev().take_while(|&y| !lines_up(y)).count()
    } else {
        (0..h).take_while(|&y| !lines_up(y)).count()
    }
}

/// Rows at one end of `image` (its end when `at_end`) where its outermost
/// pixels across the axis leave the colour they keep along the rest of
/// their length: a held window's rounded corners, showing the desktop.
fn corner_rows(image: &RgbaImage, axis: Axis, at_end: bool) -> u32 {
    let n = length(image, axis);
    let cross = length(image, other(axis));
    if n == 0 || cross < 2 {
        return 0;
    }
    let sides = [0, cross - 1];
    let mut modes = vec![];
    for c in sides {
        let mut counts: HashMap<[u8; 4], u32> = HashMap::new();
        for p in 0..n {
            *counts.entry(pixel(image, axis, p, c).0).or_default() += 1;
        }
        let Some((colour, count)) = counts.into_iter().max_by_key(|(_, count)| *count) else {
            return 0;
        };
        // Only an edge that keeps one colour, like a window's outline.
        if count * 4 < n * 3 {
            return 0;
        }
        modes.push(colour);
    }
    let off = |p: u32| {
        sides
            .iter()
            .zip(&modes)
            .any(|(&c, mode)| pixel(image, axis, p, c).0 != *mode)
    };
    let rows = if at_end {
        (0..n).rev().take_while(|&p| off(p)).count()
    } else {
        (0..n).take_while(|&p| off(p)).count()
    };
    (rows as u32).min(n / 8)
}

/// Copies `src`'s rows `from..to` along `axis` to `dst` at row `at`.
fn place(dst: &mut RgbaImage, src: &RgbaImage, axis: Axis, from: i64, to: i64, at: i64) {
    if to <= from {
        return;
    }
    let cross = length(src, other(axis));
    let (x, y, w, h) = if axis == Axis::Vertical {
        (0, from as u32, cross, (to - from) as u32)
    } else {
        (from as u32, 0, (to - from) as u32, cross)
    };
    let part = imageops::crop_imm(src, x, y, w, h).to_image();
    let (dx, dy) = if axis == Axis::Vertical {
        (0, at)
    } else {
        (at, 0)
    };
    imageops::replace(dst, &part, dx, dy);
}

fn fill(dst: &mut RgbaImage, axis: Axis, along: (i64, i64), across: (u32, u32), colour: Rgba<u8>) {
    let n = i64::from(length(dst, axis));
    for p in along.0.max(0)..along.1.min(n) {
        for c in across.0..across.1 {
            let (x, y) = if axis == Axis::Vertical {
                (c, p as u32)
            } else {
                (p as u32, c)
            };
            dst.put_pixel(x, y, colour);
        }
    }
}

/// Fixed side strips seen so far, for the "show once at top" rule.
struct Sides {
    colours: Vec<Rgba<u8>>,
    fixed_seen: Vec<bool>,
    followed: Vec<bool>,
    filled: Vec<bool>,
}

pub struct Stitcher {
    pub image: RgbaImage,
    last: RgbaImage,
    last_sigs: [Option<Vec<Vec<u64>>>; 2],
    pub(crate) axis: Option<Axis>,
    pub(crate) reverse: Option<bool>,
    pub capped: bool,
    pub(crate) limit: u32,
    /// The first frame, kept until the axis is known.
    first: Option<RgbaImage>,
    /// Canvas position of the reference frame's first row.
    pos: i64,
    /// Canvas position of the image's first row.
    lo: i64,
    /// The first frame's span on the canvas.
    first_span: (i64, i64),
    /// Rows of fixed edge at the image's start and end.
    header: Option<u32>,
    footer: Option<u32>,
    /// The frames that wrote the image's start and end, with their canvas
    /// positions, so their outline and corners are rewritten whenever the
    /// image grows past them, even after the reference has moved on.
    start_frame: (Arc<RgbaImage>, i64),
    end_frame: (Arc<RgbaImage>, i64),
    sides: Option<Sides>,
}
impl Stitcher {
    pub fn new(first: RgbaImage) -> Self {
        let capped = first.width() >= MAX_LENGTH || first.height() >= MAX_LENGTH;
        let image = imageops::crop_imm(
            &first,
            0,
            0,
            first.width().min(MAX_LENGTH),
            first.height().min(MAX_LENGTH),
        )
        .to_image();
        let shared = Arc::new(first.clone());
        Self {
            image,
            start_frame: (shared.clone(), 0),
            end_frame: (shared, 0),
            last: first.clone(),
            last_sigs: [None, None],
            axis: None,
            reverse: None,
            capped,
            limit: MAX_LENGTH,
            first: Some(first),
            pos: 0,
            lo: 0,
            first_span: (0, 0),
            header: None,
            footer: None,
            sides: None,
        }
    }
    /// Adds a frame without a step to prefer.
    #[cfg(test)]
    pub fn push(&mut self, next: RgbaImage) -> bool {
        self.push_with_hint(next, None) == Push::Grew
    }
    /// Adds a frame. `hint` is the automatic step asked for, in image pixels
    /// along the scroll axis (vertical until one is known), positive toward
    /// content not yet seen in the forward direction.
    pub fn push_with_hint(&mut self, next: RgbaImage, hint: Option<i64>) -> Push {
        if self.capped {
            return Push::Capped;
        }
        if next.dimensions() != self.last.dimensions() {
            return Push::Lost;
        }
        if next == self.last {
            return Push::Still;
        }
        let axes = self
            .axis
            .map(|a| vec![a])
            .unwrap_or(vec![Axis::Vertical, Axis::Horizontal]);
        let hint_axis = self.axis.unwrap_or(Axis::Vertical);
        let mut best: Option<(Axis, Match, Vec<Vec<u64>>)> = None;
        let mut still = false;
        for axis in axes {
            let last = &self.last;
            let last_sig =
                self.last_sigs[axis as usize].get_or_insert_with(|| signatures(last, axis));
            let next_sig = signatures(&next, axis);
            let hint = hint.filter(|_| axis == hint_axis);
            match estimate(last_sig, &next_sig, hint) {
                Ok(m) if m.offset != 0 => {
                    if best.as_ref().is_none_or(|b| m.support > b.1.support) {
                        best = Some((axis, m, next_sig));
                    }
                }
                Ok(_) | Err(Miss::Still) => still = true,
                Err(Miss::Lost) => {}
            }
        }
        let Some((axis, m, next_sig)) = best else {
            return if still { Push::Still } else { Push::Lost };
        };
        if self.axis.is_none() {
            self.axis = Some(axis);
            self.reverse = Some(m.offset < 0);
            self.first_span = (0, i64::from(length(&self.last, axis)));
            let first = self.first.take().unwrap_or_else(|| self.last.clone());
            let colours = strip_colours(&first, axis);
            let n = colours.len();
            self.sides = Some(Sides {
                colours,
                fixed_seen: vec![false; n],
                followed: vec![false; n],
                filled: vec![false; n],
            });
        }
        let grew = self.compose(axis, &next, &next_sig, &m);
        self.last = next;
        self.last_sigs = [None, None];
        self.last_sigs[axis as usize] = Some(next_sig);
        if grew {
            Push::Grew
        } else if self.capped {
            Push::Capped
        } else {
            Push::Placed
        }
    }

    /// Places `next` on the canvas and writes the rows the image lacks.
    fn compose(&mut self, axis: Axis, next: &RgbaImage, next_sig: &[Vec<u64>], m: &Match) -> bool {
        let n = i64::from(length(next, axis));
        let cross = length(next, other(axis));
        let old_pos = self.pos;
        let new_pos = old_pos + m.offset;
        self.pos = new_pos;
        let lo = self.lo;
        let hi = lo + i64::from(length(&self.image, axis));
        let limit = i64::from(self.limit);
        // The edge of the frame that wrote the image's end (or start) is
        // not the page: rewrite it from inside the new frame. That frame is
        // the reference unless the user scrolled back in between.
        let moving: Vec<usize> = (0..m.fixed.len()).filter(|&s| !m.fixed[s]).collect();
        let edge = |(frame, pos): &(Arc<RgbaImage>, i64), at_end: bool| {
            let rows = if *pos == old_pos {
                m.edge
            } else {
                let sig = signatures(frame, axis);
                let unmatched = unmatched_rows(&sig, next_sig, new_pos - pos, at_end, &moving);
                (unmatched as u32).min(length(frame, axis) / 8)
            };
            i64::from(rows.max(corner_rows(frame, axis, at_end)))
        };

        let added: (i64, i64) = if new_pos + n > hi {
            let tail = i64::from(m.tail);
            let mut footer = i64::from(self.footer.unwrap_or(m.tail));
            if self.end_frame.1 + n == hi {
                let inside = hi - new_pos - i64::from(m.head);
                footer = footer.max(edge(&self.end_frame, true).min(inside));
            }
            let content_end = hi - footer;
            self.first_span.1 = self.first_span.1.min(content_end);
            let new_len = (new_pos + n - lo).min(limit);
            if new_len <= hi - lo {
                self.capped = true;
                return false;
            }
            let end = lo + new_len;
            self.capped = new_len >= limit;
            let (w, h) = dims(axis, cross, new_len as u32);
            let mut out = RgbaImage::new(w, h);
            imageops::replace(&mut out, &self.image, 0, 0);
            let from = (content_end - new_pos).max(0);
            let to = end - tail - new_pos;
            place(&mut out, next, axis, from, to, new_pos + from - lo);
            if tail > 0 {
                place(&mut out, next, axis, n - tail, n, end - tail - lo);
            }
            self.footer = Some(m.tail);
            self.end_frame = (Arc::new(next.clone()), new_pos);
            self.image = out;
            (content_end, end)
        } else if new_pos < lo {
            let head = i64::from(m.head);
            let mut header = i64::from(self.header.unwrap_or(m.head));
            if self.start_frame.1 == lo {
                let inside = new_pos + n - i64::from(m.tail) - lo;
                header = header.max(edge(&self.start_frame, false).min(inside));
            }
            let content_start = lo + header;
            self.first_span.0 = self.first_span.0.max(content_start);
            let new_len = (hi - new_pos).min(limit);
            if new_len <= hi - lo {
                self.capped = true;
                return false;
            }
            let start = hi - new_len;
            self.capped = new_len >= limit;
            let (w, h) = dims(axis, cross, new_len as u32);
            let mut out = RgbaImage::new(w, h);
            let shift = lo - start;
            let (dx, dy) = if axis == Axis::Vertical {
                (0, shift)
            } else {
                (shift, 0)
            };
            imageops::replace(&mut out, &self.image, dx, dy);
            let from = start + head - new_pos;
            let to = (content_start - new_pos).min(n);
            place(&mut out, next, axis, from, to, head);
            if head > 0 {
                place(&mut out, next, axis, 0, head, 0);
            }
            self.header = Some(m.head);
            self.start_frame = (Arc::new(next.clone()), new_pos);
            self.lo = start;
            self.image = out;
            (start, content_start)
        } else {
            self.record_sides(m, None);
            return false;
        };
        self.record_sides(m, Some(added));
        true
    }

    /// Notes which strips follow the page and fills the ones that never do
    /// with their most common colour outside the first frame, so a fixed
    /// sidebar shows once at the top.
    fn record_sides(&mut self, m: &Match, added: Option<(i64, i64)>) {
        let Some(axis) = self.axis else { return };
        let Some(sides) = self.sides.as_mut() else {
            return;
        };
        if sides.colours.len() != m.fixed.len() {
            return;
        }
        for s in 0..m.fixed.len() {
            if m.fixed[s] {
                sides.fixed_seen[s] = true;
            } else if m.textured[s] {
                sides.followed[s] = true;
            }
        }
        let cross = length(&self.image, other(axis));
        let strips = sides.colours.len() as u32;
        let lo = self.lo;
        let (f0, f1) = self.first_span;
        let len = i64::from(length(&self.image, axis));
        for s in 0..sides.colours.len() {
            if !sides.fixed_seen[s] || sides.followed[s] {
                continue;
            }
            let span = strip_span(cross, strips, s as u32);
            let colour = sides.colours[s];
            let ranges: Vec<(i64, i64)> = if sides.filled[s] {
                match added {
                    Some((a, b)) => vec![(a.max(f1), b), (a, b.min(f0))],
                    None => vec![],
                }
            } else {
                vec![(lo, f0), (f1, lo + len)]
            };
            for (a, b) in ranges {
                if b > a {
                    fill(&mut self.image, axis, (a - lo, b - lo), span, colour);
                }
            }
            sides.filled[s] = true;
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn frame(axis: Axis, offset: u32, sticky: bool) -> RgbaImage {
        let (w, h) = if axis == Axis::Vertical {
            (24, 80)
        } else {
            (80, 24)
        };
        RgbaImage::from_fn(w, h, |x, y| {
            let p = if axis == Axis::Vertical { y } else { x };
            let c = if axis == Axis::Vertical { x } else { y };
            let v = if sticky && !(5..75).contains(&p) {
                p
            } else {
                p + offset
            };
            image::Rgba([
                ((v * 37 + c * 13) % 251) as u8,
                ((v * 71 + c * 7) % 253) as u8,
                ((v * 19 + c * 41) % 255) as u8,
                255,
            ])
        })
    }
    /// A row of page content, distinct for every page row and column.
    fn page(v: u32, c: u32) -> Rgba<u8> {
        Rgba([
            ((v * 37 + c * 13) % 251) as u8,
            ((v * 71 + c * 7) % 253) as u8,
            ((v * 19 + c * 41) % 255) as u8,
            255,
        ])
    }
    /// A sidebar that never scrolls: its own text, on a plain background.
    fn sidebar(x: u32, y: u32) -> Rgba<u8> {
        if y % 6 < 2 && !x.is_multiple_of(3) {
            Rgba([((y * 11 + x * 5) % 200) as u8, 40, 90, 255])
        } else {
            Rgba([240, 240, 245, 255])
        }
    }
    /// A docs page: a fixed sidebar on the left, a page scrolled by `offset`.
    fn docs(offset: u32) -> RgbaImage {
        RgbaImage::from_fn(96, 120, |x, y| {
            if x < 24 {
                sidebar(x, y)
            } else {
                page(y + offset, x)
            }
        })
    }

    #[test]
    fn offsets_axes_and_sticky_edges() {
        for axis in [Axis::Vertical, Axis::Horizontal] {
            for sticky in [false, true] {
                let mut s = Stitcher::new(frame(axis, 0, sticky));
                assert!(!s.push(frame(axis, 0, sticky)));
                assert!(s.push(frame(axis, 13, sticky)));
                assert_eq!(length(&s.image, axis), 93);
                assert!(s.push(frame(axis, 32, sticky)));
                assert_eq!(length(&s.image, axis), 112);
                let expected = frame(axis, 32, sticky);
                assert_eq!(
                    pixel(&s.image, axis, 111, 10),
                    pixel(&expected, axis, 79, 10)
                );
                assert!(!s.push(RgbaImage::new(2, 2)));
            }
        }
    }
    #[test]
    fn reverse_motion_prepends_in_reading_order() {
        for axis in [Axis::Vertical, Axis::Horizontal] {
            let mut s = Stitcher::new(frame(axis, 32, false));
            assert!(s.push(frame(axis, 13, false)));
            assert!(s.push(frame(axis, 0, false)));
            assert_eq!(length(&s.image, axis), 112);
            assert_eq!(
                pixel(&s.image, axis, 0, 10),
                pixel(&frame(axis, 0, false), axis, 0, 10)
            );
        }
    }
    #[test]
    fn cap_waits_without_growing() {
        let mut s = Stitcher::new(frame(Axis::Vertical, 0, false));
        s.limit = 90;
        assert!(s.push(frame(Axis::Vertical, 20, false)));
        assert_eq!(s.image.height(), 90);
        assert!(s.capped);
        assert!(!s.push(frame(Axis::Vertical, 30, false)));
    }
    #[test]
    fn partial_cap_retains_one_footer() {
        let mut s = Stitcher::new(frame(Axis::Vertical, 0, true));
        s.limit = 90;
        assert!(s.push(frame(Axis::Vertical, 20, true)));
        assert_eq!(s.image.height(), 90);
        for p in 0..5 {
            assert_eq!(
                s.image.get_pixel(10, 85 + p),
                frame(Axis::Vertical, 20, true).get_pixel(10, 75 + p)
            );
        }
    }
    #[test]
    fn ambiguous_repeating_rows_are_not_guessed() {
        let pattern = |offset| {
            RgbaImage::from_fn(24, 80, |_, y| {
                let v = (((y + offset) % 8) * 30) as u8;
                image::Rgba([v, v, v, 255])
            })
        };
        let mut s = Stitcher::new(pattern(0));
        assert!(!s.push(pattern(3)));
        assert_eq!(s.image.height(), 80);
    }
    #[test]
    fn unrelated_frames_do_not_poison_reference() {
        let mut s = Stitcher::new(frame(Axis::Vertical, 0, false));
        assert!(!s.push(RgbaImage::from_pixel(
            24,
            80,
            image::Rgba([255, 255, 255, 255])
        )));
        assert!(s.push(frame(Axis::Vertical, 10, false)));
    }
    /// Two panes moving by different amounts: `left` px wide by `a`, the
    /// rest by `b`, with different content.
    fn panes(left: u32, a: u32, b: u32) -> RgbaImage {
        RgbaImage::from_fn(96, 120, |x, y| {
            if x < left {
                page(y + a, x)
            } else {
                page(y + b + 1000, x)
            }
        })
    }
    #[test]
    fn the_step_asked_for_breaks_a_tie_between_two_panes() {
        for hint in [20, 40] {
            let mut s = Stitcher::new(panes(48, 0, 0));
            assert_eq!(s.push_with_hint(panes(48, 20, 40), Some(hint)), Push::Grew);
            assert_eq!(s.image.height(), 120 + hint as u32, "hint {hint}");
        }
    }
    #[test]
    fn the_step_asked_for_does_not_outvote_a_larger_pane() {
        let mut s = Stitcher::new(panes(12, 0, 0));
        assert_eq!(s.push_with_hint(panes(12, 20, 40), Some(20)), Push::Grew);
        assert_eq!(s.image.height(), 160);
    }

    #[test]
    fn a_fixed_sidebar_does_not_block_the_page() {
        let mut s = Stitcher::new(docs(0));
        for step in 1..=4 {
            assert_eq!(s.push_with_hint(docs(step * 40), Some(40)), Push::Grew);
        }
        assert_eq!(s.image.height(), 120 + 160);
        // The page is joined in order, each row once.
        for y in 0..s.image.height() {
            assert_eq!(*s.image.get_pixel(60, y), page(y, 60), "row {y}");
        }
    }
    #[test]
    fn a_fixed_sidebar_shows_once_at_the_top() {
        let mut s = Stitcher::new(docs(0));
        for step in 1..=3 {
            assert!(s.push(docs(step * 40)));
        }
        for y in 0..120 {
            assert_eq!(*s.image.get_pixel(4, y), sidebar(4, y));
        }
        for y in 120..s.image.height() {
            assert_eq!(
                *s.image.get_pixel(4, y),
                Rgba([240, 240, 245, 255]),
                "row {y}"
            );
        }
    }
    #[test]
    fn a_changing_title_bar_does_not_block_the_page() {
        // The top rows change on every frame but never move with the page.
        let titled = |offset: u32, title: u32| {
            RgbaImage::from_fn(64, 120, |x, y| {
                if y < 10 {
                    Rgba([
                        ((x * 7 + title * 53) % 256) as u8,
                        (title * 31 % 256) as u8,
                        0,
                        255,
                    ])
                } else {
                    page(y + offset, x)
                }
            })
        };
        let mut s = Stitcher::new(titled(0, 0));
        assert!(s.push(titled(30, 1)));
        assert!(s.push(titled(60, 2)));
        assert_eq!(s.image.height(), 180);
        assert_eq!(*s.image.get_pixel(30, 179), page(179, 30));
    }
    #[test]
    fn plain_bands_follow_the_step_asked_for() {
        // Wide plain bands with one edge each: too few features to vote on
        // their own, but every row agrees with the step asked for.
        let band = |v: u32| if (v / 50).is_multiple_of(2) { 255 } else { 30 };
        let banded = |offset: u32| {
            RgbaImage::from_fn(64, 120, |_, y| {
                let c = band(y + offset) as u8;
                Rgba([c, c, c, 255])
            })
        };
        let mut s = Stitcher::new(banded(0));
        assert_eq!(s.push_with_hint(banded(40), Some(40)), Push::Grew);
        assert_eq!(s.image.height(), 160);
    }
    #[test]
    fn a_frame_too_far_away_is_lost_and_the_reference_moves_on_only_when_placed() {
        let mut s = Stitcher::new(docs(0));
        // More than three quarters of the area away: nothing lines up.
        assert_eq!(s.push_with_hint(docs(110), None), Push::Lost);
        // Scrolling back a little lines up with the reference again.
        assert_eq!(s.push_with_hint(docs(50), None), Push::Grew);
        assert_eq!(s.image.height(), 170);
    }
    #[test]
    fn scrolling_back_within_the_image_places_without_growing() {
        let mut s = Stitcher::new(docs(0));
        assert!(s.push(docs(60)));
        assert_eq!(s.push_with_hint(docs(30), None), Push::Placed);
        assert!(s.push(docs(90)));
        assert_eq!(s.image.height(), 210);
        for y in 0..210 {
            assert_eq!(*s.image.get_pixel(50, y), page(y, 50), "row {y}");
        }
    }
    #[test]
    fn an_animation_in_a_stopped_page_counts_as_still() {
        let blinking = |on: bool| {
            let mut i = docs(0);
            for y in 40..52 {
                i.put_pixel(
                    70,
                    y,
                    if on {
                        Rgba([0, 0, 0, 255])
                    } else {
                        *i.get_pixel(71, y)
                    },
                );
            }
            i
        };
        let mut s = Stitcher::new(blinking(false));
        assert_eq!(s.push_with_hint(blinking(true), Some(40)), Push::Still);
    }

    const WALLPAPER: Rgba<u8> = Rgba([92, 37, 69, 255]);
    const BACKGROUND: Rgba<u8> = Rgba([12, 13, 15, 255]);
    /// Radius of a held window's rounded corners, in pixels.
    const RADIUS: u32 = 8;
    const HEADER: u32 = 12;
    /// The page inside a held window: plain margins around a column.
    fn column(v: u32, x: u32) -> Rgba<u8> {
        if (24..456).contains(&x) {
            page(v, x)
        } else {
            BACKGROUND
        }
    }
    /// Mixes the translucent outline macOS draws around a window over `under`.
    fn outlined(under: Rgba<u8>) -> Rgba<u8> {
        let mix = |c: u8| ((u16::from(c) + 60) / 2) as u8;
        Rgba([mix(under[0]), mix(under[1]), mix(under[2]), 255])
    }
    /// A browser window held as an area on macOS, its page scrolled by
    /// `offset`: a fixed header with a 1 px rule, a translucent outline along
    /// the window's edges and rounded bottom corners that show the wallpaper.
    fn held(offset: u32) -> RgbaImage {
        held_with(offset, false)
    }
    /// A held window, with a fixed sidebar beside the page when `side`.
    fn held_with(offset: u32, side: bool) -> RgbaImage {
        let (w, h) = (480, 160);
        RgbaImage::from_fn(w, h, |x, y| {
            let (cx, cy) = (x.min(w - 1 - x), h - 1 - y);
            if cx < RADIUS && cy < RADIUS {
                let (dx, dy) = (RADIUS - cx, RADIUS - cy);
                if dx * dx + dy * dy > RADIUS * RADIUS {
                    return WALLPAPER;
                }
            }
            let under = if y + 1 == HEADER {
                Rgba([31, 31, 34, 255])
            } else if y < HEADER {
                Rgba([43, 43, 43, 255])
            } else if side && (24..104).contains(&x) {
                sidebar(x, y)
            } else {
                column(y + offset, x)
            };
            if x == 0 || x == w - 1 || y == h - 1 {
                outlined(under)
            } else {
                under
            }
        })
    }

    #[test]
    fn a_held_windows_outline_does_not_show_at_the_seams() {
        let mut s = Stitcher::new(held(0));
        for step in 1..=4 {
            assert_eq!(s.push_with_hint(held(step * 40), Some(40)), Push::Grew);
        }
        let height = s.image.height();
        assert_eq!(height, 160 + 160);
        // Below the header, every row is the page's own, down to the last
        // frame's outline.
        for y in HEADER..height - 1 {
            for x in RADIUS..480 - RADIUS {
                assert_eq!(*s.image.get_pixel(x, y), column(y, x), "row {y}, x {x}");
            }
        }
    }
    #[test]
    fn a_held_windows_rounded_corners_show_only_at_the_end() {
        let mut s = Stitcher::new(held(0));
        for step in 1..=4 {
            assert_eq!(s.push_with_hint(held(step * 40), Some(40)), Push::Grew);
        }
        let height = s.image.height();
        for y in 0..height - RADIUS {
            for x in 0..480 {
                assert_ne!(*s.image.get_pixel(x, y), WALLPAPER, "row {y}, x {x}");
            }
        }
    }
    #[test]
    fn a_held_windows_edge_is_rewritten_after_scrolling_back_a_little() {
        // Down, back a little (trackpad momentum), then on: the image's end
        // still comes from the frame before the one scrolled back to.
        let mut s = Stitcher::new(held(0));
        assert_eq!(s.push_with_hint(held(40), None), Push::Grew);
        assert_eq!(s.push_with_hint(held(20), None), Push::Placed);
        assert_eq!(s.push_with_hint(held(60), None), Push::Grew);
        let height = s.image.height();
        assert_eq!(height, 220);
        for y in HEADER..height - 1 {
            for x in RADIUS..480 - RADIUS {
                assert_eq!(*s.image.get_pixel(x, y), column(y, x), "row {y}, x {x}");
            }
        }
        for y in 0..height - RADIUS {
            for x in 0..480 {
                assert_ne!(*s.image.get_pixel(x, y), WALLPAPER, "row {y}, x {x}");
            }
        }
    }
    #[test]
    fn a_held_windows_start_is_rewritten_after_scrolling_on_a_little() {
        // Upward, on a little, then up again: the image's start still comes
        // from the frame before the one scrolled to.
        let mut s = Stitcher::new(held(120));
        assert_eq!(s.push_with_hint(held(80), None), Push::Grew);
        assert_eq!(s.push_with_hint(held(100), None), Push::Placed);
        assert_eq!(s.push_with_hint(held(60), None), Push::Grew);
        assert_eq!(s.image.height(), 220);
        // The page joins in order below the newest frame's header.
        for y in HEADER..s.image.height() - RADIUS {
            for x in RADIUS..480 - RADIUS {
                assert_eq!(
                    *s.image.get_pixel(x, y),
                    column(y + 60, x),
                    "row {y}, x {x}"
                );
            }
        }
    }
    #[test]
    fn a_fixed_sidebar_in_a_held_window_ends_above_its_corners() {
        let mut s = Stitcher::new(held_with(0, true));
        for step in 1..=4 {
            assert_eq!(
                s.push_with_hint(held_with(step * 40, true), Some(40)),
                Push::Grew
            );
        }
        // The first frame's sidebar shows down to its rounded corners; the
        // rows rewritten from the next frame take the sidebar's colour.
        for y in HEADER..160 - RADIUS {
            assert_eq!(*s.image.get_pixel(31, y), sidebar(31, y), "row {y}");
        }
        for y in 160 - RADIUS..s.image.height() - 1 {
            assert_eq!(
                *s.image.get_pixel(31, y),
                Rgba([240, 240, 245, 255]),
                "row {y}"
            );
        }
    }
}
