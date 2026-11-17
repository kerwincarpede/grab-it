//! Command-line arguments.
//!
//! `--open <target>` opens a window directly at startup. It lets the app be
//! driven without a tray host, for example under `xvfb-run` for screenshots.
//!
//! The subcommands (`grab-it displays`, `windows`, `shot`, `record`,
//! `stop`, `gif` and `frames`) are the command
//! line agents and scripts use: they ask the running Grab-it over the
//! control connection (see `control.rs`), starting it in the tray first
//! when it is not running, and print one JSON line with the result.

use std::{
    fmt,
    io::Write,
    path::PathBuf,
    time::{Duration, Instant},
};

use crate::{
    control::{self, FramesRequest, GifRequest, RecordRequest, Request, ShotRequest, ShotTarget},
    settings::{RECORDING_FPS, RecordingFormat},
};

/// A window that `--open` can show at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenTarget {
    Settings,
    /// Starts a region capture, showing the overlay.
    Region,
    /// Opens the overlay with its toolbar of every capture mode.
    AllInOne,
    /// Opens a capture in the annotation editor: `--open editor <file>`.
    Editor(PathBuf),
    /// The Library window.
    Library,
    /// The Welcome window: what Grab-it does and its hotkeys.
    Welcome,
    /// Starts a text capture: drag over text to copy it.
    Text,
    /// Starts the colour picker.
    Colour,
    /// Captures the last dragged region again.
    Repeat,
    /// Starts a recording, or stops the one under way.
    Record,
    /// Shows a capture on the Quick Access card: `--open quick <file>`.
    Quick(PathBuf),
    /// Pins an image above other windows: `--open pin <file>`.
    Pin(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgsError {
    MissingTarget,
    UnknownTarget(String),
    /// `--open editor`, `quick` or `pin` without the file to open.
    MissingFile(String),
}

impl fmt::Display for ArgsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingTarget => {
                write!(f, "--open needs a target, for example `--open settings`")
            }
            Self::UnknownTarget(name) => {
                write!(
                    f,
                    "unknown --open target `{name}`; expected `settings`, `library`, `welcome`, `region`, `all-in-one`, `repeat`, `record`, `text`, `colour`, `editor <file>`, `quick <file>` or `pin <file>`"
                )
            }
            Self::MissingFile(target) => {
                write!(
                    f,
                    "--open {target} needs a capture, for example `--open {target} shot.png`"
                )
            }
        }
    }
}

impl std::error::Error for ArgsError {}

/// Finds the `--open` target in the process arguments.
///
/// The first item is the program name and is skipped. Other arguments are
/// ignored, since platforms may add their own (macOS adds `-psn_…`).
pub fn parse_open_target<I, S>(args: I) -> Result<Option<OpenTarget>, ArgsError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut args = args.into_iter().skip(1);
    while let Some(arg) = args.next() {
        let arg = arg.as_ref();
        let name = if arg == "--open" {
            match args.next() {
                Some(value) => value.as_ref().to_owned(),
                None => return Err(ArgsError::MissingTarget),
            }
        } else if let Some(value) = arg.strip_prefix("--open=") {
            value.to_owned()
        } else {
            continue;
        };
        if name.is_empty() {
            return Err(ArgsError::MissingTarget);
        }
        return match name.as_str() {
            "settings" => Ok(Some(OpenTarget::Settings)),
            "region" => Ok(Some(OpenTarget::Region)),
            "all-in-one" => Ok(Some(OpenTarget::AllInOne)),
            "library" => Ok(Some(OpenTarget::Library)),
            "welcome" => Ok(Some(OpenTarget::Welcome)),
            "text" => Ok(Some(OpenTarget::Text)),
            "colour" | "color" => Ok(Some(OpenTarget::Colour)),
            "repeat" => Ok(Some(OpenTarget::Repeat)),
            "record" => Ok(Some(OpenTarget::Record)),
            "editor" | "quick" | "pin" => match args.next() {
                Some(file) if !file.as_ref().is_empty() => {
                    let file = PathBuf::from(file.as_ref());
                    Ok(Some(match name.as_str() {
                        "editor" => OpenTarget::Editor(file),
                        "quick" => OpenTarget::Quick(file),
                        _ => OpenTarget::Pin(file),
                    }))
                }
                _ => Err(ArgsError::MissingFile(name)),
            },
            _ => Err(ArgsError::UnknownTarget(name)),
        };
    }
    Ok(None)
}

