//! The webcam bubble: with Show webcam on, a small borderless window shows
//! the camera over the recorded area while a recording runs, so it is
//! recorded along with the screen. It opens at the area's bottom-right
//! corner, can be dragged anywhere, and closes when the recording stops.
//! The window is a little larger than the bubble: the see-through room
//! around it is where the bubble's shadow falls.
//!
//! The page (src/webcam/) shows the camera with getUserMedia, so each
//! webview has to be allowed to use it: WebKitGTK only offers media
//! streams once they are turned on, and WebKitGTK and WebView2 ask before
//! a page may use the camera. [`allow_camera`] grants it to Grab-it's own
//! pages, and [`enable_media_streams`] turns them on. macOS asks for the
//! camera itself the first time, with Info.plist's `NSCameraUsageDescription`.
//!
//! The cameras' names are remembered in [`CAMERAS_FILE`], so the setup
//! toolbar can list them without turning a camera on: a webview names its
//! cameras only once one has been opened.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
    webview::{PermissionKind, PermissionResponse},
};

use crate::{
    capture::Rect,
    screen::MonitorInfo,
    settings::{RecordingSettings, WebcamShape},
};

pub const LABEL: &str = "webcam";
/// The cameras last listed with their names, in the app data dir.
const CAMERAS_FILE: &str = "cameras.json";
/// The bubble's size, in points, when the recorded area has room for it: a
/// round or square bubble's side. Other shapes take about the same area.
const SIZE: f64 = 200.0;
/// The most of the recorded area's shorter side the bubble takes up, so it
/// never hides most of a small recording.
const MAX_SHARE: f64 = 0.4;
/// The bubble never shrinks below this many points, unless the recorded
/// area itself is smaller.
const MIN_SIZE: f64 = 72.0;
/// The gap between the bubble and the recorded area's edges, in points.
const MARGIN: f64 = 24.0;
/// The see-through room around the bubble for its shadow, in points: the
/// page draws the bubble this far in from the window's edges (webcam.css).
/// It is no more than [`MARGIN`], so the shadow stays in the recorded area.
const SHADOW_ROOM: f64 = 24.0;

/// A bubble of `shape`'s width and height, as a share of its size.
fn proportions(shape: WebcamShape) -> (f64, f64) {
    match shape {
        WebcamShape::Squircle | WebcamShape::Round | WebcamShape::Blob => (1.0, 1.0),
        WebcamShape::Arch => (0.88, 1.10),
        WebcamShape::Pill => (0.84, 1.20),
        WebcamShape::Wide => (1.28, 0.80),
    }
}

/// A camera the webview listed by name. Mirrors `Camera` in
/// src/settings/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Camera {
    /// The webview's `deviceId`, as `RecordingSettings::camera` saves it.
    pub id: String,
    pub name: String,
}

fn cameras_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(CAMERAS_FILE))
}

/// The cameras saved at `path`; none when the file is missing or unreadable.
fn read_cameras(path: &Path) -> Vec<Camera> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Saves `cameras` at `path`, making its folder first.
fn write_cameras(path: &Path, cameras: &[Camera]) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(cameras).map_err(|err| err.to_string())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    fs::write(path, json).map_err(|err| err.to_string())
}

/// The cameras last listed with their names.
#[tauri::command]
pub fn known_cameras(app: AppHandle) -> Vec<Camera> {
    cameras_path(&app)
        .map(|path| read_cameras(&path))
        .unwrap_or_default()
}

/// Remembers `cameras`, a listing in which every camera had its name.
#[tauri::command]
pub fn remember_cameras(app: AppHandle, cameras: Vec<Camera>) -> Result<(), String> {
    let path = cameras_path(&app).ok_or("Grab-it has no data folder to remember the cameras in.")?;
    write_cameras(&path, &cameras)
}

/// Lets a window's page use the camera, and nothing else it asks for that
/// the webview would otherwise prompt for.
pub fn allow_camera<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder.on_permission_request(|_, kind| match kind {
        PermissionKind::Camera => PermissionResponse::Allow,
        _ => PermissionResponse::Default,
    })
}

/// WebKitGTK leaves `navigator.mediaDevices` out unless media streams are
/// turned on. The setting is read when a page loads, so a page already
/// loading is loaded again. Other webviews always have them.
pub fn enable_media_streams<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    window.with_webview(|webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        let view = webview.inner();
        let Some(settings) = WebViewExt::settings(&view) else {
            return;
        };
        if !settings.enables_media_stream() {
            settings.set_enable_media_stream(true);
            view.reload();
        }
    })?;
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    Ok(())
}

