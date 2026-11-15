//! Zooms in recording exports: which part of each frame shows, and how a
//! zoom eases in and out.
//!
//! A zoom segment (in `<recording>.edits.json` and the export plan) holds a
//! stretch of the recording, a scale, and a focus: a chosen point of the
//! frame, or the pointer from `<recording>.cursor.json`, smoothed. Every
//! zoom eases in over its first [`EASE_MS`] and out over its last, and the
//! zoomed view never leaves the frame.
//!
//! The page computes the same view for its preview (`viewAt` in
//! src/recording/zooms.ts), from the smoothed pointer path this module
//! hands it, so the preview and the export agree. Keep the two in step.

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::record::cursor_path;

/// How long a zoom takes to ease in, and again to ease out. Mirrors
/// `ZOOM_EASE_MS` in src/recording/zooms.ts.
pub const EASE_MS: f64 = 300.0;
/// The time constant of the pointer smoothing, in seconds: the path is
/// run through an exponential filter this slow forward, then backward, so
/// it lags neither way.
pub const FOLLOW_SMOOTHING_S: f64 = 0.25;
/// The scales an export accepts. The page offers `MIN_ZOOM_SCALE` to
/// `MAX_ZOOM_SCALE` (src/recording/zooms.ts), inside these.
pub const MIN_SCALE: f64 = 1.0;
pub const MAX_SCALE: f64 = 4.0;

/// What a zoom centres on. Mirrors `ZoomFocus` in src/recording/zooms.ts.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Focus {
    /// A point of the frame, as fractions of its width and height.
    Area { x: f64, y: f64 },
    /// The pointer, smoothed.
    Cursor,
}

/// One zoom. Mirrors `Zoom` in src/recording/zooms.ts; times are in the
/// recording, not the trimmed clip.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Zoom {
    pub start_ms: f64,
    pub end_ms: f64,
    pub scale: f64,
    pub focus: Focus,
}

impl Zoom {
    /// Refuses a zoom that could not be drawn.
    pub fn check(&self) -> Result<(), String> {
        let finite = [self.start_ms, self.end_ms, self.scale]
            .iter()
            .all(|value| value.is_finite());
        if !finite || self.start_ms < 0.0 || self.end_ms <= self.start_ms {
            return Err("a zoom needs a start before its end".to_owned());
        }
        if !(MIN_SCALE..=MAX_SCALE).contains(&self.scale) {
            return Err(format!(
                "a zoom's scale must be from {MIN_SCALE} to {MAX_SCALE}"
            ));
        }
        let inside = |value: f64| (0.0..=1.0).contains(&value);
        match self.focus {
            Focus::Area { x, y } if !(inside(x) && inside(y)) => {
                Err("a zoom's area must lie inside the frame".to_owned())
            }
            _ => Ok(()),
        }
    }

    /// How far the zoom is in at `ms`: 0 outside it, rising to 1 over the
    /// first [`EASE_MS`] and falling back over the last (each half the zoom
    /// when it is shorter), along a smoothstep.
    pub fn strength(&self, ms: f64) -> f64 {
        if ms <= self.start_ms || ms >= self.end_ms {
            return 0.0;
        }
        let ramp = EASE_MS.min((self.end_ms - self.start_ms) / 2.0);
        let p = ((ms - self.start_ms).min(self.end_ms - ms) / ramp).min(1.0);
        p * p * (3.0 - 2.0 * p)
    }
}

/// The part of the frame showing: `scale` times as large, centred on `x`,
/// `y` (fractions of the frame).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct View {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
}

impl View {
    /// The whole frame.
    pub const FULL: View = View {
        scale: 1.0,
        x: 0.5,
        y: 0.5,
    };

    /// The view's rectangle in a `width` × `height` frame: left, top,
    /// width, height.
    pub fn rect(&self, width: f64, height: f64) -> [f64; 4] {
        let (w, h) = (width / self.scale, height / self.scale);
        [self.x * width - w / 2.0, self.y * height - h / 2.0, w, h]
    }
}

