//! ffmpeg, which encodes MP4 recordings.
//!
//! ffmpeg is not shipped with Grab-it. `$GRAB_IT_FFMPEG` names one to use;
//! otherwise Grab-it looks for one already on this computer: on `PATH`,
//! then where package managers put it ([`system_dirs`]), then the copy it
//! downloaded earlier to `ffmpeg/` in the app data directory. When none of
//! those can encode H.264, it downloads FFmpeg-Builds' static LGPL build
//! for this platform from a pinned release ([`RELEASE_URL`]), checks it
//! against the SHA-256 compiled in here ([`build_for`]), and keeps its `ffmpeg`
//! there. There is no such build for macOS, where Settings asks for
//! Homebrew's. That happens in the background when Grab-it starts with MP4
//! chosen, or when MP4 is chosen in Settings, with progress shown on the
//! Recording page.
//!
//! Each H.264 encoder an ffmpeg may have is tried in turn by encoding one
//! frame, hardware encoders first, and the first ffmpeg with one that works
//! is kept, with that encoder, until Grab-it quits. A recording then pipes
//! raw RGBA frames into ffmpeg's stdin ([`Video`]), and its sound, if any,
//! is muxed in once it stops ([`add_audio`]): the microphone, the system
//! sound, or both mixed into one track.

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

use crate::rt::AppHandle;
use image::RgbaImage;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

/// Where the downloaded ffmpeg lives, under the app data directory.
pub const FFMPEG_DIR: &str = "ffmpeg";
/// Names an ffmpeg to use instead of looking for or downloading one.
pub const FFMPEG_ENV: &str = "GRAB_IT_FFMPEG";
/// Emitted with an [`FfmpegStatus`] whenever it changes.
pub const FFMPEG_STATUS_EVENT: &str = "ffmpeg-status";
/// The FFmpeg-Builds (BtbN) release the builds are downloaded from. It is a
/// month-end autobuild: FFmpeg-Builds keeps those for about two years, but
/// its daily ones for only about two weeks. To move to a newer one, take
/// the builds' names and checksums from its `checksums.sha256`; the
/// `pinned_builds_are_still_published` test checks them.
pub const RELEASE_URL: &str =
    "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59";

/// One of FFmpeg-Builds' static LGPL ffmpeg 8.1 builds: its archive in the
/// release, and that archive's SHA-256.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Build {
    pub archive: &'static str,
    pub sha256: &'static str,
}

pub const LINUX_X64: Build = Build {
    archive: "ffmpeg-n8.1.3-27-g8dca1586f4-linux64-lgpl-8.1.tar.xz",
    sha256: "a64f3171e6ad1f7d358d28890a907ee478c331d1177ec696a93418f79ac3f1f3",
};
pub const LINUX_ARM64: Build = Build {
    archive: "ffmpeg-n8.1.3-27-g8dca1586f4-linuxarm64-lgpl-8.1.tar.xz",
    sha256: "2ea30086a637e3f0ad0f49a1b38db34121422b85e93cc82df2e01d9ee5200809",
};
pub const WINDOWS_X64: Build = Build {
    archive: "ffmpeg-n8.1.3-27-g8dca1586f4-win64-lgpl-8.1.zip",
    sha256: "d4c2a42673917b4a97104a3e9f082729a9730796b98664e37c0b7eba6c6c613d",
};
pub const WINDOWS_ARM64: Build = Build {
    archive: "ffmpeg-n8.1.3-27-g8dca1586f4-winarm64-lgpl-8.1.zip",
    sha256: "c918142d3920f6b15282739dd523885be0586cbd8684f400acea9d4a8c97002f",
};
/// Every build Grab-it may download.
#[cfg(test)]
pub const BUILDS: [Build; 4] = [LINUX_X64, LINUX_ARM64, WINDOWS_X64, WINDOWS_ARM64];

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

/// The build for an OS and architecture, as Rust names them
/// (`std::env::consts`). None where FFmpeg-Builds publishes none, as for
/// macOS.
pub fn build_for(os: &str, arch: &str) -> Option<Build> {
    match (os, arch) {
        ("linux", "x86_64") => Some(LINUX_X64),
        ("linux", "aarch64") => Some(LINUX_ARM64),
        ("windows", "x86_64") => Some(WINDOWS_X64),
        ("windows", "aarch64") => Some(WINDOWS_ARM64),
        _ => None,
    }
}

/// This platform's build.
pub fn platform_build() -> Option<Build> {
    build_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// The executable's file name on `os`.
pub fn executable_name_for(os: &str) -> &'static str {
    if os == "windows" {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// The executable's file name on this platform.
pub fn executable_name() -> &'static str {
    executable_name_for(std::env::consts::OS)
}

/// Where the downloaded ffmpeg is kept.
pub fn installed_path(app_data: &Path) -> PathBuf {
    app_data.join(FFMPEG_DIR).join(executable_name())
}

/// What a person installs ffmpeg with on `os`, when Grab-it cannot
/// download it there.
pub fn install_command(os: &str) -> Option<&'static str> {
    match os {
        "macos" => Some("brew install ffmpeg"),
        _ => None,
    }
}

/// The directories an ffmpeg installed on `os` may be in, most likely
/// first: each one on `PATH` (`path`), then where package managers put it.
/// An app opened from the Dock, Finder or Start menu often does not have
/// those on its `PATH`, and one installed after Grab-it started never does.
/// `env` reads the other environment variables they are found from.
pub fn system_dirs(
    os: &str,
    path: Option<OsString>,
    env: impl Fn(&str) -> Option<OsString>,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let under = |var: &str, rest: &[&str]| {
        env(var).filter(|base| !base.is_empty()).map(|base| {
            rest.iter()
                .fold(PathBuf::from(base), |dir, part| dir.join(part))
        })
    };
    match os {
        "macos" => dirs.extend(
            // Homebrew on Apple silicon, then on Intel, then MacPorts.
            ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"].map(PathBuf::from),
        ),
        "windows" => dirs.extend(
            [
                // winget's links, which it adds to PATH only for apps
                // started after it.
                under("LOCALAPPDATA", &["Microsoft", "WinGet", "Links"]),
                under("ProgramData", &["chocolatey", "bin"]),
                under("USERPROFILE", &["scoop", "shims"]),
            ]
            .into_iter()
            .flatten(),
        ),
        _ => {
            dirs.extend(
                [
                    "/usr/local/bin",
                    "/usr/bin",
                    "/home/linuxbrew/.linuxbrew/bin",
                ]
                .map(PathBuf::from),
            );
            dirs.extend(under("HOME", &[".local", "bin"]));
        }
    }
    dirs.retain(|dir| dir.is_absolute());
    dirs
}

/// The ffmpegs in `dirs` called `name`, in order, each once: a directory
/// that is a link to another, such as `/bin` to `/usr/bin`, finds the
/// same one twice.
pub fn find_in(dirs: &[PathBuf], name: &str) -> Vec<PathBuf> {
    let mut seen = Vec::new();
    let mut found = Vec::new();
    for dir in dirs {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        let real = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !seen.contains(&real) {
            seen.push(real);
            found.push(path);
        }
    }
    found
}

