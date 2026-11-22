//! Annotate with AI: the editor sends the capture, with the text Grab-it
//! read in it, and the user's instruction ("box the provider controls and
//! point at Test connection") to the provider chosen in Settings → AI
//! integration. The model answers with typed rectangles, arrows and labels
//! that name a text region by its ID or give coordinates in the image it
//! was sent. They come back here as positions in the original capture's
//! pixels, kept inside it; anything that cannot be placed is dropped and
//! counted. The editor previews them and adds only what the user applies.

use std::time::Duration;

use image::GenericImageView;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{Manager, State};

use crate::rt::{AppHandle, WebviewWindow};
use crate::{
    ai::{self, AiError, Ask, Clients, first_object, truncate},
    capture::Rect,
    editor::{EditorState, capture_lines},
    library::LibraryState,
    ocr::OcrLine,
    settings::AiSettings,
};

/// How long a suggestion may take: the user is waiting in the editor.
pub const ANNOTATE_TIMEOUT: Duration = Duration::from_secs(120);
/// The longest instruction sent.
pub const MAX_INSTRUCTION_CHARS: usize = 1000;
/// The most text regions listed in the prompt.
const MAX_REGIONS: usize = 150;
/// The longest region text listed.
const MAX_REGION_CHARS: usize = 80;
/// The most suggestions kept; the rest are counted as skipped.
pub const MAX_SUGGESTIONS: usize = 24;
/// The longest label kept.
const MAX_LABEL_CHARS: usize = 120;
/// The longest answer an endpoint may give, in tokens.
const MAX_TOKENS: u32 = 2000;
/// A box around a text region leaves this many capture pixels around it.
const REGION_PADDING: f64 = 6.0;
/// Boxes and arrows smaller than this, in capture pixels, are dropped.
const MIN_SIZE: f64 = 3.0;
/// Arrows shorter than this are dropped.
const MIN_ARROW: f64 = 8.0;
/// The gap left between a target and an arrow's head or a label.
const GAP: f64 = 8.0;
/// About how tall a label is, to place one above its target.
const LABEL_HEIGHT: f64 = 40.0;

/// Sent as the system prompt when suggesting annotations.
pub const SYSTEM_PROMPT: &str = "You mark up screenshots with boxes, arrows and short labels, as \
     the user describes. You reply with a single JSON object and nothing else.";

/// One suggested shape, in whole pixels of the original capture and
/// inside it.
/// Mirrors `AiSuggestion` in src/editor/aiAnnotate.ts.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Suggestion {
    /// A rectangle outline.
    Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    /// An arrow from its tail (`x1`, `y1`) to its head (`x2`, `y2`).
    Arrow { x1: f64, y1: f64, x2: f64, y2: f64 },
    /// A label whose top-left corner is at `x`, `y`.
    Text { x: f64, y: f64, text: String },
}

/// What Annotate with AI found. Mirrors `AnnotateOutcome` in
/// src/editor/aiAnnotate.ts.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AnnotateOutcome {
    /// No provider is set up: the editor offers Settings, keeping the
    /// instruction.
    NeedsProvider,
    /// The model's shapes that could be placed, and how many could not.
    Suggested {
        suggestions: Vec<Suggestion>,
        skipped: u32,
        by: String,
    },
}

/// The capture's size, and how much it was scaled down for the model.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// The sent image's pixels per capture pixel: at most 1.
    pub scale: f64,
}

impl Frame {
    /// The frame for a capture of `width` × `height` sent at `sent_width`.
    pub fn new(width: u32, height: u32, sent_width: u32) -> Self {
        let scale = if width == 0 {
            1.0
        } else {
            f64::from(sent_width) / f64::from(width)
        };
        Self {
            width,
            height,
            scale: if scale > 0.0 { scale } else { 1.0 },
        }
    }

    fn sent(&self, value: f64) -> i64 {
        (value * self.scale).round() as i64
    }

    fn capture(&self, value: f64) -> f64 {
        value / self.scale
    }

    fn clamp_x(&self, x: f64) -> f64 {
        x.clamp(0.0, f64::from(self.width.saturating_sub(1)))
    }

    fn clamp_y(&self, y: f64) -> f64 {
        y.clamp(0.0, f64::from(self.height.saturating_sub(1)))
    }
}

