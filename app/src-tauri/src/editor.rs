//! The annotation editor's backend: which capture each editor window shows,
//! its annotations sidecar, and copying or exporting the flattened image.
//!
//! The capture PNG is never written here. Annotations live in
//! `<capture>.annotations.json`; the frontend flattens them only for Copy
//! and Export.

use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State, WebviewWindow, ipc::InvokeBody};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::capture::annotations_path;

/// The sidecar format version this build reads and writes.
pub const ANNOTATIONS_VERSION: u64 = 1;
/// The request header carrying the export path, URI-encoded.
pub const EXPORT_PATH_HEADER: &str = "x-export-path";

/// The capture each editor window shows, by window label.
#[derive(Default)]
pub struct EditorState(Mutex<HashMap<String, PathBuf>>);

impl EditorState {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, PathBuf>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn insert(&self, label: &str, path: PathBuf) {
        self.lock().insert(label.to_owned(), path);
    }

    pub fn remove(&self, label: &str) {
        self.lock().remove(label);
    }

    /// The label of the editor already showing `path`, if any. Paths are
    /// compared by the file they name, so a capture registered under its
    /// save-folder spelling matches the library's canonical path (symlinks,
    /// `..`, the `\\?\` prefix on Windows) and vice versa.
    pub fn label_for(&self, path: &Path) -> Option<String> {
        let wanted = fs::canonicalize(path).ok();
        self.lock()
            .iter()
            .find(|(_, open)| {
                open.as_path() == path
                    || wanted
                        .as_ref()
                        .is_some_and(|wanted| fs::canonicalize(open).ok().as_ref() == Some(wanted))
            })
            .map(|(label, _)| label.clone())
    }

    fn path_for(&self, label: &str) -> Result<PathBuf, String> {
        self.lock()
            .get(label)
            .cloned()
            .ok_or_else(|| "this window is not an editor".to_owned())
    }
}

/// Mirrors `EditorInfo` in src/editor/api.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    pub path: PathBuf,
    pub file_name: String,
    /// The saved sidecar, or `None` when the capture has no annotations yet.
    pub annotations: Option<Value>,
    /// The capture's pixels per point, from its `meta.json`; `None` for
    /// captures saved before it was recorded (the editor then uses its own
    /// window's density).
    pub scale_factor: Option<f64>,
}

/// Image types a backdrop may be filled with, by extension.
pub const BACKDROP_IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];
/// The largest backdrop image read, so a mistaken pick cannot exhaust memory.
pub const BACKDROP_IMAGE_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Reads an image picked as a backdrop fill. Only image files are read,
/// and only up to [`BACKDROP_IMAGE_MAX_BYTES`].
pub fn read_backdrop_image(path: &Path) -> Result<Vec<u8>, String> {
    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !BACKDROP_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err("the backdrop must be a PNG, JPEG, WebP or GIF image".to_owned());
    }
    let size = fs::metadata(path)
        .map_err(|err| format!("could not open {}: {err}", path.display()))?
        .len();
    if size > BACKDROP_IMAGE_MAX_BYTES {
        return Err("the backdrop image is too large".to_owned());
    }
    fs::read(path).map_err(|err| format!("could not open {}: {err}", path.display()))
}

/// The folder under the app data dir holding backdrop presets' own copies
/// of their images. Copies are never deleted, so captures framed with a
/// preset that was since deleted keep their image.
pub const BACKDROP_PRESETS_DIR: &str = "backdrop-presets";

/// Copies a backdrop image into `dir` under a fresh name, so a preset keeps
/// working when the original is moved, and returns the copy's path. The
/// image is checked as [`read_backdrop_image`] checks it. An image already
/// in `dir` is returned as it is.
pub fn save_preset_image(dir: &Path, source: &Path) -> Result<PathBuf, String> {
    let bytes = read_backdrop_image(source)?;
    let canonical_dir = fs::canonicalize(dir).ok();
    let source_dir = source
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok());
    if canonical_dir.is_some() && canonical_dir == source_dir {
        return Ok(source.to_path_buf());
    }
    fs::create_dir_all(dir).map_err(|err| format!("could not create {}: {err}", dir.display()))?;
    let stem = source
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "backdrop".to_owned());
    let extension = source
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or_default();
    for attempt in 0..1000 {
        let name = match attempt {
            0 => format!("{stem}-{stamp}.{extension}"),
            n => format!("{stem}-{stamp}-{n}.{extension}"),
        };
        let target = dir.join(name);
        // `create_new` so two saves at once never share a file.
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target);
        match file {
            Ok(mut file) => {
                use std::io::Write;
                return file
                    .write_all(&bytes)
                    .map(|()| target)
                    .map_err(|err| format!("could not save the preset image: {err}"));
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("could not save the preset image: {err}")),
        }
    }
    Err("could not name the preset image".to_owned())
}

