//! ffmpeg, which encodes MP4 recordings.
//!
//! ffmpeg is not shipped with Grab-it. `$GRAB_IT_FFMPEG` names one to use;
//! otherwise the copy in `ffmpeg/` in the app data directory is used, and
//! when there is none, this platform's LGPL build is downloaded there from
//! the `ffmpeg-n8.1` release (see .github/workflows/ffmpeg.yml) and checked
//! against its `.sha256`. That happens in the background when Grab-it starts
//! with MP4 chosen, or when MP4 is chosen in Settings, with progress shown
//! on the Recording page.
//!
//! Once ffmpeg is found, each H.264 encoder it may have is tried in turn by
//! encoding one frame, hardware encoders first, and the first that works is
//! kept until Grab-it quits. A recording then pipes raw RGBA frames into
//! ffmpeg's stdin ([`Video`]), and its microphone's sound, if any, is muxed
//! in once it stops ([`add_audio`]).

use std::{
    ffi::OsString,
    fmt, fs,
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use image::RgbaImage;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::ocr::DOWNLOAD_STALL_TIMEOUT;

/// Where the downloaded ffmpeg lives, under the app data directory.
pub const FFMPEG_DIR: &str = "ffmpeg";
/// Names an ffmpeg to use instead of downloading one.
pub const FFMPEG_ENV: &str = "GRAB_IT_FFMPEG";
/// Emitted with an [`FfmpegStatus`] whenever it changes.
pub const FFMPEG_STATUS_EVENT: &str = "ffmpeg-status";
/// The release the builds are downloaded from.
pub const RELEASE_URL: &str =
    "https://github.com/kerwincarpede/grab-it/releases/download/ffmpeg-n8.1";

/// How long trying one encoder may take. A hardware encoder whose driver
/// hangs must not keep Grab-it from trying the next one.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// The size of the frame each encoder is tried with: large enough for every
/// hardware encoder's minimum.
const PROBE_SIZE: (u32, u32) = (256, 256);
/// How long finishing a video may take once its last frame is written:
/// moving the index to the front (`+faststart`) rewrites the whole file.
const FINISH_TIMEOUT: Duration = Duration::from_secs(60);
/// The VA-API device on Linux.
const VAAPI_DEVICE: &str = "/dev/dri/renderD128";

/// The release asset for an OS and architecture, as Rust names them
/// (`std::env::consts`). None where no build is published.
pub fn asset_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("linux", "x86_64") => Some("ffmpeg-linux-x64.gz"),
        ("windows", "x86_64") => Some("ffmpeg-windows-x64.exe.gz"),
        ("macos", "aarch64") => Some("ffmpeg-macos-arm64.gz"),
        _ => None,
    }
}

/// This platform's release asset.
pub fn platform_asset() -> Option<&'static str> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// The executable's file name on this platform.
pub fn executable_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// Where the downloaded ffmpeg is kept.
pub fn installed_path(app_data: &Path) -> PathBuf {
    app_data.join(FFMPEG_DIR).join(executable_name())
}

/// Where ffmpeg comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// `$GRAB_IT_FFMPEG`, used as it is.
    Override(PathBuf),
    /// A copy downloaded earlier.
    Installed(PathBuf),
    /// Nothing yet: `asset` is downloaded to `to`.
    Download { asset: &'static str, to: PathBuf },
    /// Nothing yet, and no build is published for this platform.
    Unsupported,
}

/// Where ffmpeg comes from, given `$GRAB_IT_FFMPEG` (`env`) and this
/// platform's asset.
pub fn locate_with(app_data: &Path, env: Option<OsString>, asset: Option<&'static str>) -> Source {
    if let Some(path) = env.filter(|path| !path.is_empty()) {
        return Source::Override(PathBuf::from(path));
    }
    let installed = installed_path(app_data);
    if installed.is_file() {
        return Source::Installed(installed);
    }
    match asset {
        Some(asset) => Source::Download {
            asset,
            to: installed,
        },
        None => Source::Unsupported,
    }
}

/// Where ffmpeg comes from on this machine.
pub fn locate(app_data: &Path) -> Source {
    locate_with(app_data, std::env::var_os(FFMPEG_ENV), platform_asset())
}

#[derive(Debug)]
pub enum FfmpegError {
    /// The download failed.
    Download(String),
    /// The download did not match its published checksum.
    Checksum {
        expected: String,
        actual: String,
    },
    Io(io::Error),
    /// No build is published for this platform.
    Unsupported,
    /// `$GRAB_IT_FFMPEG` names no file.
    Missing(PathBuf),
    /// None of the H.264 encoders worked.
    NoEncoder,
    /// ffmpeg failed while encoding.
    Encode(String),
}