/// How long a command waits for a Grab-it it started to be ready.
const START_TIMEOUT: Duration = Duration::from_secs(15);
/// How often it tries to connect meanwhile.
const START_POLL: Duration = Duration::from_millis(200);

/// What `grab-it help` prints.
pub const USAGE: &str = "\
Usage: grab-it <command> [options]

Ask the running Grab-it to capture the screen. Each command prints one line
of JSON; errors go to stderr with a non-zero exit. Turn on Settings › AI
agents › Let AI agents use Grab-it first. Grab-it starts in the tray when
it is not running.

Commands:
  displays                 List the displays: id, name, x, y, width, height
  windows                  List the windows, front to back: id, app, title
                           and rectangle
  shot [target] [options]  Take a screenshot and add it to the Library,
                           tagged agent; prints its path, width and height
  record [target] [options]
                           Record an MP4 or GIF into the Library, tagged
                           agent; prints its path at once, or with --for
                           its path and durationMs once it is saved
  stop                     End the recording under way; prints its path
                           and durationMs once it is saved
  gif <video> [options]    Make an animated GIF of a video; prints its path,
                           width, height and durationMs
  frames <video> [--count <n>]
                           Make one PNG contact sheet of n evenly spaced
                           frames (default 12, up to 100)

Targets for shot and record (one; the default is --screen):
  --screen                 Every display, stitched into one image (record:
                           the main display)
  --display <id|name>      One display, by id or text in its name
  --window <id|text>       One window, by id or text in its app or title
  --region <x,y,w,h>       A rectangle in desktop coordinates

Shot options:
  --delay <seconds>        Wait before capturing (up to 60)
  --max-width <pixels>     Scale the shot down to at most this width

Record options (no sound, webcam or countdown):
  --format <mp4|gif>       What to record as (default mp4; a GIF is at most
                           a minute long)
  --fps <30|60>            An MP4's frames a second (default 30)
  --cursor                 Draw the pointer in
  --for <seconds>          Stop after this long (up to an hour) and wait for
                           the file; without it, end with `grab-it stop`

Gif options:
  --start <seconds>        Where the GIF starts in the video
  --end <seconds>          Where it ends
  --fps <n>                Frames a second (default 10, up to 50)
  --width <pixels>         Its width (default the video's, up to 1280)

Other:
  --open <target>          Open a window at startup, such as settings
  help                     Show this help
";

/// A command-line subcommand.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Help,
    /// A request for the running app.
    Request(Request),
}

/// Parses a subcommand from the process arguments. `Ok(None)` when the
/// first argument is not one, so Grab-it starts as an app (with `--open`
/// or the arguments a platform adds).
pub fn parse_command<I, S>(args: I) -> Result<Option<Command>, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let args: Vec<String> = args
        .into_iter()
        .skip(1)
        .map(|arg| arg.as_ref().to_owned())
        .collect();
    let Some((name, rest)) = args.split_first() else {
        return Ok(None);
    };
    let command = match name.as_str() {
        "help" | "--help" | "-h" => Command::Help,
        "displays" | "windows" => {
            if let Some(extra) = rest.first() {
                return Err(format!(
                    "`{name}` takes no options, but was given `{extra}`"
                ));
            }
            Command::Request(if name == "displays" {
                Request::Displays
            } else {
                Request::Windows
            })
        }
        "shot" => Command::Request(Request::Shot(parse_shot(rest)?)),
        "record" => Command::Request(Request::Record(parse_record(rest)?)),
        "stop" => {
            if let Some(extra) = rest.first() {
                return Err(format!("`stop` takes no options, but was given `{extra}`"));
            }
            Command::Request(Request::Stop)
        }
        "gif" => Command::Request(Request::Gif(parse_gif(rest)?)),
        "frames" => Command::Request(Request::Frames(parse_frames(rest)?)),
        _ => return Ok(None),
    };
    Ok(Some(command))
}

/// The options that take a value.
const VALUE_OPTIONS: [&str; 12] = [
    "--display",
    "--window",
    "--region",
    "--delay",
    "--max-width",
    "--format",
    "--fps",
    "--for",
    "--start",
    "--end",
    "--width",
    "--count",
];

/// Splits `--name=value` and `--name value` into the name and its value.
fn option_value<'a>(
    arg: &'a str,
    rest: &mut impl Iterator<Item = &'a String>,
) -> (&'a str, Option<&'a str>) {
    let (name, inline) = match arg.split_once('=') {
        Some((name, value)) if name.starts_with("--") => (name, Some(value)),
        _ => (arg, None),
    };
    if inline.is_none() && VALUE_OPTIONS.contains(&name) {
        return (name, rest.next().map(String::as_str));
    }
    (name, inline)
}

