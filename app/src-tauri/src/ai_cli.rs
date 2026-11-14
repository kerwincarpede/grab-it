//! Describing captures with an AI CLI the user already has, Claude Code or
//! Codex, so describing needs no local model and no API key.
//!
//! The CLI is found even when Grab-it starts from Finder or a launcher and
//! so lacks the shell's PATH, then run headlessly in an empty temporary
//! directory with no tools, and killed if it takes too long. Signing in is
//! the CLI's business: when it is not signed in it fails, and its message
//! is shown.

use std::{
    env,
    ffi::{OsStr, OsString},
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use crate::ai::{AiError, SYSTEM_PROMPT, truncate};

/// Claude Code's command name.
pub const CLAUDE: &str = "claude";
/// What the user calls Claude Code in messages.
pub const CLAUDE_NAME: &str = "Claude Code";
/// Codex's command name.
pub const CODEX: &str = "codex";
/// What the user calls Codex in messages.
pub const CODEX_NAME: &str = "Codex";

/// How long the login shell may take to report its PATH.
const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(3);
/// The most of a CLI's output that is read.
const MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;
/// How often a running CLI is checked on.
const POLL: Duration = Duration::from_millis(25);
/// Marks the PATH in the login shell's output, around whatever its start-up
/// files print.
const PATH_MARK: &str = "__GRAB_IT_PATH__";

/// The `claude` to run, or none when it is not installed.
pub fn find_claude() -> Option<PathBuf> {
    find(CLAUDE)
}

/// The `codex` to run, or none when it is not installed.
pub fn find_codex() -> Option<PathBuf> {
    find(CODEX)
}

/// Finds `name` in this process's PATH, then in the login shell's PATH,
/// then where installers commonly put CLIs.
pub fn find(name: &str) -> Option<PathBuf> {
    find_with(name, env::var_os("PATH"), login_shell_path, home_dir())
}

/// [`find`], given the PATH, a way to ask the login shell for its PATH
/// (only asked when this PATH has no `name`) and the home directory.
pub fn find_with(
    name: &str,
    path: Option<OsString>,
    shell_path: impl FnOnce() -> Option<OsString>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(found) = path.and_then(|path| find_in(name, env::split_paths(&path))) {
        return Some(found);
    }
    if let Some(found) = shell_path().and_then(|path| find_in(name, env::split_paths(&path))) {
        return Some(found);
    }
    find_in(name, fallback_dirs(home.as_deref()))
}

/// Where CLIs are installed outside the usual PATH: Claude Code's own
/// installers, then Homebrew's and the system's local prefixes.
pub fn fallback_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".claude").join("local"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

/// The first executable `name` in `dirs`.
fn find_in(name: &str, dirs: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    dirs.into_iter()
        .filter(|dir| !dir.as_os_str().is_empty())
        .flat_map(|dir| candidates(&dir, name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(windows)]
fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    ["exe", "cmd", "bat"]
        .iter()
        .map(|extension| dir.join(format!("{name}.{extension}")))
        .collect()
}

#[cfg(not(windows))]
fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    vec![dir.join(name)]
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

fn home_dir() -> Option<PathBuf> {
    let home = if cfg!(windows) {
        env::var_os("USERPROFILE")
    } else {
        env::var_os("HOME")
    };
    home.filter(|home| !home.is_empty()).map(PathBuf::from)
}

static SHELL_PATH: OnceLock<Option<OsString>> = OnceLock::new();

/// The PATH the user's login shell sets up, asked once and remembered.
/// None on Windows, or when the shell does not answer in time.
fn login_shell_path() -> Option<OsString> {
    SHELL_PATH.get_or_init(ask_login_shell).clone()
}

#[cfg(unix)]
fn ask_login_shell() -> Option<OsString> {
    let shell = env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/sh".into());
    let script = format!("printf '{PATH_MARK}%s{PATH_MARK}' \"$PATH\"");
    // Interactive too: many users set PATH up in .zshrc or .bashrc.
    let args: Vec<OsString> = ["-i", "-l", "-c", script.as_str()]
        .iter()
        .map(OsString::from)
        .collect();
    let dir = env::temp_dir();
    let output = run(Path::new(&shell), &args, None, &dir, SHELL_PATH_TIMEOUT).ok()?;
    let path = output.stdout.split(PATH_MARK).nth(1)?;
    (!path.is_empty()).then(|| path.into())
}

#[cfg(not(unix))]
fn ask_login_shell() -> Option<OsString> {
    None
}

/// The PATH a CLI runs with: its own directory first, so a `claude` script
/// finds the `node` installed beside it, then this process's PATH and the
/// login shell's, when it was already asked for.
fn child_path(program: &Path) -> Option<OsString> {
    let mut dirs: Vec<PathBuf> = program
        .parent()
        .map(Path::to_path_buf)
        .into_iter()
        .collect();
    if let Some(path) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&path));
    }
    if let Some(Some(path)) = SHELL_PATH.get() {
        dirs.extend(env::split_paths(path));
    }
    let mut unique: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if !dir.as_os_str().is_empty() && !unique.contains(&dir) {
            unique.push(dir);
        }
    }
    env::join_paths(unique).ok()
}