impl fmt::Display for FfmpegError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Download(err) => write!(f, "could not download ffmpeg: {err}"),
            Self::Checksum { expected, actual } => write!(
                f,
                "the ffmpeg download was damaged (its SHA-256 is {actual}, not {expected})"
            ),
            Self::Io(err) => write!(f, "{err}"),
            Self::Unsupported => f.write_str(
                "there is no ffmpeg download for this computer; set GRAB_IT_FFMPEG to an ffmpeg to use",
            ),
            Self::Missing(path) => write!(
                f,
                "{FFMPEG_ENV} is set to {}, which does not exist",
                path.display()
            ),
            Self::NoEncoder => f.write_str("ffmpeg could not encode H.264 with any encoder"),
            Self::Encode(err) => write!(f, "ffmpeg failed: {err}"),
        }
    }
}

impl std::error::Error for FfmpegError {}

impl From<io::Error> for FfmpegError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

pub type FfmpegResult<T> = std::result::Result<T, FfmpegError>;

/// Downloads `asset` from the release and installs it as the executable
/// `to`. `progress` gets the bytes downloaded so far and the total (0 when
/// the server does not say).
pub fn download(asset: &str, to: &Path, progress: impl FnMut(u64, u64)) -> FfmpegResult<()> {
    download_from(
        &crate::ocr::download_agent(DOWNLOAD_STALL_TIMEOUT),
        RELEASE_URL,
        asset,
        to,
        progress,
    )
}

/// [`download`] from the release at `base_url`. The archive is written and
/// unpacked beside `to` and renamed into place only once its checksum
/// matched, so a cut-off or damaged download is never mistaken for ffmpeg.
fn download_from(
    agent: &ureq::Agent,
    base_url: &str,
    asset: &str,
    to: &Path,
    mut progress: impl FnMut(u64, u64),
) -> FfmpegResult<()> {
    let expected = fetch_checksum(agent, &format!("{base_url}/{asset}.sha256"))?;
    let dir = to.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    // Unique per download, so parallel downloads (tests) never share one.
    static NEXT_PART: AtomicU64 = AtomicU64::new(0);
    let suffix = format!(
        "part-{}-{}",
        std::process::id(),
        NEXT_PART.fetch_add(1, Ordering::Relaxed)
    );
    let archive = dir.join(format!("{asset}.{suffix}"));
    let unpacked = dir.join(format!("{}.{suffix}", executable_name()));
    let result = (|| -> FfmpegResult<()> {
        let actual = download_hashed(
            agent,
            &format!("{base_url}/{asset}"),
            &archive,
            &mut progress,
        )?;
        if actual != expected {
            return Err(FfmpegError::Checksum { expected, actual });
        }
        unpack(&archive, &unpacked)?;
        make_executable(&unpacked)?;
        fs::rename(&unpacked, to)?;
        Ok(())
    })();
    let _ = fs::remove_file(&archive);
    if result.is_err() {
        let _ = fs::remove_file(&unpacked);
    }
    result
}

/// The checksum in a `sha256sum` line (`<hex>  <file>`), lowercased.
pub fn parse_checksum(text: &str) -> Option<String> {
    let hex = text.split_whitespace().next()?;
    (hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_lowercase())
}

fn fetch_checksum(agent: &ureq::Agent, url: &str) -> FfmpegResult<String> {
    let text = agent
        .get(url)
        .call()
        .map_err(|err| FfmpegError::Download(err.to_string()))?
        .into_body()
        .read_to_string()
        .map_err(|err| FfmpegError::Download(err.to_string()))?;
    parse_checksum(&text)
        .ok_or_else(|| FfmpegError::Download(format!("{url} holds no SHA-256 checksum")))
}