/// The value an option was given, trimmed; an error when it has none.
fn needs(name: &str, value: Option<&str>) -> Result<String, String> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(str::trim)
        .map(str::to_owned)
        .ok_or_else(|| format!("{name} needs a value; see `grab-it help`"))
}

/// The target `name` chooses, for shot and record; None when `name` is
/// not a target option.
fn target_option(name: &str, value: Option<&str>) -> Option<Result<ShotTarget, String>> {
    Some(match name {
        "--screen" if value.is_some() => Err("--screen takes no value".into()),
        "--screen" => Ok(ShotTarget::Screen),
        "--display" => needs(name, value).map(|display| ShotTarget::Display { display }),
        "--window" => needs(name, value).map(|window| ShotTarget::Window { window }),
        "--region" => needs(name, value).and_then(|text| parse_region(&text)),
        _ => return None,
    })
}

/// Keeps `chosen` as the one target; an error when there already is one.
fn choose_target(
    target: &mut Option<ShotTarget>,
    chosen: ShotTarget,
    command: &str,
) -> Result<(), String> {
    if target.is_some() {
        return Err(format!(
            "{command} takes one of --screen, --display, --window and --region"
        ));
    }
    *target = Some(chosen);
    Ok(())
}

fn parse_shot(args: &[String]) -> Result<ShotRequest, String> {
    let mut target: Option<ShotTarget> = None;
    let mut delay_ms = 0;
    let mut max_width = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let (name, value) = option_value(arg, &mut rest);
        if let Some(chosen) = target_option(name, value) {
            choose_target(&mut target, chosen?, "shot")?;
            continue;
        }
        let needs = |value: Option<&str>| needs(name, value);
        match name {
            "--delay" => {
                delay_ms = parse_delay(&needs(value)?)?;
            }
            "--max-width" => {
                let text = needs(value)?;
                max_width = Some(
                    text.parse::<u32>()
                        .ok()
                        .filter(|width| *width > 0)
                        .ok_or_else(|| {
                            format!("--max-width needs a width in pixels, not `{text}`")
                        })?,
                );
            }
            _ => return Err(format!("unknown shot option `{arg}`; see `grab-it help`")),
        }
    }
    Ok(ShotRequest {
        target: target.unwrap_or(ShotTarget::Screen),
        delay_ms,
        max_width,
    })
}

/// `x,y,w,h` in desktop coordinates.
fn parse_region(text: &str) -> Result<ShotTarget, String> {
    let wrong = || format!("--region needs x,y,width,height, such as 0,0,800,600, not `{text}`");
    let parts: Vec<&str> = text.split(',').map(str::trim).collect();
    let [x, y, width, height] = parts.as_slice() else {
        return Err(wrong());
    };
    let x = x.parse::<i32>().map_err(|_| wrong())?;
    let y = y.parse::<i32>().map_err(|_| wrong())?;
    let width = width.parse::<u32>().map_err(|_| wrong())?;
    let height = height.parse::<u32>().map_err(|_| wrong())?;
    if width == 0 || height == 0 {
        return Err(wrong());
    }
    Ok(ShotTarget::Region {
        x,
        y,
        width,
        height,
    })
}

/// Seconds, whole or not, as milliseconds, for the option `name`.
fn parse_seconds(name: &str, text: &str) -> Result<u64, String> {
    let seconds = text
        .trim_end_matches('s')
        .parse::<f64>()
        .ok()
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .ok_or_else(|| format!("{name} needs a number of seconds, not `{text}`"))?;
    Ok((seconds * 1000.0).round() as u64)
}

/// A whole number from `low` to `high`, for the option `name`.
fn parse_number(name: &str, text: &str, low: u32, high: u32) -> Result<u32, String> {
    text.parse::<u32>()
        .ok()
        .filter(|number| (low..=high).contains(number))
        .ok_or_else(|| format!("{name} needs a whole number from {low} to {high}, not `{text}`"))
}

