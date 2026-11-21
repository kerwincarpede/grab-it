//! Updates: Grab-it checks the latest GitHub release shortly after it
//! starts and then every few hours. The Grab-it window shows what an update
//! brings and installs it when asked; the tray's and the hub's "Check for
//! updates…" check on demand.
//!
//! Settings › Updates picks the channel: Stable reads the latest release's
//! `latest.json`, Edge the newest published version's immutable manifest.
//! Only a newer version counts as an update, so moving back to Stable waits until
//! Stable passes the Edge version this copy has.
//!
//! The release workflow publishes `latest.json` next to the installers,
//! each package signed with the key whose public half is in
//! `tauri.conf.json`; the updater refuses anything else. Its `changes` list
//! what each recent version brought, so the window can show everything an
//! update brings, however many versions behind this copy is.
//!
//! The state lives here as an [`UpdateStatus`]; each change is sent to the
//! windows as [`UPDATE_STATUS_EVENT`], saying whether the window should open
//! its Updates dialog (for checks and installs the user started).

use std::{
    cell::Cell,
    fs, io,
    path::Path,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::rt::AppHandle;
use crate::{
    commands::{SettingsState, lock as lock_settings},
    settings::UpdateChannel,
    windows,
};

/// Emitted to every window with an [`UpdateEvent`] whenever the status
/// changes.
pub const UPDATE_STATUS_EVENT: &str = "update-status";

/// How long after launch the first check waits, so it never competes with
/// starting up or with a capture taken right away.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(30);
/// How often a long-running Grab-it checks again.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Longer change descriptions are cut short, to keep the list readable.
const MAX_CHANGE_CHARS: usize = 100;
/// Download progress is sent at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// Stable's manifest: the one on the release GitHub marks as latest. Copies
/// from before channels existed read it from `tauri.conf.json`.
const STABLE_ENDPOINT: &str =
    "https://github.com/kerwincarpede/grab-it/releases/latest/download/latest.json";
/// Releases can finish out of order. Discover the highest published version
/// rather than trying to overwrite an asset on an immutable rolling release.
const RELEASES_API: &str = "https://api.github.com/repos/kerwincarpede/grab-it/releases";
const RELEASE_PAGE_SIZE: usize = 100;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);

const RESTORE_FILE: &str = "update-library-restore.json";

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
}

fn edge_candidate(releases: &[GithubRelease]) -> Option<Version> {
    releases
        .iter()
        .filter(|release| {
            !release.draft
                && release
                    .assets
                    .iter()
                    .any(|asset| asset.name == "latest.json")
        })
        .filter_map(|release| release.tag_name.strip_prefix('v'))
        .filter_map(|tag| Version::parse(tag).ok())
        .filter(|version| version.pre.is_empty() && version.build.is_empty())
        .max()
}

/// Discover Edge on the thread already running the update check. Bound the
/// whole paginated request, including slow responses, and use the OS trust store.
fn edge_endpoint() -> Result<String, String> {
    let started = Instant::now();
    let mut newest = None;
    for page in 1.. {
        let remaining = DISCOVERY_TIMEOUT
            .checked_sub(started.elapsed())
            .ok_or("Timed out finding the newest Edge release")?;
        let agent = ureq::Agent::config_builder()
            .tls_config(crate::net::tls_config())
            .timeout_global(Some(remaining))
            .build()
            .new_agent();
        let text = agent
            .get(format!(
                "{RELEASES_API}?per_page={RELEASE_PAGE_SIZE}&page={page}"
            ))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "Grab-it updater")
            .call()
            .map_err(|err| format!("Could not find Edge releases: {err}"))?
            .into_body()
            .read_to_string()
            .map_err(|err| err.to_string())?;
        let releases: Vec<GithubRelease> =
            serde_json::from_str(&text).map_err(|err| err.to_string())?;
        newest = newest.max(edge_candidate(&releases));
        if releases.len() < RELEASE_PAGE_SIZE {
            break;
        }
    }
    let version = newest.ok_or("There is no published Edge update yet")?;
    Ok(format!(
        "https://github.com/kerwincarpede/grab-it/releases/download/v{version}/latest.json"
    ))
}