/// Reads `<capture>.annotations.json`. A missing file is `Ok(None)`; an
/// unreadable or unknown sidecar is an error so it is never overwritten
/// by mistake.
pub fn read_annotations(png: &Path) -> Result<Option<Value>, String> {
    let path = annotations_path(png);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("could not read {}: {err}", path.display())),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|err| format!("could not parse {}: {err}", path.display()))?;
    validate_annotations(&value)?;
    Ok(Some(value))
}

/// Writes the sidecar through a temporary file so a crash never leaves a
/// half-written one.
pub fn write_annotations(png: &Path, annotations: &Value) -> Result<(), String> {
    validate_annotations(annotations)?;
    let path = annotations_path(png);
    let tmp = path.with_extension("json.tmp");
    let mut json = serde_json::to_string_pretty(annotations).map_err(|err| err.to_string())?;
    json.push('\n');
    fs::write(&tmp, json)
        .and_then(|()| fs::rename(&tmp, &path))
        .map_err(|err| format!("could not save annotations: {err}"))
}

/// Accepts `{version: 1, shapes: [...]}`, with any other fields.
pub fn validate_annotations(value: &Value) -> Result<(), String> {
    let version = value.get("version").and_then(Value::as_u64);
    if version != Some(ANNOTATIONS_VERSION) {
        return Err(format!(
            "unsupported annotations version {}",
            value.get("version").unwrap_or(&Value::Null)
        ));
    }
    if !value.get("shapes").is_some_and(Value::is_array) {
        return Err("annotations need a `shapes` list".to_owned());
    }
    Ok(())
}

/// Refuses an export that would overwrite the original capture or one of
/// its sidecars.
pub fn check_export_target(capture: &Path, target: &Path) -> Result<(), String> {
    let same = |a: &Path, b: &Path| {
        a == b
            || matches!(
                (fs::canonicalize(a), fs::canonicalize(b)),
                (Ok(a), Ok(b)) if a == b
            )
    };
    let protected = [
        capture.to_path_buf(),
        annotations_path(capture),
        crate::capture::meta_path(capture),
    ];
    if protected.iter().any(|path| same(path, target)) {
        return Err("export would overwrite the original capture; choose another file".to_owned());
    }
    Ok(())
}

/// Decodes `%XX` escapes from `encodeURIComponent`.
pub fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text
                .get(i + 1..i + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
                .ok_or("bad escape in export path")?;
            out.push(hex);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "export path is not UTF-8".to_owned())
}

fn raw_body(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("expected image bytes".to_owned()),
    }
}

#[tauri::command]
pub fn editor_info(
    window: WebviewWindow,
    state: State<'_, EditorState>,
) -> Result<EditorInfo, String> {
    let path = state.path_for(window.label())?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let annotations = read_annotations(&path)?;
    let meta = crate::capture::read_meta(&path);
    let scale_factor = crate::capture::valid_scale(meta.and_then(|meta| meta.scale_factor));
    Ok(EditorInfo {
        path,
        file_name,
        annotations,
        scale_factor,
    })
}

/// The bytes of an image picked as the backdrop fill.
#[tauri::command]
pub fn editor_backdrop_image(path: PathBuf) -> Result<tauri::ipc::Response, String> {
    read_backdrop_image(&path).map(tauri::ipc::Response::new)
}

/// Keeps a preset's own copy of its backdrop image in
/// `<app data dir>/backdrop-presets/`; returns the path to save in the preset.
#[tauri::command]
pub fn save_backdrop_preset_image(path: PathBuf, app: AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("could not find the app data folder: {err}"))?
        .join(BACKDROP_PRESETS_DIR);
    save_preset_image(&dir, &path)
}

