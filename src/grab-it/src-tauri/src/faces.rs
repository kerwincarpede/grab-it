//! Face detection in captures, for the editor's Blur private details.
//!
//! The [UltraFace](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB)
//! RFB-320 model ships with Grab-it as a Tauri resource, in `face-models/`
//! under the resource directory (from `src-tauri/face-models/`, with its
//! licence), and runs locally with rten: no capture leaves the computer.

use std::{
    fmt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use image::{RgbaImage, imageops::FilterType};
use rten::Model;
use rten_tensor::{NdTensor, prelude::*};
use tauri::Manager;

use crate::capture::Rect;
use crate::rt::AppHandle;

/// Where the model lives, under the resource directory.
pub const MODELS_DIR: &str = "face-models";
/// Overrides the models directory, for trying another copy of the model.
pub const MODELS_DIR_ENV: &str = "GRAB_IT_FACE_MODELS";
/// The UltraFace RFB-320 model from `models/onnx/` in the UltraFace
/// repository, upgraded from ONNX opset 9 to 11 and simplified so rten can
/// load it (see `face-models/LICENSE.md`). Its SHA-256 is pinned in the
/// tests.
pub const MODEL: &str = "version-RFB-320.onnx";
/// The model's input.
const INPUT_NODE: &str = "input";
/// The model's class scores, `[1, priors, 2]`: background, then face.
const SCORES_NODE: &str = "scores";
/// The model's raw box offsets from its priors, `[1, priors, 4]`, before the
/// graph decodes them. rten 0.24 panics running the model's own decoding
/// (an in-place `Mul` on a sliced tensor), so [`decode`] does it here.
const LOCATIONS_NODE: &str = "460";
/// How UltraFace scales its box offsets.
const CENTER_VARIANCE: f32 = 0.1;
const SIZE_VARIANCE: f32 = 0.2;

/// The model's input size.
const INPUT_WIDTH: u32 = 320;
const INPUT_HEIGHT: u32 = 240;
/// Boxes scoring below this are not faces.
pub const MIN_SCORE: f32 = 0.7;
/// Of two boxes overlapping more than this, the lower-scoring one is dropped.
pub const NMS_IOU: f32 = 0.3;

#[derive(Debug)]
pub enum FaceError {
    /// The model could not be loaded.
    Model(String),
    /// The model failed on the image.
    Engine(String),
}

impl fmt::Display for FaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Model(err) => write!(f, "could not load the face detection model: {err}"),
            Self::Engine(err) => write!(f, "face detection failed: {err}"),
        }
    }
}

impl std::error::Error for FaceError {}

pub type FaceResult<T> = std::result::Result<T, FaceError>;

/// The models directory: `$GRAB_IT_FACE_MODELS` when set, else the model
/// bundled in `face-models/` under the resource directory.
pub fn models_dir(resources: &Path) -> PathBuf {
    match std::env::var_os(MODELS_DIR_ENV) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => resources.join(MODELS_DIR),
    }
}

/// A box the model found, normalised to 0..1 of the image, with its score.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Detection {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub score: f32,
}

impl Detection {
    fn area(&self) -> f32 {
        (self.x2 - self.x1).max(0.) * (self.y2 - self.y1).max(0.)
    }

    /// Intersection over union with `other`.
    pub fn iou(&self, other: &Detection) -> f32 {
        let width = (self.x2.min(other.x2) - self.x1.max(other.x1)).max(0.);
        let height = (self.y2.min(other.y2) - self.y1.max(other.y1)).max(0.);
        let overlap = width * height;
        let union = self.area() + other.area() - overlap;
        if union <= 0. { 0. } else { overlap / union }
    }

    /// This box in the pixels of an image of `size`, clipped to it.
    pub fn to_rect(self, (width, height): (u32, u32)) -> Rect {
        let (w, h) = (width as f32, height as f32);
        let left = (self.x1.clamp(0., 1.) * w).floor();
        let top = (self.y1.clamp(0., 1.) * h).floor();
        let right = (self.x2.clamp(0., 1.) * w).ceil();
        let bottom = (self.y2.clamp(0., 1.) * h).ceil();
        Rect {
            x: left as i32,
            y: top as i32,
            width: (right - left).max(0.) as u32,
            height: (bottom - top).max(0.) as u32,
        }
    }
}

