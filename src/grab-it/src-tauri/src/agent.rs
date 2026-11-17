//! What the `grab-it` command line asks the running app to do, once
//! `control.rs` has let a request in: list the displays and windows, and
//! take screenshots.
//!
//! Agent captures are saved to the Library like any other and tagged
//! `agent`, but never copied to the clipboard or opened in Quick Access or
//! the editor: a short notice says an agent took one instead. Settings'
//! Install skill button writes the skill that teaches agents the commands.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Local;
use image::{RgbaImage, imageops};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    capture::{self, CaptureMode, Foreground, Rect},
    control::{Request, ShotRequest, ShotTarget},
    library::{self, LibraryState},
    quick::{self, QuickItem},
    screen::{self, MonitorInfo, WindowInfo},
};

/// The tag every agent capture gets in the Library.
pub const AGENT_TAG: &str = "agent";
/// The longest `--delay` a shot waits, in milliseconds.
pub const MAX_DELAY_MS: u64 = 60_000;
/// What capturing on Wayland fails with: only the desktop may read the
/// screen there, and it asks the user each time.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const WAYLAND: &str = "Grab-it cannot capture from the command line on Wayland: only the desktop may read the screen there. Sign in to an X11 session to use displays, windows and shot.";

/// Runs one request. Called on the control connection's own thread, so it
/// may wait and may show the notice window.
pub fn run(app: &AppHandle, request: Request) -> Result<Value, String> {
    refuse_on_wayland()?;
    match request {
        Request::Displays => {
            let displays = screen::monitors()?;
            Ok(json!({ "displays": displays.iter().map(Display::from).collect::<Vec<_>>() }))
        }
        Request::Windows => Ok(json!({
            "windows": screen::desktop().windows.iter().map(WindowEntry::from).collect::<Vec<_>>()
        })),
        Request::Shot(shot) => {
            let saved = take_shot(app, &shot)?;
            serde_json::to_value(saved).map_err(|err| err.to_string())
        }
    }
}

fn refuse_on_wayland() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        return Err(WAYLAND.into());
    }
    Ok(())
}

/// A monitor as `grab-it displays` prints it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    /// What `--display` takes.
    pub id: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub primary: bool,
}

impl From<&MonitorInfo> for Display {
    fn from(monitor: &MonitorInfo) -> Self {
        Self {
            id: monitor.index,
            name: monitor.name.clone(),
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            scale_factor: monitor.scale_factor,
            primary: monitor.is_primary,
        }
    }
}

/// A window as `grab-it windows` prints it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowEntry {
    /// What `--window` takes.
    pub id: u32,
    pub app: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl From<&WindowInfo> for WindowEntry {
    fn from(window: &WindowInfo) -> Self {
        Self {
            id: window.id,
            app: window.app_name.clone(),
            title: window.title.clone(),
            x: window.rect.x,
            y: window.rect.y,
            width: window.rect.width,
            height: window.rect.height,
        }
    }
}

/// What `grab-it shot` prints: the saved file and its Library item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedShot {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    /// The Library item's id, when it was added.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
}

/// Finds the window `query` names: its id from `grab-it windows`, else the
/// frontmost window whose app name or title holds the text, ignoring case.
/// `windows` is front to back.
pub fn match_window<'a>(windows: &'a [WindowInfo], query: &str) -> Result<&'a WindowInfo, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("--window needs an id or some text from the window's app or title".into());
    }
    if let Ok(id) = query.parse::<u32>()
        && let Some(window) = windows.iter().find(|window| window.id == id)
    {
        return Ok(window);
    }
    let needle = query.to_lowercase();
    windows
        .iter()
        .find(|window| {
            window.app_name.to_lowercase().contains(&needle)
                || window.title.to_lowercase().contains(&needle)
        })
        .ok_or_else(|| {
            format!("no window matches `{query}`; run `grab-it windows` to list them")
        })
}

/// Finds the monitor `query` names: its id from `grab-it displays`, else
/// the first whose name holds the text, ignoring case.
pub fn match_display<'a>(
    monitors: &'a [MonitorInfo],
    query: &str,
) -> Result<&'a MonitorInfo, String> {
    let query = query.trim();
    if let Ok(id) = query.parse::<usize>()
        && let Some(monitor) = monitors.iter().find(|monitor| monitor.index == id)
    {
        return Ok(monitor);
    }
    let needle = query.to_lowercase();
    monitors
        .iter()
        .find(|monitor| !needle.is_empty() && monitor.name.to_lowercase().contains(&needle))
        .ok_or_else(|| {
            format!("no display matches `{query}`; run `grab-it displays` to list them")
        })
}

