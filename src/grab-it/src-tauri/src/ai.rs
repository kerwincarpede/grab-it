//! Describing captures with a vision model, so the Library can search and
//! filter by what a capture shows.
//!
//! Off by default: nothing is sent anywhere until the user turns it on in
//! Settings. Then, like the OCR queue in `ocr.rs`, one background thread
//! describes every capture waiting for it, newest first and one at a time,
//! once OCR has finished with it. Each capture goes, downscaled, with its
//! OCR text, app and window title, to the provider picked in Settings: the
//! user's own Claude Code or Codex CLI (see `ai_cli.rs`), or an
//! OpenAI-compatible `/chat/completions` endpoint (Ollama, LM Studio,
//! llama.cpp's server, OpenAI, OpenRouter…). The model answers with a
//! description, a category and a few tags.
//!
use std::{
    fmt,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::{Duration, Instant},
};

use base64::prelude::{BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{Emitter, Manager, State};

use crate::rt::AppHandle;
use crate::{
    ai_cli,
    commands::{SettingsState, lock},
    library::{AiDescription, AiJob, LIBRARY_CHANGED_EVENT, LibraryError, LibraryState},
    settings::{AiProvider, AiSettings},
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
/// After the provider fails, a new capture retries it no sooner than this.
/// Changing the settings or asking for a description retries at once.
pub const RETRY_AFTER: Duration = Duration::from_secs(60);

/// How much OCR text goes into the prompt.
const MAX_OCR_CHARS: usize = 2000;
/// How much of the window title goes into the prompt.
const MAX_TITLE_CHARS: usize = 200;
/// AI tags stay few and short, so they read at a glance on a tile.
const MAX_TAGS: usize = 3;
const MAX_TAG_CHARS: usize = 20;
/// A tag of more words than this is a phrase, and is dropped.
const MAX_TAG_WORDS: usize = 2;
const MAX_DESCRIPTION_CHARS: usize = 600;
/// The most of a response that is read.
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
/// The longest description an endpoint may send, in tokens: a description
/// and its tags take about 150.
const DESCRIPTION_MAX_TOKENS: u32 = 400;
/// The reply budget a reasoning model gets when it thought through the
/// usual one without answering. Gemma 4 26B in LM Studio thought for 755
/// tokens before answering the connection test, and for more than 397 of
/// a description's 400.
const REASONING_MAX_TOKENS: u32 = 2048;
/// The most a reasoning retry raises a budget to. A request that already
/// asks for about [`REASONING_MAX_TOKENS`], such as Annotate with AI's,
/// gets double its own instead, up to this.
const REASONING_MAX_TOKENS_CAP: u32 = 8192;

/// The budget a reasoning model is retried with after it thought through
/// `budget`: [`REASONING_MAX_TOKENS`], or double `budget` when that is
/// more, at most [`REASONING_MAX_TOKENS_CAP`]. None when that is no more
/// than `budget`.
fn raised_budget(budget: &Value) -> Option<u32> {
    let budget = u32::try_from(budget.as_u64()?).ok()?;
    let raised = budget
        .saturating_mul(2)
        .clamp(REASONING_MAX_TOKENS, REASONING_MAX_TOKENS_CAP);
    (raised > budget).then_some(raised)
}
/// Request fields some servers refuse; one named in an error is dropped
/// and the request sent again.
const OPTIONAL_FIELDS: [&str; 3] = ["response_format", "max_tokens", "temperature"];

/// Sent as the system prompt to every provider.
pub(crate) const SYSTEM_PROMPT: &str = "You describe screenshots for a personal screenshot library, so \
     they can be found again by searching. You reply with a single JSON object and nothing else.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiError {
    /// The capture could not be read. Only this capture fails.
    Image(String),
    /// The model's answer was not the JSON asked for. Only this capture
    /// fails.
    Response(String),
    /// The endpoint could not be reached, timed out or refused the
    /// request, or the CLI is missing, failed or timed out. The queue
    /// stops, and the capture waits, until it is retried.
    Endpoint(String),
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Image(err) => write!(f, "Could not read the capture: {err}"),
            Self::Response(err) => write!(f, "The model's answer could not be used: {err}"),
            Self::Endpoint(err) => f.write_str(err),
        }
    }
}

impl std::error::Error for AiError {}

/// What the queue is doing. Mirrors `AiStatus` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub state: AiState,
    /// Captures described, or that could not be described.
    pub done: u32,
    /// Captures that are not skipped.
    pub total: u32,
    /// Why the provider failed, in the `error` state.
    pub error: Option<String>,
    /// Who describes captures, so a failure can say whom to check.
    pub provider: AiProvider,
    /// The capture being described, in the `working` state.
    pub current: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AiState {
    /// Describing is turned off in Settings.
    Off,
    /// Nothing waits to be described (or waits for OCR first).
    Idle,
    /// A capture is being described.
    Working,
    /// The provider failed; waiting captures are described once it is
    /// retried.
    Error,
}

impl AiStatus {
    fn new(
        state: AiState,
        counts: crate::library::AiCounts,
        error: Option<String>,
        provider: AiProvider,
        current: Option<i64>,
    ) -> Self {
        Self {
            state,
            done: counts.done,
            total: counts.total,
            error,
            provider,
            current,
        }
    }
}

