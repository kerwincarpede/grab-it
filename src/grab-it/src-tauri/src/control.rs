//! The control connection: how the `grab-it` command line (see `cli.rs`)
//! talks to the running app.
//!
//! The running app listens on a local socket: a Unix socket in its data
//! folder on Linux and macOS, readable and writable by the user alone, and
//! a named pipe on Windows that admits only the user who started Grab-it.
//! Each connection carries one request, a line of JSON, and gets one reply,
//! another line of JSON, back. Requests are refused while agent access is
//! off in Settings.

use std::{
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
};

use interprocess::local_socket::{GenericFilePath, ListenerOptions, Name, Stream, prelude::*};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use crate::rt::AppHandle;
use crate::{
    commands::{SettingsState, lock},
    settings::RecordingFormat,
};

/// The app's identifier in tauri.conf.json, which names its data folder.
pub const IDENTIFIER: &str = "com.kerwincarpede.grabit";
/// The socket's file name in the data folder (Linux and macOS).
#[cfg(unix)]
const SOCKET_FILE: &str = "control.sock";
/// The longest request line read; real ones are a few hundred bytes.
const MAX_REQUEST: u64 = 64 * 1024;

/// What agent access being off answers every request with.
pub const ACCESS_OFF: &str = "Agent access is off. Turn on \"Let AI agents use Grab-it\" in Grab-it's Settings › AI integration, then try again.";

/// One request from the command line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "camelCase")]
pub enum Request {
    /// The monitors, with their ids and places.
    Displays,
    /// The windows a shot can capture, front to back.
    Windows,
    /// Takes a screenshot and adds it to the Library.
    Shot(ShotRequest),
    /// Starts recording, and with `forMs` waits for it to be saved.
    Record(RecordRequest),
    /// Ends the recording under way and waits for it to be saved.
    Stop,
    /// Makes an animated GIF of a video.
    Gif(GifRequest),
    /// Makes a contact sheet of a video's frames.
    Frames(FramesRequest),
}

/// What `grab-it record` records, and how.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRequest {
    /// As for a shot; the screen is the main display, since a recording is
    /// of one display.
    pub target: ShotTarget,
    pub format: RecordingFormat,
    /// An MP4's frames a second, 30 or 60.
    pub fps: u32,
    /// Whether the pointer is drawn in.
    #[serde(default)]
    pub cursor: bool,
    /// Stops after this many milliseconds and replies once it is saved;
    /// without it the reply comes as soon as recording starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub for_ms: Option<u64>,
}

/// What `grab-it gif` turns into a GIF.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifRequest {
    /// The video, as an absolute path.
    pub video: PathBuf,
    /// Where the GIF starts in the video, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
    /// Where it ends, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<u64>,
    pub fps: u32,
    /// Its width in pixels, keeping the video's shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
}

/// What `grab-it frames` makes a contact sheet of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramesRequest {
    /// The video, as an absolute path.
    pub video: PathBuf,
    /// How many evenly spaced frames the sheet shows.
    pub count: u32,
}

/// What `grab-it shot` captures, and how.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotRequest {
    pub target: ShotTarget,
    /// How long to wait before capturing, in milliseconds.
    #[serde(default)]
    pub delay_ms: u64,
    /// Scales the shot down to this width, keeping its shape, when wider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_width: Option<u32>,
}

/// The part of the screen a shot captures.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShotTarget {
    /// Every monitor, stitched into one image.
    Screen,
    /// One monitor: an id from `grab-it displays`, or text in its name.
    Display { display: String },
    /// One window: an id from `grab-it windows`, or text in its app's name
    /// or its title.
    Window { window: String },
    /// A rectangle in desktop coordinates, as `grab-it displays` gives them.
    Region {
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    },
}

/// The answer to one request: its result, or why it failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Reply {
    pub fn success(result: Value) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(message.into()),
        }
    }

    /// The result, or the error as an `Err`.
    pub fn into_result(self) -> Result<Value, String> {
        if self.ok {
            Ok(self.result.unwrap_or(Value::Null))
        } else {
            Err(self
                .error
                .unwrap_or_else(|| "Grab-it could not do that".into()))
        }
    }
}