/// Opens the bubble over `rect`, an area of `monitor`'s image of
/// `image_size` pixels, as `recording` says. Call this off the main thread.
pub fn open(
    app: &AppHandle,
    monitor: &MonitorInfo,
    image_size: (u32, u32),
    rect: Rect,
    recording: &RecordingSettings,
) {
    if let Err(err) = try_open(app, monitor, image_size, rect, recording) {
        eprintln!("Grab-it: could not show the webcam: {err}");
    }
}

fn try_open(
    app: &AppHandle,
    monitor: &MonitorInfo,
    image_size: (u32, u32),
    rect: Rect,
    recording: &RecordingSettings,
) -> tauri::Result<()> {
    // One recording at a time, so a bubble left over is from the last one.
    close(app);
    let placements = app.available_monitors().unwrap_or_default();
    let (origin, size) = crate::overlay::placement_for(monitor, &placements);
    let (area_origin, area_size) = screen_area(
        rect,
        image_size,
        (origin.x, origin.y),
        (size.width, size.height),
    );
    let (bubble, bubble_size) = place(
        area_origin,
        area_size,
        monitor.scale_factor,
        recording.webcam_shape,
    );
    let (position, size) = with_shadow_room(bubble, bubble_size, monitor.scale_factor);

    let builder =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(page_url(recording).into()))
            .title("Grab-it webcam")
            // Built at its size: GTK keeps a window that may not be resized at the
            // size it was built with, and ignores a later set_size.
            .inner_size(
                logical(size.width, monitor.scale_factor),
                logical(size.height, monitor.scale_factor),
            )
            .decorations(false)
            // See-through, so only the bubble and its shadow show.
            .transparent(true)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            // The bubble must not pull the keyboard away from what is recorded.
            .focused(false)
            .shadow(false)
            .visible(false);
    let window = allow_camera(builder).build()?;
    enable_media_streams(&window)?;
    // Sized again in physical pixels, for a monitor whose scale differs
    // from the one the window was built on, and before it is placed:
    // macOS resizes a window around its bottom-left corner (see overlay.rs).
    window.set_size(size)?;
    window.set_position(position)?;
    window.show()?;
    Ok(())
}

/// `length` physical pixels in logical pixels at `scale`.
fn logical(length: u32, scale: f64) -> f64 {
    f64::from(length) / sane_scale(scale)
}

/// `scale`, or 1 when it is not a usable scale factor.
fn sane_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// Closes the bubble, if it is open.
pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL)
        && let Err(err) = window.destroy()
    {
        eprintln!("Grab-it: could not close the webcam: {err}");
    }
}

/// The bubble's page, told the shape, whether to mirror and the camera in
/// its hash, so it needs nothing from the backend.
fn page_url(recording: &RecordingSettings) -> String {
    let mut url = format!(
        "index.html#/webcam?shape={}",
        recording.webcam_shape.as_str()
    );
    if !recording.mirror_webcam {
        url.push_str("&mirror=0");
    }
    if let Some(camera) = &recording.camera {
        url.push_str("&camera=");
        url.push_str(&encode_component(camera));
    }
    url
}