/// The original capture's PNG bytes.
#[tauri::command]
pub fn editor_image(
    window: WebviewWindow,
    state: State<'_, EditorState>,
) -> Result<tauri::ipc::Response, String> {
    let path = state.path_for(window.label())?;
    let bytes =
        fs::read(&path).map_err(|err| format!("could not open {}: {err}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn editor_save_annotations(
    annotations: Value,
    window: WebviewWindow,
    state: State<'_, EditorState>,
) -> Result<(), String> {
    let path = state.path_for(window.label())?;
    write_annotations(&path, &annotations)
}

/// Copies the flattened PNG in the request body to the clipboard.
#[tauri::command]
pub fn editor_copy(request: tauri::ipc::Request<'_>, app: AppHandle) -> Result<(), String> {
    let png = raw_body(&request)?;
    let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
        .map_err(|err| format!("could not decode the image: {err}"))?
        .into_rgba8();
    let clip = tauri::image::Image::new(image.as_raw(), image.width(), image.height());
    app.clipboard()
        .write_image(&clip)
        .map_err(|err| format!("could not copy to the clipboard: {err}"))
}

/// Writes the flattened image in the request body to the path in the
/// [`EXPORT_PATH_HEADER`] header.
#[tauri::command]
pub fn editor_export(
    request: tauri::ipc::Request<'_>,
    window: WebviewWindow,
    state: State<'_, EditorState>,
) -> Result<(), String> {
    let capture = state.path_for(window.label())?;
    let target = request
        .headers()
        .get(EXPORT_PATH_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or("missing export path")
        .and_then(|value| percent_decode(value).map_err(|_| "bad export path"))?;
    let target = PathBuf::from(target);
    check_export_target(&capture, &target)?;
    let bytes = raw_body(&request)?;
    fs::write(&target, bytes).map_err(|err| format!("could not export: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn label_for_matches_any_spelling_of_the_same_file() {
        let dir = tempfile::tempdir().unwrap();
        let originals = dir.path().join("originals");
        fs::create_dir_all(&originals).unwrap();
        let png = originals.join("shot.png");
        fs::write(&png, b"png").unwrap();
        let other = originals.join("other.png");
        fs::write(&other, b"png").unwrap();
        // How the capture path is spelled from the save folder setting.
        let spelled = originals.join("..").join("originals").join("shot.png");
        let canonical = fs::canonicalize(&png).unwrap();

        let state = EditorState::default();
        state.insert("editor-1", spelled.clone());
        state.insert("editor-2", other.clone());
        assert_eq!(state.label_for(&canonical).as_deref(), Some("editor-1"));
        assert_eq!(state.label_for(&spelled).as_deref(), Some("editor-1"));
        assert_eq!(state.label_for(&png).as_deref(), Some("editor-1"));

        let state = EditorState::default();
        state.insert("editor-3", canonical);
        assert_eq!(state.label_for(&spelled).as_deref(), Some("editor-3"));
        assert_eq!(state.label_for(&dir.path().join("missing.png")), None);
    }

    #[cfg(unix)]
    #[test]
    fn label_for_sees_through_a_symlinked_save_folder() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("shot.png"), b"png").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let state = EditorState::default();
        state.insert("editor-1", link.join("shot.png"));
        let canonical = fs::canonicalize(real.join("shot.png")).unwrap();
        assert_eq!(state.label_for(&canonical).as_deref(), Some("editor-1"));
    }

    #[test]
    fn missing_sidecar_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("shot.png");
        assert_eq!(read_annotations(&png), Ok(None));
    }

    #[test]
    fn sidecar_round_trips_beside_the_png() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("shot.png");
        fs::write(&png, b"png").unwrap();
        let doc = json!({
            "version": 1,
            "shapes": [{"id": "a", "type": "rect", "x": 1, "y": 2, "width": 3, "height": 4}],
        });
        write_annotations(&png, &doc).unwrap();
        assert!(dir.path().join("shot.annotations.json").is_file());
        assert!(!dir.path().join("shot.annotations.json.tmp").exists());
        assert_eq!(read_annotations(&png), Ok(Some(doc)));
        // The original is untouched.
        assert_eq!(fs::read(&png).unwrap(), b"png");
    }

    #[test]
    fn unknown_versions_are_rejected() {
        assert!(validate_annotations(&json!({"version": 2, "shapes": []})).is_err());
        assert!(validate_annotations(&json!({"version": 1})).is_err());
        assert!(validate_annotations(&json!({"version": 1, "shapes": []})).is_ok());
    }

    #[test]
    fn a_corrupt_sidecar_is_an_error_not_empty() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("shot.png");
        fs::write(dir.path().join("shot.annotations.json"), "{").unwrap();
        assert!(read_annotations(&png).is_err());
    }

    #[test]
    fn export_cannot_overwrite_the_original_or_its_sidecars() {
        let capture = Path::new("/x/originals/shot.png");
        assert!(check_export_target(capture, capture).is_err());
        assert!(
            check_export_target(capture, Path::new("/x/originals/shot.annotations.json")).is_err()
        );
        assert!(check_export_target(capture, Path::new("/x/originals/shot.meta.json")).is_err());
        assert!(check_export_target(capture, Path::new("/x/export/shot.png")).is_ok());
    }

    #[test]
    fn percent_decoding_matches_encode_uri_component() {
        assert_eq!(
            percent_decode("%2Fhome%2Fme%2FGrab-it%202026.png"),
            Ok("/home/me/Grab-it 2026.png".to_owned())
        );
        assert_eq!(percent_decode("caf%C3%A9.jpg"), Ok("café.jpg".to_owned()));
        assert!(percent_decode("%zz").is_err());
        assert!(percent_decode("%2").is_err());
    }

    #[test]
    fn backdrop_images_must_be_images() {
        let dir = tempfile::tempdir().unwrap();
        let photo = dir.path().join("Beach.JPG");
        fs::write(&photo, b"jpeg").unwrap();
        assert_eq!(read_backdrop_image(&photo), Ok(b"jpeg".to_vec()));
        let notes = dir.path().join("notes.txt");
        fs::write(&notes, b"secret").unwrap();
        assert!(read_backdrop_image(&notes).is_err());
        assert!(read_backdrop_image(&dir.path().join("settings")).is_err());
        assert!(read_backdrop_image(&dir.path().join("gone.png")).is_err());
    }

    #[test]
    fn preset_images_are_copied_under_a_fresh_name() {
        let dir = tempfile::tempdir().unwrap();
        let presets = dir.path().join("data").join(BACKDROP_PRESETS_DIR);
        let photo = dir.path().join("Beach.JPG");
        fs::write(&photo, b"jpeg").unwrap();

        let first = save_preset_image(&presets, &photo).unwrap();
        let second = save_preset_image(&presets, &photo).unwrap();
        assert_ne!(first, second);
        for copy in [&first, &second] {
            assert_eq!(copy.parent(), Some(presets.as_path()));
            assert_eq!(fs::read(copy).unwrap(), b"jpeg");
            let name = copy.file_name().unwrap().to_string_lossy();
            assert!(
                name.starts_with("Beach-") && name.ends_with(".jpg"),
                "{name}"
            );
        }
        // The copy outlives the original.
        fs::remove_file(&photo).unwrap();
        assert_eq!(fs::read(&first).unwrap(), b"jpeg");
    }

    #[test]
    fn a_preset_image_already_in_the_folder_is_reused() {
        let dir = tempfile::tempdir().unwrap();
        let presets = dir.path().join(BACKDROP_PRESETS_DIR);
        let photo = dir.path().join("beach.png");
        fs::write(&photo, b"png").unwrap();
        let copy = save_preset_image(&presets, &photo).unwrap();

        assert_eq!(save_preset_image(&presets, &copy), Ok(copy.clone()));
        // Spelled another way, it is still the same folder.
        let spelled = presets
            .join("..")
            .join(BACKDROP_PRESETS_DIR)
            .join(copy.file_name().unwrap());
        assert_eq!(save_preset_image(&presets, &spelled), Ok(spelled));
        assert_eq!(fs::read_dir(&presets).unwrap().count(), 1);
    }

    #[test]
    fn only_images_are_copied_for_presets() {
        let dir = tempfile::tempdir().unwrap();
        let presets = dir.path().join(BACKDROP_PRESETS_DIR);
        let notes = dir.path().join("notes.txt");
        fs::write(&notes, b"secret").unwrap();
        assert!(save_preset_image(&presets, &notes).is_err());
        assert!(save_preset_image(&presets, &dir.path().join("gone.png")).is_err());
        assert!(!presets.exists());
    }

    #[test]
    fn the_scale_factor_comes_from_the_capture_meta() {
        use crate::capture::{CaptureMode, Foreground, read_meta, save_capture};
        let dir = tempfile::tempdir().unwrap();
        let image = image::RgbaImage::new(2, 2);
        let saved = save_capture(
            dir.path(),
            &image,
            CaptureMode::Region,
            &Foreground::default(),
            Some(2.0),
            chrono::Local::now(),
        )
        .unwrap();
        assert_eq!(
            read_meta(&saved.path).and_then(|meta| meta.scale_factor),
            Some(2.0)
        );
    }
}