/// Answers one request line: refused while agent access is off, else
/// what `run` makes of it.
pub fn respond(
    line: &str,
    access: bool,
    run: impl FnOnce(Request) -> Result<Value, String>,
) -> Reply {
    if !access {
        return Reply::failure(ACCESS_OFF);
    }
    let request = match serde_json::from_str::<Request>(line.trim()) {
        Ok(request) => request,
        Err(err) => {
            return Reply::failure(format!(
                "Grab-it did not understand the request ({err}); is the command line the same version as the app?"
            ));
        }
    };
    match run(request) {
        Ok(result) => Reply::success(result),
        Err(message) => Reply::failure(message),
    }
}

/// The folder Tauri gives the app's data, worked out without Tauri, so the
/// command line finds the socket the app made: the platform's data folder
/// with the identifier in it.
#[cfg_attr(windows, allow(dead_code))]
pub fn data_dir() -> Option<PathBuf> {
    data_dir_from(|name| std::env::var_os(name).map(PathBuf::from))
}

/// [`data_dir`], reading the environment through `env`.
pub fn data_dir_from(env: impl Fn(&str) -> Option<PathBuf>) -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        env("APPDATA")?
    } else if cfg!(target_os = "macos") {
        env("HOME")?.join("Library").join("Application Support")
    } else {
        match env("XDG_DATA_HOME").filter(|dir| dir.is_absolute()) {
            Some(dir) => dir,
            None => env("HOME")?.join(".local").join("share"),
        }
    };
    if !base.is_absolute() {
        return None;
    }
    Some(base.join(IDENTIFIER))
}

/// Grab-it's own program, as agents and a fresh launch should run it. In
/// an AppImage that is the AppImage itself (`$APPIMAGE`): the running
/// program sits in a temporary mount that changes on every launch and goes
/// away with the process that made it. AppImages exist only on Linux, so
/// elsewhere it is always the running program.
pub fn executable() -> io::Result<PathBuf> {
    let current = std::env::current_exe()?;
    #[cfg(target_os = "linux")]
    let current = executable_from(std::env::var_os("APPIMAGE").map(PathBuf::from), current);
    Ok(current)
}

/// [`executable`], given `$APPIMAGE` and the running program.
#[cfg(target_os = "linux")]
pub fn executable_from(appimage: Option<PathBuf>, current: PathBuf) -> PathBuf {
    match appimage {
        Some(appimage) if appimage.is_absolute() => appimage,
        _ => current,
    }
}

/// Where the socket is: a file in the data folder on Linux and macOS.
#[cfg(unix)]
pub fn socket_path() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join(SOCKET_FILE))
}

/// Where the socket is: a named pipe with the user's name in it on Windows,
/// so two people signed in at once each reach their own Grab-it.
#[cfg(windows)]
pub fn socket_path() -> Option<PathBuf> {
    let user = std::env::var("USERNAME").unwrap_or_default();
    Some(PathBuf::from(pipe_name(&user)))
}

/// The named pipe for `user`, with anything but letters, digits, dots and
/// dashes left out.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn pipe_name(user: &str) -> String {
    let user: String = user
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    format!(r"\\.\pipe\{IDENTIFIER}.control.{user}")
}

fn name(path: &Path) -> io::Result<Name<'_>> {
    path.to_fs_name::<GenericFilePath>()
}

/// Connects to the running app; fails when it is not running.
pub fn connect() -> io::Result<Stream> {
    let path =
        socket_path().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no data folder"))?;
    Stream::connect(name(&path)?)
}

/// Sends `request` over a fresh connection and waits for the reply.
pub fn send(stream: Stream, request: &Request) -> io::Result<Reply> {
    let mut line = serde_json::to_string(request).map_err(io::Error::other)?;
    line.push('\n');
    let mut reader = BufReader::new(stream);
    reader.get_mut().write_all(line.as_bytes())?;
    reader.get_mut().flush()?;
    let mut answer = String::new();
    reader.read_line(&mut answer)?;
    if answer.trim().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Grab-it closed the connection without answering",
        ));
    }
    serde_json::from_str(answer.trim()).map_err(io::Error::other)
}

/// Starts listening for the command line, on a thread of its own. A
/// listener that cannot start is reported and left out: the rest of
/// Grab-it works without it.
pub fn start(app: &AppHandle) {
    let listener = match listen() {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("Grab-it: the grab-it command line will not work: {err}");
            return;
        }
    };
    let app = app.clone();
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            match connection {
                Ok(stream) => {
                    let app = app.clone();
                    // A delayed shot waits; the next request need not.
                    std::thread::spawn(move || serve(&app, stream));
                }
                Err(err) => eprintln!("Grab-it: a command-line connection failed: {err}"),
            }
        }
    });
}