/// A box in capture pixels, as floats.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Area {
    fn of(rect: &Rect) -> Self {
        Self {
            x: f64::from(rect.x),
            y: f64::from(rect.y),
            width: f64::from(rect.width),
            height: f64::from(rect.height),
        }
    }

    fn centre(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    fn padded(&self, by: f64) -> Self {
        Self {
            x: self.x - by,
            y: self.y - by,
            width: self.width + by * 2.0,
            height: self.height + by * 2.0,
        }
    }

    /// The part inside `frame`; None when too little is left.
    fn inside(&self, frame: &Frame) -> Option<Self> {
        let left = self.x.max(0.0);
        let top = self.y.max(0.0);
        let right = (self.x + self.width).min(f64::from(frame.width));
        let bottom = (self.y + self.height).min(f64::from(frame.height));
        (right - left >= MIN_SIZE && bottom - top >= MIN_SIZE).then_some(Self {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        })
    }
}

/// The capture's text regions the model may name: one per line, `t1`
/// first, at most [`MAX_REGIONS`].
fn regions(lines: &[OcrLine]) -> impl Iterator<Item = (String, &OcrLine)> {
    lines
        .iter()
        .filter(|line| !line.text.trim().is_empty())
        .take(MAX_REGIONS)
        .enumerate()
        .map(|(i, line)| (format!("t{}", i + 1), line))
}

/// The instructions: the user's request, the sent image's size and the
/// text regions in its pixels.
pub fn prompt(instruction: &str, lines: &[OcrLine], frame: &Frame) -> String {
    let (width, height) = (
        frame.sent(f64::from(frame.width)),
        frame.sent(f64::from(frame.height)),
    );
    let mut prompt = format!(
        "Mark up this screenshot as the user asks. It is {width} by {height} pixels; x runs \
         right and y down from the top-left corner. Reply with JSON only, in exactly this \
         shape:\n\
         {{\"annotations\": [{{\"kind\": \"...\", \"target\": \"...\", \"box\": [], \"from\": [], \"text\": \"...\"}}]}}\n\
         - kind: \"box\" for a rectangle outline, \"arrow\" for an arrow, or \"label\" for a \
         short text label. A label is always its own \"label\" annotation: to label a box or \
         an arrow, add a label with the same target as well.\n\
         - target: the ID of the text region the shape is about, such as \"t3\", or \"\" when \
         it is about something else. A box outlines its target, an arrow points at it and a \
         label sits beside it. Prefer a region ID over coordinates whenever the shape is \
         about text listed below.\n\
         - box: without a target, where the shape goes, as [x, y, width, height] in pixels: \
         the rectangle a box outlines, what an arrow points at or where a label starts. \
         Otherwise []. To box a group of things, such as a set of controls, make the box \
         cover every region of the group, from the listed coordinates of its first to its \
         last.\n\
         - from: where an arrow starts, as [x, y]; otherwise [].\n\
         - text: a label's text, short. Only labels have text: for a box or an arrow it is \
         \"\".\n\
         Use at most {MAX_SUGGESTIONS} annotations. If nothing fits the request, reply \
         {{\"annotations\": []}}.\n\
         \nThe user asks:\n\"\"\"\n{}\n\"\"\"\n",
        truncate(instruction, MAX_INSTRUCTION_CHARS)
    );
    let mut listed = regions(lines).peekable();
    if listed.peek().is_none() {
        prompt.push_str("\nNo text was read from the screenshot, so give every shape a box.\n");
        return prompt;
    }
    prompt.push_str(
        "\nText regions read from the screenshot by OCR, which may have mistakes, as \
         ID [x, y, width, height] \"text\":\n",
    );
    for (id, line) in listed {
        let area = Area::of(&line.rect);
        prompt.push_str(&format!(
            "{id} [{}, {}, {}, {}] {:?}\n",
            frame.sent(area.x),
            frame.sent(area.y),
            frame.sent(area.width),
            frame.sent(area.height),
            truncate(&line.text, MAX_REGION_CHARS)
        ));
    }
    prompt
}

