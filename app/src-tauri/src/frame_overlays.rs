//! Click rings and the keystroke label, drawn into a recording's frames
//! after the pointer and before encoding, so they need no window of their
//! own on screen.
//!
//! A ring is drawn where the pointer was in the first frame grabbed after
//! the click, which keeps it in the frame's own pixels on every platform,
//! and grows and fades out over [`RING_FADE`]. The label of the last keys
//! pressed (see input.rs) sits at the bottom centre, stays for
//! [`LABEL_HOLD`] after the last key and then fades over [`LABEL_FADE`].
//! Its text is drawn in the cut-down DejaVu Sans Bold in fonts/, which has
//! the macOS key symbols.
//!
//! Sizes are in points, times the monitor's scale factor in pixels.

use std::time::{Duration, Instant};

use ab_glyph::{Font, FontRef, PxScale, ScaleFont, point};
use image::RgbaImage;

use crate::input::{self, InputEvent, InputKind};

/// How long a click ring takes to fade out.
pub const RING_FADE: Duration = Duration::from_millis(500);
/// How long the keystroke label stays after the last key.
pub const LABEL_HOLD: Duration = Duration::from_millis(1500);
/// How long it then takes to fade out.
pub const LABEL_FADE: Duration = Duration::from_millis(250);

/// The ring's radius, in points, as it appears and once it has faded.
const RING_START: f32 = 14.0;
const RING_END: f32 = 26.0;
/// The ring's line width, in points.
const RING_WIDTH: f32 = 3.0;
const RING_COLOUR: [u8; 3] = [255, 184, 0];
/// How opaque the ring's line and the disc inside it start out.
const RING_OPACITY: f32 = 0.9;
const DISC_OPACITY: f32 = 0.25;

/// The label's text size, padding, corner radius and distance from the
/// frame's bottom edge, in points.
const LABEL_TEXT: f32 = 26.0;
const LABEL_PADDING: (f32, f32) = (16.0, 9.0);
const LABEL_RADIUS: f32 = 10.0;
const LABEL_MARGIN: f32 = 32.0;
const LABEL_BACKGROUND: [u8; 3] = [24, 24, 27];
const LABEL_OPACITY: f32 = 0.8;
const LABEL_TEXT_COLOUR: [u8; 3] = [255, 255, 255];

static FONT: &[u8] = include_bytes!("../fonts/DejaVuSans-Bold-keys.ttf");

/// How opaque a ring is `age` after its click: from 1 down to 0 over
/// [`RING_FADE`], then None, when it is gone.
pub fn ring_alpha(age: Duration) -> Option<f32> {
    (age < RING_FADE).then(|| 1.0 - age.as_secs_f32() / RING_FADE.as_secs_f32())
}

/// A ring's radius `age` after its click, in points: it grows as it fades.
fn ring_radius(age: Duration) -> f32 {
    let progress = (age.as_secs_f32() / RING_FADE.as_secs_f32()).min(1.0);
    RING_START + (RING_END - RING_START) * progress
}

/// How opaque the label is `since` the last key: fully until
/// [`LABEL_HOLD`], then down to 0 over [`LABEL_FADE`], then None.
pub fn label_alpha(since: Duration) -> Option<f32> {
    if since < LABEL_HOLD {
        return Some(1.0);
    }
    let fading = since - LABEL_HOLD;
    (fading < LABEL_FADE).then(|| 1.0 - fading.as_secs_f32() / LABEL_FADE.as_secs_f32())
}

#[derive(Debug, Clone, PartialEq)]
struct Ring {
    at: Instant,
    centre: (i32, i32),
}

#[derive(Debug, Clone, PartialEq)]
struct Label {
    text: String,
    at: Instant,
}

/// What is drawn over the frames of one recording.
pub struct Overlays {
    input: Option<input::Capture>,
    /// Frame pixels per point.
    scale: f32,
    rings: Vec<Ring>,
    label: Option<Label>,
}

impl Overlays {
    /// Draws nothing.
    pub fn none() -> Self {
        Self {
            input: None,
            scale: 1.0,
            rings: Vec::new(),
            label: None,
        }
    }

