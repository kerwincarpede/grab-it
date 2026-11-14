//! Describing captures with a vision model, so the Library can search and
//! filter by what a capture shows.
//!
//! Off by default: nothing is sent anywhere until the user turns it on in
//! Settings. Then, like the OCR queue in `ocr.rs`, one background thread
//! describes every capture waiting for it, newest first and one at a time,
//! once OCR has finished with it. Each capture goes, downscaled, to an
//! OpenAI-compatible `/chat/completions` endpoint (Ollama, LM Studio,
//! llama.cpp's server, OpenAI, OpenRouter…) with its OCR text, app and
//! window title, and the model answers with a description, a category and
//! a few tags.

use std::{
    fmt,
    io::Cursor,
    path::Path,
    sync::{
        Mutex,
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::{Duration, Instant},
};

use base64::prelude::{BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    commands::{SettingsState, lock},
    library::{AiDescription, AiJob, LIBRARY_CHANGED_EVENT, LibraryError, LibraryState},
    settings::AiSettings,
};

/// What a capture can be. Mirrors `CATEGORIES` in src/library/api.ts.
pub const CATEGORIES: [&str; 10] = [
    "code", "terminal", "browser", "chat", "document", "design", "error", "receipt", "photo",
    "other",
];
/// The category stored when the model gives one not in [`CATEGORIES`].
pub const FALLBACK_CATEGORY: &str = "other";
/// Emitted with an [`AiStatus`] whenever the queue changes state.
pub const AI_STATUS_EVENT: &str = "ai-status";

/// How long a request may wait to connect, or for the model's answer or
/// any part of it, before it gives up. Much longer than the OCR model
/// download's: a local model on a CPU can take minutes for one image, and
/// the answer only starts once it is done.
pub const AI_STALL_TIMEOUT: Duration = Duration::from_secs(300);
/// The same for "Test connection", which the user is waiting on. Still
/// long enough for Ollama to load a model from disk.
pub const TEST_TIMEOUT: Duration = Duration::from_secs(90);
/// Captures are scaled down to fit this many pixels on their long edge
/// before they are sent: enough to read screen text, and the most that
/// several vision APIs use anyway.
pub const MAX_IMAGE_EDGE: u32 = 1568;
/// After the endpoint fails, a new capture retries it no sooner than this.
/// Changing the settings or asking for a description retries at once.
pub const RETRY_AFTER: Duration = Duration::from_secs(60);

/// How much OCR text goes into the prompt.
const MAX_OCR_CHARS: usize = 2000;
/// How much of the window title goes into the prompt.
const MAX_TITLE_CHARS: usize = 200;
const MAX_TAGS: usize = 6;
const MAX_TAG_CHARS: usize = 32;
const MAX_DESCRIPTION_CHARS: usize = 600;
/// The most of a response that is read.
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
/// Request fields some servers refuse; one named in an error is dropped
/// and the request sent again.
const OPTIONAL_FIELDS: [&str; 3] = ["response_format", "max_tokens", "temperature"];

const SYSTEM_PROMPT: &str = "You describe screenshots for a personal screenshot library, so \
     they can be found again by searching. You reply with a single JSON object and nothing else.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiError {
    /// The capture could not be read. Only this capture fails.
    Image(String),
    /// The model's answer was not the JSON asked for. Only this capture
    /// fails.
    Response(String),
    /// The endpoint could not be reached, timed out or refused the
    /// request. The queue stops, and the capture waits, until it is retried.
    Endpoint(String),
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Image(err) => write!(f, "could not read the capture: {err}"),
            Self::Response(err) => write!(f, "the model's answer could not be used: {err}"),
            Self::Endpoint(err) => f.write_str(err),
        }
    }
}

impl std::error::Error for AiError {}

/// What the queue is doing. Mirrors `AiStatus` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub state: AiState,
    /// Captures described, or that could not be described.
    pub done: u32,
    /// Captures that are not skipped.
    pub total: u32,
    /// Why the endpoint failed, in the `error` state.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AiState {
    /// Describing is turned off in Settings.
    Off,
    /// Nothing waits to be described (or waits for OCR first).
    Idle,
    /// A capture is being described.
    Working,
    /// The endpoint failed; waiting captures are described once it is
    /// retried.
    Error,
}

impl AiStatus {
    fn new(state: AiState, counts: crate::library::AiCounts, error: Option<String>) -> Self {
        Self {
            state,
            done: counts.done,
            total: counts.total,
            error,
        }
    }
}

/// An HTTP agent whose every network phase gives up after `stall` without
/// progress, and which hands back error responses so their message can be
/// shown.
pub fn agent(stall: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_resolve(Some(stall))
        .timeout_connect(Some(stall))
        .timeout_send_request(Some(stall))
        .timeout_send_body(Some(stall))
        .timeout_recv_response(Some(stall))
        .timeout_recv_body(Some(stall))
        .timeout_per_read(Some(stall))
        .timeout_per_write(Some(stall))
        .build()
        .new_agent()
}