/// Where ffmpeg comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// `$GRAB_IT_FFMPEG`, used as it is.
    Override(PathBuf),
    /// The ffmpegs already on this computer, to try in order (the copy
    /// Grab-it downloaded earlier last), then what to download when none
    /// of them can encode H.264. With no download, Settings says how to
    /// install one (`install`).
    Search {
        found: Vec<PathBuf>,
        download: Option<Download>,
        install: Option<&'static str>,
    },
}

/// A build to download, and where its ffmpeg goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Download {
    pub build: Build,
    pub to: PathBuf,
}

/// Where ffmpeg comes from, given `$GRAB_IT_FFMPEG` (`env`), the ffmpegs
/// installed on this computer (`system`), and this platform's build.
pub fn locate_with(
    app_data: &Path,
    env: Option<OsString>,
    system: Vec<PathBuf>,
    build: Option<Build>,
    install: Option<&'static str>,
) -> Source {
    if let Some(path) = env.filter(|path| !path.is_empty()) {
        return Source::Override(PathBuf::from(path));
    }
    let installed = installed_path(app_data);
    let mut found = system;
    if installed.is_file() {
        found.push(installed.clone());
    }
    Source::Search {
        found,
        download: build.map(|build| Download {
            build,
            to: installed,
        }),
        install,
    }
}

/// Where ffmpeg comes from on this machine.
pub fn locate(app_data: &Path) -> Source {
    let os = std::env::consts::OS;
    let system = find_in(
        &system_dirs(os, std::env::var_os("PATH"), |var| std::env::var_os(var)),
        executable_name(),
    );
    locate_with(
        app_data,
        std::env::var_os(FFMPEG_ENV),
        system,
        platform_build(),
        install_command(os),
    )
}

#[derive(Debug)]
pub enum FfmpegError {
    /// The download failed.
    Download(String),
    /// The download did not match its pinned checksum.
    Checksum {
        expected: String,
        actual: String,
    },
    Io(io::Error),
    /// No ffmpeg is installed, and none can be downloaded for this
    /// platform. `install` says how to install one.
    NotInstalled {
        install: Option<&'static str>,
    },
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
            Self::NotInstalled {
                install: Some(command),
            } => {
                write!(f, "ffmpeg is not installed; install it with `{command}`")
            }
            Self::NotInstalled { install: None } => f.write_str("ffmpeg is not installed"),
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

/// How long the ffmpeg download may wait to resolve the host, connect, or
/// for any single read or write before it gives up. A stalled connection
/// (Wi-Fi drop, sleep, hung proxy) then fails the download, so Settings
/// offers Retry instead of waiting forever.
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(30);

/// An HTTP agent whose every network phase gives up after `stall`
/// without progress. ureq has no timeouts by default. Certificates are
/// checked against the OS trust store (`net::tls_config`).
pub(crate) fn download_agent(stall: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .tls_config(crate::net::tls_config())
        .timeout_resolve(Some(stall))
        .timeout_connect(Some(stall))
        .timeout_send_request(Some(stall))
        .timeout_recv_response(Some(stall))
        .timeout_per_read(Some(stall))
        .timeout_per_write(Some(stall))
        .build()
        .new_agent()
}

/// Downloads `build` from the release and installs its ffmpeg as the
/// executable `to`. `progress` gets the bytes downloaded so far and the
/// total (0 when the server does not say).
pub fn download(build: Build, to: &Path, progress: impl FnMut(u64, u64)) -> FfmpegResult<()> {
    download_from(
        &download_agent(DOWNLOAD_STALL_TIMEOUT),
        RELEASE_URL,
        build,
        executable_name(),
        to,
        progress,
    )
}

/// [`download`] from the release at `base_url`, taking the executable
/// `name` out of the archive. The archive is written and unpacked beside
/// `to`, and the executable renamed into place only once the archive's
/// checksum matched, so a cut-off or damaged download is never mistaken for
/// ffmpeg.
fn download_from(
    agent: &ureq::Agent,
    base_url: &str,
    build: Build,
    name: &str,
    to: &Path,
    mut progress: impl FnMut(u64, u64),
) -> FfmpegResult<()> {
    let dir = to.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    // Unique per download, so parallel downloads (tests) never share one.
    static NEXT_PART: AtomicU64 = AtomicU64::new(0);
    let suffix = format!(
        "part-{}-{}",
        std::process::id(),
        NEXT_PART.fetch_add(1, Ordering::Relaxed)
    );
    let archive = dir.join(format!("{}.{suffix}", build.archive));
    let unpacked = dir.join(format!("{name}.{suffix}"));
    let result = (|| -> FfmpegResult<()> {
        let actual = download_hashed(
            agent,
            &format!("{base_url}/{}", build.archive),
            &archive,
            &mut progress,
        )?;
        if actual != build.sha256 {
            return Err(FfmpegError::Checksum {
                expected: build.sha256.to_owned(),
                actual,
            });
        }
        unpack(&archive, build.archive, name, &unpacked)?;
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

/// Whether `path`, inside a build's archive, is its executable `name`:
/// `bin/<name>` in the build's own top folder.
fn is_executable_entry(path: &Path, name: &str) -> bool {
    path.file_name().is_some_and(|file| file == name)
        && path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|dir| dir == "bin")
}

/// Takes the executable `name` out of the archive `from` (`archive` names
/// how it is packed: `.tar.xz` or `.zip`) and writes it to `to`.
fn unpack(from: &Path, archive: &str, name: &str, to: &Path) -> FfmpegResult<()> {
    let damaged = |err: &dyn fmt::Display| {
        FfmpegError::Download(format!("could not unpack {archive}: {err}"))
    };
    let file = BufReader::new(fs::File::open(from)?);
    let mut out = fs::File::create(to)?;
    if archive.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(file).map_err(|err| damaged(&err))?;
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).map_err(|err| damaged(&err))?;
            if entry
                .enclosed_name()
                .is_some_and(|path| is_executable_entry(&path, name))
            {
                io::copy(&mut entry, &mut out).map_err(|err| damaged(&err))?;
                out.sync_all()?;
                return Ok(());
            }
        }
    } else {
        // bin/ffmpeg comes first in FFmpeg-Builds' archives, so little more
        // than it is decompressed.
        let xz = lzma_rust2::XzReader::new(file, true);
        let mut tar = tar::Archive::new(xz);
        for entry in tar.entries().map_err(|err| damaged(&err))? {
            let mut entry = entry.map_err(|err| damaged(&err))?;
            let wanted = entry
                .path()
                .is_ok_and(|path| is_executable_entry(&path, name));
            if wanted {
                io::copy(&mut entry, &mut out).map_err(|err| damaged(&err))?;
                out.sync_all()?;
                return Ok(());
            }
        }
    }
    Err(damaged(&format!("it has no bin/{name}")))
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
/// x264, the better software encoder. It is GPL, so the LGPL builds
/// Grab-it downloads leave it out, but most ffmpegs installed from a
/// package manager have it.
pub const X264: Encoder = Encoder::new("libx264", "yuv420p");
/// Cisco's software encoder, in every build Grab-it downloads: the last
/// resort.
pub const OPENH264: Encoder = Encoder::new("libopenh264", "yuv420p");

/// The encoders to try on `os` (`std::env::consts::OS`), in order:
/// the platform's hardware encoders, then x264, then OpenH264.
pub fn candidates(os: &str) -> Vec<Encoder> {
    let mut list = match os {
        "macos" => vec![VIDEOTOOLBOX],
        "windows" => vec![NVENC, QSV, AMF, MEDIA_FOUNDATION],
        "linux" => vec![NVENC, VAAPI],
        _ => Vec::new(),
    };
    list.extend([X264, OPENH264]);
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
            let said = self.close(PROBE_TIMEOUT, || false).err();
            return Err(said.unwrap_or_else(|| FfmpegError::Encode(err.to_string())));
        }
        Ok(())
    }

    /// Ends the video and waits for ffmpeg to finish the file.
    pub fn finish(self) -> FfmpegResult<()> {
        self.finish_within(FINISH_TIMEOUT)
    }

    /// Finishes the video or stops and reaps the encoder on cancellation.
    pub(crate) fn finish_cancellable(mut self, cancelled: impl Fn() -> bool) -> FfmpegResult<()> {
        self.close(FINISH_TIMEOUT, cancelled)
    }

    fn finish_within(mut self, timeout: Duration) -> FfmpegResult<()> {
        self.close(timeout, || false)
    }

    /// Closes stdin and waits for ffmpeg to exit, time out or be cancelled.
    fn close(&mut self, timeout: Duration, cancelled: impl Fn() -> bool) -> FfmpegResult<()> {
        drop(self.stdin.take());
        let status = wait_for_unless(&mut self.child, timeout, &cancelled);
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
            None if cancelled() => Err(FfmpegError::Encode("cancelled".into())),
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
pub(crate) const AUDIO_BITRATE: &str = "160k";
/// Ends the name of the file the sound is muxed into, beside the video.
const MUXING_SUFFIX: &str = ".muxing.mp4";

/// One WAV muxed into a recording, and when it starts against the first
/// frame, in seconds (see `audio::offset`).
#[derive(Debug, Clone, Copy)]
pub struct AudioTrack<'a> {
    pub wav: &'a Path,
    pub offset: f64,
    /// Whether it is the microphone, the only sound noise is removed
    /// from: never system sound.
    pub microphone: bool,
}