    /// Watches the mouse for `clicks` and the keyboard for `keys`, for a
    /// monitor of `scale_factor`. Draws nothing if neither is asked for, or
    /// if input cannot be watched; the recording goes ahead either way.
    pub fn start(clicks: bool, keys: bool, scale_factor: f64) -> Self {
        let mut overlays = Self::none();
        overlays.scale = frame_scale(scale_factor);
        if clicks || keys {
            match input::Capture::start(clicks, keys) {
                Ok(capture) => overlays.input = Some(capture),
                Err(err) => eprintln!("Grab-it: recording without clicks or keystrokes: {err}"),
            }
        }
        overlays
    }

    /// Draws the rings and label into `frame`, grabbed at `now` with the
    /// pointer at `pointer` in its pixels.
    pub fn apply(&mut self, frame: &mut RgbaImage, pointer: Option<(i32, i32)>, now: Instant) {
        if let Some(input) = &self.input {
            let events = input.take();
            self.add(events, pointer);
        }
        self.draw(frame, now);
    }

    /// Takes in the clicks and keys since the last frame. A click is placed
    /// where the pointer is in this frame, and left out when that is not
    /// known.
    fn add(&mut self, events: Vec<InputEvent>, pointer: Option<(i32, i32)>) {
        for event in events {
            match event.kind {
                InputKind::Click => {
                    if let Some(centre) = pointer {
                        self.rings.push(Ring {
                            at: event.at,
                            centre,
                        });
                    }
                }
                InputKind::Keys(text) => {
                    self.label = Some(Label { text, at: event.at });
                }
            }
        }
    }

    /// Draws what is still showing at `now` and forgets what has faded.
    fn draw(&mut self, frame: &mut RgbaImage, now: Instant) {
        let scale = self.scale;
        self.rings.retain(|ring| {
            let age = now.saturating_duration_since(ring.at);
            let Some(alpha) = ring_alpha(age) else {
                return false;
            };
            draw_ring(frame, ring.centre, ring_radius(age) * scale, scale, alpha);
            true
        });
        if let Some(label) = &self.label {
            match label_alpha(now.saturating_duration_since(label.at)) {
                Some(alpha) => draw_label(frame, &label.text, scale, alpha),
                None => self.label = None,
            }
        }
    }
}

/// Frame pixels per point for a monitor of `scale_factor`.
fn frame_scale(scale_factor: f64) -> f32 {
    if scale_factor.is_finite() {
        scale_factor.clamp(1.0, 4.0) as f32
    } else {
        1.0
    }
}

/// Blends `colour` over one pixel at `alpha`, 0 to 1.
fn blend(frame: &mut RgbaImage, x: i64, y: i64, colour: [u8; 3], alpha: f32) {
    if alpha <= 0.0
        || x < 0
        || y < 0
        || x >= i64::from(frame.width())
        || y >= i64::from(frame.height())
    {
        return;
    }
    let alpha = alpha.min(1.0);
    let pixel = frame.get_pixel_mut(x as u32, y as u32);
    for (channel, value) in colour.iter().enumerate() {
        let under = f32::from(pixel.0[channel]);
        pixel.0[channel] = (under + (f32::from(*value) - under) * alpha).round() as u8;
    }
    pixel.0[3] = 255;
}

/// A ring of `radius` pixels around `centre`, with a faint disc inside.
fn draw_ring(frame: &mut RgbaImage, centre: (i32, i32), radius: f32, scale: f32, alpha: f32) {
    let half_width = RING_WIDTH * scale / 2.0;
    let reach = (radius + half_width + 1.0).ceil() as i64;
    let (cx, cy) = (i64::from(centre.0), i64::from(centre.1));
    for y in cy - reach..=cy + reach {
        for x in cx - reach..=cx + reach {
            // From the pixel's centre to the click.
            let dx = (x - cx) as f32;
            let dy = (y - cy) as f32;
            let distance = (dx * dx + dy * dy).sqrt();
            let line = (half_width + 0.5 - (distance - radius).abs()).clamp(0.0, 1.0);
            let inside = (radius - distance + 0.5).clamp(0.0, 1.0);
            let coverage = line * RING_OPACITY + (1.0 - line) * inside * DISC_OPACITY;
            blend(frame, x, y, RING_COLOUR, coverage * alpha);
        }
    }
}

