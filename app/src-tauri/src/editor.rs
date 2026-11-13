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
use tauri::{AppHandle, State, WebviewWindow, ipc::InvokeBody};
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
    Ok(EditorInfo {
        path,
        file_name,
        annotations,
    })
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
}
