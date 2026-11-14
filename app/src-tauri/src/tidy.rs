//! Tidying up a text capture with AI.
//!
//! Capture text reads a region with the local OCR model first, so the text
//! is on the clipboard at once. When AI is turned on (and "Tidy up captured
//! text" is, which it is by default), the region then goes to the same
//! provider that describes captures, with what OCR read. The model reads it
//! again from the image, fixing what OCR got wrong, and lays out structured
//! text the way it belongs: JSON valid and indented, code with its line
//! breaks and indentation, tables as Markdown tables. Valid JSON is
//! indented here too, so it always comes out the same way.

use std::time::Duration;

use image::{DynamicImage, RgbaImage};
use serde::de::IgnoredAny;
use serde_json::{Value, json};

use crate::{
    ai::{self, AiError, Ask, Clients, first_object, truncate},
    ai_cli,
    settings::{AiProvider, AiSettings},
};

/// What the text can be laid out as. Mirrors `TEXT_FORMATS` in
/// src/quick/api.ts.
pub const FORMATS: [&str; 7] = ["plain", "json", "yaml", "xml", "sql", "code", "table"];
/// The format kept when the model gives one not in [`FORMATS`].
const FALLBACK_FORMAT: &str = "plain";
/// The most OCR text sent along as a hint.
const MAX_OCR_CHARS: usize = 8000;
/// The longest language name kept, such as `typescript`.
const MAX_LANGUAGE_CHARS: usize = 20;
/// The longest answer an endpoint may give, in tokens: a screenful of text.
const MAX_TOKENS: u32 = 8192;
/// How long tidying may take. The user is waiting, but a CLI starting up
/// and a model writing out a screenful of text take a while.
pub const TIDY_TIMEOUT: Duration = Duration::from_secs(120);

/// Sent as the system prompt when tidying text.
pub const SYSTEM_PROMPT: &str = "You transcribe the text in screenshots exactly, so it can be \
     pasted elsewhere. You reply with a single JSON object and nothing else.";

/// The model's text, and what it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tidied {
    pub text: String,
    /// One of [`FORMATS`].
    pub format: String,
    /// The programming language, for code.
    pub language: Option<String>,
}

/// The instructions, with what OCR read as a hint.
pub fn prompt(ocr_text: &str) -> String {
    let mut prompt = format!(
        "Transcribe the text in this screenshot so it can be pasted elsewhere. Reply with \
         JSON only, in exactly this shape:\n\
         {{\"text\": \"...\", \"format\": \"...\", \"language\": \"...\"}}\n\
         - text: all of the text, in reading order, exactly as written: the same words, \
         spelling, case, numbers and punctuation. Do not translate, summarise, explain, \
         correct or add anything. Leave out window and app controls around the content, \
         and the line numbers beside code.\n\
         - Lay the text out the way it belongs:\n\
         \x20 - JSON: valid JSON indented with 2 spaces. Only repair what reading it from \
         an image broke, such as a missed quote, comma or bracket, or a line wrapped by the \
         screen's width. Do not invent values for anything cut off at the edges.\n\
         \x20 - YAML, XML, SQL and code: the original line breaks and indentation, as it \
         would be in the file.\n\
         \x20 - A table: a Markdown table.\n\
         \x20 - Anything else: paragraphs joined back up where only the screen's width \
         wrapped them; real line breaks, lists and headings kept.\n\
         - format: exactly one of {}.\n\
         - language: for code, its programming language in lowercase, such as python, \
         rust or shell; otherwise \"\".\n\
         If there is no text, reply {{\"text\": \"\", \"format\": \"plain\", \"language\": \"\"}}.\n",
        FORMATS.join(", ")
    );
    let ocr_text = ocr_text.trim();
    if !ocr_text.is_empty() {
        prompt.push_str(&format!(
            "\nText read from the image by OCR, which may have mistakes. The image is \
             right where they differ:\n\"\"\"\n{}\n\"\"\"\n",
            truncate(ocr_text, MAX_OCR_CHARS)
        ));
    }
    prompt
}

/// The JSON schema a tidied text follows, for providers that hold their
/// answer to one. Strict, as OpenAI's structured outputs want it.
pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "text": { "type": "string" },
            "format": { "type": "string", "enum": FORMATS },
            "language": { "type": "string" },
        },
        "required": ["text", "format", "language"],
        "additionalProperties": false,
    })
}