/// An HTTP agent whose every network phase gives up after `stall` without
/// progress, and which hands back error responses so their message can be
/// shown. Certificates are checked against the OS trust store
/// (`net::tls_config`).
pub fn agent(stall: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .tls_config(crate::net::tls_config())
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

/// What describing runs with: an HTTP agent for endpoints, and the
/// `claude` and `codex` CLIs, when they were found, with how long they may
/// take.
#[derive(Clone)]
pub struct Clients {
    pub http: ureq::Agent,
    pub claude: Option<PathBuf>,
    pub codex: Option<PathBuf>,
    pub cli_timeout: Duration,
    /// The endpoint and model that last needed [`REASONING_MAX_TOKENS`],
    /// so their later requests start with it instead of thinking through a
    /// smaller budget first. Another endpoint or model starts small again.
    pub reasoning: Arc<Mutex<Option<(String, String)>>>,
}

impl Clients {
    /// Clients that give up after `stall`, with the CLIs looked up now.
    pub fn new(stall: Duration) -> Self {
        Self {
            http: agent(stall),
            claude: ai_cli::find_claude(),
            codex: ai_cli::find_codex(),
            cli_timeout: stall,
            reasoning: Arc::default(),
        }
    }

    fn claude(&self) -> Result<&Path, AiError> {
        self.claude.as_deref().ok_or_else(ai_cli::claude_missing)
    }

    fn codex(&self) -> Result<&Path, AiError> {
        self.codex.as_deref().ok_or_else(ai_cli::codex_missing)
    }
}

/// The capture as PNG bytes, scaled down to fit [`MAX_IMAGE_EDGE`].
pub fn png_bytes(png: &Path) -> Result<Vec<u8>, AiError> {
    let image = image::open(png).map_err(|err| AiError::Image(err.to_string()))?;
    fit_png(image)
}

/// `image` as PNG bytes, scaled down to fit [`MAX_IMAGE_EDGE`].
pub fn fit_png(image: image::DynamicImage) -> Result<Vec<u8>, AiError> {
    encode_png(fit_image(image))
}

/// `image` scaled down to fit [`MAX_IMAGE_EDGE`], keeping its shape.
pub fn fit_image(image: image::DynamicImage) -> image::DynamicImage {
    if image.width().max(image.height()) > MAX_IMAGE_EDGE {
        image.resize(
            MAX_IMAGE_EDGE,
            MAX_IMAGE_EDGE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    }
}

/// `image` as PNG bytes, as it is.
pub fn encode_png(image: image::DynamicImage) -> Result<Vec<u8>, AiError> {
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image.into_rgb8())
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|err| AiError::Image(err.to_string()))?;
    Ok(bytes)
}

/// At most `max` characters of `text`, with `…` when cut.
pub(crate) fn truncate(text: &str, max: usize) -> String {
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
         - tags: up to {MAX_TAGS} lowercase single-word tags, most specific first, such as \
         the app, product, language or topic. No phrases, no generic words like \
         \"screenshot\".\n",
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

/// A chat completion request for `model` with `system` as the system
/// prompt and one user message: `text`, after an image when there is one.
fn request_body(
    model: &str,
    system: &str,
    text: &str,
    image: Option<&str>,
    max_tokens: u32,
) -> Value {
    let mut content = Vec::new();
    if let Some(url) = image {
        content.push(json!({ "type": "image_url", "image_url": { "url": url } }));
    }
    content.push(json!({ "type": "text", "text": text }));
    json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
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
    /// The server's own message in an error response, without the URL or
    /// status around it; empty when there was no response.
    detail: String,
}

impl Failure {
    /// `url` answered `status` with the error response `body`.
    fn answered(url: &str, status: u16, body: &str) -> Self {
        let detail = api_error_message(body);
        Self {
            status: Some(status),
            message: format!("{url} answered {status}: {detail}"),
            detail,
        }
    }
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
        detail: String::new(),
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
        return Err(Failure::answered(&url, status.as_u16(), &text));
    }
    Ok(text)
}

/// `text` with its first letter in upper case, to stand as a sentence.
fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// What an empty reply from a reasoning model that ran out of tokens says.
const THOUGHT_OUT: &str = "the model spent its whole reply budget thinking and sent no answer. \
     Choose a model without reasoning, or turn reasoning off in the server.";

/// Whether a chat completion stopped before answering because the model
/// was still reasoning: it ran out of tokens, or sent only its reasoning
/// (`reasoning_content` from LM Studio and llama.cpp, `reasoning` from
/// OpenRouter and Ollama).
fn thought_out(value: &Value) -> bool {
    let choice = value.pointer("/choices/0");
    let length = choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
        == Some("length");
    let reasoned = ["reasoning_content", "reasoning"].iter().any(|field| {
        choice
            .and_then(|choice| choice.pointer(&format!("/message/{field}")))
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
    });
    length || reasoned
}

/// The assistant's reply in a chat completion response. An empty reply
/// from a model that was still thinking is [`THOUGHT_OUT`].
fn reply_text(body: &str) -> Result<String, AiError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|err| AiError::Response(format!("not a chat completion: {err}")))?;
    let content = value
        .pointer("/choices/0/message/content")
        .ok_or_else(|| AiError::Response(format!("no reply in {}", truncate(body, 200))))?;
    let text: String = match content {
        Value::String(text) => text.clone(),
        // Some servers send the content as parts.
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect(),
        _ => String::new(),
    };
    if text.trim().is_empty() {
        if thought_out(&value) {
            return Err(AiError::Response(THOUGHT_OUT.into()));
        }
        if !content.is_string() {
            return Err(AiError::Response("the reply was empty".into()));
        }
    }
    Ok(text)
}

/// Sends `body` and returns the reply. A field from [`OPTIONAL_FIELDS`]
/// that the server says it does not support is dropped and the request
/// sent again.
///
/// A reasoning model that thinks through its whole `max_tokens` without
/// answering is asked once more with a larger budget ([`raised_budget`]:
/// [`REASONING_MAX_TOKENS`] for a description). That retry
/// sends the image again, and each request bills the tokens spent, so it
/// costs one more request with the screenshot and the first attempt's
/// tokens. `clients` then remembers the endpoint and model, so their later
/// requests start with the larger budget and pay that once, not for every
/// capture. When the larger budget also runs out, the model will not
/// answer within it, so the error is [`AiError::Endpoint`]: the queue
/// stops with what to do and the capture waits.
fn complete(clients: &Clients, ai: &AiSettings, mut body: Value) -> Result<String, AiError> {
    let key = (ai.endpoint.clone(), ai.model.clone());
    let reasoning = |clients: &Clients| {
        clients
            .reasoning
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            == Some(&key)
    };
    let mut raised = false;
    if reasoning(clients)
        && let Some(budget) = body.get_mut("max_tokens")
        && let Some(larger) = raised_budget(budget)
    {
        *budget = Value::from(larger);
        raised = true;
    }
    loop {
        match post(&clients.http, ai, &body) {
            Ok(text) => match reply_text(&text) {
                Err(AiError::Response(message)) if message == THOUGHT_OUT => {
                    if raised {
                        return Err(AiError::Endpoint(capitalized(THOUGHT_OUT)));
                    }
                    let Some((budget, larger)) = body
                        .get_mut("max_tokens")
                        .and_then(|budget| raised_budget(budget).map(|larger| (budget, larger)))
                    else {
                        return Err(AiError::Response(message));
                    };
                    *budget = Value::from(larger);
                    raised = true;
                    *clients
                        .reasoning
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(key.clone());
                }
                reply => return reply,
            },
            Err(failure) if matches!(failure.status, Some(400..=499)) => {
                let lower = failure.message.to_lowercase();
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
                    _ => return Err(endpoint_error(&ai.model, failure)),
                }
            }
            Err(failure) => return Err(endpoint_error(&ai.model, failure)),
        }
    }
}