/// UltraFace RFB-320's prior boxes, `[centre x, centre y, width, height]`
/// normalised to its input, in the order its outputs list them: per
/// feature map (strides 8, 16, 32 and 64), row by row, then by size.
pub fn priors() -> Vec<[f32; 4]> {
    const FEATURE_MAPS: [(u32, u32); 4] = [(40, 30), (20, 15), (10, 8), (5, 4)];
    const MIN_BOXES: [&[f32]; 4] = [
        &[10., 16., 24.],
        &[32., 48.],
        &[64., 96.],
        &[128., 192., 256.],
    ];
    let mut priors = Vec::new();
    for ((columns, rows), sizes) in FEATURE_MAPS.into_iter().zip(MIN_BOXES) {
        for row in 0..rows {
            for column in 0..columns {
                for size in sizes {
                    priors.push(
                        [
                            (column as f32 + 0.5) / columns as f32,
                            (row as f32 + 0.5) / rows as f32,
                            size / INPUT_WIDTH as f32,
                            size / INPUT_HEIGHT as f32,
                        ]
                        .map(|value| value.clamp(0., 1.)),
                    );
                }
            }
        }
    }
    priors
}

/// The box the model's `offsets` from `prior` describe, as the UltraFace
/// graph decodes it.
pub fn decode(offsets: [f32; 4], prior: [f32; 4], score: f32) -> Detection {
    let [cx, cy, width, height] = prior;
    let centre_x = offsets[0] * CENTER_VARIANCE * width + cx;
    let centre_y = offsets[1] * CENTER_VARIANCE * height + cy;
    let half_width = (offsets[2] * SIZE_VARIANCE).exp() * width / 2.;
    let half_height = (offsets[3] * SIZE_VARIANCE).exp() * height / 2.;
    Detection {
        x1: centre_x - half_width,
        y1: centre_y - half_height,
        x2: centre_x + half_width,
        y2: centre_y + half_height,
        score,
    }
}

/// The detections scoring at least [`MIN_SCORE`], best first, without any
/// overlapping a better one by more than [`NMS_IOU`].
pub fn suppress(mut detections: Vec<Detection>) -> Vec<Detection> {
    detections.retain(|detection| detection.score >= MIN_SCORE && detection.area() > 0.);
    detections.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for detection in detections {
        if kept.iter().all(|better| better.iou(&detection) <= NMS_IOU) {
            kept.push(detection);
        }
    }
    kept
}

/// A loaded face detector.
pub struct Faces {
    model: Model,
}

impl Faces {
    /// Loads the model from `dir`.
    pub fn load(dir: &Path) -> FaceResult<Self> {
        let model = Model::load_file(dir.join(MODEL))
            .map_err(|err| FaceError::Model(format!("{MODEL}: {err}")))?;
        Ok(Self { model })
    }

    /// The faces in `image`, in its pixels, best first.
    pub fn detect(&self, image: &RgbaImage) -> FaceResult<Vec<Rect>> {
        let size = image.dimensions();
        if size.0 == 0 || size.1 == 0 {
            return Ok(Vec::new());
        }
        let resized =
            image::imageops::resize(image, INPUT_WIDTH, INPUT_HEIGHT, FilterType::Triangle);
        // NCHW RGB, normalised as UltraFace was trained: (pixel - 127) / 128.
        let mut input =
            NdTensor::<f32, 4>::zeros([1, 3, INPUT_HEIGHT as usize, INPUT_WIDTH as usize]);
        for (x, y, pixel) in resized.enumerate_pixels() {
            for channel in 0..3 {
                input[[0, channel, y as usize, x as usize]] =
                    (f32::from(pixel[channel]) - 127.) / 128.;
            }
        }

        let node = |name: &str| {
            self.model
                .node_id(name)
                .map_err(|err| FaceError::Model(format!("{MODEL}: {err}")))
        };
        let [scores, locations] = self
            .model
            .run_n(
                vec![(node(INPUT_NODE)?, input.into())],
                [node(SCORES_NODE)?, node(LOCATIONS_NODE)?],
                None,
            )
            .map_err(|err| FaceError::Engine(err.to_string()))?;
        let scores: NdTensor<f32, 3> = scores
            .try_into()
            .map_err(|_| FaceError::Engine("unexpected scores output".into()))?;
        let locations: NdTensor<f32, 3> = locations
            .try_into()
            .map_err(|_| FaceError::Engine("unexpected box output".into()))?;
        let priors = priors();
        if scores.size(1) != priors.len()
            || locations.size(1) != priors.len()
            || scores.size(2) < 2
            || locations.size(2) < 4
        {
            return Err(FaceError::Engine("unexpected output shape".into()));
        }
        let detections = priors
            .iter()
            .enumerate()
            .map(|(i, prior)| {
                let offsets = [0, 1, 2, 3].map(|k| locations[[0, i, k]]);
                // Column 0 is the background class, 1 a face.
                decode(offsets, *prior, scores[[0, i, 1]])
            })
            .collect();
        Ok(suppress(detections)
            .into_iter()
            .map(|detection| detection.to_rect(size))
            .filter(|rect| rect.width > 0 && rect.height > 0)
            .collect())
    }
}

/// The detector behind the editor's Blur private details, loaded the first
/// time it is used and kept.
pub struct FaceState {
    models: PathBuf,
    engine: Mutex<Option<Arc<Faces>>>,
}