/// How far a pixel centre is outside a rounded rectangle: negative inside.
fn rounded_rect_distance(
    point: (f32, f32),
    centre: (f32, f32),
    half: (f32, f32),
    radius: f32,
) -> f32 {
    let qx = (point.0 - centre.0).abs() - (half.0 - radius);
    let qy = (point.1 - centre.1).abs() - (half.1 - radius);
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    outside + qx.max(qy).min(0.0) - radius
}

/// `text`'s width at `size` pixels, and its ascent and descent.
fn measure(font: &FontRef<'_>, text: &str, size: f32) -> (f32, f32, f32) {
    let scaled = font.as_scaled(PxScale::from(size));
    let width: f32 = text
        .chars()
        .map(|c| scaled.h_advance(scaled.glyph_id(c)))
        .sum();
    (width, scaled.ascent(), scaled.descent())
}

/// Where the label goes in a frame of `frame` pixels: its box's top-left
/// corner and size, and its text size, all in pixels. The text shrinks to
/// fit a narrow frame, and the box keeps clear of the bottom edge.
fn label_layout(
    frame: (u32, u32),
    text_width_at: impl Fn(f32) -> f32,
    line_height_at: impl Fn(f32) -> f32,
    scale: f32,
) -> ((f32, f32), (f32, f32), f32) {
    let (frame_width, frame_height) = (frame.0 as f32, frame.1 as f32);
    let padding = (LABEL_PADDING.0 * scale, LABEL_PADDING.1 * scale);
    let mut size = LABEL_TEXT * scale;
    let room = (frame_width - 2.0 * padding.0 - 2.0 * scale * 8.0).max(1.0);
    let natural = text_width_at(size);
    if natural > room {
        size *= room / natural;
    }
    let width = text_width_at(size) + 2.0 * padding.0;
    let height = line_height_at(size) + 2.0 * padding.1;
    let left = (frame_width - width) / 2.0;
    let top = (frame_height - LABEL_MARGIN * scale - height).max(0.0);
    ((left, top), (width, height), size)
}