/// Streams `url` into `to`, returning the SHA-256 of what was written.
fn download_hashed(
    agent: &ureq::Agent,
    url: &str,
    to: &Path,
    progress: &mut impl FnMut(u64, u64),
) -> FfmpegResult<String> {
    let response = agent
        .get(url)
        .call()
        .map_err(|err| FfmpegError::Download(err.to_string()))?;
    let total = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    progress(0, total);
    let mut reader = response.into_body().into_reader();
    let mut out = fs::File::create(to)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    let mut written = 0u64;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(FfmpegError::Download(err.to_string())),
        };
        out.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        written += read as u64;
        progress(written, total.max(written));
    }
    out.sync_all()?;
    if written == 0 {
        return Err(FfmpegError::Download(format!("{url} was empty")));
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Unpacks the gzip archive `from` into `to`.
fn unpack(from: &Path, to: &Path) -> FfmpegResult<()> {
    let mut decoder = flate2::read::GzDecoder::new(BufReader::new(fs::File::open(from)?));
    let mut out = fs::File::create(to)?;
    io::copy(&mut decoder, &mut out).map_err(|err| {
        FfmpegError::Download(format!("could not unpack {}: {err}", from.display()))
    })?;
    out.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// An H.264 encoder ffmpeg may have, with what it needs to be fed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Encoder {
    /// ffmpeg's name for it.
    pub name: &'static str,
    /// The pixel format frames are converted to for it.
    pix_fmt: &'static str,
    /// VA-API takes its frames on the GPU, uploaded from `pix_fmt`.
    vaapi: bool,
}

impl Encoder {
    const fn new(name: &'static str, pix_fmt: &'static str) -> Self {
        Self {
            name,
            pix_fmt,
            vaapi: false,
        }
    }
}

pub const VIDEOTOOLBOX: Encoder = Encoder::new("h264_videotoolbox", "yuv420p");
pub const NVENC: Encoder = Encoder::new("h264_nvenc", "yuv420p");
pub const QSV: Encoder = Encoder::new("h264_qsv", "nv12");
pub const AMF: Encoder = Encoder::new("h264_amf", "yuv420p");
pub const MEDIA_FOUNDATION: Encoder = Encoder::new("h264_mf", "yuv420p");
pub const VAAPI: Encoder = Encoder {
    name: "h264_vaapi",
    pix_fmt: "nv12",
    vaapi: true,
};
/// Cisco's software encoder, in every build: the last resort.
pub const OPENH264: Encoder = Encoder::new("libopenh264", "yuv420p");

/// The encoders to try on `os` (`std::env::consts::OS`), in order:
/// the platform's hardware encoders, then OpenH264.
pub fn candidates(os: &str) -> Vec<Encoder> {
    let mut list = match os {
        "macos" => vec![VIDEOTOOLBOX],
        "windows" => vec![NVENC, QSV, AMF, MEDIA_FOUNDATION],
        "linux" => vec![NVENC, VAAPI],
        _ => Vec::new(),
    };
    list.push(OPENH264);
    list
}

/// The first of `candidates` that `works`, trying them in order and none
/// after it.
pub fn choose(candidates: &[Encoder], mut works: impl FnMut(Encoder) -> bool) -> Option<Encoder> {
    candidates.iter().copied().find(|encoder| works(*encoder))
}

/// The H.264 encoder `ffmpeg` encodes with on this platform.
pub fn choose_encoder(ffmpeg: &Path) -> Option<Encoder> {
    choose(&candidates(std::env::consts::OS), |encoder| {
        match probe(ffmpeg, encoder) {
            Ok(()) => true,
            Err(err) => {
                eprintln!("Grab-it: ffmpeg cannot use {}: {err}", encoder.name);
                false
            }
        }
    })
}

/// Encodes one frame with `encoder` into a scratch MP4, just as a
/// recording would.
fn probe(ffmpeg: &Path, encoder: Encoder) -> FfmpegResult<()> {
    static NEXT_PROBE: AtomicU64 = AtomicU64::new(0);
    let output = std::env::temp_dir().join(format!(
        "grab-it-probe-{}-{}-{}.mp4",
        std::process::id(),
        NEXT_PROBE.fetch_add(1, Ordering::Relaxed),
        encoder.name
    ));
    let spec = VideoSpec {
        input: PROBE_SIZE,
        output: PROBE_SIZE,
        fps: 30,
        bits_per_pixel: 0.1,
    };
    let result = (|| -> FfmpegResult<()> {
        let mut video = Video::start(ffmpeg, encoder, &spec, &output)?;
        video.write(&RgbaImage::new(PROBE_SIZE.0, PROBE_SIZE.1))?;
        video.finish_within(PROBE_TIMEOUT)?;
        match fs::metadata(&output) {
            Ok(meta) if meta.len() > 0 => Ok(()),
            _ => Err(FfmpegError::Encode("it wrote nothing".to_owned())),
        }
    })();
    let _ = fs::remove_file(&output);
    result
}

/// The widest an MP4 is written; wider regions are scaled down.
pub const MAX_VIDEO_WIDTH: u32 = 1920;

/// The size a video of frames `input` big is written at: at most
/// [`MAX_VIDEO_WIDTH`] wide, keeping the ratio, and even both ways as
/// yuv420p needs.
pub fn video_size(input: (u32, u32)) -> (u32, u32) {
    let (width, height) = (input.0.max(2), input.1.max(2));
    let (width, height) = if width > MAX_VIDEO_WIDTH {
        let scaled = (f64::from(height) * f64::from(MAX_VIDEO_WIDTH) / f64::from(width)).round();
        (MAX_VIDEO_WIDTH, scaled as u32)
    } else {
        (width, height)
    };
    let even = |side: u32| (side & !1).max(2);
    (even(width), even(height))
}

/// What a video is made of.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoSpec {
    /// The size of the frames written.
    pub input: (u32, u32),
    /// The size of the video, from [`video_size`].
    pub output: (u32, u32),
    pub fps: u32,
    /// The bitrate, as bits per pixel of each frame.
    pub bits_per_pixel: f64,
}

impl VideoSpec {
    /// Bits per second.
    pub fn bitrate(&self) -> u64 {
        let pixels = f64::from(self.output.0) * f64::from(self.output.1);
        (pixels * f64::from(self.fps) * self.bits_per_pixel).round() as u64
    }
}