/// The capture as a PNG `data:` URL, scaled down to fit [`MAX_IMAGE_EDGE`].
pub fn image_data_url(png: &Path) -> Result<String, AiError> {
    let image = image::open(png).map_err(|err| AiError::Image(err.to_string()))?;
    let image = if image.width().max(image.height()) > MAX_IMAGE_EDGE {
        image.resize(
            MAX_IMAGE_EDGE,
            MAX_IMAGE_EDGE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image.into_rgb8())
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|err| AiError::Image(err.to_string()))?;
    Ok(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

/// At most `max` characters of `text`, with `…` when cut.
fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max) {
        Some((end, _)) => format!("{}…", text[..end].trim_end()),
        None => text.to_owned(),
    }
}

/// The instructions and context sent with a capture.
pub fn prompt(job: &AiJob) -> String {
    let mut prompt = format!(
        "Describe this screenshot. Reply with JSON only, in exactly this shape:\n\
         {{\"description\": \"...\", \"category\": \"...\", \"tags\": [\"...\"]}}\n\
         - description: one or two sentences on what the screenshot shows and what it is \
         about. Name the app, site, product, error or topic someone might search for.\n\
         - category: exactly one of {}.\n\
         - tags: up to {MAX_TAGS} short lowercase keywords of one or two words, useful for \
         searching.\n",
        CATEGORIES.join(", ")
    );
    let app = job
        .app
        .as_deref()
        .map(str::trim)
        .filter(|app| !app.is_empty());
    let title = job
        .window_title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty());
    let text = job
        .ocr_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    if app.is_some() || title.is_some() || text.is_some() {
        prompt.push_str("\nContext from the capture, which may be incomplete:\n");
    }
    if let Some(app) = app {
        prompt.push_str(&format!("App: {}\n", truncate(app, MAX_TITLE_CHARS)));
    }
    if let Some(title) = title {
        prompt.push_str(&format!(
            "Window title: {}\n",
            truncate(title, MAX_TITLE_CHARS)
        ));
    }
    if let Some(text) = text {
        prompt.push_str(&format!(
            "Text read from the image by OCR, which may have mistakes:\n\"\"\"\n{}\n\"\"\"\n",
            truncate(text, MAX_OCR_CHARS)
        ));
    }
    prompt
}

/// A chat completion request for `model` with one user message: `text`,
/// after an image when there is one.
fn request_body(model: &str, text: &str, image: Option<&str>, max_tokens: u32) -> Value {
    let mut content = Vec::new();
    if let Some(url) = image {
        content.push(json!({ "type": "image_url", "image_url": { "url": url } }));
    }
    content.push(json!({ "type": "text", "text": text }));
    json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": content },
        ],
        "stream": false,
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "response_format": { "type": "json_object" },
    })
}

/// Why one request failed: the HTTP status when there was a response.
struct Failure {
    status: Option<u16>,
    message: String,
}

/// The message in an error response: OpenAI's `{"error": {"message"}}`,
/// Ollama's `{"error": "..."}`, or the start of the body.
fn api_error_message(body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let message = parsed.as_ref().and_then(|value| {
        let error = value.get("error").unwrap_or(value);
        error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
            .or_else(|| value.get("detail").and_then(Value::as_str))
            .map(str::to_owned)
    });
    truncate(&message.unwrap_or_else(|| body.to_owned()), 300)
}

/// POSTs one request and returns the response body.
fn post(agent: &ureq::Agent, ai: &AiSettings, body: &Value) -> Result<String, Failure> {
    let url = format!("{}/chat/completions", ai.endpoint.trim_end_matches('/'));
    let mut request = agent.post(&url).header("Content-Type", "application/json");
    if let Some(key) = ai.api_key.as_deref().filter(|key| !key.is_empty()) {
        request = request.header("Authorization", format!("Bearer {key}"));
    }
    let failed = |err: ureq::Error| Failure {
        status: None,
        message: format!("could not reach {url}: {err}"),
    };
    let mut response = request.send(body.to_string()).map_err(failed)?;
    let status = response.status();
    let text = response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_to_string()
        .map_err(failed)?;
    if !status.is_success() {
        return Err(Failure {
            status: Some(status.as_u16()),
            message: format!(
                "{url} answered {}: {}",
                status.as_u16(),
                api_error_message(&text)
            ),
        });
    }
    Ok(text)
}

/// The assistant's reply in a chat completion response.
fn reply_text(body: &str) -> Result<String, AiError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|err| AiError::Response(format!("not a chat completion: {err}")))?;
    let content = value
        .pointer("/choices/0/message/content")
        .ok_or_else(|| AiError::Response(format!("no reply in {}", truncate(body, 200))))?;
    match content {
        Value::String(text) => Ok(text.clone()),
        // Some servers send the content as parts.
        Value::Array(parts) => Ok(parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect()),
        _ => Err(AiError::Response("the reply was empty".into())),
    }
}