#[derive(Default)]
pub struct UpdateState {
    /// A check is under way.
    busy: AtomicBool,
    /// An update is downloading or installing.
    installing: AtomicBool,
    /// The version the user chose "Later" for. Automatic checks do not
    /// point it out again until Grab-it restarts; "Check for updates…" does.
    declined: Mutex<Option<String>>,
    /// The current status; `None` until the first check, which reads as
    /// [`UpdateStatus::Idle`].
    status: Mutex<Option<UpdateStatus>>,
    /// The update the last check found, ready for [`update_install`].
    /// Its lock also orders a check's result against a channel switch.
    pending: Mutex<Option<Update>>,
    /// How many times the user has switched channel. A check records its
    /// result only if no switch came while it ran, and checks again if one
    /// came while it still held [`UpdateState::busy`].
    switches: AtomicU64,
}

/// Who asked for a check. Only a check the user asked for opens the
/// Updates dialog; a check after switching channel reports a failure too,
/// but in the sidebar only.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    Automatic,
    User,
    /// The user picked another channel in Settings.
    ChannelSwitch,
}

/// What one version brought, as `latest.json` lists it. Mirrors
/// `UpdateChanges` in the frontend.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    version: String,
    #[serde(default)]
    items: Vec<String>,
}

/// An update a check found. Mirrors `UpdateInfo` in the frontend.
#[derive(Serialize, Debug, Clone, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// This copy's version.
    current: String,
    /// The update's version.
    version: String,
    /// When the update was published, in RFC 3339.
    date: Option<String>,
    /// What each version since this one brought, newest first.
    changes: Vec<Changes>,
}

/// Where updating stands. Mirrors `UpdateStatus` in the frontend.
#[derive(Serialize, Debug, Clone, PartialEq, Eq, specta::Type)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateStatus {
    /// Not checked yet.
    Idle {
        current: String,
    },
    Checking {
        current: String,
    },
    UpToDate {
        current: String,
        /// When, in milliseconds since the Unix epoch.
        checked_at: u64,
    },
    Available {
        info: UpdateInfo,
        /// The user chose "Later" for this version.
        declined: bool,
    },
    Installing {
        info: UpdateInfo,
        /// Bytes downloaded so far.
        downloaded: u64,
        /// The download's size, when the server says.
        total: Option<u64>,
    },
    Failed {
        current: String,
        message: String,
        /// The update that failed to install; `None` when a check failed.
        info: Option<UpdateInfo>,
    },
}

/// The payload of [`UPDATE_STATUS_EVENT`].
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEvent {
    status: UpdateStatus,
    /// The window should open its Updates dialog: the user started this.
    show: bool,
}

/// Checks in the background now and then. Development builds only check
/// when asked, since their version is rarely the released one.
pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_AFTER);
        loop {
            check(&app, Trigger::Automatic);
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

/// A check the user asked for, from the tray, the hub or the Grab-it
/// window: brings the Grab-it window forward, where the Updates dialog
/// shows the result, then checks off the main thread.
pub fn user_check(app: &AppHandle) {
    let app = app.clone();
    // Off the main thread: a window must not be created from inside a
    // synchronous command, and the check blocks.
    std::thread::spawn(move || {
        if let Err(err) = windows::show_library(&app) {
            eprintln!("Grab-it: could not open the Grab-it window: {err}");
        }
        check(&app, Trigger::User);
    });
}

/// Where `channel`'s `latest.json` is. Edge discovers published versions;
/// Stable keeps the endpoint used by copies from before channels existed.
fn endpoint(channel: UpdateChannel) -> Result<String, String> {
    match channel {
        UpdateChannel::Stable => Ok(STABLE_ENDPOINT.into()),
        UpdateChannel::Edge => edge_endpoint(),
    }
}

/// Whether an update is downloading or installing, when the channel must
/// not change under it.
pub fn installing(app: &AppHandle) -> bool {
    app.state::<UpdateState>().installing.load(Ordering::SeqCst)
}

/// After the user picked another channel: forgets the update the old
/// channel offered and checks the new one off the main thread. A check
/// still running notices the switch and checks again.
pub fn channel_switched(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    if state.installing.load(Ordering::SeqCst) {
        return;
    }
    *lock(&state.declined) = None;
    {
        // Under the same lock as a check's result, so the two never cross.
        let mut pending = lock(&state.pending);
        state.switches.fetch_add(1, Ordering::SeqCst);
        *pending = None;
        set_status(
            app,
            UpdateStatus::Checking {
                current: app.package_info().version.to_string(),
            },
            false,
        );
    }
    // If a check is running, this one finds it busy and leaves the new
    // channel to it.
    let app = app.clone();
    std::thread::spawn(move || check(&app, Trigger::ChannelSwitch));
}

/// The channel Settings has picked; Stable before settings are loaded.
fn chosen_channel(app: &AppHandle) -> UpdateChannel {
    app.try_state::<SettingsState>()
        .map(|state| lock_settings(&state).get().update_channel)
        .unwrap_or_default()
}

/// Asks `channel`'s manifest for a version newer than this copy.
async fn find_update(app: &AppHandle, channel: UpdateChannel) -> Result<Option<Update>, String> {
    let url = Url::parse(&endpoint(channel)?).map_err(|err| err.to_string())?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|err| err.to_string())?
        .build()
        .map_err(|err| err.to_string())?
        .check()
        .await
        .map_err(|err| err.to_string())
}