impl FaceState {
    pub fn new(models: PathBuf) -> Self {
        Self {
            models,
            engine: Mutex::new(None),
        }
    }
}

/// The faces in `image` right now, loading the model first when this is the
/// first detection since Grab-it started.
pub fn detect_now(app: &AppHandle, image: &RgbaImage) -> FaceResult<Vec<Rect>> {
    let state = app.state::<FaceState>();
    let engine = {
        let mut slot = state
            .engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match slot.as_ref() {
            Some(engine) => Arc::clone(engine),
            None => {
                let engine = Arc::new(Faces::load(&state.models)?);
                *slot = Some(Arc::clone(&engine));
                engine
            }
        }
    };
    engine.detect(image)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::OnceLock};

    /// The model as the app bundles it.
    fn bundled_models_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(MODELS_DIR)
    }

    fn engine() -> &'static Faces {
        static ENGINE: OnceLock<Faces> = OnceLock::new();
        ENGINE.get_or_init(|| Faces::load(&bundled_models_dir()).expect("load the face model"))
    }

    /// Neil Armstrong's official NASA portrait (1969, public domain),
    /// downscaled to 320×400: `convert Neil_Armstrong_pose.jpg -resize
    /// 320x400 -strip -quality 85 face-portrait.jpg`.
    fn portrait() -> RgbaImage {
        image::open(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join("face-portrait.jpg"),
        )
        .unwrap()
        .into_rgba8()
    }

    /// The SHA-256 of the bundled model. Also listed in
    /// `face-models/LICENSE.md`.
    const MODEL_SHA256: &str = "dc64d1dcc24c426d15a88e27091add475fc201763f866792f3ad09ebaeb0d1dc";

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
    fn a_missing_model_is_a_model_error() {
        let dir = tempfile::TempDir::new().unwrap();
        let err = Faces::load(dir.path()).err().expect("no model to load");
        assert!(matches!(err, FaceError::Model(_)), "got {err:?}");
        assert!(err.to_string().contains(MODEL), "{err}");
    }

    #[test]
    fn a_blank_image_has_no_faces() {
        let blank = RgbaImage::from_pixel(640, 480, image::Rgba([255, 255, 255, 255]));
        assert_eq!(engine().detect(&blank).unwrap(), vec![]);
        assert_eq!(engine().detect(&RgbaImage::new(0, 0)).unwrap(), vec![]);
    }

    #[test]
    fn the_portrait_has_one_face_in_its_upper_half() {
        let image = portrait();
        let (width, height) = image.dimensions();
        let faces = engine().detect(&image).unwrap();
        assert_eq!(faces.len(), 1, "{faces:?}");
        let face = faces[0];
        assert!(
            face.width > width / 8 && face.height > height / 10,
            "{face:?}"
        );
        assert!(face.x >= 0 && face.y >= 0, "{face:?}");
        assert!(face.x.unsigned_abs() + face.width <= width, "{face:?}");
        assert!(face.y.unsigned_abs() + face.height <= height, "{face:?}");
        let centre_y = face.y.unsigned_abs() + face.height / 2;
        assert!(centre_y < height * 2 / 3, "{face:?}");
    }

    fn detection(x1: f32, y1: f32, x2: f32, y2: f32, score: f32) -> Detection {
        Detection {
            x1,
            y1,
            x2,
            y2,
            score,
        }
    }

    #[test]
    fn low_scores_and_overlaps_are_dropped() {
        let best = detection(0.1, 0.1, 0.3, 0.3, 0.95);
        let overlapping = detection(0.12, 0.12, 0.32, 0.32, 0.9);
        let apart = detection(0.6, 0.6, 0.8, 0.8, 0.8);
        let weak = detection(0.4, 0.0, 0.5, 0.1, 0.5);
        assert_eq!(
            suppress(vec![apart, weak, overlapping, best]),
            vec![best, apart]
        );
    }

    #[test]
    fn there_is_a_prior_for_every_box_the_model_outputs() {
        let priors = priors();
        assert_eq!(priors.len(), 4420);
        assert_eq!(priors[0], [0.0125, 1. / 60., 10. / 320., 10. / 240.]);
        assert_eq!(priors[2][2], 24. / 320.);
        // The largest boxes are clipped to the input.
        assert_eq!(priors[4419][3], 1.);
    }

    #[test]
    fn zero_offsets_decode_to_the_prior() {
        let decoded = decode([0.; 4], [0.5, 0.5, 0.2, 0.4], 0.9);
        assert_eq!(decoded, detection(0.4, 0.3, 0.6, 0.7, 0.9));
    }

    #[test]
    fn boxes_scale_to_capture_pixels() {
        let rect = detection(0.25, 0.5, 0.5, 1.2, 0.9).to_rect((800, 600));
        assert_eq!(
            rect,
            Rect {
                x: 200,
                y: 300,
                width: 200,
                height: 300,
            }
        );
    }
}