/// ffmpeg's arguments to encode raw RGBA frames from stdin with `encoder`
/// into the MP4 `output`.
pub fn encode_args(encoder: Encoder, spec: &VideoSpec, output: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-y"]
        .into_iter()
        .map(OsString::from)
        .collect();
    let mut push = |arg: &str| args.push(OsString::from(arg));
    if encoder.vaapi {
        push("-vaapi_device");
        push(VAAPI_DEVICE);
    }
    for arg in ["-f", "rawvideo", "-pix_fmt", "rgba", "-s"] {
        push(arg);
    }
    push(&format!("{}x{}", spec.input.0, spec.input.1));
    push("-framerate");
    push(&spec.fps.to_string());
    for arg in ["-i", "pipe:0", "-vf"] {
        push(arg);
    }
    let mut filters = Vec::new();
    if spec.input != spec.output {
        filters.push(format!(
            "scale={}:{}:flags=bicubic",
            spec.output.0, spec.output.1
        ));
    }
    filters.push(format!("format={}", encoder.pix_fmt));
    if encoder.vaapi {
        filters.push("hwupload".to_owned());
    }
    push(&filters.join(","));
    push("-c:v");
    push(encoder.name);
    push("-b:v");
    push(&spec.bitrate().to_string());
    // A keyframe every two seconds, so players can seek.
    push("-g");
    push(&(spec.fps * 2).to_string());
    for arg in ["-an", "-movflags", "+faststart"] {
        push(arg);
    }
    args.push(output.as_os_str().to_owned());
    args
}

/// A command running `ffmpeg`, without a console window on Windows.
pub(crate) fn command(ffmpeg: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(ffmpeg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// An MP4 being written by ffmpeg, frame by frame.
pub struct Video {
    child: Child,
    stdin: Option<ChildStdin>,
    /// Reads what ffmpeg says, so its stderr never fills up and blocks it.
    stderr: Option<JoinHandle<String>>,
    frame_size: (u32, u32),
}

impl Video {
    /// Starts ffmpeg writing `output`.
    pub fn start(
        ffmpeg: &Path,
        encoder: Encoder,
        spec: &VideoSpec,
        output: &Path,
    ) -> FfmpegResult<Self> {
        let mut child = command(ffmpeg)
            .args(encode_args(encoder, spec, output))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| {
                FfmpegError::Encode(format!("could not start {}: {err}", ffmpeg.display()))
            })?;
        let stdin = child.stdin.take();
        let stderr = child.stderr.take().map(|mut stderr| {
            thread::spawn(move || {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text);
                text
            })
        });
        Ok(Self {
            child,
            stdin,
            stderr,
            frame_size: spec.input,
        })
    }

    /// Writes one frame, which must be the size the video was started with.
    pub fn write(&mut self, frame: &RgbaImage) -> FfmpegResult<()> {
        if frame.dimensions() != self.frame_size {
            return Err(FfmpegError::Encode(format!(
                "a frame was {}×{}, not {}×{}",
                frame.width(),
                frame.height(),
                self.frame_size.0,
                self.frame_size.1
            )));
        }
        let Some(stdin) = self.stdin.as_mut() else {
            return Err(FfmpegError::Encode("the video is finished".to_owned()));
        };
        if let Err(err) = stdin.write_all(frame.as_raw()) {
            // ffmpeg stopped reading: it has most likely said why.
            let said = self.close(PROBE_TIMEOUT).err();
            return Err(said.unwrap_or_else(|| FfmpegError::Encode(err.to_string())));
        }
        Ok(())
    }

    /// Ends the video and waits for ffmpeg to finish the file.
    pub fn finish(self) -> FfmpegResult<()> {
        self.finish_within(FINISH_TIMEOUT)
    }

    fn finish_within(mut self, timeout: Duration) -> FfmpegResult<()> {
        self.close(timeout)
    }

    /// Closes stdin and waits up to `timeout` for ffmpeg to exit.
    fn close(&mut self, timeout: Duration) -> FfmpegResult<()> {
        drop(self.stdin.take());
        let status = wait_for(&mut self.child, timeout);
        let said = self
            .stderr
            .take()
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default();
        match status {
            Some(status) if status.success() => Ok(()),
            Some(status) => Err(FfmpegError::Encode(match last_line(&said) {
                Some(line) => line.to_owned(),
                None => format!("it exited with {status}"),
            })),
            None => Err(FfmpegError::Encode(format!(
                "it did not finish within {} seconds",
                timeout.as_secs()
            ))),
        }
    }
}