/// Reads the model's reply. Chatter or code fences around the JSON are
/// ignored; an unknown format is plain text. Valid JSON is indented with
/// two spaces, however the model laid it out.
pub fn parse(reply: &str) -> Result<Tidied, AiError> {
    let object = first_object(reply)
        .ok_or_else(|| AiError::Response(format!("no JSON in {:?}", truncate(reply, 200))))?;
    let value: Value = serde_json::from_str(object)
        .map_err(|err| AiError::Response(format!("invalid JSON ({err}) in {object:?}")))?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| AiError::Response(format!("no text in {}", truncate(object, 200))))?;
    let text = text.replace("\r\n", "\n");
    let text = text.trim_matches('\n').trim_end();
    let format = value
        .get("format")
        .and_then(Value::as_str)
        .map(|format| format.trim().to_lowercase())
        .filter(|format| FORMATS.contains(&format.as_str()))
        .unwrap_or_else(|| FALLBACK_FORMAT.to_owned());
    let language = value
        .get("language")
        .and_then(Value::as_str)
        .map(|language| language.trim().to_lowercase())
        .filter(|language| {
            format == "code"
                && !language.is_empty()
                && language.chars().count() <= MAX_LANGUAGE_CHARS
        });
    let text = match format.as_str() {
        "json" => indent_json(text).unwrap_or_else(|| text.to_owned()),
        _ => text.to_owned(),
    };
    Ok(Tidied {
        text,
        format,
        language,
    })
}

/// `text` indented with two spaces when it is one valid JSON value, else
/// None. Only the whitespace between tokens changes: keys keep their order
/// and numbers their digits, however long.
pub fn indent_json(text: &str) -> Option<String> {
    serde_json::from_str::<IgnoredAny>(text).ok()?;
    let mut out = String::with_capacity(text.len() * 2);
    let mut depth = 0usize;
    let mut chars = text.trim().chars().peekable();
    let newline = |out: &mut String, depth: usize| {
        out.push('\n');
        out.push_str(&"  ".repeat(depth));
    };
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                out.push('"');
                let mut escaped = false;
                for ch in chars.by_ref() {
                    out.push(ch);
                    match ch {
                        _ if escaped => escaped = false,
                        '\\' => escaped = true,
                        '"' => break,
                        _ => {}
                    }
                }
            }
            '{' | '[' => {
                let close = if ch == '{' { '}' } else { ']' };
                while chars.next_if(|next| next.is_whitespace()).is_some() {}
                if chars.next_if_eq(&close).is_some() {
                    out.push(ch);
                    out.push(close);
                } else {
                    out.push(ch);
                    depth += 1;
                    newline(&mut out, depth);
                }
            }
            '}' | ']' => {
                depth = depth.saturating_sub(1);
                newline(&mut out, depth);
                out.push(ch);
            }
            ',' => {
                out.push(',');
                newline(&mut out, depth);
            }
            ':' => out.push_str(": "),
            _ if ch.is_whitespace() => {}
            _ => out.push(ch),
        }
    }
    Some(out)
}

/// Who tidies text with `ai`, as the card names them: the CLI, or the
/// endpoint's model.
pub fn tidier_name(ai: &AiSettings) -> String {
    match ai.provider() {
        AiProvider::ClaudeCode => ai_cli::CLAUDE_NAME.to_owned(),
        AiProvider::Codex => ai_cli::CODEX_NAME.to_owned(),
        AiProvider::Endpoint => ai.model.clone(),
    }
}