#[cfg(unix)]
fn listen() -> io::Result<interprocess::local_socket::Listener> {
    use interprocess::os::unix::local_socket::ListenerOptionsExt;
    use std::os::unix::fs::PermissionsExt;

    let path =
        socket_path().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no data folder"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Only one Grab-it gets this far (the single-instance plugin sends a
    // second launch's arguments to the first), so a socket file already
    // there is left by one that quit without removing it.
    let options = || {
        ListenerOptions::new()
            .name(name(&path).expect("a file path is a valid socket name"))
            .try_overwrite(true)
    };
    let listener = match options().mode(0o600).create_sync() {
        // macOS cannot set the mode as the socket is made: it is set
        // straight after instead.
        Err(err) if err.kind() == io::ErrorKind::Unsupported => options().create_sync()?,
        other => other?,
    };
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

#[cfg(windows)]
fn listen() -> io::Result<interprocess::local_socket::Listener> {
    use interprocess::os::windows::{
        local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor,
    };

    let path =
        socket_path().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no user name"))?;
    // Protected, so nothing is inherited: full access for the pipe's owner,
    // the user who started Grab-it, and no one else.
    let sddl = widestring::U16CString::from_str("D:P(A;;GA;;;OW)").map_err(io::Error::other)?;
    let security = SecurityDescriptor::deserialize(&sddl)?;
    ListenerOptions::new()
        .name(name(&path)?)
        .security_descriptor(security)
        .create_sync()
}

/// Reads the one request on `stream`, answers it and closes it.
fn serve(app: &AppHandle, stream: Stream) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if let Err(err) = (&mut reader).take(MAX_REQUEST).read_line(&mut line) {
        eprintln!("Grab-it: could not read a command-line request: {err}");
        return;
    }
    let access = lock(&app.state::<SettingsState>()).get().agent_access;
    let reply = respond(&line, access, |request| crate::agent::run(app, request));
    let mut answer = serde_json::to_string(&reply).unwrap_or_else(|err| {
        format!(r#"{{"ok":false,"error":"could not write the reply: {err}"}}"#)
    });
    answer.push('\n');
    let stream = reader.get_mut();
    if let Err(err) = stream
        .write_all(answer.as_bytes())
        .and_then(|()| stream.flush())
    {
        eprintln!("Grab-it: could not answer a command-line request: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requests_are_refused_while_access_is_off() {
        let mut ran = false;
        let reply = respond(r#"{"command":"displays"}"#, false, |_| {
            ran = true;
            Ok(json!({}))
        });
        assert!(!ran);
        assert_eq!(reply, Reply::failure(ACCESS_OFF));
        assert!(ACCESS_OFF.contains("Settings › AI integration"));
        assert_eq!(
            serde_json::to_value(&reply).unwrap(),
            json!({"ok": false, "error": ACCESS_OFF})
        );
    }

    #[test]
    fn a_request_runs_while_access_is_on() {
        let reply = respond("{\"command\":\"windows\"}\n", true, |request| {
            assert_eq!(request, Request::Windows);
            Ok(json!({"windows": []}))
        });
        assert_eq!(
            serde_json::to_value(&reply).unwrap(),
            json!({"ok": true, "result": {"windows": []}})
        );
    }

    #[test]
    fn a_failed_request_replies_with_its_message() {
        let reply = respond(r#"{"command":"displays"}"#, true, |_| {
            Err("no monitors".into())
        });
        assert_eq!(reply.clone().into_result(), Err("no monitors".into()));
        assert_eq!(
            serde_json::to_value(&reply).unwrap(),
            json!({"ok": false, "error": "no monitors"})
        );
    }

    #[test]
    fn an_unknown_request_is_an_error() {
        let reply = respond(r#"{"command":"annotate"}"#, true, |_| Ok(json!({})));
        assert!(!reply.ok);
        assert!(reply.error.unwrap().contains("did not understand"));
        assert!(!respond("not json", true, |_| Ok(json!({}))).ok);
    }

    #[test]
    fn shot_requests_round_trip() {
        let request = Request::Shot(ShotRequest {
            target: ShotTarget::Region {
                x: -10,
                y: 20,
                width: 300,
                height: 200,
            },
            delay_ms: 1500,
            max_width: Some(800),
        });
        let text = serde_json::to_string(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({
                "command": "shot",
                "target": {"kind": "region", "x": -10, "y": 20, "width": 300, "height": 200},
                "delayMs": 1500,
                "maxWidth": 800,
            })
        );
        assert_eq!(serde_json::from_str::<Request>(&text).unwrap(), request);
        assert_eq!(
            serde_json::from_str::<Request>(
                r#"{"command":"shot","target":{"kind":"window","window":"Firefox"}}"#
            )
            .unwrap(),
            Request::Shot(ShotRequest {
                target: ShotTarget::Window {
                    window: "Firefox".into()
                },
                delay_ms: 0,
                max_width: None,
            })
        );
    }

    #[test]
    fn recording_and_video_requests_round_trip() {
        let requests = [
            (
                Request::Record(RecordRequest {
                    target: ShotTarget::Window {
                        window: "Firefox".into(),
                    },
                    format: RecordingFormat::Mp4,
                    fps: 60,
                    cursor: true,
                    for_ms: Some(5000),
                }),
                json!({
                    "command": "record",
                    "target": {"kind": "window", "window": "Firefox"},
                    "format": "mp4",
                    "fps": 60,
                    "cursor": true,
                    "forMs": 5000,
                }),
            ),
            (Request::Stop, json!({"command": "stop"})),
            (
                Request::Gif(GifRequest {
                    video: PathBuf::from("/v/a.mp4"),
                    start_ms: Some(1000),
                    end_ms: None,
                    fps: 10,
                    width: Some(640),
                }),
                json!({"command": "gif", "video": "/v/a.mp4", "startMs": 1000, "fps": 10, "width": 640}),
            ),
            (
                Request::Frames(FramesRequest {
                    video: PathBuf::from("/v/a.mp4"),
                    count: 9,
                }),
                json!({"command": "frames", "video": "/v/a.mp4", "count": 9}),
            ),
        ];
        for (request, expected) in requests {
            let text = serde_json::to_string(&request).unwrap();
            assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), expected);
            assert_eq!(serde_json::from_str::<Request>(&text).unwrap(), request);
        }
    }

    #[test]
    fn the_data_folder_matches_tauris() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                vars.iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| PathBuf::from(value))
            }
        };
        if cfg!(target_os = "windows") {
            assert_eq!(
                data_dir_from(env(&[("APPDATA", r"C:\Users\me\AppData\Roaming")])),
                Some(PathBuf::from(r"C:\Users\me\AppData\Roaming").join(IDENTIFIER))
            );
        } else if cfg!(target_os = "macos") {
            assert_eq!(
                data_dir_from(env(&[("HOME", "/Users/me")])),
                Some(PathBuf::from(
                    "/Users/me/Library/Application Support/com.kerwincarpede.grabit"
                ))
            );
        } else {
            assert_eq!(
                data_dir_from(env(&[("HOME", "/home/me")])),
                Some(PathBuf::from(
                    "/home/me/.local/share/com.kerwincarpede.grabit"
                ))
            );
            assert_eq!(
                data_dir_from(env(&[("HOME", "/home/me"), ("XDG_DATA_HOME", "/data")])),
                Some(PathBuf::from("/data/com.kerwincarpede.grabit"))
            );
            // A relative XDG_DATA_HOME is ignored, as the spec says.
            assert_eq!(
                data_dir_from(env(&[("HOME", "/home/me"), ("XDG_DATA_HOME", "data")])),
                Some(PathBuf::from(
                    "/home/me/.local/share/com.kerwincarpede.grabit"
                ))
            );
            assert_eq!(data_dir_from(env(&[])), None);
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn an_appimage_runs_as_the_appimage() {
        let mounted = PathBuf::from("/tmp/.mount_GrabXy/usr/bin/grab-it");
        assert_eq!(
            executable_from(
                Some(PathBuf::from("/home/me/Apps/Grab-it.AppImage")),
                mounted.clone()
            ),
            PathBuf::from("/home/me/Apps/Grab-it.AppImage")
        );
        assert_eq!(executable_from(None, mounted.clone()), mounted);
        // Only an absolute $APPIMAGE is trusted.
        assert_eq!(
            executable_from(Some(PathBuf::from("Grab-it.AppImage")), mounted.clone()),
            mounted
        );
    }

    #[test]
    fn pipe_names_keep_only_safe_characters() {
        assert_eq!(
            pipe_name("Kim Lee\\x"),
            r"\\.\pipe\com.kerwincarpede.grabit.control.KimLeex"
        );
    }
}