/// The keystroke label at the bottom centre of `frame`.
fn draw_label(frame: &mut RgbaImage, text: &str, scale: f32, alpha: f32) {
    let Ok(font) = FontRef::try_from_slice(FONT) else {
        return;
    };
    let ((left, top), (width, height), size) = label_layout(
        frame.dimensions(),
        |size| measure(&font, text, size).0,
        |size| {
            let (_, ascent, descent) = measure(&font, text, size);
            ascent - descent
        },
        scale,
    );
    let radius = (LABEL_RADIUS * scale).min(height / 2.0);
    let half = (width / 2.0, height / 2.0);
    let centre = (left + half.0, top + half.1);
    for y in top.floor() as i64..(top + height).ceil() as i64 {
        for x in left.floor() as i64..(left + width).ceil() as i64 {
            let pixel = (x as f32 + 0.5, y as f32 + 0.5);
            let coverage =
                (0.5 - rounded_rect_distance(pixel, centre, half, radius)).clamp(0.0, 1.0);
            blend(
                frame,
                x,
                y,
                LABEL_BACKGROUND,
                coverage * LABEL_OPACITY * alpha,
            );
        }
    }

    let scaled = font.as_scaled(PxScale::from(size));
    let baseline = top + LABEL_PADDING.1 * scale + scaled.ascent();
    let mut x = left + LABEL_PADDING.0 * scale;
    for c in text.chars() {
        let id = scaled.glyph_id(c);
        let glyph = id.with_scale_and_position(size, point(x, baseline));
        x += scaled.h_advance(id);
        let Some(outlined) = font.outline_glyph(glyph) else {
            continue;
        };
        let bounds = outlined.px_bounds();
        outlined.draw(|gx, gy, coverage| {
            let px = bounds.min.x as i64 + i64::from(gx);
            let py = bounds.min.y as i64 + i64::from(gy);
            blend(frame, px, py, LABEL_TEXT_COLOUR, coverage * alpha);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    const BLACK: Rgba<u8> = Rgba([0, 0, 0, 255]);

    fn ms(millis: u64) -> Duration {
        Duration::from_millis(millis)
    }

    fn black(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_pixel(width, height, BLACK)
    }

    fn changed(frame: &RgbaImage) -> usize {
        frame.pixels().filter(|pixel| **pixel != BLACK).count()
    }

    #[test]
    fn a_click_ring_fades_over_half_a_second() {
        assert_eq!(ring_alpha(Duration::ZERO), Some(1.0));
        assert_eq!(ring_alpha(ms(250)), Some(0.5));
        assert!(ring_alpha(ms(499)).unwrap() > 0.0);
        assert_eq!(ring_alpha(ms(500)), None);
        assert_eq!(ring_alpha(Duration::from_secs(9)), None);
        // It grows as it fades.
        assert_eq!(ring_radius(Duration::ZERO), RING_START);
        assert_eq!(ring_radius(ms(500)), RING_END);
        assert!(ring_radius(ms(250)) > RING_START);
    }

    #[test]
    fn the_label_holds_for_a_second_and_a_half_then_fades() {
        assert_eq!(label_alpha(Duration::ZERO), Some(1.0));
        assert_eq!(label_alpha(ms(1499)), Some(1.0));
        let fading = label_alpha(LABEL_HOLD + LABEL_FADE / 2).unwrap();
        assert!((fading - 0.5).abs() < 1e-3, "{fading}");
        assert_eq!(label_alpha(LABEL_HOLD + LABEL_FADE), None);
    }

    #[test]
    fn a_ring_is_drawn_where_the_pointer_was_and_then_forgotten() {
        let start = Instant::now();
        let mut overlays = Overlays::none();
        overlays.add(
            vec![InputEvent {
                at: start,
                kind: InputKind::Click,
            }],
            Some((40, 40)),
        );
        let mut frame = black(80, 80);
        overlays.draw(&mut frame, start);
        // On the ring, the line is drawn; the click itself gets the disc;
        // well outside, nothing.
        let on_line = frame.get_pixel(40 + RING_START as u32, 40);
        assert!(on_line.0[0] > 200 && on_line.0[2] < 50, "{on_line:?}");
        let centre = frame.get_pixel(40, 40);
        assert!(centre.0[0] > 0 && centre.0[0] < on_line.0[0], "{centre:?}");
        assert_eq!(frame.get_pixel(2, 2), &BLACK);

        // Halfway through, fainter and bigger.
        let mut half = black(80, 80);
        overlays.draw(&mut half, start + ms(250));
        let radius = ring_radius(ms(250)).round() as u32;
        let faded = half.get_pixel(40 + radius, 40);
        assert!(faded.0[0] < on_line.0[0] && faded.0[0] > 50, "{faded:?}");

        // Gone after half a second, and not kept.
        let mut later = black(80, 80);
        overlays.draw(&mut later, start + ms(500));
        assert_eq!(changed(&later), 0);
        assert!(overlays.rings.is_empty());
    }

    #[test]
    fn a_click_with_no_pointer_is_left_out() {
        let mut overlays = Overlays::none();
        overlays.add(
            vec![InputEvent {
                at: Instant::now(),
                kind: InputKind::Click,
            }],
            None,
        );
        assert!(overlays.rings.is_empty());
    }

    #[test]
    fn rings_near_the_edge_are_clipped() {
        let start = Instant::now();
        let mut overlays = Overlays::none();
        overlays.add(
            vec![InputEvent {
                at: start,
                kind: InputKind::Click,
            }],
            Some((-5, 3)),
        );
        let mut frame = black(20, 20);
        overlays.draw(&mut frame, start);
        assert!(changed(&frame) > 0);
    }

    #[test]
    fn the_label_sits_at_the_bottom_centre_and_shows_the_last_keys() {
        let start = Instant::now();
        let mut overlays = Overlays::none();
        overlays.add(
            vec![
                InputEvent {
                    at: start,
                    kind: InputKind::Keys("A".into()),
                },
                InputEvent {
                    at: start + ms(100),
                    kind: InputKind::Keys("Ctrl Shift 4".into()),
                },
            ],
            None,
        );
        assert_eq!(overlays.label.as_ref().unwrap().text, "Ctrl Shift 4");
        let mut frame = black(400, 200);
        overlays.draw(&mut frame, start + ms(100));
        // Drawn only in the bottom half, around the centre.
        let mut drawn = (u32::MAX, 0, u32::MAX, 0);
        for (x, y, pixel) in frame.enumerate_pixels() {
            if *pixel != BLACK {
                drawn = (
                    drawn.0.min(x),
                    drawn.1.max(x),
                    drawn.2.min(y),
                    drawn.3.max(y),
                );
            }
        }
        let (left, right, top, bottom) = drawn;
        assert!(top > 100, "top {top}");
        assert!(bottom < 200 - LABEL_MARGIN as u32 + 1, "bottom {bottom}");
        let middle = (left + right) / 2;
        assert!(middle.abs_diff(200) <= 2, "{left}..{right}");
        // The text is white on the dark box.
        assert!(
            frame
                .pixels()
                .any(|pixel| pixel.0[0] > 240 && pixel.0[1] > 240 && pixel.0[2] > 240)
        );

        // Still there 1.5 s after the last key; gone once faded.
        let mut held = black(400, 200);
        overlays.draw(&mut held, start + ms(100) + ms(1499));
        assert_eq!(changed(&held), changed(&frame));
        let mut gone = black(400, 200);
        overlays.draw(&mut gone, start + ms(100) + LABEL_HOLD + LABEL_FADE);
        assert_eq!(changed(&gone), 0);
        assert!(overlays.label.is_none());
    }

    #[test]
    fn the_font_has_every_key_symbol() {
        let font = FontRef::try_from_slice(FONT).unwrap();
        for c in "⌘⌃⌥⇧↩⌫⌦⇥⇪←→↑↓↖↘⇞⇟ AZ09`-=[];'\\,./+*".chars() {
            assert_ne!(font.glyph_id(c).0, 0, "no glyph for {c:?}");
        }
    }

    #[test]
    fn a_long_label_shrinks_to_fit_a_narrow_frame() {
        // Text 10 px wide per pixel of size: 260 px at 26 px.
        let width_at = |size: f32| size * 10.0;
        let height_at = |size: f32| size * 1.2;
        let ((left, top), (width, height), size) =
            label_layout((1000, 600), width_at, height_at, 1.0);
        assert_eq!(size, LABEL_TEXT);
        assert_eq!(width, 260.0 + 2.0 * LABEL_PADDING.0);
        assert_eq!(left, (1000.0 - width) / 2.0);
        assert_eq!(top, 600.0 - LABEL_MARGIN - height);

        let ((left, _), (width, _), size) = label_layout((200, 600), width_at, height_at, 1.0);
        assert!(size < LABEL_TEXT);
        assert!(left >= 0.0 && left + width <= 200.0, "{left} + {width}");

        // A frame too short for the margin keeps the label inside it.
        let ((_, top), _, _) = label_layout((1000, 40), width_at, height_at, 1.0);
        assert_eq!(top, 0.0);
        // HiDPI: twice the pixels.
        let (_, _, size) = label_layout((4000, 2000), width_at, height_at, 2.0);
        assert_eq!(size, LABEL_TEXT * 2.0);
    }

    #[test]
    fn scale_factors_are_kept_sensible() {
        assert_eq!(frame_scale(2.0), 2.0);
        assert_eq!(frame_scale(0.5), 1.0);
        assert_eq!(frame_scale(f64::NAN), 1.0);
        assert_eq!(frame_scale(9.0), 4.0);
    }
}