/// The current status.
#[tauri::command]
#[specta::specta]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    current_status(&app)
}

/// Checks for an update, showing the result in the Grab-it window.
#[tauri::command]
#[specta::specta]
pub fn update_check(app: AppHandle) {
    user_check(&app);
}

/// Installs the update the last check found and restarts Grab-it.
#[tauri::command]
#[specta::specta]
pub fn update_install(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    let Some(update) = lock(&state.pending).clone() else {
        return Err("There is no update to install.".into());
    };
    let data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    if state.installing.swap(true, Ordering::SeqCst) {
        emit(&app, current_status(&app), true);
        return Ok(());
    }
    // Closing the shared Library window destroys it. Minimising it keeps it open.
    let library_open = app.get_webview_window(windows::MAIN_LABEL).is_some();
    std::thread::spawn(move || install_and_restart(&app, &update, &data_dir, library_open));
    Ok(())
}

/// "Later": automatic checks stop pointing out this update.
#[tauri::command]
#[specta::specta]
pub fn update_later(app: AppHandle) {
    let state = app.state::<UpdateState>();
    if state.installing.load(Ordering::SeqCst) {
        return;
    }
    let Some(update) = lock(&state.pending).clone() else {
        return;
    };
    *lock(&state.declined) = Some(update.version.clone());
    set_status(
        &app,
        UpdateStatus::Available {
            info: info_of(&update),
            declined: true,
        },
        false,
    );
}

/// Looks for a newer release and reports what it finds. Blocks, so it must
/// not run on the main thread.
fn check(app: &AppHandle, trigger: Trigger) {
    let state = app.state::<UpdateState>();
    let ran = run_while_busy(&state.busy, &state.installing, &state.switches, |first| {
        // A switch that found this check busy is checked as its own.
        let trigger = if first {
            trigger
        } else {
            Trigger::ChannelSwitch
        };
        check_once(app, trigger)
    });
    if !ran && trigger == Trigger::User {
        emit(app, current_status(app), true);
    }
}

/// Takes `busy` and runs `attempt`, which returns the switch count its
/// result was recorded at. Runs it again, with `first` false, while a
/// switch came after that, since that switch's own check found `busy`
/// taken and left it here. False when another check or an install already
/// had it.
fn run_while_busy(
    busy: &AtomicBool,
    installing: &AtomicBool,
    switches: &AtomicU64,
    mut attempt: impl FnMut(bool) -> u64,
) -> bool {
    if installing.load(Ordering::SeqCst) || busy.swap(true, Ordering::SeqCst) {
        return false;
    }
    let mut first = true;
    loop {
        let recorded_at = attempt(first);
        busy.store(false, Ordering::SeqCst);
        if switches.load(Ordering::SeqCst) == recorded_at
            || installing.load(Ordering::SeqCst)
            || busy.swap(true, Ordering::SeqCst)
        {
            return true;
        }
        first = false;
    }
}