/// An empty directory of its own for one CLI run, removed afterwards, so
/// the CLI finds no project files to read or settings to pick up.
struct WorkDir(PathBuf);

impl WorkDir {
    fn new() -> io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = env::temp_dir().join(format!(
            "grab-it-ai-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path)?;
        Ok(Self(path))
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// What a CLI printed, and how it exited.
#[derive(Debug)]
struct Output {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

/// Reads up to [`MAX_OUTPUT_BYTES`] of a pipe on its own thread, so a
/// chatty CLI never blocks on a full pipe.
fn read_pipe(pipe: Option<impl Read + Send + 'static>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = pipe {
            let _ = pipe.take(MAX_OUTPUT_BYTES).read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// The name a program is shown by in messages.
fn display_name(program: &Path) -> String {
    match program.file_stem().and_then(OsStr::to_str) {
        Some(CLAUDE) => CLAUDE_NAME.to_owned(),
        Some(CODEX) => CODEX_NAME.to_owned(),
        Some(name) => name.to_owned(),
        None => program.display().to_string(),
    }
}

/// Runs `program` in `dir` with `input` on its stdin (closed without one),
/// killing it once `timeout` has passed.
fn run(
    program: &Path,
    args: &[OsString],
    input: Option<Vec<u8>>,
    dir: &Path,
    timeout: Duration,
) -> Result<Output, AiError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(dir)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Claude Code run from inside a Claude Code session would think it
        // is nested.
        .env_remove("CLAUDECODE");
    if let Some(path) = child_path(program) {
        command.env("PATH", path);
    }
    let name = display_name(program);
    let mut attempts = 0;
    let mut child = loop {
        match command.spawn() {
            Ok(child) => break child,
            // A script written a moment ago can still be open for writing
            // in a child another thread just forked.
            Err(err) if err.kind() == io::ErrorKind::ExecutableFileBusy && attempts < 20 => {
                attempts += 1;
                thread::sleep(POLL);
            }
            Err(err) => {
                return Err(AiError::Endpoint(format!(
                    "could not start {name} ({}): {err}",
                    program.display()
                )));
            }
        }
    };
    if let (Some(mut stdin), Some(input)) = (child.stdin.take(), input) {
        // On its own thread: a CLI that does not read must not block us.
        // Dropping stdin when done closes it.
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let stdout = read_pipe(child.stdout.take());
    let stderr = read_pipe(child.stderr.take());
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                // The readers are left to finish on their own: something
                // the CLI started may still hold its output open.
                return Err(AiError::Endpoint(format!(
                    "{name} gave no answer within {} seconds",
                    timeout.as_secs_f32().ceil()
                )));
            }
            Ok(None) => thread::sleep(POLL),
            Err(err) => {
                let _ = child.kill();
                return Err(AiError::Endpoint(format!("{name} could not be run: {err}")));
            }
        }
    };
    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// The arguments that run Claude Code headlessly: one turn on stdin, no
/// tools, MCP servers, slash commands or saved session.
pub fn claude_args(model: &str) -> Vec<OsString> {
    [
        "-p",
        "--model",
        model,
        "--tools",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--system-prompt",
        SYSTEM_PROMPT,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    .iter()
    .map(OsString::from)
    .collect()
}

/// The one stream-json line sent to Claude Code: a user message holding
/// the PNG (base64) and then `text`.
pub fn claude_input(text: &str, png_base64: &str) -> String {
    let message = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": { "type": "base64", "media_type": "image/png", "data": png_base64 },
                },
                { "type": "text", "text": text },
            ],
        },
    });
    format!("{message}\n")
}