/// The JSON schema the answer follows, for providers that hold their
/// answer to one. Strict, as OpenAI's structured outputs want it.
pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "annotations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["box", "arrow", "label"],
                            "description": "A label is its own annotation, never text on a box or an arrow.",
                        },
                        "target": {
                            "type": "string",
                            "description": "A text region's ID, such as t3, preferred over a box; or empty.",
                        },
                        "box": { "type": "array", "items": { "type": "number" } },
                        "from": { "type": "array", "items": { "type": "number" } },
                        "text": {
                            "type": "string",
                            "description": "A label's text; empty for a box or an arrow.",
                        },
                    },
                    "required": ["kind", "target", "box", "from", "text"],
                    "additionalProperties": false,
                },
            },
        },
        "required": ["annotations"],
        "additionalProperties": false,
    })
}

/// Where a target names: a region, or nothing.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Target {
    Region(Area),
    /// Text that more than one region holds: which one is meant is unclear.
    Ambiguous,
    None,
}

/// The region `target` names: by ID, or, when the model wrote the text
/// itself, the one line or word holding exactly that text.
fn resolve(target: &str, lines: &[OcrLine]) -> Target {
    let target = target.trim();
    if target.is_empty() {
        return Target::None;
    }
    if let Some((_, line)) = regions(lines).find(|(id, _)| id.eq_ignore_ascii_case(target)) {
        return Target::Region(Area::of(&line.rect));
    }
    let wanted = target.trim_matches('"').to_lowercase();
    let mut found: Vec<Rect> = Vec::new();
    for line in lines {
        if line.text.trim().to_lowercase() == wanted {
            found.push(line.rect);
        }
        for word in &line.words {
            if word.text.trim().to_lowercase() == wanted && !found.contains(&line.rect) {
                found.push(word.rect);
            }
        }
    }
    match found.as_slice() {
        [one] => Target::Region(Area::of(one)),
        [] => Target::None,
        _ => Target::Ambiguous,
    }
}

/// The numbers in `value`, when it is an array of exactly `len` of them.
fn numbers(value: Option<&Value>, len: usize) -> Option<Vec<f64>> {
    let items = value?.as_array()?;
    if items.len() != len {
        return None;
    }
    items
        .iter()
        .map(|item| item.as_f64().filter(|n| n.is_finite()))
        .collect()
}

/// A `box` in sent pixels as capture pixels: a rectangle, or a point when
/// it has two numbers.
fn sent_box(value: Option<&Value>, frame: &Frame) -> Option<Area> {
    if let Some(rect) = numbers(value, 4) {
        let area = Area {
            x: frame.capture(rect[0].min(rect[0] + rect[2])),
            y: frame.capture(rect[1].min(rect[1] + rect[3])),
            width: frame.capture(rect[2].abs()),
            height: frame.capture(rect[3].abs()),
        };
        return Some(area);
    }
    numbers(value, 2).map(|point| Area {
        x: frame.capture(point[0]),
        y: frame.capture(point[1]),
        width: 0.0,
        height: 0.0,
    })
}

/// Where an arrow aimed at `target` from `tail` ends: just outside the
/// target's edge on the way from its centre to the tail, or its centre
/// when the tail is inside it.
fn arrow_head(target: &Area, tail: (f64, f64)) -> (f64, f64) {
    let (cx, cy) = target.centre();
    let (dx, dy) = (tail.0 - cx, tail.1 - cy);
    let (half_w, half_h) = (target.width / 2.0, target.height / 2.0);
    if dx.abs() <= half_w && dy.abs() <= half_h {
        return (cx, cy);
    }
    // The fraction of the way to the tail at which the line leaves the box.
    let t = [
        if dx == 0.0 {
            f64::INFINITY
        } else {
            half_w / dx.abs()
        },
        if dy == 0.0 {
            f64::INFINITY
        } else {
            half_h / dy.abs()
        },
    ]
    .into_iter()
    .fold(f64::INFINITY, f64::min);
    let length = dx.hypot(dy);
    let t = (t + GAP / length).min(1.0);
    (cx + dx * t, cy + dy * t)
}

/// Where an arrow at `target` starts when the model gave no start: up and
/// to the left, or on whichever side has room, kept inside the frame.
fn default_tail(target: &Area, frame: &Frame) -> (f64, f64) {
    let reach = (f64::from(frame.width.max(frame.height)) * 0.08).max(48.0);
    let x = if target.x - reach >= 0.0 {
        target.x - reach
    } else {
        target.x + target.width + reach
    };
    let y = if target.y - reach >= 0.0 {
        target.y - reach
    } else {
        target.y + target.height + reach
    };
    (frame.clamp_x(x), frame.clamp_y(y))
}