/// Whether the server's own message in an error response says the model
/// reads only text. The model ID is left out first, as servers often quote
/// it and one such as `llama3.2-vision` would otherwise always match; the
/// URL is not in `detail` at all.
fn refuses_images(model: &str, detail: &str) -> bool {
    let mut lower = detail.to_lowercase();
    let model = model.trim().to_lowercase();
    if !model.is_empty() {
        lower = lower.replace(&model, "");
    }
    ["image", "vision", "multimodal", "multi-modal"]
        .iter()
        .any(|word| lower.contains(word))
}

/// A failed request as an [`AiError::Endpoint`] that starts with what to
/// fix: the server, the API key or the model. The server's own message
/// follows.
fn endpoint_error(model: &str, failure: Failure) -> AiError {
    let message = failure.message;
    AiError::Endpoint(match failure.status {
        None => format!(
            "The server did not answer. Check that it is running and that the URL is right. Details: {message}"
        ),
        Some(401 | 403) => {
            format!("The server did not accept the API key. Check the key. Details: {message}")
        }
        // What servers answer a request they cannot run, not "not found",
        // rate limits or gateway errors, which a model name cannot fix.
        Some(400 | 415 | 422 | 500) if refuses_images(model, &failure.detail) => {
            format!("{model} does not accept images. Choose a vision model. Details: {message}")
        }
        Some(_) => message,
    })
}

/// The first JSON object in `text`: code fences and chatter around it are
/// ignored.
pub(crate) fn first_object(text: &str) -> Option<&str> {
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

/// Lowercased, trimmed, `#` and quotes dropped. Two words are joined with
/// a hyphen; a longer phrase, or a tag too long to read at a glance,
/// becomes empty and is dropped.
fn clean_tag(tag: &str) -> String {
    let words: Vec<&str> = tag
        .trim()
        .trim_start_matches('#')
        .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '.')
        .split_whitespace()
        .collect();
    if words.len() > MAX_TAG_WORDS {
        return String::new();
    }
    let tag = words.join("-").to_lowercase();
    if tag.chars().count() > MAX_TAG_CHARS {
        return String::new();
    }
    tag
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

/// One question about one image, for whichever provider is chosen.
pub struct Ask<'a> {
    /// The system prompt; Codex gets it ahead of the prompt.
    pub system: &'a str,
    /// The instructions, after the image.
    pub prompt: &'a str,
    /// The image as PNG bytes, already scaled down.
    pub png: &'a [u8],
    /// The JSON schema the answer follows, for providers that hold their
    /// answer to one.
    pub schema: &'a Value,
    /// The longest answer an endpoint may give, in tokens.
    pub max_tokens: u32,
}

/// Asks the provider's model `question` and returns its reply as sent.
pub fn ask(clients: &Clients, ai: &AiSettings, question: &Ask) -> Result<String, AiError> {
    match ai.provider() {
        AiProvider::Endpoint => {
            let url = format!(
                "data:image/png;base64,{}",
                BASE64_STANDARD.encode(question.png)
            );
            let body = request_body(
                &ai.model,
                question.system,
                question.prompt,
                Some(&url),
                question.max_tokens,
            );
            complete(clients, ai, body)
        }
        AiProvider::ClaudeCode => ai_cli::claude_reply(
            clients.claude()?,
            &ai.claude_model(),
            question.system,
            question.prompt,
            &BASE64_STANDARD.encode(question.png),
            clients.cli_timeout,
        ),
        AiProvider::Codex => ai_cli::codex_reply(
            clients.codex()?,
            ai.codex_model().as_deref(),
            question.system,
            question.prompt,
            question.png,
            question.schema,
            clients.cli_timeout,
        ),
    }
}

/// Asks the provider's model about one capture.
pub fn describe(clients: &Clients, ai: &AiSettings, job: &AiJob) -> Result<AiDescription, AiError> {
    let png = png_bytes(&job.path)?;
    let reply = ask(
        clients,
        ai,
        &Ask {
            system: SYSTEM_PROMPT,
            prompt: &prompt(job),
            png: &png,
            schema: &description_schema(),
            max_tokens: DESCRIPTION_MAX_TOKENS,
        },
    )?;
    parse_description(&reply)
}

/// The JSON schema a description follows, for providers that hold their
/// answer to one. Strict, as OpenAI's structured outputs want it: every
/// field required and no others; [`parse_description`] still cuts the
/// tags down.
pub fn description_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "description": { "type": "string" },
            "category": { "type": "string", "enum": CATEGORIES },
            "tags": { "type": "array", "items": { "type": "string" } },
        },
        "required": ["description", "category", "tags"],
        "additionalProperties": false,
    })
}

const TEST_PROMPT: &str = "This is a connection test. Reply with {\"ok\": true}.";

/// The JSON schema the connection test's answer follows.
fn test_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "ok": { "type": "boolean" } },
        "required": ["ok"],
        "additionalProperties": false,
    })
}

/// Sends a tiny image and checks the provider's model answers, for
/// Settings' "Test connection".
pub fn test_connection(clients: &Clients, ai: &AiSettings) -> Result<String, AiError> {
    let reply = ask(
        clients,
        ai,
        &Ask {
            system: SYSTEM_PROMPT,
            prompt: TEST_PROMPT,
            png: include_bytes!("../fixtures/connection-test.png"),
            schema: &test_schema(),
            // A description's budget, so a reasoning model that passes
            // the test has room to describe captures too.
            max_tokens: DESCRIPTION_MAX_TOKENS,
        },
    )?;
    let answered = match ai.provider() {
        AiProvider::Endpoint => format!("{} at {} answered.", ai.model, ai.endpoint),
        AiProvider::ClaudeCode => {
            format!("{} ({}) answered.", ai_cli::CLAUDE_NAME, ai.claude_model())
        }
        AiProvider::Codex => match ai.codex_model() {
            Some(model) => format!("{} ({model}) answered.", ai_cli::CODEX_NAME),
            None => format!("{} answered.", ai_cli::CODEX_NAME),
        },
    };
    if reply.trim().is_empty() {
        return Err(AiError::Response("the model sent an empty reply".into()));
    }
    let answer = first_object(&reply).and_then(|object| serde_json::from_str::<Value>(object).ok());
    if answer.is_none_or(|answer| answer.get("ok").is_none()) {
        return Err(AiError::Response(format!(
            "it did not answer with the JSON asked for, so it may not follow instructions well enough. It said: {}",
            truncate(reply.trim(), 200)
        )));
    }
    Ok(answered)
}