/// Sends `body` and returns the reply. A field from [`OPTIONAL_FIELDS`]
/// that the server says it does not support is dropped and the request
/// sent again.
fn complete(agent: &ureq::Agent, ai: &AiSettings, mut body: Value) -> Result<String, AiError> {
    loop {
        match post(agent, ai, &body) {
            Ok(text) => return reply_text(&text),
            Err(Failure {
                status: Some(400..=499),
                message,
            }) => {
                let lower = message.to_lowercase();
                let refused = OPTIONAL_FIELDS.iter().find(|field| {
                    lower.contains(*field)
                        && body
                            .as_object()
                            .is_some_and(|object| object.contains_key(**field))
                });
                match (refused, body.as_object_mut()) {
                    (Some(field), Some(object)) => {
                        object.remove(*field);
                    }
                    _ => return Err(AiError::Endpoint(message)),
                }
            }
            Err(failure) => return Err(AiError::Endpoint(failure.message)),
        }
    }
}

/// The first JSON object in `text`: code fences and chatter around it are
/// ignored.
fn first_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in text[start..].char_indices() {
        if in_string {
            match ch {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start..start + offset + 1]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Lowercased, trimmed, `#` and quotes dropped, inner whitespace collapsed.
fn clean_tag(tag: &str) -> String {
    tag.trim()
        .trim_start_matches('#')
        .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '.')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .chars()
        .take(MAX_TAG_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// Reads the model's reply into a description. Servers that ignore
/// `response_format` may wrap the JSON in code fences or chatter; the first
/// object is used. An unknown category becomes [`FALLBACK_CATEGORY`].
pub fn parse_description(reply: &str) -> Result<AiDescription, AiError> {
    let object = first_object(reply)
        .ok_or_else(|| AiError::Response(format!("no JSON in {:?}", truncate(reply, 200))))?;
    let value: Value = serde_json::from_str(object)
        .map_err(|err| AiError::Response(format!("invalid JSON ({err}) in {object:?}")))?;
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|text| !text.is_empty())
        .ok_or_else(|| AiError::Response(format!("no description in {object:?}")))?;
    let category = value
        .get("category")
        .and_then(Value::as_str)
        .map(|category| category.trim().to_lowercase())
        .filter(|category| CATEGORIES.contains(&category.as_str()))
        .unwrap_or_else(|| FALLBACK_CATEGORY.to_owned());
    let raw_tags: Vec<String> = match value.get("tags") {
        Some(Value::Array(tags)) => tags
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        Some(Value::String(tags)) => tags.split(',').map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    let mut tags: Vec<String> = Vec::new();
    for tag in raw_tags.iter().map(|tag| clean_tag(tag)) {
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
        if tags.len() == MAX_TAGS {
            break;
        }
    }
    Ok(AiDescription {
        description: truncate(&description, MAX_DESCRIPTION_CHARS),
        category,
        tags,
    })
}

/// Asks the model about one capture.
pub fn describe(
    agent: &ureq::Agent,
    ai: &AiSettings,
    job: &AiJob,
) -> Result<AiDescription, AiError> {
    let image = image_data_url(&job.path)?;
    let body = request_body(&ai.model, &prompt(job), Some(&image), 400);
    parse_description(&complete(agent, ai, body)?)
}

/// Sends a tiny image and checks the model answers, for Settings' "Test
/// connection".
pub fn test_connection(agent: &ureq::Agent, ai: &AiSettings) -> Result<String, AiError> {
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        16,
        16,
        image::Rgb([255, 255, 255]),
    ))
    .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
    .map_err(|err| AiError::Image(err.to_string()))?;
    let image = format!("data:image/png;base64,{}", BASE64_STANDARD.encode(bytes));
    let body = request_body(
        &ai.model,
        "This is a connection test. Reply with {\"ok\": true}.",
        Some(&image),
        20,
    );
    let reply = complete(agent, ai, body)?;
    if reply.trim().is_empty() {
        return Err(AiError::Response("the model sent an empty reply".into()));
    }
    Ok(format!("{} at {} answered.", ai.model, ai.endpoint))
}

/// What one turn of the queue did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Describing is turned off.
    Off,
    /// Nothing is ready to be described.
    Empty,
    /// The capture was described.
    Described(i64),
    /// The capture could not be described and will not be retried.
    Failed(i64),
    /// The capture was deleted while it was described.
    Gone(i64),
    /// The endpoint failed; the capture still waits.
    Stopped(String),
}

/// Describes the next waiting capture, if describing is on. `working` runs
/// once a capture is picked, before the request. The library is not locked
/// while the model works.
pub fn step(
    library: &LibraryState,
    ai: &AiSettings,
    agent: &ureq::Agent,
    working: impl FnOnce(),
) -> Result<Step, LibraryError> {
    if !ai.enabled {
        return Ok(Step::Off);
    }
    let Some(job) = library.lock().next_for_ai()? else {
        return Ok(Step::Empty);
    };
    working();
    let saved = match describe(agent, ai, &job) {
        Ok(description) => library
            .lock()
            .set_ai_description(job.id, &description, &ai.model)
            .map(|()| Step::Described(job.id)),
        Err(AiError::Endpoint(message)) => return Ok(Step::Stopped(message)),
        Err(err) => {
            eprintln!("Grab-it: could not describe {}: {err}", job.path.display());
            library
                .lock()
                .mark_ai_failed(job.id)
                .map(|()| Step::Failed(job.id))
        }
    };
    match saved {
        Err(LibraryError::NotFound(id)) => Ok(Step::Gone(id)),
        other => other,
    }
}