/// Where a label beside `area` starts: below it, or above it when there is
/// no room below.
fn beside(area: &Area, frame: &Frame) -> (f64, f64) {
    let below = area.y + area.height + GAP;
    if below + LABEL_HEIGHT <= f64::from(frame.height) {
        (area.x, below)
    } else {
        (area.x, area.y - GAP - LABEL_HEIGHT)
    }
}

fn label_at(x: f64, y: f64, text: String, frame: &Frame) -> Suggestion {
    Suggestion::Text {
        x: frame.clamp_x(x).round(),
        y: frame.clamp_y(y).round(),
        text,
    }
}

/// The label a box or an arrow asks for with its own `text`, which only
/// labels should have: beside the box, or at the arrow's tail on the side
/// away from its head. None for anything else, or without text.
fn label_for(item: &Value, shape: &Suggestion, frame: &Frame) -> Option<Suggestion> {
    let text = item.get("text")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let text = truncate(text, MAX_LABEL_CHARS);
    let (x, y) = match *shape {
        Suggestion::Rect {
            x,
            y,
            width,
            height,
        } => beside(
            &Area {
                x,
                y,
                width,
                height,
            },
            frame,
        ),
        Suggestion::Arrow { x1, y1, y2, .. } if y2 > y1 => (x1, y1 - GAP - LABEL_HEIGHT),
        Suggestion::Arrow { x1, y1, .. } => (x1, y1 + GAP),
        Suggestion::Text { .. } => return None,
    };
    Some(label_at(x, y, text, frame))
}

/// Whether `item` is a label, by its kind.
fn is_label(item: &Value) -> bool {
    item.get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| matches!(kind.trim().to_lowercase().as_str(), "label" | "text"))
}