/// Whether a listed model ID is plainly an embedding or reranking model,
/// which cannot describe a capture, such as LM Studio's
/// `text-embedding-nomic-embed-text-v1.5`.
fn is_embedding_model(id: &str) -> bool {
    let lower = id.to_lowercase();
    lower.contains("embed") || lower.contains("rerank")
}

/// How long listing an endpoint's models may take.
pub const LIST_MODELS_TIMEOUT: Duration = Duration::from_secs(15);

/// The model IDs an OpenAI-compatible endpoint offers, from its `/models`:
/// `{"data": [{"id": ...}]}`, as OpenAI, OpenRouter, LM Studio and
/// Ollama send it, without embedding models. Empty when the server lists
/// none.
pub fn list_models(
    agent: &ureq::Agent,
    endpoint: &str,
    api_key: Option<&str>,
) -> Result<Vec<String>, AiError> {
    let url = format!("{}/models", endpoint.trim().trim_end_matches('/'));
    let mut request = agent.get(&url);
    if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        request = request.header("Authorization", format!("Bearer {key}"));
    }
    let failed = |err: ureq::Error| {
        endpoint_error(
            "",
            Failure {
                status: None,
                message: format!("could not reach {url}: {err}"),
                detail: String::new(),
            },
        )
    };
    let mut response = request.call().map_err(failed)?;
    let status = response.status();
    let text = response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_to_string()
        .map_err(failed)?;
    if !status.is_success() {
        return Err(endpoint_error(
            "",
            Failure::answered(&url, status.as_u16(), &text),
        ));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|err| AiError::Response(format!("not a model list: {err}")))?;
    let mut models: Vec<String> = Vec::new();
    for id in value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("id").and_then(Value::as_str))
    {
        if !is_embedding_model(id) && !models.iter().any(|known| known == id) {
            models.push(id.to_owned());
        }
    }
    Ok(models)
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
    /// The capture was deleted, or its describing cancelled, while it was
    /// described; nothing was stored.
    Gone(i64),
    /// The provider failed; the capture still waits.
    Stopped(String),
}