/// Percent-encodes everything but the unreserved characters, as
/// `encodeURIComponent` does, so `URLSearchParams` reads it back as it was.
fn encode_component(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// The recorded area on screen, in physical pixels: `rect` is in the
/// pixels of the monitor's image of `image_size`, and the monitor covers
/// `monitor_size` from `monitor_origin` on screen. The two sizes differ
/// where the image is in a different unit from the screen's.
pub fn screen_area(
    rect: Rect,
    image_size: (u32, u32),
    monitor_origin: (i32, i32),
    monitor_size: (u32, u32),
) -> ((i32, i32), (u32, u32)) {
    let ratio = |screen: u32, image: u32| {
        if image == 0 {
            1.0
        } else {
            f64::from(screen) / f64::from(image)
        }
    };
    let (sx, sy) = (
        ratio(monitor_size.0, image_size.0),
        ratio(monitor_size.1, image_size.1),
    );
    (
        (
            monitor_origin.0 + (f64::from(rect.x) * sx).round() as i32,
            monitor_origin.1 + (f64::from(rect.y) * sy).round() as i32,
        ),
        (
            (f64::from(rect.width) * sx).round() as u32,
            (f64::from(rect.height) * sy).round() as u32,
        ),
    )
}

/// Where the bubble's top-left corner goes and its width and height, in
/// physical pixels, for a `shape` bubble over a recorded area at `origin`
/// of `size` on a monitor at `scale`: in the bottom-right corner, inside
/// the area, so it is recorded.
pub fn place(
    origin: (i32, i32),
    size: (u32, u32),
    scale: f64,
    shape: WebcamShape,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let scale = sane_scale(scale);
    let (area_width, area_height) = (f64::from(size.0), f64::from(size.1));
    let shorter = area_width.min(area_height);
    let side = (SIZE * scale)
        .min(shorter * MAX_SHARE)
        .max((MIN_SIZE * scale).min(shorter));
    // A shape that is not square shrinks, keeping its proportions, where
    // it would not fit the area.
    let (share_x, share_y) = proportions(shape);
    let fit = (area_width / (side * share_x))
        .min(area_height / (side * share_y))
        .min(1.0);
    let width = (side * share_x * fit).round().max(1.0);
    let height = (side * share_y * fit).round().max(1.0);
    // The margin shrinks with a small area, so the bubble stays inside it.
    let margin = (MARGIN * scale)
        .min(((area_width - width) / 2.0).max(0.0))
        .min(((area_height - height) / 2.0).max(0.0))
        .round();
    let x = f64::from(origin.0) + area_width - width - margin;
    let y = f64::from(origin.1) + area_height - height - margin;
    (
        PhysicalPosition::new(
            (x.round() as i32).max(origin.0),
            (y.round() as i32).max(origin.1),
        ),
        PhysicalSize::new(width as u32, height as u32),
    )
}

/// The window around a bubble at `position` of `size`, in physical pixels
/// on a monitor at `scale`: [`SHADOW_ROOM`] larger on every side, so the
/// bubble itself stays where [`place`] put it.
pub fn with_shadow_room(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let room = (SHADOW_ROOM * sane_scale(scale)).round() as u32;
    (
        PhysicalPosition::new(position.x - room as i32, position.y - room as i32),
        PhysicalSize::new(size.width + 2 * room, size.height + 2 * room),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A round bubble's position and side.
    fn place_round(
        origin: (i32, i32),
        size: (u32, u32),
        scale: f64,
    ) -> (PhysicalPosition<i32>, u32) {
        let (position, bubble) = place(origin, size, scale, WebcamShape::Round);
        assert_eq!(bubble.width, bubble.height);
        (position, bubble.width)
    }

    #[test]
    fn opens_in_the_bottom_right_corner_of_the_area() {
        let (position, side) = place_round((100, 50), (1280, 720), 1.0);
        assert_eq!(side, 200);
        assert_eq!(
            position,
            PhysicalPosition::new(100 + 1280 - 200 - 24, 50 + 720 - 200 - 24)
        );
    }

    #[test]
    fn grows_with_the_scale_factor() {
        let (position, side) = place_round((0, 0), (2560, 1440), 2.0);
        assert_eq!(side, 400);
        assert_eq!(
            position,
            PhysicalPosition::new(2560 - 400 - 48, 1440 - 400 - 48)
        );
    }

    #[test]
    fn shrinks_to_fit_a_small_area_and_stays_inside_it() {
        // 40% of 300 is 120, under the full 200.
        let (position, side) = place_round((10, 20), (500, 300), 1.0);
        assert_eq!(side, 120);
        assert_eq!(
            position,
            PhysicalPosition::new(10 + 500 - 120 - 24, 20 + 300 - 120 - 24)
        );

        // Never below 72 points...
        let (_, side) = place_round((0, 0), (150, 150), 1.0);
        assert_eq!(side, 72);
        // ...unless the area is smaller still, and then the margin goes.
        let (position, side) = place_round((5, 5), (60, 40), 1.0);
        assert_eq!(side, 40);
        assert_eq!(position, PhysicalPosition::new(5 + 60 - 40, 5));
    }

    #[test]
    fn takes_about_the_same_area_whatever_its_shape() {
        let area = ((100, 50), (1280, 720));
        for (shape, width, height) in [
            (WebcamShape::Squircle, 200, 200),
            (WebcamShape::Blob, 200, 200),
            (WebcamShape::Arch, 176, 220),
            (WebcamShape::Pill, 168, 240),
            (WebcamShape::Wide, 256, 160),
        ] {
            let (position, size) = place(area.0, area.1, 1.0, shape);
            assert_eq!(size, PhysicalSize::new(width, height), "{shape:?}");
            assert_eq!(
                position,
                PhysicalPosition::new(
                    100 + 1280 - width as i32 - 24,
                    50 + 720 - height as i32 - 24
                ),
                "{shape:?}"
            );
        }
    }

    #[test]
    fn a_tall_or_wide_shape_shrinks_to_fit_a_narrow_area() {
        // At its smallest, 72 points, a pill is 86 points tall: more than
        // this area's 80, so it shrinks to fit, keeping its proportions.
        let (position, size) = place((0, 0), (400, 80), 1.0, WebcamShape::Pill);
        assert_eq!(size, PhysicalSize::new(56, 80));
        assert_eq!(position, PhysicalPosition::new(400 - 56, 0));
        let (_, size) = place((0, 0), (80, 400), 1.0, WebcamShape::Wide);
        assert_eq!(size, PhysicalSize::new(80, 50));
    }

    #[test]
    fn leaves_room_around_the_bubble_for_its_shadow() {
        let (position, size) = with_shadow_room(
            PhysicalPosition::new(1056, 496),
            PhysicalSize::new(200, 200),
            1.0,
        );
        assert_eq!(position, PhysicalPosition::new(1032, 472));
        assert_eq!(size, PhysicalSize::new(248, 248));
        let (position, size) = with_shadow_room(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(352, 512),
            2.0,
        );
        assert_eq!(position, PhysicalPosition::new(-48, -48));
        assert_eq!(size, PhysicalSize::new(448, 608));
    }

    #[test]
    fn is_built_at_its_side_in_logical_pixels() {
        let (_, side) = place_round((0, 0), (2560, 1440), 2.0);
        assert_eq!(logical(side, 2.0), 200.0);
        let (_, side) = place_round((460, 80), (920, 560), 1.0);
        assert_eq!(logical(side, 1.0), 200.0);
        assert_eq!(logical(150, 1.5), 100.0);
        assert_eq!(logical(200, f64::NAN), 200.0);
        assert_eq!(logical(200, 0.0), 200.0);
    }

    #[test]
    fn a_bad_scale_counts_as_one() {
        assert_eq!(
            place_round((0, 0), (1000, 1000), f64::NAN),
            place_round((0, 0), (1000, 1000), 1.0)
        );
        assert_eq!(
            place_round((0, 0), (1000, 1000), 0.0),
            place_round((0, 0), (1000, 1000), 1.0)
        );
    }

    #[test]
    fn maps_the_area_from_image_pixels_to_the_screen() {
        let rect = Rect {
            x: 200,
            y: 100,
            width: 800,
            height: 600,
        };
        // Image and screen in the same pixels, on a second monitor.
        assert_eq!(
            screen_area(rect, (1920, 1080), (1920, 0), (1920, 1080)),
            ((2120, 100), (800, 600))
        );
        // A 2x image of a screen measured in points.
        assert_eq!(
            screen_area(rect, (2880, 1800), (0, 0), (1440, 900)),
            ((100, 50), (400, 300))
        );
        // An empty image leaves the numbers as they are.
        assert_eq!(
            screen_area(rect, (0, 0), (-1280, 0), (1280, 1024)),
            ((-1080, 100), (800, 600))
        );
    }

    #[test]
    fn remembers_the_cameras_listed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data").join(CAMERAS_FILE);
        assert_eq!(read_cameras(&path), Vec::new());
        let cameras = vec![
            Camera {
                id: "cam-1".into(),
                name: "FaceTime HD Camera".into(),
            },
            Camera {
                id: "cam-2".into(),
                name: "Logitech BRIO".into(),
            },
        ];
        write_cameras(&path, &cameras).unwrap();
        assert_eq!(read_cameras(&path), cameras);
        write_cameras(&path, &[]).unwrap();
        assert_eq!(read_cameras(&path), Vec::new());
    }

    #[test]
    fn an_unreadable_camera_list_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CAMERAS_FILE);
        fs::write(&path, b"{not json").unwrap();
        assert_eq!(read_cameras(&path), Vec::new());
        fs::write(&path, br#"[{"id":"cam-1"}]"#).unwrap();
        assert_eq!(read_cameras(&path), Vec::new());
    }

    #[test]
    fn the_page_is_told_the_shape_and_the_camera() {
        let recording = RecordingSettings::default();
        assert_eq!(page_url(&recording), "index.html#/webcam?shape=squircle");
        let recording = RecordingSettings {
            webcam_shape: WebcamShape::Arch,
            mirror_webcam: false,
            camera: Some("a b/c+d=é".into()),
            ..RecordingSettings::default()
        };
        assert_eq!(
            page_url(&recording),
            "index.html#/webcam?shape=arch&mirror=0&camera=a%20b%2Fc%2Bd%3D%C3%A9"
        );
    }
}