/// `target` moved just far enough that a view `scale` times as large stays
/// inside the frame.
pub fn clamp_centre(target: [f64; 2], scale: f64) -> [f64; 2] {
    let half = 0.5 / scale.max(1.0);
    target.map(|value| value.clamp(half, 1.0 - half))
}

/// The view at `ms` of the recording: the zoom holding it, eased, centred
/// on its focus and kept inside the frame. Zooms never overlap; if they
/// did, the first holding `ms` wins. A pointer zoom without a path centres
/// on the frame.
pub fn view_at(zooms: &[Zoom], ms: f64, cursor: Option<&CursorPath>) -> View {
    let Some(zoom) = zooms
        .iter()
        .find(|zoom| ms > zoom.start_ms && ms < zoom.end_ms)
    else {
        return View::FULL;
    };
    let scale = zoom.scale.powf(zoom.strength(ms));
    let target = match zoom.focus {
        Focus::Area { x, y } => [x, y],
        Focus::Cursor => cursor.and_then(|path| path.at(ms)).unwrap_or([0.5, 0.5]),
    };
    let [x, y] = clamp_centre(target, scale);
    View { scale, x, y }
}

/// The largest scale any of `zooms` reaches.
pub fn max_scale(zooms: &[Zoom]) -> f64 {
    zooms.iter().map(|zoom| zoom.scale).fold(1.0, f64::max)
}

// --- The pointer path --------------------------------------------------------

/// `<recording>.cursor.json` as it is read back.
#[derive(Deserialize)]
struct CursorFile {
    width: u32,
    height: u32,
    fps: u32,
    positions: Vec<Option<[f64; 2]>>,
}

/// The pointer's smoothed path: a point a frame, as fractions of the frame,
/// held inside it. Mirrors `CursorPath` in src/recording/zooms.ts.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CursorPath {
    pub fps: u32,
    pub points: Vec<[f64; 2]>,
}

impl CursorPath {
    /// Reads and smooths the pointer sidecar beside `video`. None when it is
    /// missing, unreadable, or never saw the pointer.
    pub fn load(video: &Path) -> Option<CursorPath> {
        let bytes = fs::read(cursor_path(video)).ok()?;
        let file: CursorFile = serde_json::from_slice(&bytes).ok()?;
        if file.width == 0 || file.height == 0 || !(1..=240).contains(&file.fps) {
            return None;
        }
        let points = smooth(
            &file.positions,
            f64::from(file.width),
            f64::from(file.height),
            file.fps,
        )?;
        Some(CursorPath {
            fps: file.fps,
            points,
        })
    }

    /// Where the pointer is at `ms`, between the frames either side.
    pub fn at(&self, ms: f64) -> Option<[f64; 2]> {
        let last = self.points.len().checked_sub(1)?;
        let frame = (ms * f64::from(self.fps) / 1000.0).clamp(0.0, last as f64);
        let index = frame.floor() as usize;
        let next = (index + 1).min(last);
        let share = frame - index as f64;
        let (a, b) = (self.points[index], self.points[next]);
        Some([a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share])
    }
}

/// Smooths raw pointer `positions` (pixels of a `width` × `height` frame,
/// null where unknown) into fractions of the frame: each is held inside
/// the frame, a gap keeps the last known point (the first known one before
/// it), and the path is filtered forward and backward with
/// [`FOLLOW_SMOOTHING_S`]. Rounded to 1e-5 so the page gets the very same
/// numbers. None when no position is known.
pub fn smooth(
    positions: &[Option<[f64; 2]>],
    width: f64,
    height: f64,
    fps: u32,
) -> Option<Vec<[f64; 2]>> {
    let fraction = |[x, y]: [f64; 2]| [(x / width).clamp(0.0, 1.0), (y / height).clamp(0.0, 1.0)];
    let first = positions
        .iter()
        .flatten()
        .find(|p| p.iter().all(|v| v.is_finite()))?;
    let mut held = fraction(*first);
    let mut points: Vec<[f64; 2]> = positions
        .iter()
        .map(|position| {
            if let Some(position) = position.filter(|p| p.iter().all(|v| v.is_finite())) {
                held = fraction(position);
            }
            held
        })
        .collect();
    let alpha = 1.0 - (-1.0 / (f64::from(fps.max(1)) * FOLLOW_SMOOTHING_S)).exp();
    let follow = |from: [f64; 2], to: [f64; 2]| {
        [
            from[0] + (to[0] - from[0]) * alpha,
            from[1] + (to[1] - from[1]) * alpha,
        ]
    };
    for i in 1..points.len() {
        points[i] = follow(points[i - 1], points[i]);
    }
    for i in (0..points.len().saturating_sub(1)).rev() {
        points[i] = follow(points[i + 1], points[i]);
    }
    let round = |value: f64| (value * 100_000.0).round() / 100_000.0;
    Some(points.into_iter().map(|point| point.map(round)).collect())
}

