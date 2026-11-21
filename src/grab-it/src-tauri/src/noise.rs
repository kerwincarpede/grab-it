//! The model behind Remove background noise.
//!
//! The beguiling-drafter RNNoise model from
//! [GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models)
//! ships with Grab-it as a Tauri resource, in `noise-models/` under the
//! resource directory (from `src-tauri/noise-models/`, with its notice).
//! ffmpeg's `arnndn` filter runs it on the microphone when a recording is
//! muxed (see `ffmpeg::mux_args`): no sound leaves the computer.

use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::rt::AppHandle;

/// Where the model lives, under the resource directory.
pub const MODELS_DIR: &str = "noise-models";
/// The beguiling-drafter model, `beguiling-drafter-2018-08-30/bd.rnnn` in
/// GregorR/rnnoise-models, unchanged (see `noise-models/LICENSE.md`). Its
/// SHA-256 is pinned in the tests.
pub const MODEL: &str = "bd.rnnn";

/// Where the model is bundled, under the resource directory `resources`.
pub fn model_path(resources: &Path) -> PathBuf {
    resources.join(MODELS_DIR).join(MODEL)
}

/// The bundled model, or None when it is missing from the install.
pub fn bundled_model(app: &AppHandle) -> Option<PathBuf> {
    let path = match app.path().resource_dir() {
        Ok(resources) => model_path(&resources),
        Err(err) => {
            eprintln!("Grab-it: no resource directory for the noise model: {err}");
            return None;
        }
    };
    if path.is_file() {
        Some(path)
    } else {
        eprintln!(
            "Grab-it: the noise removal model is missing: {}",
            path.display()
        );
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// The model as the app bundles it.
    fn bundled_models_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(MODELS_DIR)
    }

    /// The SHA-256 of the bundled model. Also listed in
    /// `noise-models/LICENSE.md`.
    const MODEL_SHA256: &str = "ae3f7411e1e6a884f839a4a145c394408398f09854dbc1216ee02faafc98a17b";

    #[test]
    fn the_model_is_under_the_resource_dir() {
        assert_eq!(
            model_path(Path::new("/resources")),
            Path::new("/resources").join(MODELS_DIR).join(MODEL)
        );
    }

    #[test]
    fn the_bundled_model_matches_its_checksum() {
        use sha2::{Digest, Sha256};
        let bytes = fs::read(bundled_models_dir().join(MODEL)).unwrap();
        let actual: String = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(actual, MODEL_SHA256);
        let licence = fs::read_to_string(bundled_models_dir().join("LICENSE.md")).unwrap();
        assert!(
            licence.contains(MODEL_SHA256),
            "LICENSE.md lists the checksum"
        );
    }

    #[test]
    fn the_bundle_ships_the_model_and_its_notice() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let resources = &config["bundle"]["resources"];
        for file in [MODEL, "LICENSE.md"] {
            let path = format!("{MODELS_DIR}/{file}");
            assert_eq!(resources[&path], path.as_str(), "bundle.resources");
        }
    }
}