fn parse_record(args: &[String]) -> Result<RecordRequest, String> {
    let mut target: Option<ShotTarget> = None;
    let mut format = RecordingFormat::Mp4;
    let mut fps = RECORDING_FPS[0];
    let mut cursor = false;
    let mut for_ms = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let (name, value) = option_value(arg, &mut rest);
        if let Some(chosen) = target_option(name, value) {
            choose_target(&mut target, chosen?, "record")?;
            continue;
        }
        match name {
            "--format" => {
                let text = needs(name, value)?;
                format = match text.to_ascii_lowercase().as_str() {
                    "mp4" => RecordingFormat::Mp4,
                    "gif" => RecordingFormat::Gif,
                    _ => return Err(format!("--format is mp4 or gif, not `{text}`")),
                };
            }
            "--fps" => {
                let text = needs(name, value)?;
                fps = text
                    .parse::<u32>()
                    .ok()
                    .filter(|fps| RECORDING_FPS.contains(fps))
                    .ok_or_else(|| format!("--fps is 30 or 60, not `{text}`"))?;
            }
            "--cursor" => {
                if value.is_some() {
                    return Err("--cursor takes no value".into());
                }
                cursor = true;
            }
            "--for" => {
                let ms = parse_seconds(name, &needs(name, value)?)?;
                if ms == 0 || ms > crate::agent::MAX_RECORD_MS {
                    return Err("--for needs a number of seconds above 0, up to an hour".into());
                }
                for_ms = Some(ms);
            }
            _ => return Err(format!("unknown record option `{arg}`; see `grab-it help`")),
        }
    }
    Ok(RecordRequest {
        target: target.unwrap_or(ShotTarget::Screen),
        format,
        fps,
        cursor,
        for_ms,
    })
}

/// The video a command names, and its options; an error when it names
/// none or more than one.
fn video_and_options<'a>(
    command: &str,
    args: &'a [String],
) -> Result<(PathBuf, Vec<(&'a str, Option<&'a str>, &'a String)>), String> {
    let mut video = None;
    let mut options = Vec::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if !arg.starts_with("--") {
            if video.is_some() {
                return Err(format!(
                    "{command} takes one video, but was also given `{arg}`"
                ));
            }
            video = Some(PathBuf::from(arg));
            continue;
        }
        let (name, value) = option_value(arg, &mut rest);
        options.push((name, value, arg));
    }
    let video = video
        .filter(|video| !video.as_os_str().is_empty())
        .ok_or_else(|| {
            format!("{command} needs a video, for example `grab-it {command} demo.mp4`")
        })?;
    Ok((video, options))
}

fn parse_gif(args: &[String]) -> Result<GifRequest, String> {
    let (video, options) = video_and_options("gif", args)?;
    let mut request = GifRequest {
        video,
        start_ms: None,
        end_ms: None,
        fps: crate::agent::GIF_FPS,
        width: None,
    };
    for (name, value, arg) in options {
        let text = || needs(name, value);
        match name {
            "--start" => request.start_ms = Some(parse_seconds(name, &text()?)?),
            "--end" => request.end_ms = Some(parse_seconds(name, &text()?)?),
            "--fps" => request.fps = parse_number(name, &text()?, 1, crate::agent::MAX_GIF_FPS)?,
            "--width" => request.width = Some(parse_number(name, &text()?, 16, 7680)?),
            _ => return Err(format!("unknown gif option `{arg}`; see `grab-it help`")),
        }
    }
    if let (Some(start), Some(end)) = (request.start_ms, request.end_ms)
        && end <= start
    {
        return Err("--end needs to be after --start".into());
    }
    if request.end_ms == Some(0) {
        return Err("--end needs to be after the video's start".into());
    }
    Ok(request)
}

fn parse_frames(args: &[String]) -> Result<FramesRequest, String> {
    let (video, options) = video_and_options("frames", args)?;
    let mut count = crate::agent::FRAMES_COUNT;
    for (name, value, arg) in options {
        match name {
            "--count" => {
                count = parse_number(name, &needs(name, value)?, 1, crate::agent::MAX_FRAMES)?
            }
            _ => return Err(format!("unknown frames option `{arg}`; see `grab-it help`")),
        }
    }
    Ok(FramesRequest { video, count })
}

/// Makes the video a request names absolute, from the folder the command
/// was run in, since the app runs in a folder of its own.
fn absolute_video(request: Request) -> Result<Request, String> {
    let absolute = |video: PathBuf| {
        std::path::absolute(&video)
            .map_err(|err| format!("could not find {}: {err}", video.display()))
    };
    Ok(match request {
        Request::Gif(gif) => Request::Gif(GifRequest {
            video: absolute(gif.video.clone())?,
            ..gif
        }),
        Request::Frames(frames) => Request::Frames(FramesRequest {
            video: absolute(frames.video.clone())?,
            ..frames
        }),
        other => other,
    })
}