/// One check while holding [`UpdateState::busy`]. Fetches again whenever
/// the user switched channel meanwhile, so what the old channel offered is
/// never shown, and returns the switch count its result was recorded at.
fn check_once(app: &AppHandle, trigger: Trigger) -> u64 {
    let state = app.state::<UpdateState>();
    let show = trigger == Trigger::User;
    let mut report_failure = trigger != Trigger::Automatic;
    let current = app.package_info().version.to_string();
    let mut previous = current_status(app);
    // A background check leaves an update on show as it is meanwhile.
    if show || !matches!(previous, UpdateStatus::Available { .. }) {
        set_status(
            app,
            UpdateStatus::Checking {
                current: current.clone(),
            },
            show,
        );
    }
    loop {
        let seen = state.switches.load(Ordering::SeqCst);
        let channel = chosen_channel(app);
        let found = tauri::async_runtime::block_on(find_update(app, channel));
        // An install started meanwhile owns the status now.
        if state.installing.load(Ordering::SeqCst) {
            return seen;
        }
        let mut pending = lock(&state.pending);
        if state.switches.load(Ordering::SeqCst) != seen {
            // The user switched channel: what was on show came from the
            // old one, and the new channel's result is theirs to see.
            drop(pending);
            report_failure = true;
            previous = UpdateStatus::Idle {
                current: current.clone(),
            };
            continue;
        }
        match found {
            Ok(Some(update)) => {
                // Found in the background or not, the update waits in the
                // Grab-it window's sidebar; nothing pops up to announce it.
                let declined = lock(&state.declined).clone();
                let status = UpdateStatus::Available {
                    info: info_of(&update),
                    declined: declined.as_deref() == Some(update.version.as_str()),
                };
                *pending = Some(update);
                set_status(app, status, show);
            }
            Ok(None) => {
                *pending = None;
                set_status(
                    app,
                    UpdateStatus::UpToDate {
                        current,
                        checked_at: now_ms(),
                    },
                    show,
                );
            }
            Err(err) => {
                eprintln!("Grab-it: could not check for updates: {err}");
                if report_failure {
                    set_status(
                        app,
                        UpdateStatus::Failed {
                            current,
                            message: err,
                            info: None,
                        },
                        show,
                    );
                } else {
                    // A background failure is not worth reporting: put
                    // back what was there before the check.
                    let restored = match previous {
                        UpdateStatus::Checking { current } => UpdateStatus::Idle { current },
                        other => other,
                    };
                    set_status(app, restored, false);
                }
            }
        }
        return seen;
    }
}