/// The monitor holding the most of `rect` (desktop coordinates), or None
/// when it is on none of them.
pub fn monitor_for<'a>(monitors: &'a [MonitorInfo], rect: Rect) -> Option<&'a MonitorInfo> {
    let overlap = |monitor: &MonitorInfo| {
        let left = rect.x.max(monitor.x);
        let top = rect.y.max(monitor.y);
        let right = (rect.x + rect.width as i32).min(monitor.x + monitor.width as i32);
        let bottom = (rect.y + rect.height as i32).min(monitor.y + monitor.height as i32);
        i64::from((right - left).max(0)) * i64::from((bottom - top).max(0))
    };
    monitors
        .iter()
        .map(|monitor| (overlap(monitor), monitor))
        .filter(|(area, _)| *area > 0)
        .max_by_key(|(area, _)| *area)
        .map(|(_, monitor)| monitor)
}

/// `rect` (desktop coordinates) in the pixels of `monitor`'s image, which
/// is `image_width` pixels wide, clipped to it. None when nothing is left.
pub fn region_in_image(
    monitor: &MonitorInfo,
    rect: Rect,
    image_size: (u32, u32),
) -> Option<Rect> {
    if monitor.width == 0 {
        return None;
    }
    let scale = f64::from(image_size.0) / f64::from(monitor.width);
    let px = |v: i32| (f64::from(v) * scale).round() as i32;
    let x0 = px(rect.x - monitor.x);
    let y0 = px(rect.y - monitor.y);
    let x1 = px(rect.x + rect.width as i32 - monitor.x);
    let y1 = px(rect.y + rect.height as i32 - monitor.y);
    let left = x0.max(0);
    let top = y0.max(0);
    let right = x1.min(image_size.0 as i32);
    let bottom = y1.min(image_size.1 as i32);
    if right <= left || bottom <= top {
        return None;
    }
    Some(Rect {
        x: left,
        y: top,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

/// Scales `image` down to `max_width`, keeping its shape, when it is
/// wider; the second value is how much it was scaled by.
pub fn fit_width(image: RgbaImage, max_width: Option<u32>) -> (RgbaImage, f64) {
    match max_width {
        Some(max) if max > 0 && image.width() > max => {
            let ratio = f64::from(max) / f64::from(image.width());
            let height = ((f64::from(image.height()) * ratio).round() as u32).max(1);
            (
                imageops::resize(&image, max, height, imageops::FilterType::Lanczos3),
                ratio,
            )
        }
        _ => (image, 1.0),
    }
}

/// Captures what `shot` asks for after its delay, saves it and adds it to
/// the Library tagged `agent`, and says so in a notice.
fn take_shot(app: &AppHandle, shot: &ShotRequest) -> Result<SavedShot, String> {
    if !crate::permissions::ensure_screen_capture(app) {
        return Err("Grab-it needs the Screen Recording permission to capture the screen. Turn it on in System Settings › Privacy & Security › Screen Recording, then try again.".into());
    }
    if shot.delay_ms > 0 {
        std::thread::sleep(Duration::from_millis(shot.delay_ms.min(MAX_DELAY_MS)));
    }
    let (image, mode, foreground, scale) = grab(&shot.target)?;
    let (image, ratio) = fit_width(image, shot.max_width);
    let scale = scale.map(|scale| scale * ratio);
    let folder = library::current_save_folder(app);
    let saved = capture::save_capture(&folder, &image, mode, &foreground, scale, Local::now())
        .map_err(|err| err.to_string())?;
    let id = add_to_library(app, &saved.path);
    let _ = app.emit(crate::actions::CAPTURE_SAVED_EVENT, &saved);
    quick::show(app, captured_notice(&saved.path));
    Ok(SavedShot {
        path: saved.path,
        width: image.width(),
        height: image.height(),
        id,
    })
}

/// The pixels, what kind of capture they are, the app they show and the
/// monitor's pixels per point.
fn grab(target: &ShotTarget) -> Result<(RgbaImage, CaptureMode, Foreground, Option<f64>), String> {
    match target {
        ShotTarget::Screen => {
            let scale = crate::actions::monitor_scale(None);
            let image = screen::capture_all()?;
            Ok((image, CaptureMode::Screen, screen::foreground(), scale))
        }
        ShotTarget::Display { display } => {
            let monitors = screen::monitors()?;
            let monitor = match_display(&monitors, display)?;
            let image = screen::capture_monitor(monitor.index)?;
            Ok((
                image,
                CaptureMode::Monitor,
                screen::foreground(),
                Some(monitor.scale_factor),
            ))
        }
        ShotTarget::Window { window } => {
            let windows = screen::desktop().windows;
            let window = match_window(&windows, window)?;
            let scale = screen::monitors()
                .ok()
                .and_then(|monitors| monitor_for(&monitors, window.rect).map(|m| m.scale_factor));
            let image = screen::capture_window(window.id)?;
            Ok((
                image,
                CaptureMode::Window,
                screen::foreground_of(window),
                scale,
            ))
        }
        ShotTarget::Region {
            x,
            y,
            width,
            height,
        } => {
            let rect = Rect {
                x: *x,
                y: *y,
                width: *width,
                height: *height,
            };
            if rect.width == 0 || rect.height == 0 {
                return Err("--region needs a width and height above 0".into());
            }
            let monitors = screen::monitors()?;
            let monitor = monitor_for(&monitors, rect).ok_or_else(|| {
                "the region is off every display; run `grab-it displays` to see where they are"
                    .to_string()
            })?;
            let image = screen::capture_monitor(monitor.index)?;
            let crop = region_in_image(monitor, rect, image.dimensions())
                .and_then(|place| capture::crop(&image, place))
                .ok_or("the region is off the display")?;
            Ok((
                crop,
                CaptureMode::Region,
                screen::foreground(),
                Some(monitor.scale_factor),
            ))
        }
    }
}

/// Adds the capture to the Library and tags it `agent`, keeping any tags
/// it has. Returns its id, or None when the Library could not take it.
fn add_to_library(app: &AppHandle, png: &Path) -> Option<i64> {
    library::record_capture(app, png);
    let state = app.try_state::<LibraryState>()?;
    let mut shots = state.lock();
    let id = shots.id_for_path(png).ok().flatten()?;
    let tags = shots.get(id).map(|shot| shot.tags).unwrap_or_default();
    match shots.set_tags(id, &with_agent_tag(tags)) {
        Ok(_) => {
            drop(shots);
            let _ = app.emit(library::LIBRARY_CHANGED_EVENT, ());
        }
        Err(err) => eprintln!("Grab-it: could not tag {} agent: {err}", png.display()),
    }
    Some(id)
}

/// `tags` with `agent` added, once.
pub fn with_agent_tag(mut tags: Vec<String>) -> Vec<String> {
    if !tags.iter().any(|tag| tag.eq_ignore_ascii_case(AGENT_TAG)) {
        tags.push(AGENT_TAG.into());
    }
    tags
}

/// The notice an agent capture shows in place of Quick Access.
pub fn captured_notice(path: &Path) -> QuickItem {
    let file = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    QuickItem::Notice {
        title: "Captured by an agent".into(),
        message: format!("{file} is in the Library, tagged agent."),
    }
}

/// The skill's text, with `{{GRAB_IT}}` where Grab-it's executable goes.
const SKILL_TEMPLATE: &str = include_str!("../agent-skill/SKILL.md");
/// The skill's folder name in each skills folder.
const SKILL_NAME: &str = "grab-it";
/// The skills folders, under the home folder, that Install skill writes
/// to: the shared one Codex and others read, and Claude Code's.
pub const SKILL_DIRS: [&str; 2] = [".agents/skills", ".claude/skills"];

/// The skill with `exe`, Grab-it's executable, filled in.
pub fn skill_text(exe: &Path) -> String {
    SKILL_TEMPLATE.replace("{{GRAB_IT}}", &exe.to_string_lossy())
}

/// Where the skill goes under `home`, one `SKILL.md` per skills folder.
pub fn skill_paths(home: &Path) -> Vec<PathBuf> {
    SKILL_DIRS
        .iter()
        .map(|dir| home.join(dir).join(SKILL_NAME).join("SKILL.md"))
        .collect()
}

/// Writes the skill into every skills folder under `home`.
pub fn install_skill(home: &Path, exe: &Path) -> Result<Vec<PathBuf>, String> {
    let text = skill_text(exe);
    let paths = skill_paths(home);
    for path in &paths {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|err| format!("could not create {}: {err}", dir.display()))?;
        }
        std::fs::write(path, &text)
            .map_err(|err| format!("could not write {}: {err}", path.display()))?;
    }
    Ok(paths)
}

/// Whether the skill is installed, and where. Mirrors `AgentSkill` in
/// src/settings/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    /// The `SKILL.md` files written, in [`SKILL_DIRS`] order.
    pub installed: Vec<PathBuf>,
    /// Whether every installed copy names this Grab-it, as it is now.
    pub current: bool,
}