/// Seconds, whole or not, up to [`crate::agent::MAX_DELAY_MS`].
fn parse_delay(text: &str) -> Result<u64, String> {
    let ms = parse_seconds("--delay", text)?;
    if ms > crate::agent::MAX_DELAY_MS {
        return Err(format!(
            "--delay is at most {} seconds",
            crate::agent::MAX_DELAY_MS / 1000
        ));
    }
    Ok(ms)
}

/// Runs a subcommand when the arguments hold one, returning the exit code;
/// None when Grab-it should start as an app. Called before anything else,
/// so the single-instance plugin never sees a subcommand.
pub fn run_command<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let parsed = parse_command(args);
    if matches!(parsed, Ok(None)) {
        return None;
    }
    attach_console();
    let code = match parsed {
        Ok(Some(Command::Help)) => {
            print!("{USAGE}");
            0
        }
        Ok(Some(Command::Request(request))) => {
            match absolute_video(request).and_then(|request| ask(&request)) {
                Ok(result) => {
                    let mut out = std::io::stdout().lock();
                    let _ = writeln!(out, "{result}");
                    let _ = out.flush();
                    0
                }
                Err(message) => {
                    eprintln!("grab-it: {message}");
                    1
                }
            }
        }
        Err(message) => {
            eprintln!("grab-it: {message}");
            2
        }
        Ok(None) => unreachable!("handled above"),
    };
    Some(code)
}

/// Sends `request` to the running Grab-it, starting it in the tray first
/// when it is not running, and returns the result.
fn ask(request: &Request) -> Result<serde_json::Value, String> {
    let stream = match control::connect() {
        Ok(stream) => stream,
        Err(_) => start_and_connect()?,
    };
    control::send(stream, request)
        .map_err(|err| format!("could not talk to Grab-it: {err}"))?
        .into_result()
}

/// Starts Grab-it with no arguments, so it waits in the tray, and connects
/// once it is listening.
fn start_and_connect() -> Result<interprocess::local_socket::Stream, String> {
    // In an AppImage, the AppImage itself: a program started from this
    // process's own mount would quit when the mount goes with it.
    let exe = control::executable()
        .map_err(|err| format!("could not find Grab-it to start it: {err}"))?;
    std::process::Command::new(&exe)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|err| format!("could not start Grab-it: {err}"))?;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        std::thread::sleep(START_POLL);
        match control::connect() {
            Ok(stream) => return Ok(stream),
            Err(_) if Instant::now() < deadline => continue,
            Err(err) => {
                return Err(format!(
                    "Grab-it did not start within {} seconds: {err}",
                    START_TIMEOUT.as_secs()
                ));
            }
        }
    }
}