/// Escapes `value` for one filter option in an ffmpeg filter graph: once
/// for the option (`\`, `'` and `:`), then again for the graph (`\`,
/// `'`, `[`, `]`, `,` and `;`). A Windows path holds `\` and `:`.
fn escape_filter_value(value: &str) -> String {
    let escape = |text: &str, special: &[char]| {
        let mut escaped = String::with_capacity(text.len());
        for ch in text.chars() {
            if special.contains(&ch) {
                escaped.push('\\');
            }
            escaped.push(ch);
        }
        escaped
    };
    escape(
        &escape(value, &['\\', '\'', ':']),
        &['\\', '\'', '[', ']', ',', ';'],
    )
}

/// The filter that removes background noise with the RNNoise model at
/// `model` (ffmpeg's `arnndn`), followed by a comma, or nothing for
/// `None` or a track other than the microphone.
fn denoise(track: &AudioTrack<'_>, model: Option<&Path>) -> String {
    match model {
        Some(model) if track.microphone => format!("{},", noise_filter(model)),
        _ => String::new(),
    }
}

/// The `arnndn` filter that removes background noise with the RNNoise
/// model at `model`, its path escaped for a filter graph.
pub fn noise_filter(model: &Path) -> String {
    format!("arnndn=m={}", escape_filter_value(&model.to_string_lossy()))
}

/// The channels and rate each sound is brought to before two are mixed.
pub const MIX_FORMAT: &str = "aformat=sample_rates=48000:channel_layouts=stereo";

/// The filter that mixes `inputs` sounds into one. Not normalised: each
/// keeps its own level rather than being turned down by the number mixed.
pub fn mix(inputs: usize) -> String {
    format!("amix=inputs={inputs}:duration=longest:dropout_transition=0:normalize=0")
}