/// Asks the provider in `ai` to read the text in `image` again, given what
/// OCR read.
pub fn tidy(
    clients: &Clients,
    ai: &AiSettings,
    image: &RgbaImage,
    ocr_text: &str,
) -> Result<Tidied, AiError> {
    let png = ai::fit_png(DynamicImage::ImageRgba8(image.clone()))?;
    let reply = ai::ask(
        clients,
        ai,
        &Ask {
            system: SYSTEM_PROMPT,
            prompt: &prompt(ocr_text),
            png: &png,
            schema: &schema(),
            max_tokens: MAX_TOKENS,
        },
    )?;
    parse(&reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_is_indented_without_reordering_or_rounding() {
        let text = r#"{"zeta": 1, "alpha": {"id": 123456789012345678901234567890, "tags": ["a", "b"], "none": {}, "empty": [ ]}, "s": "a, {b}: \"c\""}"#;
        assert_eq!(
            indent_json(text).unwrap(),
            "{\n  \"zeta\": 1,\n  \"alpha\": {\n    \"id\": 123456789012345678901234567890,\n    \
             \"tags\": [\n      \"a\",\n      \"b\"\n    ],\n    \"none\": {},\n    \
             \"empty\": []\n  },\n  \"s\": \"a, {b}: \\\"c\\\"\"\n}"
        );
        assert_eq!(indent_json("[1,2]").unwrap(), "[\n  1,\n  2\n]");
        assert_eq!(indent_json(" 42 ").unwrap(), "42");
        assert_eq!(indent_json("{a: 1}"), None);
        assert_eq!(indent_json("{\"a\": 1} trailing"), None);
    }

    #[test]
    fn a_json_reply_is_indented_here() {
        let reply = r#"{"text": "{\"b\":[1,2],\"a\":null}", "format": "json", "language": ""}"#;
        let tidied = parse(reply).unwrap();
        assert_eq!(
            tidied.text,
            "{\n  \"b\": [\n    1,\n    2\n  ],\n  \"a\": null\n}"
        );
        assert_eq!(tidied.format, "json");
        assert_eq!(tidied.language, None);
    }

    #[test]
    fn json_that_does_not_parse_is_kept_as_the_model_wrote_it() {
        let reply = r#"{"text": "{\n  \"cut\": \"off", "format": "json", "language": ""}"#;
        assert_eq!(parse(reply).unwrap().text, "{\n  \"cut\": \"off");
    }

    #[test]
    fn code_keeps_its_layout_and_language() {
        let reply = "Here you go:\n```json\n{\"text\": \"\\r\\ndef f():\\n    return 1\\n\\n\", \
                     \"format\": \"Code\", \"language\": \" Python \"}\n```";
        let tidied = parse(reply).unwrap();
        assert_eq!(tidied.text, "def f():\n    return 1");
        assert_eq!(tidied.format, "code");
        assert_eq!(tidied.language.as_deref(), Some("python"));
    }

    #[test]
    fn unknown_formats_are_plain_and_only_code_has_a_language() {
        let tidied =
            parse(r#"{"text": "Hello", "format": "poem", "language": "english"}"#).unwrap();
        assert_eq!(tidied.format, "plain");
        assert_eq!(tidied.language, None);
        let missing = parse(r#"{"text": "Hello"}"#).unwrap();
        assert_eq!(missing.format, "plain");
    }

    #[test]
    fn no_text_is_empty_and_no_json_is_an_error() {
        assert_eq!(
            parse(r#"{"text": "", "format": "plain", "language": ""}"#)
                .unwrap()
                .text,
            ""
        );
        assert!(matches!(
            parse("Sorry, I can't."),
            Err(AiError::Response(_))
        ));
        assert!(matches!(
            parse(r#"{"format": "plain"}"#),
            Err(AiError::Response(_))
        ));
    }

    #[test]
    fn the_prompt_carries_the_ocr_text_as_a_hint() {
        let with = prompt("  {\"a\": l}  ");
        assert!(with.contains("\"\"\"\n{\"a\": l}\n\"\"\""), "{with}");
        assert!(with.contains("json, yaml, xml, sql, code, table"), "{with}");
        let without = prompt("   ");
        assert!(!without.contains("OCR"), "{without}");
    }

    #[test]
    fn the_schema_lists_every_format() {
        let schema = schema();
        assert_eq!(schema["properties"]["format"]["enum"], json!(FORMATS));
        assert_eq!(schema["required"], json!(["text", "format", "language"]));
    }

    #[test]
    fn the_tidier_is_named_by_provider() {
        let mut ai = AiSettings {
            provider: Some(AiProvider::ClaudeCode),
            ..AiSettings::default()
        };
        assert_eq!(tidier_name(&ai), "Claude Code");
        ai.provider = Some(AiProvider::Codex);
        assert_eq!(tidier_name(&ai), "Codex");
        ai.provider = Some(AiProvider::Endpoint);
        ai.model = "qwen3-vl:4b".into();
        assert_eq!(tidier_name(&ai), "qwen3-vl:4b");
    }
}