impl Drop for Video {
    fn drop(&mut self) {
        drop(self.stdin.take());
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

/// The bitrate of a recording's sound, as AAC.
const AUDIO_BITRATE: &str = "160k";
/// Ends the name of the file the sound is muxed into, beside the video.
const MUXING_SUFFIX: &str = ".muxing.mp4";

/// ffmpeg's arguments to mux the WAV `audio` into the MP4 `video` as AAC
/// (ffmpeg's own `aac` encoder), writing `output`. The video is copied as
/// it is. `offset` is when the sound starts against the first frame, in
/// seconds (see `audio::offset`): sound that started later is delayed with
/// silence, and sound that started earlier has its start cut. The sound is
/// padded or cut to `duration`, the video's length.
pub fn mux_args(
    video: &Path,
    audio: &Path,
    offset: f64,
    duration: Duration,
    output: &Path,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-y", "-i"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(video.as_os_str().to_owned());
    let mut push = |arg: &str| args.push(OsString::from(arg));
    let millis = (offset * 1000.0).round() as i64;
    if millis < 0 {
        push("-ss");
        push(&format!("{:.3}", millis.unsigned_abs() as f64 / 1000.0));
    }
    push("-i");
    args.push(audio.as_os_str().to_owned());
    let mut push = |arg: &str| args.push(OsString::from(arg));
    for arg in ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af"] {
        push(arg);
    }
    if millis > 0 {
        push(&format!("adelay=delays={millis}:all=1,apad"));
    } else {
        push("apad");
    }
    for arg in ["-c:a", "aac", "-b:a", AUDIO_BITRATE, "-t"] {
        push(arg);
    }
    push(&format!("{:.3}", duration.as_secs_f64()));
    for arg in ["-movflags", "+faststart"] {
        push(arg);
    }
    args.push(output.as_os_str().to_owned());
    args
}

/// Muxes the WAV `audio` into the MP4 `video` in place, as [`mux_args`]
/// says. The video is replaced only once the muxed copy is finished, so
/// on failure it is left as it was, silent.
pub fn add_audio(
    ffmpeg: &Path,
    video: &Path,
    audio: &Path,
    offset: f64,
    duration: Duration,
) -> FfmpegResult<()> {
    let output = crate::capture::sidecar_path(video, MUXING_SUFFIX);
    let result = (|| -> FfmpegResult<()> {
        let mut child = command(ffmpeg)
            .args(mux_args(video, audio, offset, duration, &output))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| {
                FfmpegError::Encode(format!("could not start {}: {err}", ffmpeg.display()))
            })?;
        let stderr = child.stderr.take().map(|mut stderr| {
            thread::spawn(move || {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text);
                text
            })
        });
        let status = wait_for(&mut child, FINISH_TIMEOUT);
        let said = stderr
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default();
        match status {
            Some(status) if status.success() => {}
            Some(status) => {
                return Err(FfmpegError::Encode(match last_line(&said) {
                    Some(line) => line.to_owned(),
                    None => format!("it exited with {status}"),
                }));
            }
            None => {
                return Err(FfmpegError::Encode(format!(
                    "adding the sound did not finish within {} seconds",
                    FINISH_TIMEOUT.as_secs()
                )));
            }
        }
        fs::rename(&output, video)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&output);
    }
    result
}

/// The last line ffmpeg printed, if any.
pub(crate) fn last_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).rfind(|line| !line.is_empty())
}

/// Waits up to `timeout` for `child`, killing it if it has not exited.
pub(crate) fn wait_for(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Where ffmpeg is up to. Mirrors `FfmpegStatus` in src/settings/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum FfmpegStatus {
    /// Not looked for yet: nothing has asked for MP4.
    Missing,
    /// Being downloaded; `total` is 0 until the server says.
    Downloading { downloaded: u64, total: u64 },
    /// Found; its encoders are being tried.
    Checking,
    /// Ready to record with `encoder`.
    Ready { encoder: String },
    /// It could not be downloaded or used. Retry tries again.
    Failed { message: String },
}

/// An ffmpeg ready to record with, and the encoder it uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ready {
    pub path: PathBuf,
    pub encoder: Encoder,
}

struct Inner {
    status: FfmpegStatus,
    ready: Option<Ready>,
    /// A download or encoder check is under way.
    busy: bool,
}

/// ffmpeg's state, managed as Tauri state.
pub struct FfmpegState {
    app_data: PathBuf,
    inner: Mutex<Inner>,
}