/// What is installed under `home` for Grab-it at `exe`.
pub fn skill_status(home: &Path, exe: &Path) -> AgentSkill {
    let text = skill_text(exe);
    let mut current = true;
    let installed = skill_paths(home)
        .into_iter()
        .filter(|path| match std::fs::read_to_string(path) {
            Ok(found) => {
                current &= found == text;
                true
            }
            Err(_) => false,
        })
        .collect::<Vec<_>>();
    AgentSkill {
        current: current && !installed.is_empty(),
        installed,
    }
}

fn home_and_exe(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|err| format!("could not find your home folder: {err}"))?;
    let exe = std::env::current_exe()
        .map_err(|err| format!("could not find Grab-it's own program: {err}"))?;
    Ok((home, exe))
}

/// Settings › AI agents: whether the skill is installed.
#[tauri::command]
pub fn agent_skill_status(app: AppHandle) -> Result<AgentSkill, String> {
    let (home, exe) = home_and_exe(&app)?;
    Ok(skill_status(&home, &exe))
}

/// Settings › AI agents' Install skill: writes the skill for Claude Code,
/// Codex and other agents.
#[tauri::command]
pub fn install_agent_skill(app: AppHandle) -> Result<AgentSkill, String> {
    let (home, exe) = home_and_exe(&app)?;
    install_skill(&home, &exe)?;
    Ok(skill_status(&home, &exe))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn window(id: u32, app: &str, title: &str) -> WindowInfo {
        WindowInfo {
            id,
            app_name: app.into(),
            title: title.into(),
            rect: Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            },
        }
    }

    fn monitor(index: usize, name: &str, x: i32, width: u32) -> MonitorInfo {
        MonitorInfo {
            index,
            name: name.into(),
            x,
            y: 0,
            width,
            height: 1080,
            scale_factor: 1.0,
            is_primary: index == 0,
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
    fn windows_match_by_id_first() {
        let windows = [window(7, "Terminal", "build"), window(42, "Firefox", "7 tabs")];
        assert_eq!(match_window(&windows, "42").unwrap().id, 42);
        assert_eq!(match_window(&windows, " 7 ").unwrap().id, 7);
    }

    #[test]
    fn windows_match_app_or_title_ignoring_case_frontmost_first() {
        let windows = [
            window(1, "Firefox", "Docs"),
            window(2, "Code", "grab-it — lib.rs"),
            window(3, "Firefox", "Issues"),
        ];
        assert_eq!(match_window(&windows, "firefox").unwrap().id, 1);
        assert_eq!(match_window(&windows, "LIB.RS").unwrap().id, 2);
        assert_eq!(match_window(&windows, "issues").unwrap().id, 3);
        // A number that is no window's id is looked for as text.
        let windows = [window(5, "Game", "2048")];
        assert_eq!(match_window(&windows, "2048").unwrap().id, 5);
    }

    #[test]
    fn no_matching_window_says_how_to_list_them() {
        let windows = [window(1, "Firefox", "Docs")];
        let err = match_window(&windows, "Slack").unwrap_err();
        assert!(err.contains("`Slack`") && err.contains("grab-it windows"));
        assert!(match_window(&windows, "  ").is_err());
    }

    #[test]
    fn displays_match_by_id_or_name() {
        let monitors = [monitor(0, "DELL U2720Q", 0, 1920), monitor(1, "Built-in", 1920, 1440)];
        assert_eq!(match_display(&monitors, "1").unwrap().index, 1);
        assert_eq!(match_display(&monitors, "dell").unwrap().index, 0);
        assert!(match_display(&monitors, "5").unwrap_err().contains("grab-it displays"));
        assert!(match_display(&monitors, "").is_err());
    }

    #[test]
    fn a_region_belongs_to_the_display_holding_most_of_it() {
        let monitors = [monitor(0, "Left", 0, 1920), monitor(1, "Right", 1920, 1920)];
        assert_eq!(monitor_for(&monitors, rect(100, 100, 200, 200)).unwrap().index, 0);
        assert_eq!(monitor_for(&monitors, rect(1800, 0, 400, 100)).unwrap().index, 1);
        assert!(monitor_for(&monitors, rect(-500, 0, 100, 100)).is_none());
    }

    #[test]
    fn a_region_is_scaled_into_the_displays_pixels_and_clipped() {
        let right = monitor(1, "Retina", 1920, 1440);
        // A 2x display: its image is twice as wide as its desktop size.
        assert_eq!(
            region_in_image(&right, rect(2020, 10, 100, 50), (2880, 2160)),
            Some(rect(200, 20, 200, 100))
        );
        // Running off the display's right edge.
        assert_eq!(
            region_in_image(&right, rect(3300, 0, 200, 100), (1440, 1080)),
            Some(rect(1380, 0, 60, 100))
        );
        assert_eq!(region_in_image(&right, rect(0, 0, 100, 100), (1440, 1080)), None);
    }

    #[test]
    fn max_width_only_scales_down() {
        let (image, ratio) = fit_width(RgbaImage::new(400, 200), Some(100));
        assert_eq!((image.dimensions(), ratio), ((100, 50), 0.25));
        let (image, ratio) = fit_width(RgbaImage::new(80, 20), Some(100));
        assert_eq!((image.dimensions(), ratio), ((80, 20), 1.0));
        assert_eq!(fit_width(RgbaImage::new(80, 20), None).0.dimensions(), (80, 20));
    }

    #[test]
    fn agent_captures_are_tagged_once() {
        assert_eq!(with_agent_tag(vec![]), vec!["agent".to_string()]);
        assert_eq!(
            with_agent_tag(vec!["docs".into(), "Agent".into()]),
            vec!["docs".to_string(), "Agent".to_string()]
        );
    }

    #[test]
    fn the_notice_names_the_capture() {
        assert_eq!(
            captured_notice(Path::new("/p/originals/Grab-it 2026-11-17 09-00-00.png")),
            QuickItem::Notice {
                title: "Captured by an agent".into(),
                message: "Grab-it 2026-11-17 09-00-00.png is in the Library, tagged agent."
                    .into(),
            }
        );
    }

    #[test]
    fn replies_are_json_lines_with_ids_names_and_rectangles() {
        let display = Display::from(&monitor(1, "Built-in", 1920, 1440));
        assert_eq!(
            serde_json::to_value(&display).unwrap(),
            json!({"id": 1, "name": "Built-in", "x": 1920, "y": 0, "width": 1440, "height": 1080, "scaleFactor": 1.0, "primary": false})
        );
        let entry = WindowEntry::from(&window(42, "Firefox", "Docs"));
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            json!({"id": 42, "app": "Firefox", "title": "Docs", "x": 0, "y": 0, "width": 100, "height": 100})
        );
        let saved = SavedShot {
            path: PathBuf::from("/p/shot.png"),
            width: 640,
            height: 480,
            id: Some(9),
        };
        assert_eq!(
            serde_json::to_string(&saved).unwrap(),
            r#"{"path":"/p/shot.png","width":640,"height":480,"id":9}"#
        );
    }

    #[test]
    fn the_skill_names_this_grab_it_and_its_commands() {
        let text = skill_text(Path::new("/opt/Grab-it/grab-it"));
        assert!(!text.contains("{{GRAB_IT}}"));
        assert!(text.contains(r#""/opt/Grab-it/grab-it" displays"#));
        assert!(text.contains(r#""/opt/Grab-it/grab-it" windows"#));
        assert!(text.contains(r#""/opt/Grab-it/grab-it" shot"#));
        assert!(text.starts_with("---\nname: grab-it\n"));
    }

    #[test]
    fn the_skill_installs_into_both_skills_folders() {
        let home = TempDir::new().unwrap();
        let exe = Path::new("/opt/grab-it");
        assert_eq!(
            skill_status(home.path(), exe),
            AgentSkill {
                installed: vec![],
                current: false
            }
        );
        let written = install_skill(home.path(), exe).unwrap();
        assert_eq!(
            written,
            vec![
                home.path().join(".agents/skills/grab-it/SKILL.md"),
                home.path().join(".claude/skills/grab-it/SKILL.md"),
            ]
        );
        let status = skill_status(home.path(), exe);
        assert_eq!(status.installed, written);
        assert!(status.current);
        // Grab-it moved: the installed skill names the old place.
        assert!(!skill_status(home.path(), Path::new("/elsewhere/grab-it")).current);
    }
}
