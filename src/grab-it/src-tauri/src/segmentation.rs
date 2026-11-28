//! Person segmentation for the webcam bubble's Blur and Colour backgrounds.
//!
//! Google's MediaPipe selfie segmentation model ships with Grab-it as a
//! Tauri resource, in `segmentation-models/` under the resource directory
//! (from `src-tauri/segmentation-models/`, with its licence), and runs
//! locally with rten: no camera frame leaves the computer. The bubble sends
//! each frame squashed to [`FRAME_SIZE`] square and gets back how likely
//! each of its pixels is the person.

use std::{
    fmt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use rten::Model;
use rten_tensor::{NdTensor, prelude::*};
use tauri::Manager;

use crate::rt::AppHandle;

/// Where the model lives, under the resource directory.
pub const MODELS_DIR: &str = "segmentation-models";
/// Overrides the models directory, for trying another copy of the model.
pub const MODELS_DIR_ENV: &str = "GRAB_IT_SEGMENTATION_MODELS";
/// The fp32 `onnx/model.onnx` of onnx-community/mediapipe_selfie_segmentation
/// (see `segmentation-models/LICENSE.md`). Its SHA-256 is pinned in the
/// tests.
pub const MODEL: &str = "model.onnx";
/// The model's input: `[1, 3, 256, 256]` RGB scaled to 0..1.
const INPUT_NODE: &str = "pixel_values";
/// The model's output: `[1, 1, 256, 256]`, how likely each pixel is the
/// person, 0..1.
const OUTPUT_NODE: &str = "alphas";

/// The width and height of the frames the model takes and the masks it
/// gives. Mirrors `MASK_SIZE` in src/webcam/api.ts.
pub const FRAME_SIZE: usize = 256;
/// The bytes of a frame: [`FRAME_SIZE`] square, RGBA.
pub const FRAME_BYTES: usize = FRAME_SIZE * FRAME_SIZE * 4;

#[derive(Debug, Clone)]
pub enum SegmentationError {
    /// The model could not be loaded.
    Model(String),
    /// The model failed on the frame.
    Engine(String),
    /// The frame is not [`FRAME_SIZE`] square RGBA.
    Frame(usize),
}

impl fmt::Display for SegmentationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Model(err) => write!(f, "could not load the person segmentation model: {err}"),
            Self::Engine(err) => write!(f, "person segmentation failed: {err}"),
            Self::Frame(len) => write!(
                f,
                "a webcam frame is {FRAME_SIZE}×{FRAME_SIZE} RGBA ({FRAME_BYTES} bytes), not {len} bytes"
            ),
        }
    }
}

impl std::error::Error for SegmentationError {}

pub type SegmentationResult<T> = std::result::Result<T, SegmentationError>;

/// The models directory: `$GRAB_IT_SEGMENTATION_MODELS` when set, else the
/// model bundled in `segmentation-models/` under the resource directory.
pub fn models_dir(resources: &Path) -> PathBuf {
    match std::env::var_os(MODELS_DIR_ENV) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => resources.join(MODELS_DIR),
    }
}

/// A loaded person segmenter.
pub struct Segmenter {
    model: Model,
}

impl Segmenter {
    /// Loads the model from `dir`.
    pub fn load(dir: &Path) -> SegmentationResult<Self> {
        let model = Model::load_file(dir.join(MODEL))
            .map_err(|err| SegmentationError::Model(format!("{MODEL}: {err}")))?;
        Ok(Self { model })
    }

    /// How likely each pixel of `frame`, [`FRAME_SIZE`] square RGBA, is the
    /// person, from 0 (the room) to 255 (the person), row by row.
    pub fn segment(&self, frame: &[u8]) -> SegmentationResult<Vec<u8>> {
        if frame.len() != FRAME_BYTES {
            return Err(SegmentationError::Frame(frame.len()));
        }
        // NCHW RGB scaled to 0..1, with no other normalisation; alpha is
        // ignored.
        let mut input = NdTensor::<f32, 4>::zeros([1, 3, FRAME_SIZE, FRAME_SIZE]);
        for (i, pixel) in frame.as_chunks::<4>().0.iter().enumerate() {
            let (y, x) = (i / FRAME_SIZE, i % FRAME_SIZE);
            for channel in 0..3 {
                input[[0, channel, y, x]] = f32::from(pixel[channel]) / 255.;
            }
        }

        let node = |name: &str| {
            self.model
                .node_id(name)
                .map_err(|err| SegmentationError::Model(format!("{MODEL}: {err}")))
        };
        let [alphas] = self
            .model
            .run_n(
                vec![(node(INPUT_NODE)?, input.into())],
                [node(OUTPUT_NODE)?],
                None,
            )
            .map_err(|err| SegmentationError::Engine(err.to_string()))?;
        let alphas: NdTensor<f32, 4> = alphas
            .try_into()
            .map_err(|_| SegmentationError::Engine("unexpected mask output".into()))?;
        if alphas.shape() != [1, 1, FRAME_SIZE, FRAME_SIZE] {
            return Err(SegmentationError::Engine(format!(
                "unexpected mask shape {:?}",
                alphas.shape()
            )));
        }
        Ok(alphas
            .iter()
            .map(|alpha| (alpha.clamp(0., 1.) * 255.).round() as u8)
            .collect())
    }
}