/// Windows release builds are GUI programs, with no console: attaches to
/// the terminal Grab-it was run from, so what it prints reaches it. Output
/// already going to a pipe or file (as an agent reads it) is left alone.
#[cfg(windows)]
fn attach_console() {
    use windows::Win32::System::Console::{
        ATTACH_PARENT_PROCESS, AttachConsole, GetStdHandle, STD_OUTPUT_HANDLE,
    };
    // SAFETY: both only look up or attach the process's console.
    unsafe {
        let has_output = GetStdHandle(STD_OUTPUT_HANDLE)
            .map(|handle| !handle.is_invalid())
            .unwrap_or(false);
        if !has_output {
            let _ = AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

#[cfg(not(windows))]
fn attach_console() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Option<OpenTarget>, ArgsError> {
        parse_open_target(std::iter::once("grab-it").chain(args.iter().copied()))
    }

    #[test]
    fn no_arguments_opens_nothing() {
        assert_eq!(parse(&[]), Ok(None));
    }

    #[test]
    fn open_settings_as_two_arguments() {
        assert_eq!(
            parse(&["--open", "settings"]),
            Ok(Some(OpenTarget::Settings))
        );
    }

    #[test]
    fn open_settings_with_equals() {
        assert_eq!(parse(&["--open=settings"]), Ok(Some(OpenTarget::Settings)));
    }

    #[test]
    fn open_region() {
        assert_eq!(parse(&["--open", "region"]), Ok(Some(OpenTarget::Region)));
        assert_eq!(parse(&["--open=region"]), Ok(Some(OpenTarget::Region)));
    }

    #[test]
    fn open_all_in_one() {
        assert_eq!(
            parse(&["--open", "all-in-one"]),
            Ok(Some(OpenTarget::AllInOne))
        );
        assert_eq!(
            parse(&["--open=all-in-one"]),
            Ok(Some(OpenTarget::AllInOne))
        );
    }

    #[test]
    fn open_library() {
        assert_eq!(parse(&["--open", "library"]), Ok(Some(OpenTarget::Library)));
        assert_eq!(parse(&["--open=library"]), Ok(Some(OpenTarget::Library)));
        assert_eq!(parse(&["--open", "welcome"]), Ok(Some(OpenTarget::Welcome)));
    }

    #[test]
    fn open_editor_with_a_file() {
        assert_eq!(
            parse(&["--open", "editor", "/tmp/shot.png"]),
            Ok(Some(OpenTarget::Editor(PathBuf::from("/tmp/shot.png"))))
        );
        assert_eq!(
            parse(&["--open=editor", "shot.png"]),
            Ok(Some(OpenTarget::Editor(PathBuf::from("shot.png"))))
        );
    }

    #[test]
    fn open_editor_without_a_file_is_an_error() {
        assert_eq!(
            parse(&["--open", "editor"]),
            Err(ArgsError::MissingFile("editor".into()))
        );
        assert_eq!(
            parse(&["--open", "editor", ""]),
            Err(ArgsError::MissingFile("editor".into()))
        );
        assert_eq!(
            parse(&["--open", "pin"]),
            Err(ArgsError::MissingFile("pin".into()))
        );
    }

    #[test]
    fn open_text_and_colour() {
        assert_eq!(parse(&["--open", "text"]), Ok(Some(OpenTarget::Text)));
        assert_eq!(parse(&["--open", "colour"]), Ok(Some(OpenTarget::Colour)));
        assert_eq!(parse(&["--open=color"]), Ok(Some(OpenTarget::Colour)));
        assert_eq!(parse(&["--open", "repeat"]), Ok(Some(OpenTarget::Repeat)));
        assert_eq!(parse(&["--open", "record"]), Ok(Some(OpenTarget::Record)));
    }

    #[test]
    fn open_quick_and_pin_with_a_file() {
        assert_eq!(
            parse(&["--open", "quick", "/tmp/shot.png"]),
            Ok(Some(OpenTarget::Quick(PathBuf::from("/tmp/shot.png"))))
        );
        assert_eq!(
            parse(&["--open=pin", "shot.png"]),
            Ok(Some(OpenTarget::Pin(PathBuf::from("shot.png"))))
        );
    }

    #[test]
    fn unrelated_arguments_are_ignored() {
        assert_eq!(
            parse(&["-psn_0_12345", "--open", "settings"]),
            Ok(Some(OpenTarget::Settings))
        );
        assert_eq!(parse(&["--verbose"]), Ok(None));
    }

    #[test]
    fn program_name_is_not_parsed() {
        assert_eq!(parse_open_target(["--open"]), Ok(None));
    }

    #[test]
    fn missing_target_is_an_error() {
        assert_eq!(parse(&["--open"]), Err(ArgsError::MissingTarget));
        assert_eq!(parse(&["--open="]), Err(ArgsError::MissingTarget));
    }

    #[test]
    fn unknown_target_is_an_error() {
        assert_eq!(
            parse(&["--open", "nope"]),
            Err(ArgsError::UnknownTarget("nope".into()))
        );
    }

    fn command(args: &[&str]) -> Result<Option<Command>, String> {
        parse_command(std::iter::once("grab-it").chain(args.iter().copied()))
    }

    fn shot(args: &[&str]) -> Result<ShotRequest, String> {
        let mut all = vec!["shot"];
        all.extend_from_slice(args);
        match command(&all)? {
            Some(Command::Request(Request::Shot(shot))) => Ok(shot),
            other => panic!("not a shot: {other:?}"),
        }
    }

    #[test]
    fn the_app_starts_without_a_subcommand() {
        assert_eq!(command(&[]), Ok(None));
        assert_eq!(command(&["--open", "settings"]), Ok(None));
        assert_eq!(command(&["-psn_0_12345"]), Ok(None));
        // A subcommand name later on is not one.
        assert_eq!(command(&["--open", "library", "shot"]), Ok(None));
    }

    #[test]
    fn displays_windows_and_help() {
        assert_eq!(
            command(&["displays"]),
            Ok(Some(Command::Request(Request::Displays)))
        );
        assert_eq!(
            command(&["windows"]),
            Ok(Some(Command::Request(Request::Windows)))
        );
        assert_eq!(command(&["help"]), Ok(Some(Command::Help)));
        assert_eq!(command(&["--help"]), Ok(Some(Command::Help)));
        assert!(
            command(&["windows", "--all"])
                .unwrap_err()
                .contains("--all")
        );
    }

    #[test]
    fn a_shot_is_of_the_screen_by_default() {
        assert_eq!(
            shot(&[]),
            Ok(ShotRequest {
                target: ShotTarget::Screen,
                delay_ms: 0,
                max_width: None,
            })
        );
        assert_eq!(shot(&["--screen"]).unwrap().target, ShotTarget::Screen);
    }

    #[test]
    fn shot_targets() {
        assert_eq!(
            shot(&["--display", "1"]).unwrap().target,
            ShotTarget::Display {
                display: "1".into()
            }
        );
        assert_eq!(
            shot(&["--window=Firefox"]).unwrap().target,
            ShotTarget::Window {
                window: "Firefox".into()
            }
        );
        assert_eq!(
            shot(&["--window", "Visual Studio Code"]).unwrap().target,
            ShotTarget::Window {
                window: "Visual Studio Code".into()
            }
        );
        assert_eq!(
            shot(&["--region", "-1920, 0, 800, 600"]).unwrap().target,
            ShotTarget::Region {
                x: -1920,
                y: 0,
                width: 800,
                height: 600
            }
        );
    }

    #[test]
    fn shot_takes_one_target() {
        assert!(
            shot(&["--screen", "--window", "1"])
                .unwrap_err()
                .contains("one of")
        );
    }

    #[test]
    fn delay_and_max_width() {
        let request = shot(&["--window", "7", "--delay", "1.5", "--max-width=1280"]).unwrap();
        assert_eq!(request.delay_ms, 1500);
        assert_eq!(request.max_width, Some(1280));
        assert_eq!(shot(&["--delay", "2s"]).unwrap().delay_ms, 2000);
        assert!(shot(&["--delay", "61"]).unwrap_err().contains("at most 60"));
        assert!(shot(&["--delay", "-1"]).is_err());
        assert!(shot(&["--max-width", "0"]).is_err());
        assert!(shot(&["--max-width", "wide"]).is_err());
    }

    #[test]
    fn bad_shot_arguments_are_errors() {
        assert!(shot(&["--window"]).unwrap_err().contains("needs a value"));
        assert!(
            shot(&["--region", "1,2,3"])
                .unwrap_err()
                .contains("x,y,width,height")
        );
        assert!(shot(&["--region", "0,0,0,10"]).is_err());
        assert!(shot(&["--region", "a,b,c,d"]).is_err());
        assert!(
            shot(&["--annotate"])
                .unwrap_err()
                .contains("unknown shot option")
        );
        assert!(shot(&["--screen=yes"]).is_err());
    }

    fn request(args: &[&str]) -> Result<Request, String> {
        match command(args)? {
            Some(Command::Request(request)) => Ok(request),
            other => panic!("not a request: {other:?}"),
        }
    }

    fn record(args: &[&str]) -> Result<RecordRequest, String> {
        let mut all = vec!["record"];
        all.extend_from_slice(args);
        match request(&all)? {
            Request::Record(record) => Ok(record),
            other => panic!("not a recording: {other:?}"),
        }
    }

    #[test]
    fn a_recording_is_an_mp4_of_the_screen_by_default() {
        assert_eq!(
            record(&[]),
            Ok(RecordRequest {
                target: ShotTarget::Screen,
                format: RecordingFormat::Mp4,
                fps: 30,
                cursor: false,
                for_ms: None,
            })
        );
    }

    #[test]
    fn record_takes_the_shot_targets_and_its_own_options() {
        assert_eq!(
            record(&[
                "--window",
                "Firefox",
                "--format=gif",
                "--fps",
                "60",
                "--cursor",
                "--for",
                "5"
            ]),
            Ok(RecordRequest {
                target: ShotTarget::Window {
                    window: "Firefox".into()
                },
                format: RecordingFormat::Gif,
                fps: 60,
                cursor: true,
                for_ms: Some(5000),
            })
        );
        assert_eq!(
            record(&["--region", "0,0,640,480", "--for=2.5s"]).unwrap(),
            RecordRequest {
                target: ShotTarget::Region {
                    x: 0,
                    y: 0,
                    width: 640,
                    height: 480
                },
                format: RecordingFormat::Mp4,
                fps: 30,
                cursor: false,
                for_ms: Some(2500),
            }
        );
    }

    #[test]
    fn bad_record_arguments_are_errors() {
        assert!(
            record(&["--format", "webm"])
                .unwrap_err()
                .contains("mp4 or gif")
        );
        assert!(record(&["--fps", "24"]).unwrap_err().contains("30 or 60"));
        assert!(record(&["--for", "0"]).is_err());
        assert!(record(&["--for", "3601"]).unwrap_err().contains("an hour"));
        assert!(record(&["--cursor=yes"]).is_err());
        assert!(
            record(&["--screen", "--display", "1"])
                .unwrap_err()
                .contains("record takes one of")
        );
        assert!(
            record(&["--delay", "1"])
                .unwrap_err()
                .contains("unknown record option")
        );
    }

    #[test]
    fn stop_takes_no_options() {
        assert_eq!(request(&["stop"]), Ok(Request::Stop));
        assert!(command(&["stop", "--now"]).unwrap_err().contains("--now"));
    }

    #[test]
    fn gif_takes_a_video_and_its_trim_rate_and_width() {
        assert_eq!(
            request(&[
                "gif", "demo.mp4", "--start", "1.5", "--end=4", "--fps", "15", "--width", "800"
            ]),
            Ok(Request::Gif(GifRequest {
                video: PathBuf::from("demo.mp4"),
                start_ms: Some(1500),
                end_ms: Some(4000),
                fps: 15,
                width: Some(800),
            }))
        );
        // The video may come after the options.
        assert_eq!(
            request(&["gif", "--fps", "12", "/v/a.mp4"]),
            Ok(Request::Gif(GifRequest {
                video: PathBuf::from("/v/a.mp4"),
                start_ms: None,
                end_ms: None,
                fps: 12,
                width: None,
            }))
        );
    }

    #[test]
    fn bad_gif_arguments_are_errors() {
        assert!(request(&["gif"]).unwrap_err().contains("needs a video"));
        assert!(
            request(&["gif", "a.mp4", "b.mp4"])
                .unwrap_err()
                .contains("one video")
        );
        assert!(
            request(&["gif", "a.mp4", "--start", "4", "--end", "2"])
                .unwrap_err()
                .contains("after --start")
        );
        assert!(request(&["gif", "a.mp4", "--fps", "0"]).is_err());
        assert!(request(&["gif", "a.mp4", "--fps", "51"]).is_err());
        assert!(request(&["gif", "a.mp4", "--width", "wide"]).is_err());
        assert!(
            request(&["gif", "a.mp4", "--loop"])
                .unwrap_err()
                .contains("unknown gif option")
        );
    }

    #[test]
    fn frames_takes_a_video_and_a_count() {
        assert_eq!(
            request(&["frames", "a.mp4"]),
            Ok(Request::Frames(FramesRequest {
                video: PathBuf::from("a.mp4"),
                count: 12,
            }))
        );
        assert_eq!(
            request(&["frames", "a.mp4", "--count=9"]),
            Ok(Request::Frames(FramesRequest {
                video: PathBuf::from("a.mp4"),
                count: 9,
            }))
        );
        assert!(request(&["frames", "a.mp4", "--count", "0"]).is_err());
        assert!(request(&["frames", "a.mp4", "--count", "101"]).is_err());
        assert!(request(&["frames"]).unwrap_err().contains("needs a video"));
    }

    #[test]
    fn videos_are_sent_as_absolute_paths() {
        let Request::Gif(gif) = absolute_video(request(&["gif", "demo.mp4"]).unwrap()).unwrap()
        else {
            panic!("not a gif");
        };
        assert!(gif.video.is_absolute());
        assert!(gif.video.ends_with("demo.mp4"));
        assert_eq!(absolute_video(Request::Stop), Ok(Request::Stop));
    }

    #[test]
    fn the_usage_lists_every_command() {
        for word in [
            "displays",
            "windows",
            "shot",
            "record",
            "stop",
            "gif",
            "frames",
            "--format",
            "--fps",
            "--cursor",
            "--for",
            "--start",
            "--end",
            "--width",
            "--count",
            "--display",
            "--window",
            "--region",
            "--delay",
            "--max-width",
        ] {
            assert!(USAGE.contains(word), "{word}");
        }
    }
}