// --- Drawing a view ----------------------------------------------------------

/// Draws `view` of the RGBA `frame` (`width` × `height`) into `out`
/// (`out_width` × `out_height` RGBA), sampling bilinearly. When it shrinks
/// the frame, each output pixel averages a grid of samples across the
/// pixels it covers, so fine text does not shimmer.
pub fn draw_view(
    frame: &[u8],
    (width, height): (u32, u32),
    view: View,
    out: &mut [u8],
    (out_width, out_height): (u32, u32),
) {
    let [left, top, view_w, view_h] = view.rect(f64::from(width), f64::from(height));
    let step_x = view_w / f64::from(out_width);
    let step_y = view_h / f64::from(out_height);
    let taps_x = step_x.ceil().clamp(1.0, 4.0) as usize;
    let taps_y = step_y.ceil().clamp(1.0, 4.0) as usize;
    let (w, h) = (width as usize, height as usize);
    let (max_x, max_y) = (f64::from(width) - 1.0, f64::from(height) - 1.0);
    let sample = |x: f64, y: f64, sum: &mut [f64; 3]| {
        let x = x.clamp(0.0, max_x);
        let y = y.clamp(0.0, max_y);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        let (fx, fy) = (x - x0 as f64, y - y0 as f64);
        let at =
            |px: usize, py: usize, channel: usize| f64::from(frame[(py * w + px) * 4 + channel]);
        for (channel, total) in sum.iter_mut().enumerate() {
            let upper = at(x0, y0, channel) * (1.0 - fx) + at(x1, y0, channel) * fx;
            let lower = at(x0, y1, channel) * (1.0 - fx) + at(x1, y1, channel) * fx;
            *total += upper * (1.0 - fy) + lower * fy;
        }
    };
    let taps = (taps_x * taps_y) as f64;
    for row in 0..out_height as usize {
        for col in 0..out_width as usize {
            let mut sum = [0.0; 3];
            for ty in 0..taps_y {
                // The sample's place in the frame, pixel centres at .5.
                let y = top + (row as f64 + (ty as f64 + 0.5) / taps_y as f64) * step_y - 0.5;
                for tx in 0..taps_x {
                    let x = left + (col as f64 + (tx as f64 + 0.5) / taps_x as f64) * step_x - 0.5;
                    sample(x, y, &mut sum);
                }
            }
            let dst = (row * out_width as usize + col) * 4;
            for channel in 0..3 {
                out[dst + channel] = (sum[channel] / taps).round().clamp(0.0, 255.0) as u8;
            }
            out[dst + 3] = 255;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(start_ms: f64, end_ms: f64, scale: f64, x: f64, y: f64) -> Zoom {
        Zoom {
            start_ms,
            end_ms,
            scale,
            focus: Focus::Area { x, y },
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn zooms_read_as_the_page_writes_them() {
        let zooms: Vec<Zoom> = serde_json::from_str(
            r#"[{"id":"z1","startMs":2000,"endMs":4500,"scale":2,"focus":{"kind":"area","x":0.25,"y":0.75}},
                {"id":"z2","startMs":6000,"endMs":8000,"scale":1.5,"focus":{"kind":"cursor"}}]"#,
        )
        .unwrap();
        assert_eq!(zooms[0], area(2000.0, 4500.0, 2.0, 0.25, 0.75));
        assert_eq!(zooms[1].focus, Focus::Cursor);
        assert!(zooms.iter().all(|zoom| zoom.check().is_ok()));
        assert!(area(10.0, 10.0, 2.0, 0.5, 0.5).check().is_err());
        assert!(area(0.0, 900.0, 9.0, 0.5, 0.5).check().is_err());
        assert!(area(0.0, 900.0, 2.0, 1.5, 0.5).check().is_err());
    }

    #[test]
    fn a_zoom_eases_in_and_out_over_three_tenths_of_a_second() {
        let zoom = area(1000.0, 3000.0, 2.0, 0.5, 0.5);
        assert_eq!(zoom.strength(1000.0), 0.0);
        assert!(close(zoom.strength(1150.0), 0.5));
        assert_eq!(zoom.strength(1300.0), 1.0);
        assert_eq!(zoom.strength(2000.0), 1.0);
        assert!(close(zoom.strength(2850.0), 0.5));
        assert_eq!(zoom.strength(3000.0), 0.0);
        // Smoothstep: slow at either end of the ramp.
        assert!(close(zoom.strength(1075.0), 0.15625));
        // A zoom shorter than both ramps eases half way each.
        let short = area(0.0, 400.0, 2.0, 0.5, 0.5);
        assert_eq!(short.strength(200.0), 1.0);
        assert!(close(short.strength(100.0), 0.5));
    }

    #[test]
    fn the_view_scales_up_along_the_ease() {
        let zooms = [area(1000.0, 3000.0, 4.0, 0.5, 0.5)];
        assert_eq!(view_at(&zooms, 500.0, None), View::FULL);
        assert!(close(view_at(&zooms, 1150.0, None).scale, 2.0));
        assert!(close(view_at(&zooms, 2000.0, None).scale, 4.0));
        assert_eq!(view_at(&zooms, 3500.0, None), View::FULL);
    }

    #[test]
    fn the_view_stays_inside_the_frame() {
        assert_eq!(clamp_centre([0.0, 1.0], 2.0), [0.25, 0.75]);
        assert_eq!(clamp_centre([0.4, 0.6], 2.0), [0.4, 0.6]);
        assert_eq!(clamp_centre([0.0, 0.0], 1.0), [0.5, 0.5]);
        let zooms = [area(0.0, 2000.0, 2.0, 0.95, 0.02)];
        let view = view_at(&zooms, 1000.0, None);
        assert_eq!((view.x, view.y), (0.75, 0.25));
        let [left, top, w, h] = view.rect(1920.0, 1080.0);
        assert_eq!([left, top, w, h], [960.0, 0.0, 960.0, 540.0]);
        // Easing in from a corner, the view never leaves the frame either.
        for ms in (0..300).step_by(10) {
            let [left, top, w, h] = view_at(&zooms, f64::from(ms), None).rect(1920.0, 1080.0);
            assert!(left >= -1e-9 && top >= -1e-9, "{ms}");
            assert!(
                left + w <= 1920.0 + 1e-9 && top + h <= 1080.0 + 1e-9,
                "{ms}"
            );
        }
    }

    #[test]
    fn the_pointer_path_is_smoothed_without_lag() {
        // Still, then a jump to the far side: the path glides there, and
        // the forward-and-back filter starts the glide before the jump as
        // much as it finishes it after.
        let mut positions = vec![Some([0.0, 540.0]); 300];
        positions.extend(vec![Some([1920.0, 540.0]); 300]);
        let points = smooth(&positions, 1920.0, 1080.0, 60).unwrap();
        assert_eq!(points.len(), 600);
        assert!(points.windows(2).all(|pair| pair[1][0] >= pair[0][0]));
        assert!(points[0][0] < 1e-4 && points[599][0] > 1.0 - 1e-4);
        assert!(points[299][0] > 0.1 && points[299][0] < 0.5);
        assert!((points[299][0] + points[300][0] - 1.0).abs() < 1e-4);
        assert!(points.iter().all(|point| point[1] == 0.5));
    }

    #[test]
    fn gaps_and_strays_in_the_pointer_path_are_filled_and_held_in() {
        let positions = [None, Some([-200.0, 2000.0]), None, None];
        let points = smooth(&positions, 1920.0, 1080.0, 30).unwrap();
        assert_eq!(points, vec![[0.0, 1.0]; 4]);
        assert_eq!(smooth(&[None, None], 1920.0, 1080.0, 30), None);
        assert_eq!(smooth(&[], 1920.0, 1080.0, 30), None);
    }

    #[test]
    fn the_pointer_is_found_between_frames() {
        let path = CursorPath {
            fps: 10,
            points: vec![[0.0, 0.0], [0.5, 1.0], [1.0, 1.0]],
        };
        assert_eq!(path.at(0.0), Some([0.0, 0.0]));
        assert_eq!(path.at(50.0), Some([0.25, 0.5]));
        assert_eq!(path.at(150.0), Some([0.75, 1.0]));
        assert_eq!(path.at(9000.0), Some([1.0, 1.0]));
        assert_eq!(path.at(-10.0), Some([0.0, 0.0]));
        let empty = CursorPath {
            fps: 10,
            points: Vec::new(),
        };
        assert_eq!(empty.at(0.0), None);
    }

    #[test]
    fn a_pointer_zoom_follows_the_path_inside_the_frame() {
        let mut points = vec![[0.3, 0.4]; 6];
        points.extend([[1.0, 0.0]; 5]);
        let path = CursorPath { fps: 10, points };
        let zooms = [Zoom {
            start_ms: 0.0,
            end_ms: 2000.0,
            scale: 2.0,
            focus: Focus::Cursor,
        }];
        let view = view_at(&zooms, 400.0, Some(&path));
        assert_eq!((view.scale, view.x, view.y), (2.0, 0.3, 0.4));
        // At the frame's edge, the view stops at it.
        let view = view_at(&zooms, 1000.0, Some(&path));
        assert_eq!((view.scale, view.x, view.y), (2.0, 0.75, 0.25));
        // No path: the centre of the frame.
        let view = view_at(&zooms, 1000.0, None);
        assert_eq!((view.x, view.y), (0.5, 0.5));
    }

    #[test]
    fn the_sidecar_is_read_and_smoothed() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("clip.mp4");
        assert_eq!(CursorPath::load(&video), None);
        fs::write(
            dir.path().join("clip.cursor.json"),
            r#"{"version":1,"width":200,"height":100,"fps":30,"positions":[[50,25],null,[50,25]]}"#,
        )
        .unwrap();
        let path = CursorPath::load(&video).unwrap();
        assert_eq!(path.fps, 30);
        assert_eq!(path.points, vec![[0.25, 0.25]; 3]);
        fs::write(
            dir.path().join("clip.cursor.json"),
            r#"{"version":1,"width":200,"height":100,"fps":30,"positions":[null]}"#,
        )
        .unwrap();
        assert_eq!(CursorPath::load(&video), None);
    }

    #[test]
    fn a_view_is_drawn_from_its_part_of_the_frame() {
        // A 4×2 frame: left half red, right half blue.
        let red = [255, 0, 0, 255];
        let blue = [0, 0, 255, 255];
        let frame: Vec<u8> = (0..2)
            .flat_map(|_| [red, red, blue, blue].concat())
            .collect();
        let mut out = vec![0; 2 * 2 * 4];
        // The whole frame, halved: one red and one blue column.
        draw_view(&frame, (4, 2), View::FULL, &mut out, (2, 2));
        assert_eq!(&out[0..4], &red);
        assert_eq!(&out[4..8], &blue);
        // Twice as large on the right half: all blue.
        let view = View {
            scale: 2.0,
            x: 0.75,
            y: 0.5,
        };
        draw_view(&frame, (4, 2), view, &mut out, (2, 2));
        assert!(out.chunks(4).all(|pixel| pixel == blue));
    }
}