/// Claude Code's answer in its stream-json output: the `result` of the
/// last `type: result` line. An error result or a failed exit is an
/// [`AiError::Endpoint`], so the queue stops and shows why.
fn claude_answer(output: &Output) -> Result<String, AiError> {
    let result = output
        .stdout
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find(|value| value.get("type").and_then(Value::as_str) == Some("result"));
    let text = result
        .as_ref()
        .and_then(|value| value.get("result"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let is_error = result
        .as_ref()
        .and_then(|value| value.get("is_error"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_error || !output.status.success() {
        let stderr = output.stderr.trim();
        let why = text
            .map(str::to_owned)
            .or_else(|| (!stderr.is_empty()).then(|| stderr.to_owned()))
            .or_else(|| {
                result
                    .as_ref()
                    .and_then(|value| value.get("subtype"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| format!("it exited with {}", output.status));
        return Err(AiError::Endpoint(format!(
            "{CLAUDE_NAME} failed: {}",
            truncate(&why, 300)
        )));
    }
    text.map(str::to_owned).ok_or_else(|| {
        AiError::Response(format!(
            "{CLAUDE_NAME} sent no answer: {}",
            truncate(&output.stdout, 200)
        ))
    })
}

/// Asks Claude Code at `program` about one PNG, given as base64, and
/// returns its reply. It runs in an empty temporary directory and is
/// killed once `timeout` has passed.
pub fn claude_reply(
    program: &Path,
    model: &str,
    text: &str,
    png_base64: &str,
    timeout: Duration,
) -> Result<String, AiError> {
    let dir = WorkDir::new().map_err(|err| {
        AiError::Endpoint(format!(
            "could not make a folder to run {CLAUDE_NAME} in: {err}"
        ))
    })?;
    let input = claude_input(text, png_base64).into_bytes();
    let output = run(program, &claude_args(model), Some(input), &dir.0, timeout)?;
    claude_answer(&output)
}

/// Why describing with Claude Code cannot start.
pub fn claude_missing() -> AiError {
    missing(CLAUDE_NAME, CLAUDE)
}

/// Why describing with Codex cannot start.
pub fn codex_missing() -> AiError {
    missing(CODEX_NAME, CODEX)
}

fn missing(name: &str, command: &str) -> AiError {
    AiError::Endpoint(format!(
        "{name} is not installed: Grab-it could not find `{command}`. Install it, or choose \
         another provider in Settings."
    ))
}

/// The capture Codex is given, beside it in its folder.
const CODEX_IMAGE: &str = "capture.png";
/// The JSON schema Codex's answer must follow, beside it in its folder.
const CODEX_SCHEMA: &str = "schema.json";
/// Where Codex writes its last message, beside it in its folder.
const CODEX_REPLY: &str = "reply.txt";

/// The arguments that run Codex headlessly: one read-only turn on `prompt`
/// with the image attached, its answer held to the schema and written to
/// the reply file, with nothing saved, at low reasoning effort. Codex uses
/// `model`, or without one the model the user configured for it.
pub fn codex_args(
    image: &Path,
    schema: &Path,
    reply: &Path,
    prompt: &str,
    model: Option<&str>,
) -> Vec<OsString> {
    let flag = OsString::from;
    let mut args = vec![
        flag("exec"),
        flag("-i"),
        image.as_os_str().to_owned(),
        flag("-s"),
        flag("read-only"),
        flag("--skip-git-repo-check"),
        flag("--ephemeral"),
        flag("--output-schema"),
        schema.as_os_str().to_owned(),
        flag("-o"),
        reply.as_os_str().to_owned(),
        flag("-c"),
        flag("model_reasoning_effort=\"low\""),
    ];
    if let Some(model) = model {
        args.extend([flag("-m"), flag(model)]);
    }
    args.push(flag(prompt));
    args
}

/// What Codex is asked: it has no separate system prompt, so the system
/// prompt leads.
pub fn codex_prompt(text: &str) -> String {
    format!("{SYSTEM_PROMPT}\n\n{text}")
}

/// At most the last `max` characters of `text`, with `…` when cut: Codex
/// prints its progress first and why it failed last.
fn tail(text: &str, max: usize) -> String {
    let text = text.trim();
    let count = text.chars().count();
    if count <= max {
        return text.to_owned();
    }
    let start = text
        .char_indices()
        .nth(count - max)
        .map_or(0, |(start, _)| start);
    format!("…{}", text[start..].trim_start())
}

/// Codex's answer: what it wrote to `reply`. A failed exit is an
/// [`AiError::Endpoint`], so the queue stops and shows why.
fn codex_answer(output: &Output, reply: &Path) -> Result<String, AiError> {
    if !output.status.success() {
        let stderr = output.stderr.trim();
        let stdout = output.stdout.trim();
        let why = if !stderr.is_empty() {
            tail(stderr, 300)
        } else if !stdout.is_empty() {
            tail(stdout, 300)
        } else {
            format!("it exited with {}", output.status)
        };
        return Err(AiError::Endpoint(format!("{CODEX_NAME} failed: {why}")));
    }
    let text = fs::read_to_string(reply).unwrap_or_default();
    let text = text.trim();
    if text.is_empty() {
        return Err(AiError::Response(format!(
            "{CODEX_NAME} sent no answer: {}",
            truncate(&output.stdout, 200)
        )));
    }
    Ok(text.to_owned())
}

/// Asks Codex at `program` about one PNG, holding its answer to `schema`,
/// and returns its reply. It runs in an empty temporary directory, holding
/// only the image and the schema, with stdin closed, and is killed once
/// `timeout` has passed.
pub fn codex_reply(
    program: &Path,
    model: Option<&str>,
    text: &str,
    png: &[u8],
    schema: &Value,
    timeout: Duration,
) -> Result<String, AiError> {
    let dir = WorkDir::new().map_err(|err| {
        AiError::Endpoint(format!(
            "could not make a folder to run {CODEX_NAME} in: {err}"
        ))
    })?;
    let image = dir.0.join(CODEX_IMAGE);
    let schema_path = dir.0.join(CODEX_SCHEMA);
    let reply = dir.0.join(CODEX_REPLY);
    fs::write(&image, png)
        .and_then(|()| fs::write(&schema_path, schema.to_string()))
        .map_err(|err| {
            AiError::Endpoint(format!("could not give {CODEX_NAME} the capture: {err}"))
        })?;
    let args = codex_args(&image, &schema_path, &reply, &codex_prompt(text), model);
    let output = run(program, &args, None, &dir.0, timeout)?;
    codex_answer(&output, &reply)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::Cell;
    use tempfile::TempDir;

    #[cfg(unix)]
    fn executable(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_lookup_tries_path_then_the_login_shell_then_the_usual_places() {
        let dir = TempDir::new().unwrap();
        let on_path = dir.path().join("path");
        let from_shell = dir.path().join("shell");
        let home = dir.path().join("home");
        let asked = Cell::new(0);
        let shell = |path: &Path| {
            let path = path.as_os_str().to_owned();
            let asked = &asked;
            move || {
                asked.set(asked.get() + 1);
                Some(path)
            }
        };

        // Nowhere yet: not even the fallback directories under this home.
        let none = find_with(
            "grab-it-fake-cli",
            Some(on_path.clone().into()),
            shell(&from_shell),
            Some(home.clone()),
        );
        assert_eq!(none, None);

        // In ~/.claude/local, as Claude Code's local installer puts it.
        let local = home.join(".claude").join("local").join("grab-it-fake-cli");
        executable(&local, "true");
        assert_eq!(
            find_with(
                "grab-it-fake-cli",
                Some(on_path.clone().into()),
                shell(&from_shell),
                Some(home.clone()),
            ),
            Some(local.clone())
        );

        // ~/.local/bin comes before it.
        let user_bin = home.join(".local").join("bin").join("grab-it-fake-cli");
        executable(&user_bin, "true");
        assert_eq!(
            find_with(
                "grab-it-fake-cli",
                None,
                shell(&from_shell),
                Some(home.clone()),
            ),
            Some(user_bin)
        );

        // The login shell's PATH comes before the usual places.
        let shell_cli = from_shell.join("grab-it-fake-cli");
        executable(&shell_cli, "true");
        assert_eq!(
            find_with(
                "grab-it-fake-cli",
                Some(on_path.clone().into()),
                shell(&from_shell),
                Some(home.clone()),
            ),
            Some(shell_cli)
        );

        // And the PATH before it, without asking the shell at all.
        asked.set(0);
        let path_cli = on_path.join("grab-it-fake-cli");
        executable(&path_cli, "true");
        assert_eq!(
            find_with(
                "grab-it-fake-cli",
                Some(on_path.into()),
                shell(&from_shell),
                Some(home),
            ),
            Some(path_cli)
        );
        assert_eq!(asked.get(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn files_that_cannot_run_and_folders_are_skipped() {
        let dir = TempDir::new().unwrap();
        let first = dir.path().join("a");
        let second = dir.path().join("b");
        fs::create_dir_all(&first).unwrap();
        fs::write(first.join("grab-it-fake-cli"), "not executable").unwrap();
        fs::create_dir_all(second.join("grab-it-fake-cli")).unwrap();
        let path = env::join_paths([&first, &second]).unwrap();
        assert_eq!(
            find_with("grab-it-fake-cli", Some(path), || None, None),
            None
        );
    }

    #[test]
    fn the_fallbacks_are_the_installers_folders() {
        let dirs = fallback_dirs(Some(Path::new("/home/me")));
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/home/me/.local/bin"),
                PathBuf::from("/home/me/.claude/local"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ]
        );
        assert_eq!(fallback_dirs(None).len(), 2);
    }

    #[test]
    fn claude_runs_headless_with_no_tools() {
        let args: Vec<String> = claude_args("haiku")
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
        let after = |flag: &str| {
            let at = args.iter().position(|arg| arg == flag).unwrap();
            args[at + 1].clone()
        };
        assert_eq!(args[0], "-p");
        assert_eq!(after("--model"), "haiku");
        assert_eq!(after("--tools"), "");
        assert_eq!(after("--system-prompt"), SYSTEM_PROMPT);
        assert_eq!(after("--input-format"), "stream-json");
        assert_eq!(after("--output-format"), "stream-json");
        for flag in [
            "--strict-mcp-config",
            "--no-session-persistence",
            "--disable-slash-commands",
            "--verbose",
        ] {
            assert!(args.iter().any(|arg| arg == flag), "{flag}");
        }

        let line = claude_input("Describe it.", "iVBORw0K");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["type"], "user");
        assert_eq!(value["message"]["role"], "user");
        let content = value["message"]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["type"], "base64");
        assert_eq!(content[0]["source"]["media_type"], "image/png");
        assert_eq!(content[0]["source"]["data"], "iVBORw0K");
        assert_eq!(
            content[1],
            json!({ "type": "text", "text": "Describe it." })
        );
    }

    // --- Against a fake `claude` ---------------------------------------

    /// A stream-json result line answering `result`.
    #[cfg(unix)]
    fn result_line(result: &str, is_error: bool) -> String {
        json!({
            "type": "result",
            "subtype": if is_error { "error_during_execution" } else { "success" },
            "is_error": is_error,
            "result": result,
        })
        .to_string()
    }

    /// A fake `claude` in `dir` that runs `body`.
    #[cfg(unix)]
    pub(crate) fn fake_claude(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("bin").join(CLAUDE);
        executable(&path, body);
        path
    }

    /// A fake `claude` that records its arguments, stdin and folder beside
    /// itself, then prints `lines` and exits with `code`.
    #[cfg(unix)]
    pub(crate) fn recording_claude(dir: &Path, lines: &[String], code: i32) -> PathBuf {
        let log = dir.join("log");
        fs::create_dir_all(&log).unwrap();
        let printed: String = lines
            .iter()
            .map(|line| format!("printf '%s\\n' '{line}'\n"))
            .collect();
        let body = format!(
            "for arg in \"$@\"; do printf '%s\\n' \"$arg\"; done > '{log}/args'\n\
             cat > '{log}/stdin'\n\
             pwd > '{log}/cwd'\n\
             ls -A > '{log}/files'\n\
             printf '%s' \"$PATH\" > '{log}/path'\n\
             {printed}\
             exit {code}",
            log = log.display()
        );
        fake_claude(dir, &body)
    }

    #[cfg(unix)]
    pub(crate) fn success(result: &str) -> Vec<String> {
        vec![
            json!({ "type": "system", "subtype": "init" }).to_string(),
            json!({ "type": "assistant", "message": { "content": [] } }).to_string(),
            result_line(result, false),
        ]
    }

    #[cfg(unix)]
    #[test]
    fn claude_gets_the_image_on_stdin_in_an_empty_folder() {
        let dir = TempDir::new().unwrap();
        let claude = recording_claude(dir.path(), &success("{\"ok\": true}"), 0);

        let reply = claude_reply(
            &claude,
            "haiku",
            "Describe it.",
            "iVBORw0K",
            Duration::from_secs(10),
        )
        .unwrap();

        assert_eq!(reply, "{\"ok\": true}");
        let log = dir.path().join("log");
        let args = fs::read_to_string(log.join("args")).unwrap();
        assert!(
            args.starts_with("-p\n--model\nhaiku\n--tools\n\n"),
            "{args}"
        );
        let stdin: Value =
            serde_json::from_str(&fs::read_to_string(log.join("stdin")).unwrap()).unwrap();
        assert_eq!(stdin["message"]["content"][0]["source"]["data"], "iVBORw0K");
        assert_eq!(stdin["message"]["content"][1]["text"], "Describe it.");
        // Its own empty folder, gone once it has answered.
        let cwd = PathBuf::from(fs::read_to_string(log.join("cwd")).unwrap().trim());
        assert_ne!(cwd, env::current_dir().unwrap());
        assert_eq!(fs::read_to_string(log.join("files")).unwrap(), "");
        assert!(!cwd.exists(), "{}", cwd.display());
        // Its own folder leads the PATH, for a `node` installed beside it.
        let path = fs::read_to_string(log.join("path")).unwrap();
        assert!(
            path.starts_with(&claude.parent().unwrap().display().to_string()),
            "{path}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_error_result_or_a_failed_exit_stops_with_the_clis_message() {
        let dir = TempDir::new().unwrap();
        let claude = recording_claude(
            dir.path(),
            &[result_line("Invalid API key · Please run /login", true)],
            1,
        );
        let err = claude_reply(&claude, "haiku", "x", "x", Duration::from_secs(10)).unwrap_err();
        let AiError::Endpoint(message) = err else {
            panic!("{err:?}");
        };
        assert!(message.contains("Please run /login"), "{message}");
        assert!(message.starts_with("Claude Code"), "{message}");

        // An error result on a clean exit still stops the queue.
        let dir = TempDir::new().unwrap();
        let claude = recording_claude(dir.path(), &[result_line("Usage limit reached", true)], 0);
        assert!(matches!(
            claude_reply(&claude, "haiku", "x", "x", Duration::from_secs(10)),
            Err(AiError::Endpoint(message)) if message.contains("Usage limit reached")
        ));

        // Without a result, what it printed on stderr says why.
        let dir = TempDir::new().unwrap();
        let claude = fake_claude(
            dir.path(),
            "cat > /dev/null\necho 'unknown option --tools' >&2\nexit 2",
        );
        assert!(matches!(
            claude_reply(&claude, "haiku", "x", "x", Duration::from_secs(10)),
            Err(AiError::Endpoint(message)) if message.contains("unknown option --tools")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_clean_exit_without_an_answer_fails_only_the_capture() {
        let dir = TempDir::new().unwrap();
        let claude = recording_claude(dir.path(), &["not json".to_owned()], 0);
        assert!(matches!(
            claude_reply(&claude, "haiku", "x", "x", Duration::from_secs(10)),
            Err(AiError::Response(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_stalled_cli_is_killed_after_the_timeout() {
        let dir = TempDir::new().unwrap();
        let claude = fake_claude(dir.path(), "exec sleep 30");
        let started = Instant::now();
        let err = claude_reply(&claude, "haiku", "x", "x", Duration::from_millis(300)).unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(
            matches!(&err, AiError::Endpoint(message) if message.contains("no answer")),
            "{err:?}"
        );
    }

    // --- Codex -------------------------------------------------------------

    #[test]
    fn codex_is_asked_for_the_chosen_model() {
        let args: Vec<String> = codex_args(
            Path::new("/tmp/run/capture.png"),
            Path::new("/tmp/run/schema.json"),
            Path::new("/tmp/run/reply.txt"),
            "Describe it.",
            Some("gpt-5-mini"),
        )
        .into_iter()
        .map(|arg| arg.into_string().unwrap())
        .collect();
        let at = args.iter().position(|arg| arg == "-m").unwrap();
        assert_eq!(args[at + 1], "gpt-5-mini");
        assert_eq!(args.last().unwrap(), "Describe it.");
    }

    #[test]
    fn claude_is_asked_for_the_chosen_model() {
        let args: Vec<String> = claude_args("sonnet")
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
        let at = args.iter().position(|arg| arg == "--model").unwrap();
        assert_eq!(args[at + 1], "sonnet");
    }

    #[test]
    fn codex_runs_read_only_with_the_image_schema_and_reply_file() {
        let args: Vec<String> = codex_args(
            Path::new("/tmp/run/capture.png"),
            Path::new("/tmp/run/schema.json"),
            Path::new("/tmp/run/reply.txt"),
            "Describe it.",
            None,
        )
        .into_iter()
        .map(|arg| arg.into_string().unwrap())
        .collect();
        assert_eq!(
            args,
            [
                "exec",
                "-i",
                "/tmp/run/capture.png",
                "-s",
                "read-only",
                "--skip-git-repo-check",
                "--ephemeral",
                "--output-schema",
                "/tmp/run/schema.json",
                "-o",
                "/tmp/run/reply.txt",
                "-c",
                "model_reasoning_effort=\"low\"",
                "Describe it.",
            ]
        );
        let prompt = codex_prompt("Describe it.");
        assert!(prompt.starts_with(SYSTEM_PROMPT), "{prompt}");
        assert!(prompt.ends_with("\n\nDescribe it."), "{prompt}");
    }

    #[test]
    fn a_long_message_keeps_its_end() {
        assert_eq!(tail("  short  ", 10), "short");
        assert_eq!(tail("progress… then the error", 9), "…the error");
        assert_eq!(tail("ééééé", 2), "…éé");
    }

    /// A fake `codex` in `dir` that records its arguments, stdin, folder and
    /// the files it was given beside itself, writes `answer` (when there is
    /// one) to its `-o` file, prints `stderr` and exits with `code`.
    #[cfg(unix)]
    pub(crate) fn recording_codex(
        dir: &Path,
        answer: Option<&str>,
        stderr: &str,
        code: i32,
    ) -> PathBuf {
        let log = dir.join("log");
        fs::create_dir_all(&log).unwrap();
        fs::write(dir.join("stderr"), stderr).unwrap();
        let write_answer = match answer {
            Some(answer) => {
                fs::write(dir.join("answer"), answer).unwrap();
                format!("cat '{}' > \"$out\"\n", dir.join("answer").display())
            }
            None => String::new(),
        };
        let body = format!(
            "for arg in \"$@\"; do printf '%s\\n' \"$arg\"; done > '{log}/args'\n\
             cat > '{log}/stdin'\n\
             pwd > '{log}/cwd'\n\
             ls -A > '{log}/files'\n\
             prev=''\n\
             out=''\n\
             for arg in \"$@\"; do\n\
               [ \"$prev\" = '-o' ] && out=\"$arg\"\n\
               [ \"$prev\" = '-i' ] && cp \"$arg\" '{log}/image'\n\
               [ \"$prev\" = '--output-schema' ] && cp \"$arg\" '{log}/schema'\n\
               prev=\"$arg\"\n\
             done\n\
             {write_answer}\
             cat '{stderr}' >&2\n\
             exit {code}",
            log = log.display(),
            stderr = dir.join("stderr").display(),
        );
        let path = dir.join("bin").join(CODEX);
        executable(&path, &body);
        path
    }

    #[cfg(unix)]
    #[test]
    fn codex_gets_the_image_and_schema_in_an_empty_folder() {
        let dir = TempDir::new().unwrap();
        let codex = recording_codex(dir.path(), Some("{\"ok\": true}\n"), "", 0);
        let schema = json!({ "type": "object", "required": ["ok"] });

        let reply = codex_reply(
            &codex,
            None,
            "Describe it.",
            b"png bytes",
            &schema,
            Duration::from_secs(10),
        )
        .unwrap();

        assert_eq!(reply, "{\"ok\": true}");
        let log = dir.path().join("log");
        let args = fs::read_to_string(log.join("args")).unwrap();
        assert!(args.starts_with("exec\n-i\n"), "{args}");
        assert!(args.contains("Describe it."), "{args}");
        assert_eq!(fs::read(log.join("image")).unwrap(), b"png bytes");
        let sent: Value =
            serde_json::from_str(&fs::read_to_string(log.join("schema")).unwrap()).unwrap();
        assert_eq!(sent, schema);
        // Stdin is closed, so it has nothing to read.
        assert_eq!(fs::read_to_string(log.join("stdin")).unwrap(), "");
        // Its own folder, holding only what it was given, gone afterwards.
        let cwd = PathBuf::from(fs::read_to_string(log.join("cwd")).unwrap().trim());
        assert_ne!(cwd, env::current_dir().unwrap());
        assert_eq!(
            fs::read_to_string(log.join("files")).unwrap(),
            "capture.png\nschema.json\n"
        );
        assert!(!cwd.exists(), "{}", cwd.display());
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_codex_stops_with_the_end_of_its_message() {
        let dir = TempDir::new().unwrap();
        let progress = "OpenAI Codex v0.50\n--------\n".repeat(40);
        let codex = recording_codex(
            dir.path(),
            None,
            &format!("{progress}ERROR: You are not logged in. Run `codex login`."),
            1,
        );
        let err =
            codex_reply(&codex, None, "x", b"x", &json!({}), Duration::from_secs(10)).unwrap_err();
        let AiError::Endpoint(message) = err else {
            panic!("{err:?}");
        };
        assert!(message.starts_with("Codex failed: …"), "{message}");
        assert!(message.ends_with("Run `codex login`."), "{message}");
    }

    #[cfg(unix)]
    #[test]
    fn a_codex_that_writes_no_answer_fails_only_the_capture() {
        let dir = TempDir::new().unwrap();
        let codex = recording_codex(dir.path(), None, "", 0);
        assert!(matches!(
            codex_reply(&codex, None, "x", b"x", &json!({}), Duration::from_secs(10)),
            Err(AiError::Response(message)) if message.starts_with("Codex sent no answer")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_stalled_codex_is_killed_after_the_timeout() {
        let dir = TempDir::new().unwrap();
        let codex = dir.path().join("bin").join(CODEX);
        executable(&codex, "exec sleep 30");
        let started = Instant::now();
        let err = codex_reply(
            &codex,
            None,
            "x",
            b"x",
            &json!({}),
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(
            matches!(&err, AiError::Endpoint(message) if message.starts_with("Codex gave no answer")),
            "{err:?}"
        );
    }

    #[test]
    fn a_missing_program_cannot_start() {
        let dir = TempDir::new().unwrap();
        let err = claude_reply(
            &dir.path().join("claude"),
            "haiku",
            "x",
            "x",
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(
            matches!(&err, AiError::Endpoint(message) if message.contains("could not start Claude Code")),
            "{err:?}"
        );
    }
}