/// Whether saving `after` over `before` turned describing on for new
/// captures only, so the captures already waiting are skipped.
pub fn skips_existing(before: &AiSettings, after: &AiSettings) -> bool {
    !before.enabled && after.enabled && after.new_captures_only
}

/// Why the queue is woken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wake {
    /// A capture was added or read by OCR.
    Kick,
    /// The user changed something: retry a failed endpoint at once.
    Retry,
}

/// The describing queue, managed as Tauri state.
pub struct AiQueue {
    wake: Mutex<Sender<Wake>>,
    status: Mutex<AiStatus>,
}

impl AiQueue {
    fn new(wake: Sender<Wake>) -> Self {
        Self {
            wake: Mutex::new(wake),
            status: Mutex::new(AiStatus::new(AiState::Off, Default::default(), None)),
        }
    }

    pub fn status(&self) -> AiStatus {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn send(&self, wake: Wake) {
        let _ = self
            .wake
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .send(wake);
    }
}

/// Starts the queue's thread. It describes every waiting capture while
/// describing is on, then sleeps until woken.
pub fn start(app: &AppHandle) {
    let (sender, receiver) = mpsc::channel();
    app.manage(AiQueue::new(sender));
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("grab-it-ai".into())
        .spawn(move || run(&app, &receiver));
    if let Err(err) = spawned {
        eprintln!("Grab-it: could not start describing captures: {err}");
    }
}

/// Tells the queue captures may be waiting.
pub fn wake(app: &AppHandle) {
    if let Some(queue) = app.try_state::<AiQueue>() {
        queue.send(Wake::Kick);
    }
}

/// Tells the queue the user changed something, retrying a failed endpoint.
pub fn retry(app: &AppHandle) {
    if let Some(queue) = app.try_state::<AiQueue>() {
        queue.send(Wake::Retry);
    }
}

/// Runs after the AI settings are saved, while the settings are still
/// locked so the queue cannot start on a capture that is to be skipped.
pub fn settings_saved(app: &AppHandle, before: &AiSettings, after: &AiSettings) {
    if skips_existing(before, after)
        && let Some(library) = app.try_state::<LibraryState>()
        && let Err(err) = library.lock().skip_waiting_ai()
    {
        eprintln!("Grab-it: could not skip existing captures: {err}");
    }
    if before != after {
        retry(app);
    }
}

fn set_status(app: &AppHandle, state: AiState, error: Option<String>) {
    let Some(queue) = app.try_state::<AiQueue>() else {
        return;
    };
    let counts = app
        .state::<LibraryState>()
        .lock()
        .ai_counts()
        .unwrap_or_default();
    let status = AiStatus::new(state, counts, error);
    {
        let mut current = queue
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *current == status {
            return;
        }
        *current = status.clone();
    }
    let _ = app.emit(AI_STATUS_EVENT, status);
}

/// Blocks until woken. False once nothing can wake the thread any more.
fn wait(receiver: &Receiver<Wake>) -> bool {
    if receiver.recv().is_err() {
        return false;
    }
    // Several wakes while busy need only one more pass.
    while receiver.try_recv().is_ok() {}
    true
}

/// Blocks after the endpoint failed, until the user retries or a capture
/// arrives at least [`RETRY_AFTER`] later. False once nothing can wake it.
fn wait_to_retry(receiver: &Receiver<Wake>) -> bool {
    let failed = Instant::now();
    loop {
        match receiver.recv() {
            Err(_) => return false,
            Ok(Wake::Retry) => break,
            Ok(Wake::Kick) if failed.elapsed() >= RETRY_AFTER => break,
            Ok(Wake::Kick) => {}
        }
    }
    while receiver.try_recv().is_ok() {}
    true
}

fn current_settings(app: &AppHandle) -> AiSettings {
    lock(&app.state::<SettingsState>())
        .get()
        .preferences
        .ai
        .clone()
}

fn run(app: &AppHandle, receiver: &Receiver<Wake>) {
    let agent = agent(AI_STALL_TIMEOUT);
    loop {
        let ai = current_settings(app);
        let library = app.state::<LibraryState>();
        let result = step(&library, &ai, &agent, || {
            set_status(app, AiState::Working, None);
        });
        let keep_going = match result {
            Ok(Step::Described(_) | Step::Failed(_)) => {
                set_status(app, AiState::Working, None);
                let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
                true
            }
            Ok(Step::Gone(_)) => true,
            Ok(Step::Off) => {
                set_status(app, AiState::Off, None);
                wait(receiver)
            }
            Ok(Step::Empty) => {
                set_status(app, AiState::Idle, None);
                wait(receiver)
            }
            Ok(Step::Stopped(message)) => {
                eprintln!("Grab-it: describing captures stopped: {message}");
                set_status(app, AiState::Error, Some(message));
                wait_to_retry(receiver)
            }
            Err(err) => {
                // Do not spin on a database that refuses writes.
                eprintln!("Grab-it: could not store a description: {err}");
                set_status(app, AiState::Idle, None);
                wait(receiver)
            }
        };
        if !keep_going {
            return;
        }
    }
}

fn changed(app: &AppHandle) {
    let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
    retry(app);
}

#[tauri::command]
pub fn ai_status(queue: State<'_, AiQueue>) -> AiStatus {
    queue.status()
}

/// Queues one capture to be described again, with the current model.
#[tauri::command(async)]
pub fn ai_redescribe(id: i64, app: AppHandle) -> Result<(), String> {
    app.state::<LibraryState>()
        .lock()
        .requeue_ai(id)
        .map_err(|err| err.to_string())?;
    changed(&app);
    Ok(())
}

/// Drops a capture's description, category and AI tags, and skips it.
#[tauri::command(async)]
pub fn ai_clear(id: i64, app: AppHandle) -> Result<(), String> {
    app.state::<LibraryState>()
        .lock()
        .clear_ai(id)
        .map_err(|err| err.to_string())?;
    changed(&app);
    Ok(())
}

/// Queues every capture, skipped ones too, to be described again.
#[tauri::command(async)]
pub fn ai_redescribe_all(app: AppHandle) -> Result<(), String> {
    app.state::<LibraryState>()
        .lock()
        .requeue_all_ai()
        .map_err(|err| err.to_string())?;
    changed(&app);
    Ok(())
}

/// Checks that the saved endpoint and model answer, whether or not
/// describing is on.
#[tauri::command(async)]
pub fn ai_test_connection(app: AppHandle) -> Result<String, String> {
    let ai = AiSettings {
        enabled: true,
        ..current_settings(&app)
    }
    .validated()
    .map_err(|err| err.to_string())?;
    let message = test_connection(&agent(TEST_TIMEOUT), &ai).map_err(|err| err.to_string())?;
    // It works now: a queue stopped by an earlier failure can go on.
    retry(&app);
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        capture::{CaptureMode, Foreground, save_capture},
        library::{AI_DONE, AI_FAILED, AI_SKIPPED, AI_WAITING, Library},
        search::{MatchField, SearchQuery},
    };
    use chrono::{Local, TimeZone};
    use image::{Rgba, RgbaImage};
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        path::PathBuf,
        sync::Arc,
    };
    use tempfile::TempDir;

    // --- Parsing the model's reply -------------------------------------

    #[test]
    fn plain_json_is_parsed() {
        let parsed = parse_description(
            r##"{"description": "A Rust  compiler error\nin main.rs.", "category": "error",
                "tags": ["Rust", "#compiler error", "rust", "  borrow   checker "]}"##,
        )
        .unwrap();
        assert_eq!(
            parsed,
            AiDescription {
                description: "A Rust compiler error in main.rs.".into(),
                category: "error".into(),
                tags: vec![
                    "rust".into(),
                    "compiler error".into(),
                    "borrow checker".into()
                ],
            }
        );
    }

    #[test]
    fn fenced_json_is_parsed() {
        let reply = "```json\n{\"description\": \"A pull request on GitHub.\", \
                     \"category\": \"Browser\", \"tags\": [\"github\"]}\n```";
        let parsed = parse_description(reply).unwrap();
        assert_eq!(parsed.description, "A pull request on GitHub.");
        assert_eq!(parsed.category, "browser");
        assert_eq!(parsed.tags, vec!["github"]);
    }

    #[test]
    fn chatty_replies_use_the_first_object() {
        let reply = "Sure! Here is the JSON you asked for:\n\
            {\"description\": \"A chat about {braces} and \\\"quotes\\\".\", \
             \"category\": \"chat\", \"tags\": \"slack, standup\"}\n\
            Let me know if you want more. {\"other\": 1}";
        let parsed = parse_description(reply).unwrap();
        assert_eq!(parsed.description, "A chat about {braces} and \"quotes\".");
        assert_eq!(parsed.category, "chat");
        assert_eq!(parsed.tags, vec!["slack", "standup"]);
    }

    #[test]
    fn an_unknown_or_missing_category_becomes_other() {
        for reply in [
            r#"{"description": "A cat.", "category": "animals", "tags": []}"#,
            r#"{"description": "A cat.", "category": 3}"#,
            r#"{"description": "A cat."}"#,
        ] {
            let parsed = parse_description(reply).unwrap();
            assert_eq!(parsed.category, "other", "{reply}");
            assert!(parsed.tags.is_empty());
        }
    }

    #[test]
    fn tags_are_capped_and_cleaned() {
        let parsed = parse_description(
            r#"{"description": "x", "category": "code",
                "tags": ["a", "b", "", "c", "d", "e", "f", "g", 5,
                         "a very long tag that goes on and on and on past the limit"]}"#,
        )
        .unwrap();
        assert_eq!(parsed.tags, vec!["a", "b", "c", "d", "e", "f"]);
        let long = parse_description(
            r#"{"description": "x", "tags": ["a very long tag that goes on and on and on"]}"#,
        )
        .unwrap();
        assert!(long.tags[0].chars().count() <= MAX_TAG_CHARS);
    }

    #[test]
    fn replies_without_usable_json_are_response_errors() {
        for reply in [
            "I can't help with that.",
            "{\"description\": ",
            "{\"category\": \"code\"}",
            "{\"description\": \"   \"}",
            "{not json}",
        ] {
            assert!(
                matches!(parse_description(reply), Err(AiError::Response(_))),
                "{reply}"
            );
        }
    }

    #[test]
    fn the_prompt_carries_the_context_truncated() {
        let job = AiJob {
            id: 1,
            path: PathBuf::from("/x.png"),
            ocr_text: Some(format!("Invoice 42 {}", "word ".repeat(1000))),
            app: Some("firefox".into()),
            window_title: Some("Billing".into()),
        };
        let prompt = prompt(&job);
        assert!(prompt.contains("App: firefox"));
        assert!(prompt.contains("Window title: Billing"));
        assert!(prompt.contains("Invoice 42"));
        assert!(prompt.contains('…'));
        assert!(prompt.len() < 3000, "{}", prompt.len());
        for category in CATEGORIES {
            assert!(prompt.contains(category));
        }
        let bare = super::prompt(&AiJob {
            ocr_text: None,
            app: None,
            window_title: Some(" ".into()),
            ..job
        });
        assert!(!bare.contains("Context"));
    }

    #[test]
    fn large_captures_are_scaled_down() {
        let dir = TempDir::new().unwrap();
        let png = dir.path().join("big.png");
        RgbaImage::from_pixel(3200, 1000, Rgba([1, 2, 3, 255]))
            .save(&png)
            .unwrap();
        let url = image_data_url(&png).unwrap();
        let bytes = BASE64_STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (MAX_IMAGE_EDGE, 490));
        assert!(matches!(
            image_data_url(&dir.path().join("missing.png")),
            Err(AiError::Image(_))
        ));
    }

    #[test]
    fn statuses_serialize_for_the_frontend() {
        let status = AiStatus {
            state: AiState::Working,
            done: 1,
            total: 3,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({ "state": "working", "done": 1, "total": 3, "error": null })
        );
        assert_eq!(serde_json::to_value(AiState::Off).unwrap(), json!("off"));
        assert_eq!(
            serde_json::to_value(AiState::Error).unwrap(),
            json!("error")
        );
    }

    #[test]
    fn turning_on_for_new_captures_only_skips_existing_ones() {
        let off = AiSettings::default();
        let on = AiSettings {
            enabled: true,
            ..AiSettings::default()
        };
        let on_for_all = AiSettings {
            new_captures_only: false,
            ..on.clone()
        };
        assert!(skips_existing(&off, &on));
        assert!(!skips_existing(&off, &on_for_all));
        assert!(!skips_existing(&on, &on));
        assert!(!skips_existing(&on_for_all, &on));
        assert!(!skips_existing(&on, &off));
    }

    // --- The queue against a fake server -------------------------------

    /// One request the fake server received.
    #[derive(Debug, Clone)]
    struct Received {
        head: String,
        body: Value,
    }

    /// How the fake server answers one request.
    #[derive(Clone)]
    enum Reply {
        /// A status and a JSON body.
        Json(u16, Value),
        /// A chat completion whose reply is this text.
        Chat(String),
        /// Reads the request, then sends nothing.
        Stall,
    }

    struct FakeServer {
        endpoint: String,
        received: Arc<Mutex<Vec<Received>>>,
        _thread: thread::JoinHandle<()>,
    }

    fn read_request(stream: &mut TcpStream) -> Option<Received> {
        let mut data = Vec::new();
        let mut buffer = [0; 8192];
        let head_end = loop {
            if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                break end + 4;
            }
            let read = stream.read(&mut buffer).ok().filter(|&read| read > 0)?;
            data.extend_from_slice(&buffer[..read]);
        };
        let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
        let length: usize = head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().ok())?
            })
            .unwrap_or(0);
        while data.len() < head_end + length {
            let read = stream.read(&mut buffer).ok().filter(|&read| read > 0)?;
            data.extend_from_slice(&buffer[..read]);
        }
        let body =
            serde_json::from_slice(&data[head_end..head_end + length]).unwrap_or(Value::Null);
        Some(Received { head, body })
    }

    /// Serves one connection per reply, in order.
    fn serve(replies: Vec<Reply>) -> FakeServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let received = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&received);
        let thread = thread::spawn(move || {
            for reply in replies {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let Some(request) = read_request(&mut stream) else {
                    continue;
                };
                log.lock().unwrap().push(request);
                let (status, body) = match reply {
                    Reply::Stall => {
                        thread::sleep(Duration::from_secs(3));
                        continue;
                    }
                    Reply::Json(status, body) => (status, body),
                    Reply::Chat(text) => (
                        200,
                        json!({ "choices": [{ "message": { "role": "assistant", "content": text } }] }),
                    ),
                };
                let body = body.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.flush();
            }
        });
        FakeServer {
            endpoint,
            received,
            _thread: thread,
        }
    }

    impl FakeServer {
        fn requests(&self) -> Vec<Received> {
            self.received.lock().unwrap().clone()
        }
    }

    fn settings(server: &FakeServer) -> AiSettings {
        AiSettings {
            enabled: true,
            endpoint: format!("{}/", server.endpoint),
            model: "test-vision".into(),
            api_key: None,
            new_captures_only: false,
        }
    }

    /// A library with one capture from firefox, "Billing", whose OCR read
    /// `ocr` (or failed, for `None`).
    fn library_with_shot(dir: &Path, ocr: Option<&str>) -> (LibraryState, i64) {
        let image = RgbaImage::from_pixel(2000, 400, Rgba([240, 240, 240, 255]));
        let foreground = Foreground {
            app: Some("firefox".into()),
            window_title: Some("Billing".into()),
        };
        let when = Local.with_ymd_and_hms(2026, 3, 7, 9, 0, 0).unwrap();
        let png = save_capture(dir, &image, CaptureMode::Region, &foreground, None, when)
            .unwrap()
            .path;
        let mut library = Library::open_in_memory().unwrap();
        let id = library.add_capture(&png).unwrap().id;
        match ocr {
            Some(text) => library.set_ocr_text(id, text).unwrap(),
            None => library.mark_ocr_failed(id).unwrap(),
        }
        (LibraryState::new(library), id)
    }

    fn fast() -> ureq::Agent {
        agent(Duration::from_millis(500))
    }

    const GOOD_REPLY: &str = "```json\n{\"description\": \"An unpaid invoice from Acme in a \
        billing page.\", \"category\": \"receipt\", \"tags\": [\"invoice\", \"Acme\", \
        \"billing\"]}\n```";

    #[test]
    fn a_capture_is_described_stored_and_searchable() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("Invoice 42 total due"));
        let server = serve(vec![Reply::Chat(GOOD_REPLY.into())]);
        let ai = AiSettings {
            api_key: Some("sk-secret".into()),
            ..settings(&server)
        };
        let mut worked = false;

        let step = step(&library, &ai, &fast(), || worked = true).unwrap();

        assert_eq!(step, Step::Described(id));
        assert!(worked);
        let guard = library.lock();
        let shot = guard.get(id).unwrap();
        assert_eq!(
            shot.ai_description.as_deref(),
            Some("An unpaid invoice from Acme in a billing page.")
        );
        assert_eq!(shot.ai_category.as_deref(), Some("receipt"));
        assert_eq!(shot.ai_tags, vec!["acme", "billing", "invoice"]);
        assert!(shot.tags.is_empty());
        assert_eq!(guard.ai_state(id).unwrap(), AI_DONE);
        assert_eq!(guard.ai_model(id).unwrap().as_deref(), Some("test-vision"));
        let counts = guard.ai_counts().unwrap();
        assert_eq!((counts.done, counts.total), (1, 1));

        let page = guard
            .search(
                &SearchQuery {
                    text: "unpaid".into(),
                    ..SearchQuery::default()
                },
                0,
                10,
            )
            .unwrap();
        assert_eq!(page.hits[0].field, Some(MatchField::Description));

        // What was sent.
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        let Received { head, body } = &requests[0];
        assert!(head.starts_with("POST /v1/chat/completions "), "{head}");
        assert!(
            head.to_lowercase()
                .contains("authorization: bearer sk-secret"),
            "{head}"
        );
        assert_eq!(body["model"], "test-vision");
        assert_eq!(body["response_format"]["type"], "json_object");
        let content = body["messages"][1]["content"].as_array().unwrap();
        let image = content[0]["image_url"]["url"].as_str().unwrap();
        assert!(image.starts_with("data:image/png;base64,"));
        let sent = image::load_from_memory(
            &BASE64_STANDARD
                .decode(image.split_once(',').unwrap().1)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(sent.width(), MAX_IMAGE_EDGE);
        let text = content[1]["text"].as_str().unwrap();
        assert!(text.contains("Invoice 42 total due"));
        assert!(text.contains("App: firefox"));
        assert!(text.contains("Window title: Billing"));

        // Nothing left to do.
        drop(guard);
        assert_eq!(step_again(&library, &ai), Step::Empty);
    }

    fn step_again(library: &LibraryState, ai: &AiSettings) -> Step {
        step(library, ai, &fast(), || {}).unwrap()
    }

    #[test]
    fn no_key_sends_no_authorization_and_failed_ocr_sends_no_text() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), None);
        let server = serve(vec![Reply::Chat(GOOD_REPLY.into())]);
        assert_eq!(
            step_again(&library, &settings(&server)),
            Step::Described(id)
        );
        let Received { head, body } = &server.requests()[0];
        assert!(!head.to_lowercase().contains("authorization"), "{head}");
        let text = body["messages"][1]["content"][1]["text"].as_str().unwrap();
        assert!(!text.contains("OCR"));
    }

    #[test]
    fn a_capture_waits_for_ocr_and_nothing_is_sent_while_off() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        library
            .lock()
            .connection()
            .execute("UPDATE shots SET ocr_state = 0 WHERE id = ?1", [id])
            .unwrap();
        // Nothing listens there: any request would fail the step.
        let ai = AiSettings {
            enabled: true,
            endpoint: "http://127.0.0.1:9".into(),
            ..AiSettings::default()
        };
        assert_eq!(step_again(&library, &ai), Step::Empty);
        library.lock().set_ocr_text(id, "x").unwrap();
        let off = AiSettings {
            enabled: false,
            ..ai
        };
        assert_eq!(step_again(&library, &off), Step::Off);
        assert_eq!(library.lock().ai_state(id).unwrap(), AI_WAITING);
    }

    #[test]
    fn an_unusable_reply_fails_only_that_capture() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let server = serve(vec![Reply::Chat("Sorry, I cannot see images.".into())]);
        assert_eq!(step_again(&library, &settings(&server)), Step::Failed(id));
        let guard = library.lock();
        assert_eq!(guard.ai_state(id).unwrap(), AI_FAILED);
        assert_eq!(guard.get(id).unwrap().ai_description, None);
        assert!(guard.next_for_ai().unwrap().is_none());
        let counts = guard.ai_counts().unwrap();
        assert_eq!((counts.done, counts.total), (1, 1));
    }

    #[test]
    fn an_endpoint_error_stops_the_queue_and_the_capture_waits() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let server = serve(vec![Reply::Json(
            404,
            json!({ "error": { "message": "model \"test-vision\" not found, try pulling it first" } }),
        )]);
        let Step::Stopped(message) = step_again(&library, &settings(&server)) else {
            panic!("the queue should stop");
        };
        assert!(message.contains("404"), "{message}");
        assert!(
            message.contains("not found, try pulling it first"),
            "{message}"
        );
        assert_eq!(library.lock().ai_state(id).unwrap(), AI_WAITING);
    }

    #[test]
    fn an_unreachable_endpoint_stops_the_queue() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        // Bound, then closed: nothing listens on the port.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let ai = AiSettings {
            enabled: true,
            endpoint: format!("http://127.0.0.1:{port}/v1"),
            ..AiSettings::default()
        };
        assert!(matches!(step_again(&library, &ai), Step::Stopped(_)));
        assert_eq!(library.lock().ai_state(id).unwrap(), AI_WAITING);
    }

    #[test]
    fn a_stalled_endpoint_times_out_and_the_capture_waits() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let server = serve(vec![Reply::Stall]);
        let started = Instant::now();
        let step = step(
            &library,
            &settings(&server),
            &agent(Duration::from_millis(300)),
            || {},
        )
        .unwrap();
        assert!(matches!(step, Step::Stopped(_)), "{step:?}");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(library.lock().ai_state(id).unwrap(), AI_WAITING);
    }

    #[test]
    fn a_refused_response_format_is_dropped_and_retried() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let server = serve(vec![
            Reply::Json(
                400,
                json!({ "error": "'response_format.type' must be 'json_schema'" }),
            ),
            Reply::Chat(GOOD_REPLY.into()),
        ]);
        assert_eq!(
            step_again(&library, &settings(&server)),
            Step::Described(id)
        );
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].body.get("response_format").is_some());
        assert!(requests[1].body.get("response_format").is_none());
    }

    #[test]
    fn the_connection_test_reports_the_model_or_the_error() {
        let server = serve(vec![
            Reply::Chat("{\"ok\": true}".into()),
            Reply::Json(401, json!({ "error": { "message": "Incorrect API key" } })),
        ]);
        let ai = settings(&server);
        let message = test_connection(&fast(), &ai).unwrap();
        assert!(message.contains("test-vision"), "{message}");
        let err = test_connection(&fast(), &ai).unwrap_err();
        assert!(err.to_string().contains("Incorrect API key"), "{err}");
    }

    #[test]
    fn redescribing_clearing_and_skipping_move_captures_through_the_queue() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let server = serve(vec![Reply::Chat(GOOD_REPLY.into())]);
        let ai = settings(&server);
        assert_eq!(step_again(&library, &ai), Step::Described(id));

        let mut guard = library.lock();
        guard.requeue_ai(id).unwrap();
        assert_eq!(guard.ai_state(id).unwrap(), AI_WAITING);
        // The old description stays until a new one replaces it.
        assert!(guard.get(id).unwrap().ai_description.is_some());

        guard.clear_ai(id).unwrap();
        let shot = guard.get(id).unwrap();
        assert_eq!(
            (shot.ai_description, shot.ai_category, shot.ai_tags.len()),
            (None, None, 0)
        );
        assert_eq!(guard.ai_state(id).unwrap(), AI_SKIPPED);
        assert_eq!(guard.ai_model(id).unwrap(), None);
        assert!(guard.next_for_ai().unwrap().is_none());
        assert_eq!(guard.ai_counts().unwrap().total, 0);

        assert_eq!(guard.requeue_all_ai().unwrap(), 1);
        assert_eq!(guard.ai_state(id).unwrap(), AI_WAITING);
        assert_eq!(guard.skip_waiting_ai().unwrap(), 1);
        assert_eq!(guard.ai_state(id).unwrap(), AI_SKIPPED);
        assert!(matches!(
            guard.requeue_ai(id + 1),
            Err(LibraryError::NotFound(_))
        ));
        assert!(matches!(
            guard.clear_ai(id + 1),
            Err(LibraryError::NotFound(_))
        ));
    }
}