impl FfmpegState {
    fn new(app_data: PathBuf) -> Self {
        Self {
            app_data,
            inner: Mutex::new(Inner {
                status: FfmpegStatus::Missing,
                ready: None,
                busy: false,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn status(&self) -> FfmpegStatus {
        self.lock().status.clone()
    }
}

/// Sets up ffmpeg's state, and gets ffmpeg ready in the background when
/// recordings are MP4.
pub fn start(app: &AppHandle, app_data: PathBuf, wants_mp4: bool) {
    app.manage(FfmpegState::new(app_data));
    if wants_mp4 {
        prepare_in_background(app);
    }
}

/// The ffmpeg to record with, when it is ready.
pub fn ready(app: &AppHandle) -> Option<Ready> {
    app.try_state::<FfmpegState>()
        .and_then(|state| state.lock().ready.clone())
}

/// Where ffmpeg is up to.
pub fn status(app: &AppHandle) -> FfmpegStatus {
    app.try_state::<FfmpegState>()
        .map_or(FfmpegStatus::Missing, |state| state.status())
}

fn set_status(app: &AppHandle, status: FfmpegStatus) {
    let Some(state) = app.try_state::<FfmpegState>() else {
        return;
    };
    {
        let mut inner = state.lock();
        if inner.status == status {
            return;
        }
        inner.status = status.clone();
    }
    let _ = app.emit(FFMPEG_STATUS_EVENT, status);
}

/// Finds or downloads ffmpeg and chooses its encoder, on a thread of its
/// own. Does nothing when ffmpeg is ready or already being prepared.
pub fn prepare_in_background(app: &AppHandle) {
    let Some(state) = app.try_state::<FfmpegState>() else {
        return;
    };
    let source = {
        let mut inner = state.lock();
        if inner.busy || inner.ready.is_some() {
            return;
        }
        inner.busy = true;
        locate(&state.app_data)
    };
    // Said at once, so Settings shows the work as soon as it is asked for.
    set_status(
        app,
        match source {
            Source::Download { .. } => FfmpegStatus::Downloading {
                downloaded: 0,
                total: 0,
            },
            _ => FfmpegStatus::Checking,
        },
    );
    let handle = app.clone();
    let spawned = thread::Builder::new()
        .name("grab-it-ffmpeg".into())
        .spawn(move || {
            let result = prepare(&handle, source);
            let state = handle.state::<FfmpegState>();
            let status = match result {
                Ok(ready) => {
                    let encoder = ready.encoder.name.to_owned();
                    state.lock().ready = Some(ready);
                    FfmpegStatus::Ready { encoder }
                }
                Err(err) => {
                    eprintln!("Grab-it: {err}");
                    FfmpegStatus::Failed {
                        message: err.to_string(),
                    }
                }
            };
            state.lock().busy = false;
            set_status(&handle, status);
        });
    if let Err(err) = spawned {
        state.lock().busy = false;
        set_status(
            app,
            FfmpegStatus::Failed {
                message: format!("could not start getting ffmpeg ready: {err}"),
            },
        );
    }
}

/// Gets ffmpeg from `source`, downloading it with progress if needed, and
/// chooses its encoder.
fn prepare(app: &AppHandle, source: Source) -> FfmpegResult<Ready> {
    let (path, downloaded) = match source {
        Source::Override(path) => {
            if !path.is_file() {
                return Err(FfmpegError::Missing(path));
            }
            (path, false)
        }
        Source::Installed(path) => (path, false),
        Source::Download { asset, to } => {
            let mut last_percent = None;
            download(asset, &to, |downloaded, total| {
                // Every percent, or every megabyte while the size is unknown.
                let step = (downloaded * 100)
                    .checked_div(total)
                    .unwrap_or(downloaded >> 20);
                if last_percent != Some(step) {
                    last_percent = Some(step);
                    set_status(app, FfmpegStatus::Downloading { downloaded, total });
                }
            })?;
            (to, true)
        }
        Source::Unsupported => return Err(FfmpegError::Unsupported),
    };
    set_status(app, FfmpegStatus::Checking);
    match choose_encoder(&path) {
        Some(encoder) => Ok(Ready { path, encoder }),
        None => {
            // A copy Grab-it downloaded earlier may be damaged: fetch a
            // fresh one on Retry. One just downloaded was checked.
            if !downloaded && path == installed_path(&app.state::<FfmpegState>().app_data) {
                let _ = fs::remove_file(&path);
            }
            Err(FfmpegError::NoEncoder)
        }
    }
}

/// Why an MP4 recording was saved as a GIF instead, as the card says it.
pub fn fallback_reason(status: &FfmpegStatus) -> String {
    match status {
        FfmpegStatus::Downloading { .. } | FfmpegStatus::Missing => {
            "Saved as a GIF: ffmpeg, which MP4 needs, is still downloading.".to_owned()
        }
        FfmpegStatus::Checking => {
            "Saved as a GIF: ffmpeg, which MP4 needs, is still getting ready.".to_owned()
        }
        FfmpegStatus::Ready { .. } => "Saved as a GIF.".to_owned(),
        FfmpegStatus::Failed { .. } => {
            "Saved as a GIF: ffmpeg, which MP4 needs, could not be set up. See Settings → Recording."
                .to_owned()
        }
    }
}

#[tauri::command]
pub fn ffmpeg_status(app: AppHandle) -> FfmpegStatus {
    status(&app)
}

/// Tries again to download ffmpeg or find an encoder. Returns the status
/// as the new attempt starts.
#[tauri::command]
pub fn ffmpeg_retry(app: AppHandle) -> FfmpegStatus {
    prepare_in_background(&app);
    status(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn each_platform_has_its_release_asset() {
        assert_eq!(asset_for("linux", "x86_64"), Some("ffmpeg-linux-x64.gz"));
        assert_eq!(
            asset_for("windows", "x86_64"),
            Some("ffmpeg-windows-x64.exe.gz")
        );
        assert_eq!(asset_for("macos", "aarch64"), Some("ffmpeg-macos-arm64.gz"));
        assert_eq!(asset_for("macos", "x86_64"), None);
        assert_eq!(asset_for("linux", "aarch64"), None);
    }

    #[test]
    fn the_override_comes_first_then_the_installed_copy_then_a_download() {
        let dir = tempfile::tempdir().unwrap();
        let installed = installed_path(dir.path());
        assert_eq!(
            locate_with(
                dir.path(),
                Some("/opt/ffmpeg".into()),
                Some("ffmpeg-linux-x64.gz")
            ),
            Source::Override(PathBuf::from("/opt/ffmpeg"))
        );
        assert_eq!(
            locate_with(dir.path(), Some("".into()), Some("ffmpeg-linux-x64.gz")),
            Source::Download {
                asset: "ffmpeg-linux-x64.gz",
                to: installed.clone()
            }
        );
        assert_eq!(locate_with(dir.path(), None, None), Source::Unsupported);

        fs::create_dir_all(installed.parent().unwrap()).unwrap();
        fs::write(&installed, b"ffmpeg").unwrap();
        assert_eq!(
            locate_with(dir.path(), None, Some("ffmpeg-linux-x64.gz")),
            Source::Installed(installed.clone())
        );
        assert_eq!(installed.parent().unwrap(), dir.path().join(FFMPEG_DIR));
    }

    #[test]
    fn checksums_are_read_from_sha256sum_lines() {
        let hex = "AB".repeat(32);
        assert_eq!(
            parse_checksum(&format!("{hex}  ffmpeg-linux-x64.gz\n")),
            Some("ab".repeat(32))
        );
        assert_eq!(parse_checksum("not-a-checksum  ffmpeg"), None);
        assert_eq!(parse_checksum(""), None);
    }

    #[test]
    fn hardware_encoders_are_tried_before_openh264() {
        let names = |os: &str| candidates(os).iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names("macos"), ["h264_videotoolbox", "libopenh264"]);
        assert_eq!(
            names("windows"),
            [
                "h264_nvenc",
                "h264_qsv",
                "h264_amf",
                "h264_mf",
                "libopenh264"
            ]
        );
        assert_eq!(names("linux"), ["h264_nvenc", "h264_vaapi", "libopenh264"]);
        assert_eq!(names("freebsd"), ["libopenh264"]);
    }

    #[test]
    fn the_first_encoder_that_works_is_chosen_and_none_after_it_tried() {
        let mut tried = Vec::new();
        let chosen = choose(&candidates("windows"), |encoder| {
            tried.push(encoder.name);
            encoder == AMF
        });
        assert_eq!(chosen, Some(AMF));
        assert_eq!(tried, ["h264_nvenc", "h264_qsv", "h264_amf"]);
        assert_eq!(choose(&candidates("linux"), |_| false), None);
    }

    #[test]
    fn videos_are_even_sized_and_at_most_full_hd_wide() {
        assert_eq!(video_size((800, 600)), (800, 600));
        assert_eq!(video_size((801, 601)), (800, 600));
        assert_eq!(video_size((3840, 2160)), (1920, 1080));
        assert_eq!(video_size((5120, 1441)), (1920, 540));
        assert_eq!(video_size((1, 1)), (2, 2));
    }

    #[test]
    fn frames_are_piped_in_as_rgba_and_written_as_yuv420p_with_faststart() {
        let spec = VideoSpec {
            input: (3840, 2160),
            output: (1920, 1080),
            fps: 30,
            bits_per_pixel: 0.2,
        };
        let args: Vec<String> = encode_args(OPENH264, &spec, Path::new("/tmp/clip.mp4"))
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
        let joined = args.join(" ");
        assert!(
            joined.contains("-f rawvideo -pix_fmt rgba -s 3840x2160 -framerate 30 -i pipe:0"),
            "{joined}"
        );
        assert!(
            joined.contains("-vf scale=1920:1080:flags=bicubic,format=yuv420p"),
            "{joined}"
        );
        assert!(
            joined.contains("-c:v libopenh264 -b:v 12441600"),
            "{joined}"
        );
        assert!(
            joined.ends_with("-movflags +faststart /tmp/clip.mp4"),
            "{joined}"
        );

        let vaapi = encode_args(
            VAAPI,
            &VideoSpec {
                output: spec.input,
                ..spec
            },
            Path::new("clip.mp4"),
        )
        .into_iter()
        .map(|arg| arg.into_string().unwrap())
        .collect::<Vec<_>>()
        .join(" ");
        assert!(
            vaapi.contains("-vaapi_device /dev/dri/renderD128 -f rawvideo"),
            "{vaapi}"
        );
        assert!(
            vaapi.contains("-vf format=nv12,hwupload -c:v h264_vaapi"),
            "{vaapi}"
        );
    }

    #[test]
    fn sound_is_muxed_as_aac_beside_the_copied_video() {
        let args = |offset: f64| {
            mux_args(
                Path::new("/rec/clip.mp4"),
                Path::new("/tmp/mic.wav"),
                offset,
                Duration::from_millis(12_345),
                Path::new("/rec/clip.muxing.mp4"),
            )
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect::<Vec<_>>()
            .join(" ")
        };
        // The sound started 250 ms before the first frame: its start is cut.
        assert_eq!(
            args(-0.25),
            "-hide_banner -loglevel error -y -i /rec/clip.mp4 -ss 0.250 -i /tmp/mic.wav \
             -map 0:v:0 -map 1:a:0 -c:v copy -af apad -c:a aac -b:a 160k -t 12.345 \
             -movflags +faststart /rec/clip.muxing.mp4"
        );
        // It started 120 ms after: it is delayed by as much.
        let later = args(0.1204);
        assert!(
            later.contains("-i /rec/clip.mp4 -i /tmp/mic.wav"),
            "{later}"
        );
        assert!(
            later.contains("-af adelay=delays=120:all=1,apad -c:a aac"),
            "{later}"
        );
        // Under half a millisecond either way is no shift at all.
        let none = args(-0.0004);
        assert!(!none.contains("-ss"), "{none}");
        assert!(none.contains("-af apad -c:a"), "{none}");
    }

    #[test]
    fn the_bitrate_is_bits_per_pixel_per_frame() {
        let spec = |bits_per_pixel| VideoSpec {
            input: (1280, 720),
            output: (1280, 720),
            fps: 30,
            bits_per_pixel,
        };
        assert_eq!(spec(0.05).bitrate(), 1_382_400);
        assert_eq!(spec(0.1).bitrate(), 2_764_800);
        assert_eq!(spec(0.2).bitrate(), 5_529_600);
    }

    #[test]
    fn a_gif_fallback_says_why() {
        assert!(
            fallback_reason(&FfmpegStatus::Downloading {
                downloaded: 1,
                total: 2
            })
            .contains("still downloading")
        );
        assert!(
            fallback_reason(&FfmpegStatus::Failed {
                message: "offline".into()
            })
            .contains("could not be set up")
        );
    }

    #[test]
    fn statuses_serialize_for_the_frontend() {
        assert_eq!(
            serde_json::to_value(FfmpegStatus::Downloading {
                downloaded: 5,
                total: 10
            })
            .unwrap(),
            serde_json::json!({ "state": "downloading", "downloaded": 5, "total": 10 })
        );
        assert_eq!(
            serde_json::to_value(FfmpegStatus::Ready {
                encoder: "libopenh264".into()
            })
            .unwrap(),
            serde_json::json!({ "state": "ready", "encoder": "libopenh264" })
        );
    }

    /// Serves each of `replies` to one connection in turn, by path.
    fn release_server(replies: Vec<(&'static str, Vec<u8>)>) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            for _ in 0..replies.len() {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let read = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..read]);
                let path = request.split_whitespace().nth(1).unwrap_or("").to_owned();
                let body = replies
                    .iter()
                    .find(|(name, _)| path == format!("/{name}"))
                    .map(|(_, body)| body.clone());
                let reply = match body {
                    Some(body) => {
                        let mut reply = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .into_bytes();
                        reply.extend(body);
                        reply
                    }
                    None => {
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_vec()
                    }
                };
                let _ = stream.write_all(&reply);
                let _ = stream.flush();
            }
        });
        (url, server)
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn a_download_matching_its_checksum_is_unpacked_into_place() {
        let archive = gzip(b"#!/bin/sh\necho ffmpeg\n");
        let line = format!("{}  ffmpeg-linux-x64.gz\n", sha256(&archive)).into_bytes();
        let (url, server) = release_server(vec![
            ("ffmpeg-linux-x64.gz.sha256", line),
            ("ffmpeg-linux-x64.gz", archive),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let to = installed_path(dir.path());
        let mut seen = Vec::new();
        download_from(
            &crate::ocr::download_agent(Duration::from_secs(5)),
            &url,
            "ffmpeg-linux-x64.gz",
            &to,
            |done, total| seen.push((done, total)),
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(fs::read(&to).unwrap(), b"#!/bin/sh\necho ffmpeg\n");
        assert_eq!(seen.last().map(|(done, total)| done == total), Some(true));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&to).unwrap().permissions().mode() & 0o111,
                0o111
            );
        }
        // Nothing but ffmpeg is left behind.
        assert_eq!(fs::read_dir(to.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn a_download_not_matching_its_checksum_is_thrown_away() {
        let archive = gzip(b"tampered");
        let line = format!("{}  ffmpeg-linux-x64.gz\n", "0".repeat(64)).into_bytes();
        let (url, server) = release_server(vec![
            ("ffmpeg-linux-x64.gz.sha256", line),
            ("ffmpeg-linux-x64.gz", archive),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let to = installed_path(dir.path());
        let result = download_from(
            &crate::ocr::download_agent(Duration::from_secs(5)),
            &url,
            "ffmpeg-linux-x64.gz",
            &to,
            |_, _| {},
        );
        server.join().unwrap();
        assert!(
            matches!(result, Err(FfmpegError::Checksum { .. })),
            "got {result:?}"
        );
        assert!(!to.exists());
        assert_eq!(fs::read_dir(to.parent().unwrap()).unwrap().count(), 0);
    }

    #[test]
    fn a_missing_checksum_fails_before_downloading() {
        let (url, server) = release_server(vec![("nothing", Vec::new())]);
        let dir = tempfile::tempdir().unwrap();
        let to = installed_path(dir.path());
        let result = download_from(
            &crate::ocr::download_agent(Duration::from_secs(5)),
            &url,
            "ffmpeg-linux-x64.gz",
            &to,
            |_, _| {},
        );
        server.join().unwrap();
        assert!(
            matches!(result, Err(FfmpegError::Download(_))),
            "got {result:?}"
        );
        assert!(!to.exists());
    }
}