/// The segmenter behind the webcam bubble's backgrounds, loaded the first
/// time it is used and kept. A model that would not load is not tried
/// again: its error is kept and given to every later frame.
pub struct SegmentationState {
    models: PathBuf,
    engine: Mutex<Option<Result<Arc<Segmenter>, SegmentationError>>>,
}

impl SegmentationState {
    pub fn new(models: PathBuf) -> Self {
        Self {
            models,
            engine: Mutex::new(None),
        }
    }

    /// The segmenter, loading it first when this is the first frame since
    /// Grab-it started.
    fn engine(&self) -> SegmentationResult<Arc<Segmenter>> {
        let mut slot = self
            .engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.get_or_insert_with(|| Segmenter::load(&self.models).map(Arc::new))
            .clone()
    }
}

/// The person mask of `frame` right now. See [`Segmenter::segment`].
pub fn segment_now(app: &AppHandle, frame: &[u8]) -> SegmentationResult<Vec<u8>> {
    if frame.len() != FRAME_BYTES {
        return Err(SegmentationError::Frame(frame.len()));
    }
    app.state::<SegmentationState>().engine()?.segment(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::OnceLock};

    /// The model as the app bundles it.
    fn bundled_models_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(MODELS_DIR)
    }

    fn engine() -> &'static Segmenter {
        static ENGINE: OnceLock<Segmenter> = OnceLock::new();
        ENGINE.get_or_init(|| {
            Segmenter::load(&bundled_models_dir()).expect("load the segmentation model")
        })
    }

    /// The face fixture (see faces.rs), squashed to a frame as the bubble
    /// squashes the camera's.
    fn portrait_frame() -> Vec<u8> {
        let image = image::open(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join("face-portrait.jpg"),
        )
        .unwrap()
        .into_rgba8();
        image::imageops::resize(
            &image,
            FRAME_SIZE as u32,
            FRAME_SIZE as u32,
            image::imageops::FilterType::Triangle,
        )
        .into_raw()
    }

    /// The average of `mask` over the part of the frame from `left` to
    /// `right` and `top` to `bottom`, in fractions of it.
    fn average(mask: &[u8], (left, right): (f32, f32), (top, bottom): (f32, f32)) -> f32 {
        let size = FRAME_SIZE as f32;
        let (x0, x1) = ((left * size) as usize, (right * size) as usize);
        let (y0, y1) = ((top * size) as usize, (bottom * size) as usize);
        let mut sum = 0.;
        for y in y0..y1 {
            for x in x0..x1 {
                sum += f32::from(mask[y * FRAME_SIZE + x]);
            }
        }
        sum / ((x1 - x0) * (y1 - y0)) as f32
    }

    /// The SHA-256 of the bundled model. Also listed in
    /// `segmentation-models/LICENSE.md`.
    const MODEL_SHA256: &str = "3241ac4ad8aa35bdaf33946776db29f7c283a413aa0b0dacb9483594b4531aad";

    #[test]
    fn models_dir_defaults_to_the_resource_dir() {
        if std::env::var_os(MODELS_DIR_ENV).is_none() {
            assert_eq!(
                models_dir(Path::new("/resources")),
                Path::new("/resources").join(MODELS_DIR)
            );
        }
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
        assert!(
            licence.contains("Apache License"),
            "LICENSE.md is Apache-2.0"
        );
    }

    #[test]
    fn the_bundle_ships_the_model_and_its_licence() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let resources = &config["bundle"]["resources"];
        for file in [MODEL, "LICENSE.md"] {
            let path = format!("{MODELS_DIR}/{file}");
            assert_eq!(resources[&path], path.as_str(), "bundle.resources");
        }
    }

    #[test]
    fn a_missing_model_is_a_model_error_kept_for_later_frames() {
        let dir = tempfile::TempDir::new().unwrap();
        let err = Segmenter::load(dir.path()).err().expect("no model to load");
        assert!(matches!(err, SegmentationError::Model(_)), "got {err:?}");
        assert!(err.to_string().contains(MODEL), "{err}");

        let state = SegmentationState::new(dir.path().to_owned());
        assert!(state.engine().is_err());
        // The model turning up later is not loaded: the first error stays.
        fs::copy(bundled_models_dir().join(MODEL), dir.path().join(MODEL)).unwrap();
        assert!(matches!(state.engine(), Err(SegmentationError::Model(_))));
    }

    #[test]
    fn a_frame_of_the_wrong_size_is_refused() {
        for len in [0, FRAME_BYTES - 4, FRAME_BYTES + 1] {
            let err = engine().segment(&vec![0; len]).unwrap_err();
            assert!(
                matches!(err, SegmentationError::Frame(n) if n == len),
                "{err:?}"
            );
        }
    }

    #[test]
    fn the_mask_covers_the_person_in_the_portrait() {
        let mask = engine().segment(&portrait_frame()).unwrap();
        assert_eq!(mask.len(), FRAME_SIZE * FRAME_SIZE);
        // His head is right of centre in the portrait's upper half, and his
        // shoulders fill its lower right.
        let head = average(&mask, (0.6, 0.75), (0.25, 0.45));
        assert!(head > 200., "head {head}");
        let shoulders = average(&mask, (0.6, 0.9), (0.5, 0.75));
        assert!(shoulders > 200., "shoulders {shoulders}");
        // The upper left and the top are the room behind him.
        let room = average(&mask, (0., 0.4), (0., 0.4));
        assert!(room < 30., "room {room}");
        let top = average(&mask, (0., 1.), (0., 0.1));
        assert!(top < 30., "top {top}");
    }
}