/// Adds each WAV of `tracks` to `args` as an input, its start cut by
/// `-ss` when it started before the first frame. Returns how long each
/// is to be delayed instead, in whole milliseconds.
fn push_audio_inputs(args: &mut Vec<OsString>, tracks: &[AudioTrack<'_>]) -> Vec<i64> {
    let mut delays = Vec::with_capacity(tracks.len());
    for track in tracks {
        let millis = (track.offset * 1000.0).round() as i64;
        if millis < 0 {
            args.push("-ss".into());
            args.push(format!("{:.3}", millis.unsigned_abs() as f64 / 1000.0).into());
        }
        args.push("-i".into());
        args.push(track.wav.as_os_str().to_owned());
        delays.push(millis.max(0));
    }
    delays
}

/// The filter that delays a sound by `millis` with silence, followed by a
/// comma, or nothing for no delay.
fn delay(millis: i64) -> String {
    if millis > 0 {
        format!("adelay=delays={millis}:all=1,")
    } else {
        String::new()
    }
}

/// ffmpeg's arguments to mux the WAVs `tracks` into the MP4 `video` as one
/// AAC track (ffmpeg's own `aac` encoder), writing `output`. The video is
/// copied as it is. Each WAV is shifted by its offset: sound that started
/// later is delayed with silence, and sound that started earlier has its
/// start cut. Two or more are brought to 48 kHz stereo and mixed with
/// `amix` at their own levels. The sound is padded or cut to `duration`,
/// the video's length. With `noise_model`, background noise is first
/// removed from the microphone alone with that RNNoise model.
pub fn mux_args(
    video: &Path,
    tracks: &[AudioTrack<'_>],
    noise_model: Option<&Path>,
    duration: Duration,
    output: &Path,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-y", "-i"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(video.as_os_str().to_owned());
    let delays = push_audio_inputs(&mut args, tracks);
    let mut push = |arg: &str| args.push(OsString::from(arg));
    if let &[millis] = delays.as_slice() {
        for arg in ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af"] {
            push(arg);
        }
        push(&format!(
            "{}{}apad",
            denoise(&tracks[0], noise_model),
            delay(millis)
        ));
    } else {
        let mut graph = String::new();
        for (index, (track, millis)) in tracks.iter().zip(&delays).enumerate() {
            graph.push_str(&format!(
                "[{}:a]{}{}{MIX_FORMAT}[a{index}];",
                index + 1,
                denoise(track, noise_model),
                delay(*millis)
            ));
        }
        for index in 0..delays.len() {
            graph.push_str(&format!("[a{index}]"));
        }
        graph.push_str(&format!("{},apad[mix]", mix(delays.len())));
        for arg in [
            "-filter_complex",
            graph.as_str(),
            "-map",
            "0:v:0",
            "-map",
            "[mix]",
            "-c:v",
            "copy",
        ] {
            push(arg);
        }
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

/// Muxes the WAVs `tracks` into the MP4 `video` in place, as [`mux_args`]
/// says. The video is replaced only once the muxed copy is finished, so
/// on failure it is left as it was, silent.
pub fn add_audio(
    ffmpeg: &Path,
    video: &Path,
    tracks: &[AudioTrack<'_>],
    noise_model: Option<&Path>,
    duration: Duration,
) -> FfmpegResult<()> {
    let output = crate::capture::sidecar_path(video, MUXING_SUFFIX);
    let result = run(
        ffmpeg,
        mux_args(video, tracks, noise_model, duration, &output),
        FINISH_TIMEOUT,
    )
    .and_then(|()| fs::rename(&output, video).map_err(FfmpegError::from));
    if result.is_err() {
        let _ = fs::remove_file(&output);
    }
    result
}

/// ffmpeg's arguments to write the WAVs `tracks` to `output`, an M4A
/// holding each as its own AAC stream, in their order and unmixed. Each
/// is shifted by its offset and padded or cut to `duration` as
/// [`mux_args`] does, so every stream lines up with the video, but is
/// otherwise left as it was heard: no filter, no change of rate or
/// channels.
pub fn sound_args(tracks: &[AudioTrack<'_>], duration: Duration, output: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-y"]
        .into_iter()
        .map(OsString::from)
        .collect();
    let delays = push_audio_inputs(&mut args, tracks);
    let graph = delays
        .iter()
        .enumerate()
        .map(|(index, millis)| format!("[{index}:a]{}apad[s{index}]", delay(*millis)))
        .collect::<Vec<_>>()
        .join(";");
    args.push("-filter_complex".into());
    args.push(graph.into());
    for index in 0..delays.len() {
        args.push("-map".into());
        args.push(format!("[s{index}]").into());
    }
    for arg in ["-c:a", "aac", "-b:a", AUDIO_BITRATE, "-t"] {
        args.push(arg.into());
    }
    args.push(format!("{:.3}", duration.as_secs_f64()).into());
    for arg in ["-movflags", "+faststart"] {
        args.push(arg.into());
    }
    args.push(output.as_os_str().to_owned());
    args
}

/// Writes the WAVs `tracks` to `output` as [`sound_args`] says. On
/// failure nothing is left at `output`.
pub fn write_sound(
    ffmpeg: &Path,
    tracks: &[AudioTrack<'_>],
    duration: Duration,
    output: &Path,
) -> FfmpegResult<()> {
    let result = run(ffmpeg, sound_args(tracks, duration, output), FINISH_TIMEOUT);
    if result.is_err() {
        let _ = fs::remove_file(output);
    }
    result
}

/// Runs `ffmpeg` with `args` to the end, for up to `timeout`. Fails with
/// the last line it printed when it fails.
pub(crate) fn run(ffmpeg: &Path, args: Vec<OsString>, timeout: Duration) -> FfmpegResult<()> {
    run_cancellable(ffmpeg, args, timeout, || false)
}

/// Runs ffmpeg until it finishes, times out, or cancellation is requested.
/// Reaps the child before returning so its output can be removed.
pub(crate) fn run_cancellable(
    ffmpeg: &Path,
    args: Vec<OsString>,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> FfmpegResult<()> {
    let mut child = command(ffmpeg)
        .args(args)
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
    let status = wait_for_unless(&mut child, timeout, &cancelled);
    let said = stderr
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    match status {
        Some(status) if status.success() => Ok(()),
        Some(status) => Err(FfmpegError::Encode(match last_line(&said) {
            Some(line) => line.to_owned(),
            None => format!("it exited with {status}"),
        })),
        None if cancelled() => Err(FfmpegError::Encode("cancelled".into())),
        None => Err(FfmpegError::Encode(format!(
            "it did not finish within {} seconds",
            timeout.as_secs()
        ))),
    }
}

/// The last line ffmpeg printed, if any.
pub(crate) fn last_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).rfind(|line| !line.is_empty())
}

/// Waits up to `timeout` for `child`, killing it if it has not exited.
pub(crate) fn wait_for(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    wait_for_unless(child, timeout, || false)
}

fn wait_for_unless(
    child: &mut Child,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if !cancelled() && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// What ffmpeg says a video or GIF holds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Probe {
    /// How long it runs, in milliseconds, when ffmpeg says.
    pub duration_ms: Option<u64>,
    /// Its first video stream's size, when ffmpeg says.
    pub size: Option<(u32, u32)>,
    /// Whether it has a sound stream.
    pub audio: bool,
}

/// Reads `Duration: 00:00:46.12`, the first video stream's `1920x1080`
/// and whether there is an `Audio:` stream from what `ffmpeg -i` prints
/// about a file.
pub fn parse_probe(said: &str) -> Probe {
    let duration_ms = said.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("Duration:")?;
        let stamp = rest.split(',').next()?.trim();
        let mut parts = stamp.split(':');
        let hours: f64 = parts.next()?.parse().ok()?;
        let minutes: f64 = parts.next()?.parse().ok()?;
        let seconds: f64 = parts.next()?.parse().ok()?;
        let total = (hours * 3600.0 + minutes * 60.0 + seconds) * 1000.0;
        (total.is_finite() && total >= 0.0).then(|| total.round() as u64)
    });
    let size = said
        .lines()
        .filter(|line| line.contains("Stream #") && line.contains("Video:"))
        .find_map(|line| {
            line.split([' ', ',']).find_map(|word| {
                let (width, height) = word.split_once('x')?;
                let width: u32 = width.parse().ok()?;
                let height: u32 = height.parse().ok()?;
                (width > 0 && height > 0).then_some((width, height))
            })
        });
    let audio = said
        .lines()
        .any(|line| line.contains("Stream #") && line.contains("Audio:"));
    Probe {
        duration_ms,
        size,
        audio,
    }
}

/// What ffmpeg says `video` holds; empty when it cannot say.
pub fn probe_file(ffmpeg: &Path, video: &Path) -> Probe {
    probe_file_cancellable(ffmpeg, video, || false)
}

/// Probes the file, stopping and reaping ffmpeg if the export is cancelled.
pub(crate) fn probe_file_cancellable(
    ffmpeg: &Path,
    video: &Path,
    cancelled: impl Fn() -> bool,
) -> Probe {
    let said = command(ffmpeg)
        .arg("-hide_banner")
        .arg("-i")
        .arg(video)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .ok()
        .and_then(|mut child| {
            let reader = child.stderr.take().map(|mut stderr| {
                thread::spawn(move || {
                    let mut text = String::new();
                    let _ = stderr.read_to_string(&mut text);
                    text
                })
            });
            // ffmpeg exits with an error here (no output named), after
            // printing what the file holds.
            wait_for_unless(&mut child, Duration::from_secs(10), cancelled);
            reader.and_then(|reader| reader.join().ok())
        });
    said.as_deref().map(parse_probe).unwrap_or_default()
}

/// One frame of `video`, `at_ms` in, fitted inside `max` × `max` pixels.
/// Decoded through a temporary PNG: a pipe would fill and stall ffmpeg
/// while it waits to be read.
pub fn video_frame(
    ffmpeg: &Path,
    video: &Path,
    at_ms: u64,
    max: u32,
) -> Result<image::DynamicImage, String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let frame = std::env::temp_dir().join(format!(
        "grab-it-frame-{}-{}.png",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let args: Vec<OsString> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        format!("{:.3}", at_ms as f64 / 1000.0).into(),
        "-i".into(),
        video.into(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        format!("scale={max}:{max}:force_original_aspect_ratio=decrease").into(),
        "-y".into(),
        frame.clone().into(),
    ];
    let image = run(ffmpeg, args, Duration::from_secs(10))
        .map_err(|err| err.to_string())
        .and_then(|()| image::open(&frame).map_err(|err| err.to_string()));
    let _ = fs::remove_file(&frame);
    image.map_err(|err| format!("could not read a frame of {}: {err}", video.display()))
}

/// Where in a recording its preview frame is taken: a second in, or
/// halfway through a shorter one, so it is rarely the blank first frame.
pub fn preview_at_ms(duration_ms: Option<u64>) -> u64 {
    duration_ms.map_or(1000, |duration| duration.min(2000) / 2)
}

/// Where ffmpeg is up to. Mirrors `FfmpegStatus` in src/settings/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum FfmpegStatus {
    /// Not looked for yet: nothing has asked for MP4.
    Missing,
    /// Being downloaded; `total` is 0 until the server says.
    Downloading { downloaded: u64, total: u64 },
    /// Found; its encoders are being tried.
    Checking,
    /// Ready to record with the ffmpeg at `path` and its `encoder`.
    Ready { path: String, encoder: String },
    /// No ffmpeg is installed, and none can be downloaded for this
    /// platform. `install` is the command that installs one, if known.
    /// Retry looks again.
    NotInstalled { install: Option<String> },
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
        match &source {
            Source::Search {
                found,
                download: Some(_),
                ..
            } if found.is_empty() => FfmpegStatus::Downloading {
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
                    let status = FfmpegStatus::Ready {
                        path: ready.path.display().to_string(),
                        encoder: ready.encoder.name.to_owned(),
                    };
                    state.lock().ready = Some(ready);
                    // Recordings found before now get their length, size
                    // and preview.
                    crate::library::rescan_in_background(
                        &handle,
                        crate::library::current_save_folder(&handle),
                    );
                    status
                }
                Err(FfmpegError::NotInstalled { install }) => FfmpegStatus::NotInstalled {
                    install: install.map(str::to_owned),
                },
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

/// Gets ffmpeg from `source`: the first ffmpeg found that can encode
/// H.264, or else one downloaded with progress, and its encoder.
fn prepare(app: &AppHandle, source: Source) -> FfmpegResult<Ready> {
    let (found, download_to, install) = match source {
        Source::Override(path) => {
            if !path.is_file() {
                return Err(FfmpegError::Missing(path));
            }
            let encoder = choose_encoder(&path).ok_or(FfmpegError::NoEncoder)?;
            return Ok(Ready { path, encoder });
        }
        Source::Search {
            found,
            download,
            install,
        } => (found, download, install),
    };
    let installed = installed_path(&app.state::<FfmpegState>().app_data);
    for path in &found {
        set_status(app, FfmpegStatus::Checking);
        if let Some(encoder) = choose_encoder(path) {
            return Ok(Ready {
                path: path.clone(),
                encoder,
            });
        }
        // A copy Grab-it downloaded earlier may be damaged: fetch it again.
        if *path == installed {
            let _ = fs::remove_file(path);
        }
    }
    let Some(Download { build, to }) = download_to else {
        return Err(if found.is_empty() {
            FfmpegError::NotInstalled { install }
        } else {
            FfmpegError::NoEncoder
        });
    };
    set_status(
        app,
        FfmpegStatus::Downloading {
            downloaded: 0,
            total: 0,
        },
    );
    let mut last_percent = None;
    download(build, &to, |downloaded, total| {
        // Every percent, or every megabyte while the size is unknown.
        let step = (downloaded * 100)
            .checked_div(total)
            .unwrap_or(downloaded >> 20);
        if last_percent != Some(step) {
            last_percent = Some(step);
            set_status(app, FfmpegStatus::Downloading { downloaded, total });
        }
    })?;
    set_status(app, FfmpegStatus::Checking);
    // Just downloaded and checked, so kept even when no encoder works.
    let encoder = choose_encoder(&to).ok_or(FfmpegError::NoEncoder)?;
    Ok(Ready { path: to, encoder })
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
        FfmpegStatus::NotInstalled { .. } => {
            "Saved as a GIF: MP4 needs ffmpeg, which is not installed. See Settings → Recording."
                .to_owned()
        }
        FfmpegStatus::Failed { .. } => {
            "Saved as a GIF: ffmpeg, which MP4 needs, could not be set up. See Settings → Recording."
                .to_owned()
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn ffmpeg_status(app: AppHandle) -> FfmpegStatus {
    status(&app)
}

/// Looks again for ffmpeg, downloading it or finding an encoder. Returns the status
/// as the new attempt starts.
#[tauri::command]
#[specta::specta]
pub fn ffmpeg_retry(app: AppHandle) -> FfmpegStatus {
    prepare_in_background(&app);
    status(&app)
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_probe_reads_the_length_and_size() {
        let said = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Metadata:
    encoder         : Lavf61.7.100
  Duration: 00:01:02.50, start: 0.000000, bitrate: 1785 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1650 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)
At least one output file must be specified";
        assert_eq!(
            parse_probe(said),
            Probe {
                duration_ms: Some(62_500),
                size: Some((1920, 1080)),
                audio: true,
            }
        );
    }

    #[test]
    fn a_gif_probe_reads_its_size_and_a_missing_length_is_none() {
        let said = "Input #0, gif, from 'a.gif':
  Duration: N/A, bitrate: N/A
  Stream #0:0: Video: gif, bgra, 640x360, 10 fps, 10 tbr, 100 tbn";
        assert_eq!(
            parse_probe(said),
            Probe {
                duration_ms: None,
                size: Some((640, 360)),
                audio: false,
            }
        );
        assert_eq!(parse_probe(""), Probe::default());
    }

    #[test]
    fn a_probe_tells_a_silent_video_from_one_with_sound() {
        let silent = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Metadata:
    title           : Audio: none
  Duration: 00:00:05.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1280x720, 30 fps";
        assert!(!parse_probe(silent).audio);
        let sound =
            format!("{silent}\n  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp");
        assert!(parse_probe(&sound).audio);
    }

    #[test]
    fn the_preview_frame_is_a_second_in_or_halfway_through() {
        assert_eq!(preview_at_ms(Some(46_000)), 1000);
        assert_eq!(preview_at_ms(Some(600)), 300);
        assert_eq!(preview_at_ms(None), 1000);
    }

    use super::*;
    use std::net::TcpListener;

    #[test]
    fn each_platform_but_macos_has_its_build() {
        assert_eq!(build_for("linux", "x86_64"), Some(LINUX_X64));
        assert_eq!(build_for("linux", "aarch64"), Some(LINUX_ARM64));
        assert_eq!(build_for("windows", "x86_64"), Some(WINDOWS_X64));
        assert_eq!(build_for("windows", "aarch64"), Some(WINDOWS_ARM64));
        assert_eq!(build_for("macos", "aarch64"), None);
        assert_eq!(build_for("macos", "x86_64"), None);
        assert_eq!(install_command("macos"), Some("brew install ffmpeg"));
        assert_eq!(install_command("linux"), None);
        for build in BUILDS {
            assert_eq!(build.sha256.len(), 64, "{}", build.archive);
            assert!(
                build
                    .sha256
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            );
            assert!(
                build.archive.contains("-lgpl-"),
                "{} is not LGPL",
                build.archive
            );
        }
    }

    #[cfg(unix)]
    fn no_env(_: &str) -> Option<OsString> {
        None
    }

    #[test]
    #[cfg(unix)]
    fn path_comes_before_where_package_managers_put_ffmpeg() {
        let path = std::env::join_paths(["/custom/bin", "relative/bin", "/usr/bin"]).unwrap();
        assert_eq!(
            system_dirs("macos", Some(path.clone()), no_env),
            [
                "/custom/bin",
                "/usr/bin",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/opt/local/bin"
            ]
            .map(PathBuf::from)
        );
        let home = |var: &str| (var == "HOME").then(|| OsString::from("/home/me"));
        assert_eq!(
            system_dirs("linux", Some(path), home),
            [
                "/custom/bin",
                "/usr/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/home/linuxbrew/.linuxbrew/bin",
                "/home/me/.local/bin"
            ]
            .map(PathBuf::from)
        );
        assert_eq!(system_dirs("linux", None, no_env).len(), 3);
    }

    #[test]
    #[cfg(windows)]
    fn windows_looks_where_winget_chocolatey_and_scoop_put_ffmpeg() {
        let env = |var: &str| match var {
            "LOCALAPPDATA" => Some(OsString::from(r"C:\Users\me\AppData\Local")),
            "ProgramData" => Some(OsString::from(r"C:\ProgramData")),
            "USERPROFILE" => Some(OsString::from(r"C:\Users\me")),
            _ => None,
        };
        assert_eq!(
            system_dirs("windows", Some(OsString::from(r"C:\Tools")), env),
            [
                r"C:\Tools",
                r"C:\Users\me\AppData\Local\Microsoft\WinGet\Links",
                r"C:\ProgramData\chocolatey\bin",
                r"C:\Users\me\scoop\shims"
            ]
            .map(PathBuf::from)
        );
    }

    #[test]
    #[cfg(unix)]
    fn each_installed_ffmpeg_is_found_once_in_order() {
        let root = tempfile::tempdir().unwrap();
        let [first, second, empty] = ["first", "second", "empty"].map(|dir| {
            let dir = root.path().join(dir);
            fs::create_dir_all(&dir).unwrap();
            dir
        });
        fs::write(first.join("ffmpeg"), b"").unwrap();
        fs::write(second.join("ffmpeg"), b"").unwrap();
        // A directory linked to one already searched finds the same ffmpeg.
        let linked = root.path().join("linked");
        std::os::unix::fs::symlink(&first, &linked).unwrap();
        // A directory called ffmpeg is not one.
        fs::create_dir_all(empty.join("ffmpeg")).unwrap();
        assert_eq!(
            find_in(
                &[
                    empty,
                    second.clone(),
                    linked,
                    first,
                    root.path().join("gone")
                ],
                "ffmpeg"
            ),
            [
                second.join("ffmpeg"),
                root.path().join("linked").join("ffmpeg")
            ]
        );
    }

    #[test]
    fn the_override_comes_first_then_installed_ffmpegs_then_a_download() {
        let dir = tempfile::tempdir().unwrap();
        let installed = installed_path(dir.path());
        let system = vec![PathBuf::from("/usr/bin/ffmpeg")];
        assert_eq!(
            locate_with(
                dir.path(),
                Some("/opt/ffmpeg".into()),
                system.clone(),
                Some(LINUX_X64),
                None
            ),
            Source::Override(PathBuf::from("/opt/ffmpeg"))
        );
        assert_eq!(
            locate_with(
                dir.path(),
                Some("".into()),
                system.clone(),
                Some(LINUX_X64),
                None
            ),
            Source::Search {
                found: system.clone(),
                download: Some(Download {
                    build: LINUX_X64,
                    to: installed.clone()
                }),
                install: None,
            }
        );
        assert_eq!(
            locate_with(
                dir.path(),
                None,
                Vec::new(),
                None,
                Some("brew install ffmpeg")
            ),
            Source::Search {
                found: Vec::new(),
                download: None,
                install: Some("brew install ffmpeg"),
            }
        );

        // The copy downloaded earlier is tried after the system's.
        fs::create_dir_all(installed.parent().unwrap()).unwrap();
        fs::write(&installed, b"ffmpeg").unwrap();
        let Source::Search { found, .. } =
            locate_with(dir.path(), None, system, Some(LINUX_X64), None)
        else {
            panic!("expected a search");
        };
        assert_eq!(found, [PathBuf::from("/usr/bin/ffmpeg"), installed.clone()]);
        assert_eq!(installed.parent().unwrap(), dir.path().join(FFMPEG_DIR));
    }

    #[test]
    fn not_installed_says_how_to_install_it() {
        assert_eq!(
            FfmpegError::NotInstalled {
                install: Some("brew install ffmpeg")
            }
            .to_string(),
            "ffmpeg is not installed; install it with `brew install ffmpeg`"
        );
        assert_eq!(
            serde_json::to_value(FfmpegStatus::NotInstalled {
                install: Some("brew install ffmpeg".into())
            })
            .unwrap(),
            serde_json::json!({ "state": "notInstalled", "install": "brew install ffmpeg" })
        );
    }

    #[test]
    fn hardware_encoders_are_tried_before_x264_then_openh264() {
        let names = |os: &str| candidates(os).iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(
            names("macos"),
            ["h264_videotoolbox", "libx264", "libopenh264"]
        );
        assert_eq!(
            names("windows"),
            [
                "h264_nvenc",
                "h264_qsv",
                "h264_amf",
                "h264_mf",
                "libx264",
                "libopenh264"
            ]
        );
        assert_eq!(
            names("linux"),
            ["h264_nvenc", "h264_vaapi", "libx264", "libopenh264"]
        );
        assert_eq!(names("freebsd"), ["libx264", "libopenh264"]);
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
                &[AudioTrack {
                    wav: Path::new("/tmp/mic.wav"),
                    offset,
                    microphone: true,
                }],
                None,
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
    fn the_microphone_and_system_sound_are_mixed_into_one_track() {
        let args = |microphone: f64, system: f64| {
            mux_args(
                Path::new("/rec/clip.mp4"),
                &[
                    AudioTrack {
                        wav: Path::new("/tmp/mic.wav"),
                        offset: microphone,
                        microphone: true,
                    },
                    AudioTrack {
                        wav: Path::new("/tmp/system.wav"),
                        offset: system,
                        microphone: false,
                    },
                ],
                None,
                Duration::from_millis(12_345),
                Path::new("/rec/clip.muxing.mp4"),
            )
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect::<Vec<_>>()
        };
        // The microphone started 250 ms early and the system sound 120 ms
        // late: one has its start cut, the other is delayed.
        assert_eq!(
            args(-0.25, 0.12).join(" "),
            "-hide_banner -loglevel error -y -i /rec/clip.mp4 \
             -ss 0.250 -i /tmp/mic.wav -i /tmp/system.wav \
             -filter_complex \
             [1:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];\
             [2:a]adelay=delays=120:all=1,aformat=sample_rates=48000:channel_layouts=stereo[a1];\
             [a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad[mix] \
             -map 0:v:0 -map [mix] -c:v copy -c:a aac -b:a 160k -t 12.345 \
             -movflags +faststart /rec/clip.muxing.mp4"
        );
        // The graph is one argument, and there is one sound track.
        let both = args(0.0, -0.5);
        let graph = both
            .iter()
            .position(|arg| arg == "-filter_complex")
            .unwrap()
            + 1;
        assert!(both[graph].starts_with("[1:a]aformat="), "{}", both[graph]);
        assert_eq!(both.iter().filter(|arg| *arg == "-map").count(), 2);
        assert!(!both.iter().any(|arg| arg == "-af"));
        assert!(
            both.join(" ")
                .contains("-i /tmp/mic.wav -ss 0.500 -i /tmp/system.wav")
        );
    }

    /// The tracks of a recording with the microphone, and with system
    /// sound when `system`, muxed with noise removed by `model`.
    fn denoised(system: bool, model: &str) -> Vec<String> {
        let mut tracks = vec![AudioTrack {
            wav: Path::new("/tmp/mic.wav"),
            offset: 0.12,
            microphone: true,
        }];
        if system {
            tracks.push(AudioTrack {
                wav: Path::new("/tmp/system.wav"),
                offset: 0.0,
                microphone: false,
            });
        }
        mux_args(
            Path::new("/rec/clip.mp4"),
            &tracks,
            Some(Path::new(model)),
            Duration::from_millis(12_345),
            Path::new("/rec/clip.muxing.mp4"),
        )
        .into_iter()
        .map(|arg| arg.into_string().unwrap())
        .collect()
    }

    /// The argument after `flag` in `args`.
    fn after<'a>(args: &'a [String], flag: &str) -> &'a str {
        let at = args.iter().position(|arg| arg == flag).unwrap();
        &args[at + 1]
    }

    #[test]
    fn noise_is_removed_from_the_microphone_alone() {
        let args = denoised(false, "/opt/grab-it/noise-models/bd.rnnn");
        // Before it is delayed and padded, so the delay's silence is not
        // run through the model.
        assert_eq!(
            after(&args, "-af"),
            "arnndn=m=/opt/grab-it/noise-models/bd.rnnn,adelay=delays=120:all=1,apad"
        );
    }

    #[test]
    fn noise_is_removed_from_the_microphone_but_not_system_sound() {
        let args = denoised(true, "/opt/grab-it/noise-models/bd.rnnn");
        let graph = after(&args, "-filter_complex");
        assert_eq!(
            graph,
            "[1:a]arnndn=m=/opt/grab-it/noise-models/bd.rnnn,adelay=delays=120:all=1,\
             aformat=sample_rates=48000:channel_layouts=stereo[a0];\
             [2:a]aformat=sample_rates=48000:channel_layouts=stereo[a1];\
             [a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad[mix]"
        );
        assert_eq!(graph.matches("arnndn").count(), 1);
    }

    #[test]
    fn system_sound_alone_is_never_denoised() {
        let args = mux_args(
            Path::new("/rec/clip.mp4"),
            &[AudioTrack {
                wav: Path::new("/tmp/system.wav"),
                offset: 0.0,
                microphone: false,
            }],
            Some(Path::new("/opt/bd.rnnn")),
            Duration::from_millis(12_345),
            Path::new("/rec/clip.muxing.mp4"),
        );
        assert!(
            !args
                .iter()
                .any(|arg| arg.to_string_lossy().contains("arnndn"))
        );
    }

    #[test]
    fn a_windows_model_path_is_escaped_for_the_filter_graph() {
        let args = denoised(true, r"C:\Program Files\Grab-it\noise-models\bd.rnnn");
        let graph = after(&args, "-filter_complex");
        // `\` and `:` escaped for the option, then each `\` again for the
        // graph.
        assert!(
            graph.starts_with(
                r"[1:a]arnndn=m=C\\:\\\\Program Files\\\\Grab-it\\\\noise-models\\\\bd.rnnn,adelay="
            ),
            "{graph}"
        );
        // The graph's own separators in a path are escaped too.
        assert_eq!(
            escape_filter_value("/a,b;c[d]'e'"),
            r"/a\,b\;c\[d\]\\\'e\\\'"
        );
    }

    #[test]
    fn the_microphone_alone_is_kept_as_one_aligned_stream() {
        let args = |offset: f64| {
            sound_args(
                &[AudioTrack {
                    wav: Path::new("/tmp/mic.wav"),
                    offset,
                    microphone: true,
                }],
                Duration::from_millis(12_345),
                Path::new("/rec/clip.sound.m4a"),
            )
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect::<Vec<_>>()
            .join(" ")
        };
        // Started 250 ms before the first frame: its start is cut.
        assert_eq!(
            args(-0.25),
            "-hide_banner -loglevel error -y -ss 0.250 -i /tmp/mic.wav \
             -filter_complex [0:a]apad[s0] -map [s0] -c:a aac -b:a 160k -t 12.345 \
             -movflags +faststart /rec/clip.sound.m4a"
        );
        // Started 120 ms after: delayed by as much, and never resampled.
        let later = args(0.12);
        assert!(
            later.contains("-i /tmp/mic.wav -filter_complex [0:a]adelay=delays=120:all=1,apad[s0]"),
            "{later}"
        );
        assert!(!later.contains("aformat"), "{later}");
    }

    #[test]
    fn the_microphone_and_system_sound_are_kept_as_separate_streams() {
        let args = sound_args(
            &[
                AudioTrack {
                    wav: Path::new("/tmp/mic.wav"),
                    offset: -0.25,
                    microphone: true,
                },
                AudioTrack {
                    wav: Path::new("/tmp/system.wav"),
                    offset: 0.12,
                    microphone: false,
                },
            ],
            Duration::from_millis(12_345),
            Path::new("/rec/clip.sound.m4a"),
        )
        .into_iter()
        .map(|arg| arg.into_string().unwrap())
        .collect::<Vec<_>>();
        assert_eq!(
            args.join(" "),
            "-hide_banner -loglevel error -y -ss 0.250 -i /tmp/mic.wav -i /tmp/system.wav \
             -filter_complex [0:a]apad[s0];[1:a]adelay=delays=120:all=1,apad[s1] \
             -map [s0] -map [s1] -c:a aac -b:a 160k -t 12.345 \
             -movflags +faststart /rec/clip.sound.m4a"
        );
        // Not mixed: two streams, in the order given, and no video.
        assert!(!args.iter().any(|arg| arg.contains("amix")));
        assert_eq!(args.iter().filter(|arg| *arg == "-map").count(), 2);
        assert!(!args.iter().any(|arg| arg.contains(":v")));
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
        assert!(
            fallback_reason(&FfmpegStatus::NotInstalled { install: None })
                .contains("not installed")
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
                path: "/usr/bin/ffmpeg".into(),
                encoder: "libopenh264".into()
            })
            .unwrap(),
            serde_json::json!({ "state": "ready", "path": "/usr/bin/ffmpeg", "encoder": "libopenh264" })
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

    /// A `.tar.xz` like FFmpeg-Builds': `files` in one top folder.
    fn tar_xz(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        for (path, bytes) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            tar.append_data(&mut header, format!("ffmpeg-n8.1-lgpl/{path}"), *bytes)
                .unwrap();
        }
        let tar = tar.into_inner().unwrap();
        let mut xz =
            lzma_rust2::XzWriter::new(Vec::new(), lzma_rust2::XzOptions::with_preset(1)).unwrap();
        xz.write_all(&tar).unwrap();
        xz.finish().unwrap()
    }

    /// A `.zip` like FFmpeg-Builds': `files` in one top folder.
    fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        for (path, bytes) in files {
            zip.start_file(
                format!("ffmpeg-n8.1-lgpl/{path}"),
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    /// A build called `archive` whose checksum is `bytes`'.
    fn build_of(archive: &'static str, bytes: &[u8]) -> Build {
        Build {
            archive,
            sha256: Box::leak(sha256(bytes).into_boxed_str()),
        }
    }

    /// Serves one connection: sends `reply`, then holds the connection
    /// open without sending anything more, like a stalled network.
    fn stalling_server(reply: &'static [u8]) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/ffmpeg.zip", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(reply);
            let _ = stream.flush();
            thread::sleep(Duration::from_secs(5));
        });
        (url, server)
    }

    fn assert_stalled_download_fails(reply: &'static [u8]) {
        let (url, server) = stalling_server(reply);
        let dir = tempfile::TempDir::new().unwrap();
        let part = dir.path().join("ffmpeg.zip.part");
        let started = Instant::now();
        let result = download_hashed(
            &download_agent(Duration::from_millis(300)),
            &url,
            &part,
            &mut |_, _| {},
        );
        assert!(
            matches!(result, Err(FfmpegError::Download(_))),
            "got {result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(4));
        server.join().unwrap();
    }

    #[test]
    fn a_download_stalled_before_the_response_fails() {
        assert_stalled_download_fails(b"");
    }

    #[test]
    fn a_download_stalled_mid_body_fails() {
        assert_stalled_download_fails(
            b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\nonly a few bytes",
        );
    }

    /// Downloads `build`, served as `bytes`, taking out `name`.
    fn download_served(
        build: Build,
        bytes: Vec<u8>,
        name: &str,
        to: &Path,
        progress: impl FnMut(u64, u64),
    ) -> FfmpegResult<()> {
        let (url, server) = release_server(vec![(build.archive, bytes)]);
        let result = download_from(
            &download_agent(Duration::from_secs(5)),
            &url,
            build,
            name,
            to,
            progress,
        );
        server.join().unwrap();
        result
    }

    const FAKE_FFMPEG: &[u8] = b"#!/bin/sh\necho ffmpeg\n";

    #[test]
    fn a_linux_build_matching_its_checksum_is_unpacked_into_place() {
        let archive = tar_xz(&[
            ("LICENSE.txt", b"LGPL"),
            ("bin/ffprobe", b"ffprobe"),
            ("bin/ffmpeg", FAKE_FFMPEG),
            ("doc/ffmpeg", b"not this one"),
        ]);
        let build = build_of("ffmpeg-linux64-lgpl-8.1.tar.xz", &archive);
        let dir = tempfile::tempdir().unwrap();
        let to = installed_path(dir.path());
        let mut seen = Vec::new();
        download_served(build, archive, "ffmpeg", &to, |done, total| {
            seen.push((done, total))
        })
        .unwrap();
        assert_eq!(fs::read(&to).unwrap(), FAKE_FFMPEG);
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
    fn a_windows_build_is_unpacked_from_its_zip() {
        let archive = zip(&[
            ("bin/ffplay.exe", b"ffplay"),
            ("bin/ffmpeg.exe", FAKE_FFMPEG),
        ]);
        let build = build_of("ffmpeg-win64-lgpl-8.1.zip", &archive);
        let dir = tempfile::tempdir().unwrap();
        let to = dir.path().join(FFMPEG_DIR).join("ffmpeg.exe");
        download_served(build, archive, "ffmpeg.exe", &to, |_, _| {}).unwrap();
        assert_eq!(fs::read(&to).unwrap(), FAKE_FFMPEG);
        assert_eq!(fs::read_dir(to.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn a_download_not_matching_its_checksum_is_thrown_away() {
        let archive = tar_xz(&[("bin/ffmpeg", b"tampered")]);
        let build = Build {
            archive: "ffmpeg-linux64-lgpl-8.1.tar.xz",
            sha256: LINUX_X64.sha256,
        };
        let dir = tempfile::tempdir().unwrap();
        let to = installed_path(dir.path());
        let result = download_served(build, archive, "ffmpeg", &to, |_, _| {});
        assert!(
            matches!(result, Err(FfmpegError::Checksum { .. })),
            "got {result:?}"
        );
        assert!(!to.exists());
        assert_eq!(fs::read_dir(to.parent().unwrap()).unwrap().count(), 0);
    }

    #[test]
    fn an_archive_without_ffmpeg_installs_nothing() {
        let archive = tar_xz(&[("ffmpeg", b"not in bin/"), ("bin/ffprobe", b"ffprobe")]);
        let build = build_of("ffmpeg-linux64-lgpl-8.1.tar.xz", &archive);
        let dir = tempfile::tempdir().unwrap();
        let to = installed_path(dir.path());
        let result = download_served(build, archive, "ffmpeg", &to, |_, _| {});
        assert!(
            matches!(&result, Err(FfmpegError::Download(err)) if err.contains("no bin/ffmpeg")),
            "got {result:?}"
        );
        assert!(!to.exists());
        assert_eq!(fs::read_dir(to.parent().unwrap()).unwrap().count(), 0);
    }

    #[test]
    fn a_missing_build_fails_to_download() {
        let (url, server) = release_server(vec![("nothing", Vec::new())]);
        let dir = tempfile::tempdir().unwrap();
        let to = installed_path(dir.path());
        let result = download_from(
            &download_agent(Duration::from_secs(5)),
            &url,
            LINUX_X64,
            "ffmpeg",
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

    /// FFmpeg-Builds still publishes every pinned build with the pinned
    /// checksum. It prunes old releases, so this fails CI, and with it a
    /// release, before installed copies would find their build gone.
    #[test]
    fn pinned_builds_are_still_published() {
        let url = format!("{RELEASE_URL}/checksums.sha256");
        let checksums = download_agent(Duration::from_secs(30))
            .get(&url)
            .call()
            .unwrap_or_else(|err| panic!("{url}: {err}"))
            .into_body()
            .read_to_string()
            .unwrap();
        for build in BUILDS {
            let line = format!("{}  {}", build.sha256, build.archive);
            assert!(
                checksums
                    .lines()
                    .any(|published| published.trim_end() == line),
                "{url} does not list {line}"
            );
        }
    }
}