/// `item`'s `field`, trimmed and lowercased; empty when missing.
fn key(item: &Value, field: &str) -> String {
    item.get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

/// Reads one annotation as a suggestion, or None when it cannot be placed.
/// A box and an arrow use their target's region when it has one, which
/// OCR measured, else the `box`; a label goes where its `box` says, else
/// beside its target.
fn suggestion(item: &Value, lines: &[OcrLine], frame: &Frame) -> Option<Suggestion> {
    let kind = item.get("kind")?.as_str()?.trim().to_lowercase();
    // An ambiguous target is placed only by its box.
    let region = match resolve(
        item.get("target").and_then(Value::as_str).unwrap_or(""),
        lines,
    ) {
        Target::Region(area) => Some(area),
        Target::Ambiguous | Target::None => None,
    };
    let placed = sent_box(item.get("box"), frame);
    let sized = placed.filter(|area| area.width > 0.0 && area.height > 0.0);
    match kind.as_str() {
        "box" | "rect" | "rectangle" => {
            let area = region.map(|area| area.padded(REGION_PADDING)).or(sized)?;
            let area = area.inside(frame)?;
            Some(Suggestion::Rect {
                x: area.x.round(),
                y: area.y.round(),
                width: area.width.round(),
                height: area.height.round(),
            })
        }
        "arrow" => {
            let aim = region.or(placed)?;
            let tail = numbers(item.get("from"), 2)
                .map(|point| {
                    (
                        frame.clamp_x(frame.capture(point[0])),
                        frame.clamp_y(frame.capture(point[1])),
                    )
                })
                .unwrap_or_else(|| default_tail(&aim, frame));
            let (x2, y2) = arrow_head(&aim, tail);
            let (x1, y1) = (tail.0.round(), tail.1.round());
            let (x2, y2) = (frame.clamp_x(x2).round(), frame.clamp_y(y2).round());
            ((x2 - x1).hypot(y2 - y1) >= MIN_ARROW).then_some(Suggestion::Arrow { x1, y1, x2, y2 })
        }
        "label" | "text" => {
            let text = item.get("text")?.as_str()?.trim();
            if text.is_empty() {
                return None;
            }
            let text = truncate(text, MAX_LABEL_CHARS);
            let (x, y) = match (placed, region) {
                (Some(at), _) => (at.x, at.y),
                (None, Some(region)) => beside(&region, frame),
                (None, None) => return None,
            };
            Some(label_at(x, y, text, frame))
        }
        _ => None,
    }
}

/// Reads the model's reply as suggestions in capture pixels, and how many
/// annotations could not be placed. A box or an arrow that carries text,
/// as models do although only labels should, also gets that text as a
/// label, unless one of the model's labels has its target or its text.
///
/// Those that could not be placed have an unknown kind, a target that is
/// missing or names more than one region, a label without text, or a
/// shape with no room inside the capture. Chatter or code fences around
/// the JSON are ignored.
pub fn parse(
    reply: &str,
    lines: &[OcrLine],
    frame: &Frame,
) -> Result<(Vec<Suggestion>, u32), AiError> {
    let object = first_object(reply)
        .ok_or_else(|| AiError::Response(format!("no JSON in {:?}", truncate(reply, 200))))?;
    let value: Value = serde_json::from_str(object)
        .map_err(|err| AiError::Response(format!("invalid JSON ({err}) in {object:?}")))?;
    let items = value
        .get("annotations")
        .and_then(Value::as_array)
        .ok_or_else(|| AiError::Response(format!("no annotations in {}", truncate(object, 200))))?;
    // What the model's own labels are about, so a box or arrow that also
    // carries text gets a label only when none of them is for it already.
    let labels: Vec<(String, String)> = items
        .iter()
        .filter(|item| is_label(item))
        .map(|item| (key(item, "target"), key(item, "text")))
        .collect();
    let labelled = |item: &Value| {
        let (target, text) = (key(item, "target"), key(item, "text"));
        labels.iter().any(|(label_target, label_text)| {
            (!target.is_empty() && *label_target == target) || *label_text == text
        })
    };
    let mut suggestions = Vec::new();
    let mut skipped = 0u32;
    let mut keep = |found: Option<Suggestion>, suggestions: &mut Vec<Suggestion>| match found {
        Some(found) if suggestions.len() < MAX_SUGGESTIONS => suggestions.push(found),
        _ => skipped += 1,
    };
    for item in items {
        let found = suggestion(item, lines, frame);
        let extra = match &found {
            Some(shape) if !is_label(item) && !labelled(item) => label_for(item, shape, frame),
            _ => None,
        };
        keep(found, &mut suggestions);
        if extra.is_some() {
            keep(extra, &mut suggestions);
        }
    }
    Ok((suggestions, skipped))
}

/// Asks the provider in `ai` to mark up `image` as `instruction` says.
pub fn annotate(
    clients: &Clients,
    ai: &AiSettings,
    image: image::DynamicImage,
    lines: &[OcrLine],
    instruction: &str,
) -> Result<(Vec<Suggestion>, u32), AiError> {
    let (width, height) = image.dimensions();
    let fitted = ai::fit_image(image);
    let frame = Frame::new(width, height, fitted.width());
    let png = ai::encode_png(fitted)?;
    let reply = ai::ask(
        clients,
        ai,
        &Ask {
            system: SYSTEM_PROMPT,
            prompt: &prompt(instruction, lines, &frame),
            png: &png,
            schema: &schema(),
            max_tokens: MAX_TOKENS,
        },
    )?;
    parse(&reply, lines, &frame)
}

/// Suggests annotations for the editor's capture as `instruction` asks.
/// Without a provider set up, says so, so the editor can offer Settings.
/// The text regions are the library's stored ones or read now; a capture
/// with none is still sent, and the model places shapes by coordinates.
#[tauri::command(async)]
#[specta::specta]
pub fn editor_annotate(
    instruction: String,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, EditorState>,
) -> Result<AnnotateOutcome, String> {
    let instruction = instruction.trim();
    if instruction.is_empty() {
        return Err("Describe the markup you want first.".into());
    }
    let ai = ai::current_settings(&app);
    if !ai.enabled {
        return Ok(AnnotateOutcome::NeedsProvider);
    }
    let path = state.path_for(window.label())?;
    let image =
        image::open(&path).map_err(|err| format!("could not open {}: {err}", path.display()))?;
    let library = app.try_state::<LibraryState>();
    let lines = capture_lines(library.as_deref(), &path, |image| {
        crate::ocr::read_now(&app, image).map_err(|err| err.to_string())
    })
    .unwrap_or_else(|err| {
        eprintln!("Grab-it: Annotate with AI goes without text regions: {err}");
        Vec::new()
    });
    let clients = Clients::new(ANNOTATE_TIMEOUT);
    let (suggestions, skipped) =
        annotate(&clients, &ai, image, &lines, instruction).map_err(|err| err.to_string())?;
    Ok(AnnotateOutcome::Suggested {
        suggestions,
        skipped,
        by: crate::tidy::tidier_name(&ai),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocr::OcrWord;

    fn line(text: &str, x: i32, y: i32, width: u32, height: u32) -> OcrLine {
        let rect = Rect {
            x,
            y,
            width,
            height,
        };
        OcrLine {
            text: text.into(),
            rect,
            words: vec![OcrWord {
                text: text.into(),
                rect,
            }],
        }
    }

    fn settings_page() -> Vec<OcrLine> {
        vec![
            line("Provider", 100, 100, 200, 30),
            line("Test connection", 400, 600, 240, 40),
            line("Save", 900, 600, 80, 40),
            line("Save", 900, 900, 80, 40),
        ]
    }

    /// A 2x HiDPI capture sent at half its size.
    fn hidpi() -> Frame {
        Frame::new(3136, 2000, 1568)
    }

    fn reply(annotations: Value) -> String {
        json!({ "annotations": annotations }).to_string()
    }

    #[test]
    fn region_ids_map_to_the_ocr_box_in_capture_pixels() {
        let lines = settings_page();
        let answer = reply(json!([
            { "kind": "box", "target": "t2", "box": [], "from": [], "text": "" },
        ]));
        let (found, skipped) = parse(&answer, &lines, &hidpi()).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(
            found,
            vec![Suggestion::Rect {
                x: 394.0,
                y: 594.0,
                width: 252.0,
                height: 52.0
            }]
        );
    }

    #[test]
    fn coordinates_in_the_sent_image_are_scaled_back_up() {
        let answer = reply(json!([
            { "kind": "box", "target": "", "box": [50, 40, 100, 25], "from": [], "text": "" },
            { "kind": "label", "target": "", "box": [10, 20], "from": [], "text": "Here" },
        ]));
        let (found, _) = parse(&answer, &[], &hidpi()).unwrap();
        assert_eq!(
            found,
            vec![
                Suggestion::Rect {
                    x: 100.0,
                    y: 80.0,
                    width: 200.0,
                    height: 50.0
                },
                Suggestion::Text {
                    x: 20.0,
                    y: 40.0,
                    text: "Here".into()
                },
            ]
        );
    }

    #[test]
    fn the_prompt_lists_regions_in_the_sent_images_pixels() {
        let text = prompt("Box the provider", &settings_page(), &hidpi());
        assert!(text.contains("1568 by 1000 pixels"), "{text}");
        assert!(
            text.contains("t2 [200, 300, 120, 20] \"Test connection\""),
            "{text}"
        );
        assert!(text.contains("\"\"\"\nBox the provider\n\"\"\""), "{text}");
    }

    #[test]
    fn missing_ocr_asks_for_coordinates() {
        let text = prompt("Box it", &[], &Frame::new(800, 600, 800));
        assert!(text.contains("No text was read"), "{text}");
        assert!(!text.contains("t1 ["), "{text}");
        let answer = reply(json!([
            { "kind": "box", "target": "t1", "box": [], "from": [], "text": "" },
            { "kind": "box", "target": "", "box": [10, 10, 50, 50], "from": [], "text": "" },
        ]));
        let (found, skipped) = parse(&answer, &[], &Frame::new(800, 600, 800)).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(skipped, 1);
    }

    #[test]
    fn an_ambiguous_label_is_skipped_unless_a_box_places_it() {
        let lines = settings_page();
        let frame = Frame::new(1200, 1000, 1200);
        let answer = reply(json!([
            { "kind": "box", "target": "Save", "box": [], "from": [], "text": "" },
            { "kind": "box", "target": "Save", "box": [895, 595, 90, 50], "from": [], "text": "" },
            { "kind": "arrow", "target": "Test connection", "box": [], "from": [], "text": "" },
        ]));
        let (found, skipped) = parse(&answer, &lines, &frame).unwrap();
        assert_eq!(skipped, 1);
        assert_eq!(
            found[0],
            Suggestion::Rect {
                x: 895.0,
                y: 595.0,
                width: 90.0,
                height: 50.0
            }
        );
        // The unique text resolves like its ID.
        assert!(matches!(found[1], Suggestion::Arrow { .. }));
    }

    #[test]
    fn an_arrow_stops_short_of_its_target() {
        let lines = settings_page();
        let frame = Frame::new(1200, 1000, 1200);
        let answer = reply(json!([
            { "kind": "arrow", "target": "t2", "box": [], "from": [520, 400], "text": "" },
        ]));
        let (found, _) = parse(&answer, &lines, &frame).unwrap();
        // Straight down onto the top edge (y 600), the gap above it.
        assert_eq!(
            found,
            vec![Suggestion::Arrow {
                x1: 520.0,
                y1: 400.0,
                x2: 520.0,
                y2: 592.0
            }]
        );
    }

    #[test]
    fn shapes_are_kept_inside_the_capture() {
        let frame = Frame::new(800, 600, 800);
        let answer = reply(json!([
            { "kind": "box", "target": "", "box": [700, 500, 400, 400], "from": [], "text": "" },
            { "kind": "box", "target": "", "box": [900, 900, 50, 50], "from": [], "text": "" },
            { "kind": "label", "target": "", "box": [5000, -20], "from": [], "text": "Off" },
            { "kind": "arrow", "target": "", "box": [10, 10, 20, 20], "from": [-50, 9000], "text": "" },
        ]));
        let (found, skipped) = parse(&answer, &[], &frame).unwrap();
        assert_eq!(skipped, 1);
        assert_eq!(
            found[0],
            Suggestion::Rect {
                x: 700.0,
                y: 500.0,
                width: 100.0,
                height: 100.0
            }
        );
        assert_eq!(
            found[1],
            Suggestion::Text {
                x: 799.0,
                y: 0.0,
                text: "Off".into()
            }
        );
        let Suggestion::Arrow { x1, y1, .. } = found[2] else {
            panic!("{:?}", found[2]);
        };
        assert_eq!((x1, y1), (0.0, 599.0));
    }

    #[test]
    fn a_label_sits_below_its_target() {
        let lines = settings_page();
        let frame = Frame::new(1200, 960, 1200);
        let answer = reply(json!([
            { "kind": "label", "target": "t1", "box": [], "from": [], "text": "  Pick one  " },
            { "kind": "label", "target": "t4", "box": [], "from": [], "text": "Last" },
        ]));
        let (found, _) = parse(&answer, &lines, &frame).unwrap();
        assert_eq!(
            found[0],
            Suggestion::Text {
                x: 100.0,
                y: 138.0,
                text: "Pick one".into()
            }
        );
        // No room below the bottom region: above it.
        assert_eq!(
            found[1],
            Suggestion::Text {
                x: 900.0,
                y: 852.0,
                text: "Last".into()
            }
        );
    }

    #[test]
    fn invalid_output_is_an_error_or_skipped() {
        let frame = Frame::new(800, 600, 800);
        assert!(matches!(
            parse("I can't do that.", &[], &frame),
            Err(AiError::Response(_))
        ));
        assert!(matches!(
            parse(r#"{"shapes": []}"#, &[], &frame),
            Err(AiError::Response(_))
        ));
        let answer = reply(json!([
            { "kind": "circle", "target": "", "box": [1, 1, 50, 50] },
            { "kind": "label", "target": "", "box": [1, 1], "text": "   " },
            { "kind": "box", "target": "", "box": ["a", 1, 2, 3] },
            { "kind": "box", "target": "", "box": [1, 1, 1, 1] },
            "nonsense",
        ]));
        assert_eq!(parse(&answer, &[], &frame).unwrap(), (vec![], 5));
        let fenced = format!("Sure:\n```json\n{}\n```", reply(json!([])));
        assert_eq!(parse(&fenced, &[], &frame).unwrap(), (vec![], 0));
    }

    #[test]
    fn suggestions_past_the_limit_are_skipped() {
        let frame = Frame::new(800, 600, 800);
        let many: Vec<Value> = (0..MAX_SUGGESTIONS + 3)
            .map(|i| json!({ "kind": "box", "target": "", "box": [i, i, 20, 20], "from": [], "text": "" }))
            .collect();
        let (found, skipped) = parse(&reply(Value::Array(many)), &[], &frame).unwrap();
        assert_eq!(found.len(), MAX_SUGGESTIONS);
        assert_eq!(skipped, 3);
    }

    /// Gemma 4 26B's answer in LM Studio to "Box the provider controls,
    /// point an arrow at Test connection and label it", on a 2180 × 1720
    /// Settings screenshot sent at 1568 × 1237, where OCR read 44 regions
    /// and Test connection was t41. It put each label in its shape's text.
    const GEMMA_REPLY: &str = "```json\n{\"annotations\": [{\"kind\": \"box\", \"target\": \"\", \
        \"box\": [403, 315, 731, 400], \"from\": [], \"text\": \"provider controls\"}, {\"kind\": \
        \"arrow\", \"target\": \"t41\", \"box\": [1167, 1050], \"from\": [1167, 1050], \"text\": \
        \"Test connection\"}]}\n```";

    #[test]
    fn text_on_a_box_or_an_arrow_becomes_its_label() {
        let frame = Frame::new(2180, 1720, 1568);
        // Forty other lines, then Test connection as t41, in capture pixels.
        let mut lines: Vec<OcrLine> = (0..40)
            .map(|i| line(&format!("Line {i}"), 40, 40 + i * 30, 120, 20))
            .collect();
        lines.push(line("Test connection", 1520, 1532, 207, 24));
        let (found, skipped) = parse(GEMMA_REPLY, &lines, &frame).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(found.len(), 4, "{found:?}");
        assert_eq!(
            found[0],
            Suggestion::Rect {
                x: 560.0,
                y: 438.0,
                width: 1016.0,
                height: 556.0
            }
        );
        // Below the box.
        assert_eq!(
            found[1],
            Suggestion::Text {
                x: 560.0,
                y: 1002.0,
                text: "provider controls".into()
            }
        );
        let Suggestion::Arrow { x1, y1, x2, y2 } = found[2] else {
            panic!("{:?}", found[2]);
        };
        assert_eq!((x1, y1), (1622.0, 1460.0));
        // Down to just above Test connection.
        assert!(
            (1520.0..=1727.0).contains(&x2) && y2 < 1532.0 && y2 > y1,
            "{x2}, {y2}"
        );
        // The arrow points down, so its label sits above its tail.
        assert_eq!(
            found[3],
            Suggestion::Text {
                x: 1622.0,
                y: 1412.0,
                text: "Test connection".into()
            }
        );
    }

    #[test]
    fn a_shape_the_model_labelled_itself_gets_no_second_label() {
        let lines = settings_page();
        let frame = Frame::new(1200, 1000, 1200);
        let answer = reply(json!([
            { "kind": "arrow", "target": "t2", "box": [], "from": [520, 400], "text": "Test it" },
            { "kind": "label", "target": "t2", "box": [], "from": [], "text": "Try this" },
            { "kind": "box", "target": "t1", "box": [], "from": [], "text": "Provider" },
            { "kind": "label", "target": "", "box": [10, 10], "from": [], "text": "provider" },
        ]));
        let (found, skipped) = parse(&answer, &lines, &frame).unwrap();
        assert_eq!(skipped, 0);
        let texts: Vec<&str> = found
            .iter()
            .filter_map(|shape| match shape {
                Suggestion::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, ["Try this", "provider"]);
    }

    #[test]
    fn the_prompt_keeps_labels_separate_and_prefers_region_ids() {
        let text = prompt("Box it", &settings_page(), &Frame::new(1200, 1000, 1200));
        assert!(
            text.contains("A label is always its own \"label\" annotation"),
            "{text}"
        );
        assert!(text.contains("Only labels have text"), "{text}");
        assert!(
            text.contains("Prefer a region ID over coordinates"),
            "{text}"
        );
        assert!(text.contains("cover every region of the group"), "{text}");
    }

    #[test]
    fn the_schema_requires_every_field() {
        let schema = schema();
        assert_eq!(
            schema["properties"]["annotations"]["items"]["required"],
            json!(["kind", "target", "box", "from", "text"])
        );
    }
}
