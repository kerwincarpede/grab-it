//! Saving captures: file naming, cropping, scale conversion, stitching and
//! the `meta.json` sidecar. Everything here is platform independent; the
//! screen grabbing itself lives in `screen.rs` and `portal.rs`.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Local};
use image::{RgbaImage, imageops};
use serde::{Deserialize, Serialize};

pub const ORIGINALS_DIR: &str = "originals";
pub const META_SUFFIX: &str = ".meta.json";
pub const ANNOTATIONS_SUFFIX: &str = ".annotations.json";

/// What the user asked to capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureMode {
    Region,
    Window,
    /// Every monitor, stitched into one image.
    Screen,
    /// A single monitor.
    Monitor,
}

/// A rectangle in some pixel space.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// A rectangle in CSS pixels of an overlay window, as the frontend sends it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Converts a selection in an overlay's CSS pixels into image pixels.
///
/// `scale` is image pixels per CSS pixel: the monitor's scale factor, or
/// better the frozen image width over the overlay's viewport width, which
/// stays right when monitors have different scale factors. The edges are
/// rounded outwards and the result is clipped to the image, so it may be
/// empty (`None`).
pub fn css_to_image_rect(rect: CssRect, scale: f64, image_size: (u32, u32)) -> Option<Rect> {
    if !(scale.is_finite() && scale > 0.0) {
        return None;
    }
    let (x0, x1) = ordered(rect.x, rect.x + rect.width);
    let (y0, y1) = ordered(rect.y, rect.y + rect.height);
    let left = (x0 * scale).floor().max(0.0);
    let top = (y0 * scale).floor().max(0.0);
    let right = (x1 * scale).ceil().min(f64::from(image_size.0));
    let bottom = (y1 * scale).ceil().min(f64::from(image_size.1));
    if right <= left || bottom <= top {
        return None;
    }
    Some(Rect {
        x: left as i32,
        y: top as i32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

fn ordered(a: f64, b: f64) -> (f64, f64) {
    if a <= b { (a, b) } else { (b, a) }
}

/// The scale between a frozen image and the overlay showing it.
pub fn image_scale(image_width: u32, viewport_width: f64, fallback: f64) -> f64 {
    if viewport_width.is_finite() && viewport_width > 0.0 && image_width > 0 {
        f64::from(image_width) / viewport_width
    } else {
        fallback
    }
}

/// Intersects `rect` with an image of `size`. `None` when nothing is left.
pub fn clip_rect(rect: Rect, size: (u32, u32)) -> Option<Rect> {
    let left = i64::from(rect.x).max(0);
    let top = i64::from(rect.y).max(0);
    let right = (i64::from(rect.x) + i64::from(rect.width)).min(i64::from(size.0));
    let bottom = (i64::from(rect.y) + i64::from(rect.height)).min(i64::from(size.1));
    if right <= left || bottom <= top {
        return None;
    }
    Some(Rect {
        x: left as i32,
        y: top as i32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

/// Copies `rect` out of `image`, clipped to its bounds.
pub fn crop(image: &RgbaImage, rect: Rect) -> Option<RgbaImage> {
    let rect = clip_rect(rect, image.dimensions())?;
    Some(
        imageops::crop_imm(image, rect.x as u32, rect.y as u32, rect.width, rect.height).to_image(),
    )
}

/// One monitor's image and where the monitor sits on the desktop, in the
/// coordinate space the platform reports monitor positions in.
pub struct Tile<'a> {
    pub x: i32,
    pub y: i32,
    /// Monitor size in desktop coordinates. On macOS these are points, so
    /// the image can be larger than this.
    pub width: u32,
    pub height: u32,
    pub image: &'a RgbaImage,
}

/// Where each tile lands in the stitched image, and the image's size.
///
/// The output uses the densest monitor's pixels per desktop unit, so no
/// monitor loses detail; less dense monitors are scaled up.
pub fn stitch_layout(tiles: &[Tile<'_>]) -> Option<((u32, u32), Vec<Rect>)> {
    let min_x = tiles.iter().map(|t| t.x).min()?;
    let min_y = tiles.iter().map(|t| t.y).min()?;
    let max_x = tiles.iter().map(|t| t.x + t.width as i32).max()?;
    let max_y = tiles.iter().map(|t| t.y + t.height as i32).max()?;
    let density = tiles
        .iter()
        .filter(|t| t.width > 0)
        .map(|t| f64::from(t.image.width()) / f64::from(t.width))
        .fold(1.0_f64, f64::max);
    let px = |v: i32| (f64::from(v) * density).round() as i32;
    let size = (px(max_x - min_x) as u32, px(max_y - min_y) as u32);
    let places = tiles
        .iter()
        .map(|t| Rect {
            x: px(t.x - min_x),
            y: px(t.y - min_y),
            width: px(t.width as i32) as u32,
            height: px(t.height as i32) as u32,
        })
        .collect();
    Some((size, places))
}

/// Joins every monitor's image into one, following the desktop layout.
/// Gaps between monitors stay transparent.
pub fn stitch(tiles: &[Tile<'_>]) -> Option<RgbaImage> {
    let (size, places) = stitch_layout(tiles)?;
    let mut out = RgbaImage::new(size.0.max(1), size.1.max(1));
    for (tile, place) in tiles.iter().zip(places) {
        let resized;
        let image = if tile.image.dimensions() == (place.width, place.height) {
            tile.image
        } else {
            resized = imageops::resize(
                tile.image,
                place.width.max(1),
                place.height.max(1),
                imageops::FilterType::Triangle,
            );
            &resized
        };
        imageops::replace(&mut out, image, i64::from(place.x), i64::from(place.y));
    }
    Some(out)
}

/// The file name for a capture taken at `time`, without a folder.
pub fn capture_file_name(time: &DateTime<Local>, counter: u32) -> String {
    let stamp = time.format("%Y-%m-%d %H-%M-%S");
    if counter <= 1 {
        format!("Grab-it {stamp}.png")
    } else {
        format!("Grab-it {stamp} ({counter}).png")
    }
}

/// A free path in `dir` for a capture taken at `time`. Captures in the same
/// second get ` (2)`, ` (3)`, … appended.
pub fn unique_capture_path(dir: &Path, time: &DateTime<Local>) -> PathBuf {
    let mut counter = 1;
    loop {
        let path = dir.join(capture_file_name(time, counter));
        if !path.exists() {
            return path;
        }
        counter += 1;
    }
}

/// The sidecar path for a capture: `<name>.png` gives `<name>.meta.json`.
pub fn meta_path(png: &Path) -> PathBuf {
    sidecar_path(png, META_SUFFIX)
}

/// The annotations sidecar: `<name>.png` gives `<name>.annotations.json`.
pub fn annotations_path(png: &Path) -> PathBuf {
    sidecar_path(png, ANNOTATIONS_SUFFIX)
}

fn sidecar_path(png: &Path, suffix: &str) -> PathBuf {
    let stem = png
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    png.with_file_name(format!("{stem}{suffix}"))
}

/// What is known about the capture, written beside it as `meta.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMeta {
    pub version: u32,
    /// RFC 3339 local time.
    pub captured_at: String,
    pub mode: CaptureMode,
    /// The foreground application when the capture started.
    pub app: Option<String>,
    /// The foreground window's title when the capture started.
    pub window_title: Option<String>,
    pub width: u32,
    pub height: u32,
}

/// The foreground application and window when a capture started.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Foreground {
    pub app: Option<String>,
    pub window_title: Option<String>,
}

/// The files written for one capture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCapture {
    pub path: PathBuf,
    pub meta_path: PathBuf,
}

#[derive(Debug)]
pub enum SaveError {
    Io(io::Error),
    Image(image::ImageError),
    Json(serde_json::Error),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "could not save the capture: {err}"),
            Self::Image(err) => write!(f, "could not encode the capture: {err}"),
            Self::Json(err) => write!(f, "could not write capture details: {err}"),
        }
    }
}

impl std::error::Error for SaveError {}

impl From<io::Error> for SaveError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<image::ImageError> for SaveError {
    fn from(err: image::ImageError) -> Self {
        Self::Image(err)
    }
}

impl From<serde_json::Error> for SaveError {
    fn from(err: serde_json::Error) -> Self {
        Self::Json(err)
    }
}

/// Saves `image` as a timestamped PNG in `<save_folder>/originals/`, with
/// its `meta.json` sidecar beside it.
pub fn save_capture(
    save_folder: &Path,
    image: &RgbaImage,
    mode: CaptureMode,
    foreground: &Foreground,
    time: DateTime<Local>,
) -> Result<SavedCapture, SaveError> {
    let dir = save_folder.join(ORIGINALS_DIR);
    fs::create_dir_all(&dir)?;
    let path = unique_capture_path(&dir, &time);
    image.save_with_format(&path, image::ImageFormat::Png)?;

    let meta = CaptureMeta {
        version: 1,
        captured_at: time.to_rfc3339(),
        mode,
        app: foreground.app.clone(),
        window_title: foreground.window_title.clone(),
        width: image.width(),
        height: image.height(),
    };
    let meta_path = meta_path(&path);
    let mut json = serde_json::to_string_pretty(&meta)?;
    json.push('\n');
    fs::write(&meta_path, json)?;
    Ok(SavedCapture { path, meta_path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use image::Rgba;
    use tempfile::TempDir;

    fn time() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 3, 7, 9, 5, 1).unwrap()
    }

    fn css(x: f64, y: f64, width: f64, height: f64) -> CssRect {
        CssRect {
            x,
            y,
            width,
            height,
        }
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn file_names_are_timestamped_and_sortable() {
        assert_eq!(
            capture_file_name(&time(), 1),
            "Grab-it 2026-03-07 09-05-01.png"
        );
        assert_eq!(
            capture_file_name(&time(), 3),
            "Grab-it 2026-03-07 09-05-01 (3).png"
        );
    }

    #[test]
    fn captures_in_the_same_second_get_a_counter() {
        let dir = TempDir::new().unwrap();
        let first = unique_capture_path(dir.path(), &time());
        fs::write(&first, b"").unwrap();
        let second = unique_capture_path(dir.path(), &time());
        assert_eq!(
            second.file_name().unwrap(),
            "Grab-it 2026-03-07 09-05-01 (2).png"
        );
    }

    #[test]
    fn meta_path_sits_beside_the_png() {
        assert_eq!(
            meta_path(Path::new("/x/originals/Grab-it 2026-03-07 09-05-01.png")),
            PathBuf::from("/x/originals/Grab-it 2026-03-07 09-05-01.meta.json")
        );
    }

    #[test]
    fn scale_one_keeps_css_pixels() {
        assert_eq!(
            css_to_image_rect(css(10.0, 20.0, 30.0, 40.0), 1.0, (100, 100)),
            Some(rect(10, 20, 30, 40))
        );
    }

    #[test]
    fn hidpi_scales_and_rounds_outwards() {
        assert_eq!(
            css_to_image_rect(css(10.0, 20.0, 30.0, 40.0), 2.0, (400, 400)),
            Some(rect(20, 40, 60, 80))
        );
        // 1.5x: 3.3 * 1.5 = 4.95 floors to 4; (3.3 + 10) * 1.5 = 19.95 ceils to 20.
        assert_eq!(
            css_to_image_rect(css(3.3, 0.0, 10.0, 10.0), 1.5, (400, 400)),
            Some(rect(4, 0, 16, 15))
        );
    }

    #[test]
    fn reversed_drags_are_normalised() {
        assert_eq!(
            css_to_image_rect(css(40.0, 60.0, -30.0, -40.0), 1.0, (100, 100)),
            Some(rect(10, 20, 30, 40))
        );
    }

    #[test]
    fn selections_are_clipped_to_the_image() {
        assert_eq!(
            css_to_image_rect(css(-5.0, 90.0, 20.0, 50.0), 1.0, (100, 100)),
            Some(rect(0, 90, 15, 10))
        );
        assert_eq!(
            css_to_image_rect(css(200.0, 0.0, 10.0, 10.0), 1.0, (100, 100)),
            None
        );
        assert_eq!(
            css_to_image_rect(css(5.0, 5.0, 0.0, 10.0), 1.0, (100, 100)),
            None
        );
        assert_eq!(
            css_to_image_rect(css(5.0, 5.0, 1.0, 1.0), 0.0, (100, 100)),
            None
        );
    }

    #[test]
    fn image_scale_follows_the_viewport_on_mixed_monitors() {
        // A 2x monitor: 2880 px shown in a 1440 CSS px wide overlay.
        assert_eq!(image_scale(2880, 1440.0, 1.0), 2.0);
        // A 1.25x monitor next to it.
        assert_eq!(image_scale(1920, 1536.0, 1.0), 1.25);
        assert_eq!(image_scale(1920, 0.0, 1.5), 1.5);
    }

    #[test]
    fn crop_copies_the_pixels_inside_the_rect() {
        let mut image = RgbaImage::new(4, 4);
        image.put_pixel(2, 1, Rgba([255, 0, 0, 255]));
        let cropped = crop(&image, rect(2, 1, 2, 2)).unwrap();
        assert_eq!(cropped.dimensions(), (2, 2));
        assert_eq!(cropped.get_pixel(0, 0), &Rgba([255, 0, 0, 255]));
        assert_eq!(crop(&image, rect(3, 3, 5, 5)).unwrap().dimensions(), (1, 1));
        assert!(crop(&image, rect(-5, 0, 5, 4)).is_none());
    }

    #[test]
    fn stitching_follows_the_desktop_layout() {
        let left = RgbaImage::from_pixel(2, 2, Rgba([1, 0, 0, 255]));
        let right = RgbaImage::from_pixel(3, 1, Rgba([2, 0, 0, 255]));
        let tiles = [
            Tile {
                x: -2,
                y: 0,
                width: 2,
                height: 2,
                image: &left,
            },
            Tile {
                x: 0,
                y: 1,
                width: 3,
                height: 1,
                image: &right,
            },
        ];
        let out = stitch(&tiles).unwrap();
        assert_eq!(out.dimensions(), (5, 2));
        assert_eq!(out.get_pixel(0, 0), &Rgba([1, 0, 0, 255]));
        assert_eq!(out.get_pixel(4, 1), &Rgba([2, 0, 0, 255]));
        // The gap above the right monitor stays transparent.
        assert_eq!(out.get_pixel(4, 0), &Rgba([0, 0, 0, 0]));
    }

    #[test]
    fn stitching_uses_the_densest_monitor() {
        // A Retina monitor (2 px per point) beside a 1x one.
        let retina = RgbaImage::new(4, 4);
        let plain = RgbaImage::new(2, 2);
        let tiles = [
            Tile {
                x: 0,
                y: 0,
                width: 2,
                height: 2,
                image: &retina,
            },
            Tile {
                x: 2,
                y: 0,
                width: 2,
                height: 2,
                image: &plain,
            },
        ];
        let (size, places) = stitch_layout(&tiles).unwrap();
        assert_eq!(size, (8, 4));
        assert_eq!(places, vec![rect(0, 0, 4, 4), rect(4, 0, 4, 4)]);
        assert!(stitch_layout(&[]).is_none());
    }

    #[test]
    fn save_writes_the_png_and_its_sidecar() {
        let dir = TempDir::new().unwrap();
        let image = RgbaImage::from_pixel(3, 2, Rgba([9, 8, 7, 255]));
        let foreground = Foreground {
            app: Some("firefox".into()),
            window_title: Some("Docs".into()),
        };

        let saved =
            save_capture(dir.path(), &image, CaptureMode::Region, &foreground, time()).unwrap();

        assert_eq!(saved.path.parent().unwrap(), dir.path().join(ORIGINALS_DIR));
        assert_eq!(image::open(&saved.path).unwrap().to_rgba8(), image);
        let meta: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&saved.meta_path).unwrap()).unwrap();
        assert_eq!(meta["version"], 1);
        assert_eq!(meta["mode"], "region");
        assert_eq!(meta["app"], "firefox");
        assert_eq!(meta["windowTitle"], "Docs");
        assert_eq!(meta["width"], 3);
        assert_eq!(meta["height"], 2);
        assert!(
            meta["capturedAt"]
                .as_str()
                .unwrap()
                .starts_with("2026-03-07T09:05:01")
        );
    }
}