fn clear_restore(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Takes the one-use Library handoff, even when startup will show another window.
pub fn take_library_restore(data_dir: &Path, current: &Version) -> bool {
    let path = data_dir.join(RESTORE_FILE);
    let contents = match fs::read(&path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => return false,
        result => result,
    };
    if let Err(err) = clear_restore(&path) {
        eprintln!("Grab-it: could not consume the Library restore record: {err}");
        return false;
    }
    contents
        .ok()
        .and_then(|data| serde_json::from_slice::<String>(&data).ok())
        .is_some_and(|target| target == current.to_string())
}

// The Windows installer exits the process on success, so the handoff must
// already be on disk before entering the updater. A read-only profile should
// still be able to install the update.
fn install_with_restore<E>(
    data_dir: &Path,
    version: &str,
    library_open: bool,
    install: impl FnOnce() -> Result<(), E>,
) -> Result<(), E> {
    let path = data_dir.join(RESTORE_FILE);
    let saved = if library_open {
        fs::write(&path, serde_json::Value::from(version).to_string())
    } else {
        clear_restore(&path)
    };
    if let Err(err) = saved {
        eprintln!("Grab-it: could not prepare the Library for restart: {err}");
    }
    let result = install();
    if result.is_err()
        && let Err(err) = clear_restore(&path)
    {
        eprintln!("Grab-it: could not clear the Library restore record: {err}");
    }
    result
}

/// Downloads and installs `update`, reporting progress, then restarts.
/// Blocks, so it must not run on the main thread. The caller has set
/// [`UpdateState::installing`].
fn install_and_restart(app: &AppHandle, update: &Update, data_dir: &Path, library_open: bool) {
    let info = info_of(update);
    let installing = |downloaded: u64, total: Option<u64>| UpdateStatus::Installing {
        info: info.clone(),
        downloaded,
        total,
    };
    set_status(app, installing(0, None), true);
    // A recording in progress is finished first, so its file is complete.
    crate::record::stop_and_wait(app);

    // Shared by the two callbacks: bytes so far, and the download's size.
    let downloaded = Cell::new(0u64);
    let total = Cell::new(None::<u64>);
    let mut sent_at: Option<Instant> = None;
    let installed = install_with_restore(data_dir, &update.version, library_open, || {
        tauri::async_runtime::block_on(update.download_and_install(
            |chunk, length| {
                downloaded.set(downloaded.get() + chunk as u64);
                total.set(length);
                let done = length.is_some_and(|length| downloaded.get() >= length);
                if done || sent_at.is_none_or(|at| at.elapsed() >= PROGRESS_EVERY) {
                    sent_at = Some(Instant::now());
                    set_status(app, installing(downloaded.get(), length), true);
                }
            },
            || set_status(app, installing(downloaded.get(), total.get()), true),
        ))
    });
    match installed {
        // On Windows the installer has already closed Grab-it by now.
        Ok(()) => app.restart(),
        Err(err) => {
            eprintln!("Grab-it: could not install the update: {err}");
            let state = app.state::<UpdateState>();
            state.installing.store(false, Ordering::SeqCst);
            set_status(
                app,
                UpdateStatus::Failed {
                    current: update.current_version.clone(),
                    message: err.to_string(),
                    info: Some(info),
                },
                true,
            );
        }
    }
}

fn current_status(app: &AppHandle) -> UpdateStatus {
    lock(&app.state::<UpdateState>().status)
        .clone()
        .unwrap_or_else(|| UpdateStatus::Idle {
            current: app.package_info().version.to_string(),
        })
}

/// Records `status` and tells the windows.
fn set_status(app: &AppHandle, status: UpdateStatus, show: bool) {
    *lock(&app.state::<UpdateState>().status) = Some(status.clone());
    emit(app, status, show);
}

fn emit(app: &AppHandle, status: UpdateStatus, show: bool) {
    if let Err(err) = app.emit(UPDATE_STATUS_EVENT, UpdateEvent { status, show }) {
        eprintln!("Grab-it: could not report the update status: {err}");
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

/// What the window shows about `update`.
fn info_of(update: &Update) -> UpdateInfo {
    UpdateInfo {
        current: update.current_version.clone(),
        version: update.version.clone(),
        // As `latest.json` has it (RFC 3339), if the updater could read it.
        date: update
            .date
            .and_then(|_| update.raw_json.get("pub_date")?.as_str())
            .map(str::to_string),
        changes: changes_since(update)
            .into_iter()
            .map(|changes| Changes {
                items: changes.items.iter().map(|item| shorten(item)).collect(),
                ..changes
            })
            .collect(),
    }
}

/// The changes between this copy and the update, newest first.
fn changes_since(update: &Update) -> Vec<Changes> {
    let listed = update
        .raw_json
        .get("changes")
        .cloned()
        .and_then(|changes| serde_json::from_value(changes).ok())
        .unwrap_or_default();
    pick_changes(
        listed,
        &update.current_version,
        &update.version,
        update.body.as_deref(),
    )
}

/// Keeps the versions after `current`, up to and including `available`.
/// Without a changelog, the update's notes (a Markdown list) stand in.
fn pick_changes(
    listed: Vec<Changes>,
    current: &str,
    available: &str,
    notes: Option<&str>,
) -> Vec<Changes> {
    let (Ok(current), Ok(newest)) = (Version::parse(current), Version::parse(available)) else {
        return Vec::new();
    };
    let mut picked: Vec<(Version, Changes)> = listed
        .into_iter()
        .filter_map(|changes| {
            let version = Version::parse(&changes.version).ok()?;
            (version > current && version <= newest).then_some((version, changes))
        })
        .collect();
    picked.sort_by(|a, b| b.0.cmp(&a.0));
    if picked.is_empty()
        && let Some(notes) = notes
    {
        let items: Vec<String> = notes
            .lines()
            .filter_map(|line| line.trim().strip_prefix("- "))
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect();
        if !items.is_empty() {
            return vec![Changes {
                version: available.to_string(),
                items,
            }];
        }
    }
    picked.into_iter().map(|(_, changes)| changes).collect()
}

fn shorten(item: &str) -> String {
    if item.chars().count() <= MAX_CHANGE_CHARS {
        return item.to_string();
    }
    let cut: String = item.chars().take(MAX_CHANGE_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_open_library_is_recorded_before_install_and_restored_once() {
        let dir = tempfile::tempdir().unwrap();
        let version = Version::new(1, 2, 3);
        let record = dir.path().join(RESTORE_FILE);
        install_with_restore(dir.path(), "1.2.3", true, || {
            assert!(record.exists());
            Ok::<_, ()>(())
        })
        .unwrap();
        assert!(take_library_restore(dir.path(), &version));
        assert!(!take_library_restore(dir.path(), &version));
    }

    #[test]
    fn a_closed_library_leaves_no_restore_record() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join(RESTORE_FILE);
        fs::write(&record, r#""1.2.3""#).unwrap();
        install_with_restore(dir.path(), "1.2.3", false, || {
            assert!(!record.exists());
            Ok::<_, ()>(())
        })
        .unwrap();
        assert!(!take_library_restore(dir.path(), &Version::new(1, 2, 3)));
    }

    #[test]
    fn a_failed_install_clears_the_handoff() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            install_with_restore(dir.path(), "1.2.3", true, || Err("installer failed")),
            Err("installer failed")
        );
        assert!(!dir.path().join(RESTORE_FILE).exists());
    }

    #[test]
    fn an_ordinary_launch_discards_invalid_records_and_other_versions() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join(RESTORE_FILE);
        let version = Version::new(1, 2, 3);
        assert!(!take_library_restore(dir.path(), &version));
        for contents in [r#""1.2.4""#, r#""broken""#, "bad json"] {
            fs::write(&record, contents).unwrap();
            assert!(!take_library_restore(dir.path(), &version));
            assert!(!record.exists());
        }
    }

    fn changes(version: &str, items: &[&str]) -> Changes {
        Changes {
            version: version.into(),
            items: items.iter().map(|item| item.to_string()).collect(),
        }
    }

    #[test]
    fn stable_keeps_its_manifest_endpoint() {
        assert_eq!(
            endpoint(UpdateChannel::Stable).unwrap(),
            "https://github.com/kerwincarpede/grab-it/releases/latest/download/latest.json"
        );
        let url = Url::parse(&endpoint(UpdateChannel::Stable).unwrap()).unwrap();
        assert_eq!(url.scheme(), "https");
    }

    #[test]
    fn edge_uses_version_order_and_ignores_drafts_and_incomplete_releases() {
        let releases: Vec<GithubRelease> = serde_json::from_value(json!([
            {"tag_name":"v0.10.0", "draft":false, "assets":[{"name":"latest.json"}]},
            {"tag_name":"v0.9.0", "draft":false, "assets":[{"name":"latest.json"}]},
            {"tag_name":"v0.11.0", "draft":true, "assets":[{"name":"latest.json"}]},
            {"tag_name":"v0.12.0", "draft":false, "assets":[]},
            {"tag_name":"edge", "draft":false, "assets":[{"name":"latest.json"}]},
            {"tag_name":"v1.0.0-beta.1", "draft":false, "assets":[{"name":"latest.json"}]}
        ]))
        .unwrap();
        assert_eq!(edge_candidate(&releases), Some(Version::new(0, 10, 0)));
        assert_eq!(edge_candidate(&[]), None);
    }

    #[test]
    fn stable_is_the_endpoint_older_copies_use() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["plugins"]["updater"]["endpoints"][0],
            endpoint(UpdateChannel::Stable).unwrap()
        );
    }

    #[test]
    fn a_switch_while_busy_is_checked_before_busy_is_released() {
        let busy = AtomicBool::new(false);
        let installing = AtomicBool::new(false);
        let switches = AtomicU64::new(0);
        let mut runs = Vec::new();
        let ran = run_while_busy(&busy, &installing, &switches, |first| {
            runs.push(first);
            let recorded_at = switches.load(Ordering::SeqCst);
            // The user switches channel after the first result is recorded,
            // and that switch's own check finds this one busy.
            if first {
                switches.fetch_add(1, Ordering::SeqCst);
                assert!(!run_while_busy(&busy, &installing, &switches, |_| {
                    panic!("a busy check must not run a second one")
                }));
            }
            recorded_at
        });
        assert!(ran);
        assert_eq!(runs, vec![true, false]);
        assert!(!busy.load(Ordering::SeqCst));
    }

    #[test]
    fn a_check_without_a_switch_runs_once() {
        let busy = AtomicBool::new(false);
        let installing = AtomicBool::new(false);
        let switches = AtomicU64::new(3);
        let mut runs = 0;
        assert!(run_while_busy(&busy, &installing, &switches, |_| {
            runs += 1;
            3
        }));
        assert_eq!(runs, 1);
        assert!(!busy.load(Ordering::SeqCst));
    }

    #[test]
    fn no_check_runs_while_an_update_installs() {
        let busy = AtomicBool::new(false);
        let installing = AtomicBool::new(true);
        let switches = AtomicU64::new(0);
        assert!(!run_while_busy(&busy, &installing, &switches, |_| {
            panic!("no check while installing")
        }));
        assert!(!busy.load(Ordering::SeqCst));
    }

    #[test]
    fn only_versions_since_this_one_count_newest_first() {
        let listed = vec![
            changes("0.3.0", &["Three"]),
            changes("0.5.0", &["Five"]),
            changes("0.10.0", &["Ten"]),
            changes("0.4.0", &["Four"]),
            changes("0.6.0", &["Six"]),
            changes("not a version", &["?"]),
        ];
        let picked = pick_changes(listed, "0.3.0", "0.5.0", None);
        assert_eq!(
            picked,
            vec![changes("0.5.0", &["Five"]), changes("0.4.0", &["Four"])]
        );
    }

    #[test]
    fn without_a_changelog_the_notes_stand_in() {
        let picked = pick_changes(Vec::new(), "0.3.0", "0.4.0", Some("- One\n- Two\n\nmore"));
        assert_eq!(picked, vec![changes("0.4.0", &["One", "Two"])]);
        assert!(pick_changes(Vec::new(), "0.3.0", "0.4.0", Some("prose")).is_empty());
        assert!(pick_changes(Vec::new(), "0.3.0", "0.4.0", None).is_empty());
    }

    #[test]
    fn long_changes_are_shortened() {
        let long = "x".repeat(150);
        let short = shorten(&long);
        assert_eq!(short.chars().count(), MAX_CHANGE_CHARS);
        assert!(short.ends_with('…'));
        assert_eq!(shorten("Short"), "Short");
    }

    fn info() -> UpdateInfo {
        UpdateInfo {
            current: "0.2.0".into(),
            version: "0.3.0".into(),
            date: Some("2026-11-01T12:00:00Z".into()),
            changes: vec![changes("0.3.0", &["One"])],
        }
    }

    fn info_json() -> serde_json::Value {
        json!({
            "current": "0.2.0",
            "version": "0.3.0",
            "date": "2026-11-01T12:00:00Z",
            "changes": [{ "version": "0.3.0", "items": ["One"] }],
        })
    }

    #[test]
    fn the_status_serializes_as_the_frontend_expects() {
        let cases = [
            (
                UpdateStatus::Idle {
                    current: "0.2.0".into(),
                },
                json!({ "state": "idle", "current": "0.2.0" }),
            ),
            (
                UpdateStatus::Checking {
                    current: "0.2.0".into(),
                },
                json!({ "state": "checking", "current": "0.2.0" }),
            ),
            (
                UpdateStatus::UpToDate {
                    current: "0.2.0".into(),
                    checked_at: 1_700_000_000_000,
                },
                json!({ "state": "upToDate", "current": "0.2.0", "checkedAt": 1_700_000_000_000u64 }),
            ),
            (
                UpdateStatus::Available {
                    info: info(),
                    declined: false,
                },
                json!({ "state": "available", "info": info_json(), "declined": false }),
            ),
            (
                UpdateStatus::Installing {
                    info: info(),
                    downloaded: 512,
                    total: None,
                },
                json!({ "state": "installing", "info": info_json(), "downloaded": 512, "total": null }),
            ),
            (
                UpdateStatus::Failed {
                    current: "0.2.0".into(),
                    message: "offline".into(),
                    info: None,
                },
                json!({ "state": "failed", "current": "0.2.0", "message": "offline", "info": null }),
            ),
            (
                UpdateStatus::Failed {
                    current: "0.2.0".into(),
                    message: "bad signature".into(),
                    info: Some(UpdateInfo {
                        date: None,
                        ..info()
                    }),
                },
                json!({
                    "state": "failed",
                    "current": "0.2.0",
                    "message": "bad signature",
                    "info": { "current": "0.2.0", "version": "0.3.0", "date": null,
                              "changes": [{ "version": "0.3.0", "items": ["One"] }] },
                }),
            ),
        ];
        for (status, expected) in cases {
            assert_eq!(serde_json::to_value(&status).unwrap(), expected);
        }
        let event = UpdateEvent {
            status: UpdateStatus::Idle {
                current: "0.2.0".into(),
            },
            show: true,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({ "status": { "state": "idle", "current": "0.2.0" }, "show": true })
        );
    }
}