/// Describes the next waiting capture, if describing is on. `working` runs
/// with its id once a capture is picked, before the request. The library is
/// not locked while the model works, so the answer is dropped if the
/// capture stopped waiting meanwhile (the user cancelled).
pub fn step(
    library: &LibraryState,
    ai: &AiSettings,
    clients: &Clients,
    working: impl FnOnce(i64),
) -> Result<Step, LibraryError> {
    if !ai.describes() {
        return Ok(Step::Off);
    }
    let Some(job) = library.lock().next_for_ai()? else {
        return Ok(Step::Empty);
    };
    working(job.id);
    let described = describe(clients, ai, &job);
    let mut guard = library.lock();
    if !guard.ai_waiting(job.id)? {
        return Ok(Step::Gone(job.id));
    }
    let saved = match described {
        Ok(description) => guard
            .set_ai_description(job.id, &description, &ai.model_label())
            .map(|()| Step::Described(job.id)),
        Err(AiError::Endpoint(message)) => return Ok(Step::Stopped(message)),
        Err(err) => {
            eprintln!("Grab-it: could not describe {}: {err}", job.path.display());
            guard.mark_ai_failed(job.id).map(|()| Step::Failed(job.id))
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
    !before.describes() && after.describes() && after.new_captures_only
}

/// Why the queue is woken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wake {
    /// A capture was added or read by OCR.
    Kick,
    /// The user changed something: retry a failed provider at once.
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
            status: Mutex::new(AiStatus::new(
                AiState::Off,
                Default::default(),
                None,
                AiProvider::Endpoint,
                None,
            )),
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

/// Describes waiting captures when automatic descriptions are enabled.
pub fn start(app: &AppHandle) {
    let (sender, receiver) = mpsc::channel();
    app.manage(AiQueue::new(sender));
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("grab-it-ai".into())
        .spawn(move || {
            run(&app, &receiver);
        });
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

/// Tells the queue the user changed something, retrying a failed provider.
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

fn set_status(
    app: &AppHandle,
    state: AiState,
    provider: AiProvider,
    error: Option<String>,
    current: Option<i64>,
) {
    let Some(queue) = app.try_state::<AiQueue>() else {
        return;
    };
    let counts = app
        .state::<LibraryState>()
        .lock()
        .ai_counts()
        .unwrap_or_default();
    let status = AiStatus::new(state, counts, error, provider, current);
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

/// Blocks after the provider failed, until the user retries or a capture
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

pub(crate) fn current_settings(app: &AppHandle) -> AiSettings {
    lock(&app.state::<SettingsState>())
        .get()
        .preferences
        .ai
        .clone()
}

fn run(app: &AppHandle, receiver: &Receiver<Wake>) {
    let mut clients = Clients {
        http: agent(AI_STALL_TIMEOUT),
        claude: None,
        codex: None,
        cli_timeout: AI_STALL_TIMEOUT,
        reasoning: Arc::default(),
    };
    loop {
        let ai = current_settings(app);
        let provider = ai.provider();
        // Looked up each time, so installing it later needs no restart.
        if ai.describes() && provider == AiProvider::ClaudeCode {
            clients.claude = ai_cli::find_claude();
        }
        if ai.describes() && provider == AiProvider::Codex {
            clients.codex = ai_cli::find_codex();
        }
        let library = app.state::<LibraryState>();
        let result = step(&library, &ai, &clients, |id| {
            set_status(app, AiState::Working, provider, None, Some(id));
        });
        let keep_going = match result {
            Ok(Step::Described(_) | Step::Failed(_)) => {
                let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
                true
            }
            Ok(Step::Gone(_)) => true,
            Ok(Step::Off) => {
                set_status(app, AiState::Off, provider, None, None);
                wait(receiver)
            }
            Ok(Step::Empty) => {
                set_status(app, AiState::Idle, provider, None, None);
                wait(receiver)
            }
            Ok(Step::Stopped(message)) => {
                eprintln!("Grab-it: describing captures stopped: {message}");
                set_status(app, AiState::Error, provider, Some(message), None);
                wait_to_retry(receiver)
            }
            Err(err) => {
                // Do not spin on a database that refuses writes.
                eprintln!("Grab-it: could not store a description: {err}");
                set_status(app, AiState::Idle, provider, None, None);
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
#[specta::specta]
pub fn ai_status(queue: State<'_, AiQueue>) -> AiStatus {
    queue.status()
}

/// Queues one capture to be described again, with the current model.
#[tauri::command(async)]
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
pub fn ai_redescribe_all(app: AppHandle) -> Result<(), String> {
    app.state::<LibraryState>()
        .lock()
        .requeue_all_ai()
        .map_err(|err| err.to_string())?;
    changed(&app);
    Ok(())
}

/// Stops describing: every capture still waiting leaves the queue, and the
/// answer for the one being described is dropped. Captures made later are
/// described as usual.
#[tauri::command(async)]
#[specta::specta]
pub fn ai_cancel(app: AppHandle) -> Result<(), String> {
    app.state::<LibraryState>()
        .lock()
        .cancel_waiting_ai()
        .map_err(|err| err.to_string())?;
    // Said at once: the request in flight may take a while to come back.
    let provider = current_settings(&app).provider();
    set_status(&app, AiState::Idle, provider, None, None);
    changed(&app);
    Ok(())
}

/// Tests draft settings with a synthetic image without changing the active provider.
#[tauri::command(async)]
#[specta::specta]
pub fn ai_test_connection(draft: AiSettings) -> Result<String, String> {
    let ai = AiSettings {
        enabled: true,
        ..draft
    }
    .validated()
    .map_err(|err| err.to_string())?;
    test_connection(&Clients::new(TEST_TIMEOUT), &ai).map_err(|err| err.to_string())
}

/// Lists the models an OpenAI-compatible endpoint offers, for Settings to
/// suggest. Nothing is saved, and no image is sent.
#[tauri::command(async)]
#[specta::specta]
pub fn ai_list_models(endpoint: String, api_key: Option<String>) -> Result<Vec<String>, String> {
    let lower = endpoint.trim().to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!(
            "The AI endpoint must start with http:// or https://, not `{}`.",
            endpoint.trim()
        ));
    }
    list_models(&agent(LIST_MODELS_TIMEOUT), &endpoint, api_key.as_deref())
        .map_err(|err| err.to_string())
}

/// Counts the screenshots a whole-library request would describe: every
/// image for Re-describe all, or with `waiting` only those still waiting,
/// which is what a save that describes earlier captures sends.
#[tauri::command(async)]
#[specta::specta]
pub fn ai_capture_count(app: AppHandle, waiting: bool) -> Result<u32, String> {
    app.state::<LibraryState>()
        .lock()
        .ai_capture_count(waiting)
        .map_err(|err| err.to_string())
}

/// Which AI CLIs are installed, by where they were found. Mirrors
/// `AiClis` in src/settings/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiClis {
    pub claude_code: Option<PathBuf>,
    pub codex: Option<PathBuf>,
}

/// Looks for the AI CLIs, for Settings to say when the chosen one is
/// missing. Async: the lookup may ask the login shell for its PATH.
#[tauri::command(async)]
#[specta::specta]
pub fn ai_clis() -> AiClis {
    AiClis {
        claude_code: ai_cli::find_claude(),
        codex: ai_cli::find_codex(),
    }
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
                    "compiler-error".into(),
                    "borrow-checker".into()
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
                "tags": ["a", "", 5, "b", "c", "d", "e"]}"#,
        )
        .unwrap();
        assert_eq!(parsed.tags, vec!["a", "b", "c"]);
    }

    #[test]
    fn phrases_and_long_tags_are_dropped() {
        let parsed = parse_description(
            r#"{"description": "x",
                "tags": ["a tag that is a phrase", "supercalifragilisticexpialidocious",
                         "VS Code", "rust"]}"#,
        )
        .unwrap();
        assert_eq!(parsed.tags, vec!["vs-code", "rust"]);
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
        let bytes = png_bytes(&png).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (MAX_IMAGE_EDGE, 490));
        assert!(matches!(
            png_bytes(&dir.path().join("missing.png")),
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
            provider: AiProvider::ClaudeCode,
            current: Some(7),
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({
                "state": "working", "done": 1, "total": 3, "error": null, "provider": "claudeCode",
                "current": 7
            })
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
            automatic_descriptions: None,
            enabled: true,
            provider: Some(AiProvider::Endpoint),
            endpoint: format!("{}/", server.endpoint),
            model: "test-vision".into(),
            claude_model: "haiku".into(),
            codex_model: String::new(),
            api_key: None,
            new_captures_only: false,
            tidy_text: true,
            notice_pending: false,
            api_key_storage: Default::default(),
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
        let png = save_capture(
            &crate::media::SaveDestination::flat(dir),
            &image,
            CaptureMode::Region,
            &foreground,
            None,
            when,
        )
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

    /// Clients that give up fast, with no `claude` or `codex`.
    fn fast() -> Clients {
        Clients {
            http: agent(Duration::from_millis(500)),
            claude: None,
            codex: None,
            cli_timeout: Duration::from_secs(10),
            reasoning: Arc::default(),
        }
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

        let step = step(&library, &ai, &fast(), |_| worked = true).unwrap();

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
        step(library, ai, &fast(), |_| {}).unwrap()
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
    fn switching_descriptions_off_leaves_waiting_captures_waiting() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        // Nothing listens there: any request would fail the step.
        let on = AiSettings {
            enabled: true,
            endpoint: "http://127.0.0.1:9".into(),
            ..AiSettings::default()
        };
        // The provider stays on for manual use, but automatic descriptions
        // are off: the waiting capture is neither sent nor skipped.
        let off = AiSettings {
            automatic_descriptions: Some(false),
            ..on.clone()
        };
        assert!(!off.describes());
        assert_eq!(step_again(&library, &off), Step::Off);
        assert_eq!(library.lock().ai_state(id).unwrap(), AI_WAITING);
        // Turning them back on for new captures only skips what waited.
        assert!(skips_existing(
            &off,
            &AiSettings {
                automatic_descriptions: Some(true),
                new_captures_only: true,
                ..off.clone()
            }
        ));
        // Settings from before the switch existed describe as they did.
        assert!(on.describes());
    }

    #[test]
    fn the_capture_count_tells_waiting_captures_from_every_capture() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let guard = library.lock();
        assert_eq!(guard.ai_capture_count(true).unwrap(), 1);
        assert_eq!(guard.ai_capture_count(false).unwrap(), 1);
        // Described or skipped, a save would not send it; Re-describe all would.
        for state in [AI_DONE, AI_SKIPPED] {
            guard
                .connection()
                .execute("UPDATE shots SET ai_state = ?1 WHERE id = ?2", [state, id])
                .unwrap();
            assert_eq!(guard.ai_capture_count(true).unwrap(), 0);
            assert_eq!(guard.ai_capture_count(false).unwrap(), 1);
        }
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
            &Clients {
                http: agent(Duration::from_millis(300)),
                ..fast()
            },
            |_| {},
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
    fn the_connection_test_says_what_to_fix() {
        let server = serve(vec![
            Reply::Json(
                401,
                json!({ "error": { "message": "No auth credentials found" } }),
            ),
            Reply::Json(
                400,
                json!({ "error": { "message": "Model does not support images. Please use a model that does." } }),
            ),
            Reply::Json(
                500,
                json!({ "error": "this model is missing data required for image input" }),
            ),
            Reply::Chat("Sure! The connection works.".into()),
        ]);
        let ai = settings(&server);
        let auth = test_connection(&fast(), &ai).unwrap_err().to_string();
        assert!(
            auth.starts_with("The server did not accept the API key."),
            "{auth}"
        );
        assert!(auth.contains("No auth credentials found"), "{auth}");
        for _ in 0..2 {
            let images = test_connection(&fast(), &ai).unwrap_err().to_string();
            assert!(
                images.starts_with("test-vision does not accept images."),
                "{images}"
            );
        }
        let answer = test_connection(&fast(), &ai).unwrap_err();
        assert!(matches!(answer, AiError::Response(_)), "{answer:?}");
        assert!(
            answer.to_string().contains("did not answer with the JSON"),
            "{answer}"
        );
        // Nothing listens on the port any more.
        drop(server);
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let offline = AiSettings {
            endpoint: format!("http://127.0.0.1:{port}/v1"),
            ..ai
        };
        let down = test_connection(&fast(), &offline).unwrap_err().to_string();
        assert!(down.starts_with("The server did not answer."), "{down}");
    }

    #[test]
    fn a_vision_model_that_is_missing_or_busy_is_not_said_to_refuse_images() {
        let server = serve(vec![
            Reply::Json(
                404,
                json!({ "error": { "message": "model \"llama3.2-vision\" not found, try pulling it first" } }),
            ),
            Reply::Json(
                400,
                json!({ "error": "llama3.2-vision: the prompt is longer than the context length" }),
            ),
            Reply::Json(
                429,
                json!({ "error": { "message": "Rate limit exceeded for vision requests" } }),
            ),
        ]);
        let ai = AiSettings {
            model: "llama3.2-vision".into(),
            ..settings(&server)
        };
        for _ in 0..3 {
            let err = test_connection(&fast(), &ai).unwrap_err().to_string();
            assert!(!err.contains("does not accept images"), "{err}");
        }
    }

    /// A reasoning model's answer when it ran out of tokens while thinking.
    fn thought_out_reply() -> Reply {
        Reply::Json(
            200,
            json!({ "choices": [{
                "finish_reason": "length",
                "message": { "role": "assistant", "content": "", "reasoning_content": "The user wants JSON. Let me think…" },
            }] }),
        )
    }

    #[test]
    fn a_reasoning_model_that_runs_out_of_tokens_is_asked_again_with_more() {
        let server = serve(vec![
            thought_out_reply(),
            Reply::Chat("{\"ok\": true}".into()),
        ]);
        let ai = settings(&server);
        test_connection(&fast(), &ai).unwrap();
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].body["max_tokens"], DESCRIPTION_MAX_TOKENS);
        assert_eq!(requests[1].body["max_tokens"], REASONING_MAX_TOKENS);
    }

    #[test]
    fn a_budget_near_the_reasoning_one_is_doubled_up_to_a_cap() {
        let raise = |budget: u32| raised_budget(&Value::from(budget));
        assert_eq!(raise(DESCRIPTION_MAX_TOKENS), Some(REASONING_MAX_TOKENS));
        assert_eq!(raise(20), Some(REASONING_MAX_TOKENS));
        assert_eq!(raise(2000), Some(4000));
        assert_eq!(raise(5000), Some(REASONING_MAX_TOKENS_CAP));
        assert_eq!(raise(REASONING_MAX_TOKENS_CAP), None);
        assert_eq!(raised_budget(&Value::from("lots")), None);

        // A request that asks for 2000 is retried with 4000, and so starts
        // the next time.
        let server = serve(vec![
            thought_out_reply(),
            Reply::Chat("{\"ok\": true}".into()),
            Reply::Chat("{\"ok\": true}".into()),
        ]);
        let clients = fast();
        let ai = settings(&server);
        let ask_big = || {
            ask(
                &clients,
                &ai,
                &Ask {
                    system: SYSTEM_PROMPT,
                    prompt: TEST_PROMPT,
                    png: include_bytes!("../fixtures/connection-test.png"),
                    schema: &test_schema(),
                    max_tokens: 2000,
                },
            )
        };
        ask_big().unwrap();
        ask_big().unwrap();
        let budgets: Vec<Value> = server
            .requests()
            .iter()
            .map(|request| request.body["max_tokens"].clone())
            .collect();
        assert_eq!(
            budgets,
            [Value::from(2000), Value::from(4000), Value::from(4000)]
        );
    }

    #[test]
    fn a_reasoning_model_that_never_answers_says_so() {
        let server = serve(vec![thought_out_reply(), thought_out_reply()]);
        let err = test_connection(&fast(), &settings(&server)).unwrap_err();
        assert!(matches!(err, AiError::Endpoint(_)), "{err:?}");
        let message = err.to_string();
        assert!(
            message.starts_with("The model spent its whole reply budget thinking"),
            "{message}"
        );
        assert!(
            message.contains("turn reasoning off in the server"),
            "{message}"
        );
        // Asked once more, not again and again.
        assert_eq!(server.requests().len(), 2);
    }

    #[test]
    fn a_reasoning_model_that_never_answers_stops_the_queue() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let server = serve(vec![thought_out_reply(), thought_out_reply()]);
        let Step::Stopped(message) = step_again(&library, &settings(&server)) else {
            panic!("the queue should stop");
        };
        assert!(
            message.contains("Choose a model without reasoning"),
            "{message}"
        );
        assert_eq!(library.lock().ai_state(id).unwrap(), AI_WAITING);
        assert_eq!(server.requests().len(), 2);
    }

    #[test]
    fn the_larger_budget_is_remembered_for_the_endpoint_and_model() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let job = library.lock().next_for_ai().unwrap().unwrap();
        assert_eq!(job.id, id);
        let server = serve(vec![
            thought_out_reply(),
            Reply::Chat(GOOD_REPLY.into()),
            Reply::Chat(GOOD_REPLY.into()),
            Reply::Chat(GOOD_REPLY.into()),
        ]);
        let clients = fast();
        let ai = settings(&server);
        describe(&clients, &ai, &job).unwrap();
        describe(&clients, &ai, &job).unwrap();
        // Another model starts small again.
        let other = AiSettings {
            model: "other-vision".into(),
            ..ai.clone()
        };
        describe(&clients, &other, &job).unwrap();
        let budgets: Vec<Value> = server
            .requests()
            .iter()
            .map(|request| request.body["max_tokens"].clone())
            .collect();
        assert_eq!(
            budgets,
            [
                Value::from(DESCRIPTION_MAX_TOKENS),
                Value::from(REASONING_MAX_TOKENS),
                Value::from(REASONING_MAX_TOKENS),
                Value::from(DESCRIPTION_MAX_TOKENS),
            ]
        );
    }

    #[test]
    fn an_empty_reply_without_reasoning_is_not_blamed_on_thinking() {
        let server = serve(vec![Reply::Chat(String::new())]);
        let err = test_connection(&fast(), &settings(&server))
            .unwrap_err()
            .to_string();
        assert!(err.contains("empty reply"), "{err}");
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn an_endpoint_lists_its_models() {
        let server = serve(vec![
            Reply::Json(
                200,
                json!({ "object": "list", "data": [
                    { "id": "qwen3-vl:4b", "object": "model" },
                    { "id": "gemma3:4b", "object": "model" },
                    { "id": "text-embedding-nomic-embed-text-v1.5", "object": "model" },
                    { "id": "bge-reranker-v2-m3", "object": "model" },
                    { "id": "qwen3-vl:4b", "object": "model" },
                ] }),
            ),
            Reply::Json(401, json!({ "error": { "message": "Invalid API key" } })),
        ]);
        let agent = agent(Duration::from_secs(5));
        let models =
            list_models(&agent, &format!("{}/", server.endpoint), Some("sk-test")).unwrap();
        assert_eq!(models, ["qwen3-vl:4b", "gemma3:4b"]);
        let request = &server.requests()[0];
        assert!(
            request.head.starts_with("GET /v1/models "),
            "{}",
            request.head
        );
        assert!(request.head.contains("Bearer sk-test"), "{}", request.head);
        let err = list_models(&agent, &server.endpoint, None)
            .unwrap_err()
            .to_string();
        assert!(
            err.starts_with("The server did not accept the API key."),
            "{err}"
        );
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

    #[test]
    fn cancelling_empties_the_queue_and_keeps_earlier_descriptions() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let server = serve(vec![Reply::Chat(GOOD_REPLY.into())]);
        assert_eq!(
            step_again(&library, &settings(&server)),
            Step::Described(id)
        );

        let mut guard = library.lock();
        assert!(!guard.get(id).unwrap().ai_waiting);
        guard.requeue_ai(id).unwrap();
        assert!(guard.get(id).unwrap().ai_waiting);
        assert_eq!(guard.cancel_waiting_ai().unwrap(), 1);
        // Described before, so it is described again, as it was.
        assert_eq!(guard.ai_state(id).unwrap(), AI_DONE);
        let shot = guard.get(id).unwrap();
        assert!(!shot.ai_waiting);
        assert!(shot.ai_description.is_some());

        // Never described: skipped until the user asks again.
        guard.clear_ai(id).unwrap();
        guard.requeue_ai(id).unwrap();
        assert_eq!(guard.cancel_waiting_ai().unwrap(), 1);
        assert_eq!(guard.ai_state(id).unwrap(), AI_SKIPPED);
        assert!(guard.next_for_ai().unwrap().is_none());
        assert_eq!(guard.cancel_waiting_ai().unwrap(), 0);
    }

    #[test]
    fn an_answer_that_arrives_after_cancelling_is_dropped() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let server = serve(vec![Reply::Chat(GOOD_REPLY.into())]);

        let step = step(&library, &settings(&server), &fast(), |working| {
            assert_eq!(working, id);
            library.lock().cancel_waiting_ai().unwrap();
        })
        .unwrap();

        assert_eq!(step, Step::Gone(id));
        let guard = library.lock();
        assert_eq!(guard.ai_state(id).unwrap(), AI_SKIPPED);
        assert_eq!(guard.get(id).unwrap().ai_description, None);
    }

    // --- The queue with Claude Code --------------------------------------

    fn claude_settings() -> AiSettings {
        AiSettings {
            enabled: true,
            provider: Some(AiProvider::ClaudeCode),
            new_captures_only: false,
            ..AiSettings::default()
        }
    }

    #[cfg(unix)]
    #[test]
    fn claude_code_describes_a_capture_and_is_recorded_as_the_model() {
        use crate::ai_cli::tests::{recording_claude, success};
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("Invoice 42 total due"));
        let cli = TempDir::new().unwrap();
        let claude = recording_claude(cli.path(), &success(GOOD_REPLY), 0);
        let clients = Clients {
            claude: Some(claude),
            ..fast()
        };

        assert_eq!(
            step(&library, &claude_settings(), &clients, |_| {}).unwrap(),
            Step::Described(id)
        );

        let guard = library.lock();
        let shot = guard.get(id).unwrap();
        assert_eq!(shot.ai_category.as_deref(), Some("receipt"));
        assert_eq!(shot.ai_tags, vec!["acme", "billing", "invoice"]);
        assert_eq!(
            guard.ai_model(id).unwrap().as_deref(),
            Some("claude-code/haiku")
        );
        // The prompt and the scaled-down capture went in on stdin.
        let stdin: Value = serde_json::from_str(
            &std::fs::read_to_string(cli.path().join("log").join("stdin")).unwrap(),
        )
        .unwrap();
        let content = &stdin["message"]["content"];
        let sent = image::load_from_memory(
            &BASE64_STANDARD
                .decode(content[0]["source"]["data"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(sent.width(), MAX_IMAGE_EDGE);
        let text = content[1]["text"].as_str().unwrap();
        assert!(text.contains("Invoice 42 total due"), "{text}");
        assert!(text.contains("App: firefox"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_claude_stops_the_queue_with_its_message() {
        use crate::ai_cli::tests::fake_claude;
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let cli = TempDir::new().unwrap();
        let result = json!({
            "type": "result", "subtype": "success", "is_error": true,
            "result": "Not logged in · Please run /login",
        });
        let claude = fake_claude(
            cli.path(),
            &format!("cat > /dev/null\nprintf '%s\\n' '{result}'\nexit 1"),
        );
        let clients = Clients {
            claude: Some(claude),
            ..fast()
        };
        let Step::Stopped(message) = step(&library, &claude_settings(), &clients, |_| {}).unwrap()
        else {
            panic!("the queue should stop");
        };
        assert!(message.contains("Please run /login"), "{message}");
        assert_eq!(library.lock().ai_state(id).unwrap(), AI_WAITING);
    }

    #[test]
    fn a_missing_claude_stops_the_queue_and_the_capture_waits() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let mut worked = false;
        let Step::Stopped(message) =
            step(&library, &claude_settings(), &fast(), |_| worked = true).unwrap()
        else {
            panic!("the queue should stop");
        };
        assert!(worked);
        assert!(
            message.contains("Claude Code is not installed"),
            "{message}"
        );
        assert_eq!(library.lock().ai_state(id).unwrap(), AI_WAITING);
        assert!(test_connection(&fast(), &claude_settings()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_connection_test_runs_claude_code() {
        use crate::ai_cli::tests::{recording_claude, success};
        let cli = TempDir::new().unwrap();
        let claude = recording_claude(cli.path(), &success("{\"ok\": true}"), 0);
        let clients = Clients {
            claude: Some(claude),
            ..fast()
        };
        let message = test_connection(&clients, &claude_settings()).unwrap();
        assert_eq!(message, "Claude Code (haiku) answered.");
        let stdin = std::fs::read_to_string(cli.path().join("log").join("stdin")).unwrap();
        assert!(stdin.contains("connection test"), "{stdin}");
    }

    // --- The queue with Codex ---------------------------------------------

    fn codex_settings() -> AiSettings {
        AiSettings {
            enabled: true,
            provider: Some(AiProvider::Codex),
            new_captures_only: false,
            ..AiSettings::default()
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_describes_a_capture_and_is_recorded_as_the_model() {
        use crate::ai_cli::tests::recording_codex;
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("Invoice 42 total due"));
        let cli = TempDir::new().unwrap();
        let codex = recording_codex(cli.path(), Some(GOOD_REPLY), "", 0);
        let clients = Clients {
            codex: Some(codex),
            ..fast()
        };

        assert_eq!(
            step(&library, &codex_settings(), &clients, |_| {}).unwrap(),
            Step::Described(id)
        );

        let guard = library.lock();
        let shot = guard.get(id).unwrap();
        assert_eq!(shot.ai_category.as_deref(), Some("receipt"));
        assert_eq!(shot.ai_tags, vec!["acme", "billing", "invoice"]);
        assert_eq!(guard.ai_model(id).unwrap().as_deref(), Some("codex"));
        // The scaled-down capture, the prompt and the description's schema.
        let log = cli.path().join("log");
        let sent = image::load_from_memory(&std::fs::read(log.join("image")).unwrap()).unwrap();
        assert_eq!(sent.width(), MAX_IMAGE_EDGE);
        let args = std::fs::read_to_string(log.join("args")).unwrap();
        assert!(args.contains("Invoice 42 total due"), "{args}");
        assert!(args.contains(SYSTEM_PROMPT), "{args}");
        let schema: Value =
            serde_json::from_str(&std::fs::read_to_string(log.join("schema")).unwrap()).unwrap();
        assert_eq!(schema, description_schema());
    }

    #[test]
    fn the_description_schema_is_strict() {
        let schema = description_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["required"],
            json!(["description", "category", "tags"])
        );
        assert_eq!(schema["properties"]["category"]["enum"], json!(CATEGORIES));
        let test = test_schema();
        assert_eq!(test["additionalProperties"], false);
        assert_eq!(test["required"], json!(["ok"]));
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_codex_stops_the_queue_with_its_message() {
        use crate::ai_cli::tests::recording_codex;
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let cli = TempDir::new().unwrap();
        let codex = recording_codex(cli.path(), None, "Not logged in. Run `codex login`.", 1);
        let clients = Clients {
            codex: Some(codex),
            ..fast()
        };
        let Step::Stopped(message) = step(&library, &codex_settings(), &clients, |_| {}).unwrap()
        else {
            panic!("the queue should stop");
        };
        assert!(message.contains("Run `codex login`"), "{message}");
        assert_eq!(library.lock().ai_state(id).unwrap(), AI_WAITING);
    }

    #[test]
    fn a_missing_codex_stops_the_queue_and_the_capture_waits() {
        let dir = TempDir::new().unwrap();
        let (library, id) = library_with_shot(dir.path(), Some("x"));
        let Step::Stopped(message) = step(&library, &codex_settings(), &fast(), |_| {}).unwrap()
        else {
            panic!("the queue should stop");
        };
        assert!(message.contains("Codex is not installed"), "{message}");
        assert_eq!(library.lock().ai_state(id).unwrap(), AI_WAITING);
        assert!(test_connection(&fast(), &codex_settings()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_connection_test_runs_codex() {
        use crate::ai_cli::tests::recording_codex;
        let cli = TempDir::new().unwrap();
        let codex = recording_codex(cli.path(), Some("{\"ok\": true}"), "", 0);
        let clients = Clients {
            codex: Some(codex),
            ..fast()
        };
        let message = test_connection(&clients, &codex_settings()).unwrap();
        assert_eq!(message, "Codex answered.");
        let log = cli.path().join("log");
        let args = std::fs::read_to_string(log.join("args")).unwrap();
        assert!(args.contains("connection test"), "{args}");
        let schema: Value =
            serde_json::from_str(&std::fs::read_to_string(log.join("schema")).unwrap()).unwrap();
        assert_eq!(schema, test_schema());
    }
}
