//! Updates: Grab-it checks the latest GitHub release shortly after it
//! starts and then every few hours. The Grab-it window shows what an update
//! brings and installs it when asked; the tray's and the hub's "Check for
//! updates…" check on demand.
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
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::windows;

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
    pending: Mutex<Option<Update>>,
}

/// Who asked for a check. Only a check the user asked for opens the
/// Updates dialog and reports a failure.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    Automatic,
    User,
}

/// What one version brought, as `latest.json` lists it. Mirrors
/// `UpdateChanges` in the frontend.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    version: String,
    #[serde(default)]
    items: Vec<String>,
}

/// An update a check found. Mirrors `UpdateInfo` in the frontend.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
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
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
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

/// The current status.
#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    current_status(&app)
}

/// Checks for an update, showing the result in the Grab-it window.
#[tauri::command]
pub fn update_check(app: AppHandle) {
    user_check(&app);
}

/// Installs the update the last check found and restarts Grab-it.
#[tauri::command]
pub fn update_install(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    let Some(update) = lock(&state.pending).clone() else {
        return Err("There is no update to install.".into());
    };
    if state.installing.swap(true, Ordering::SeqCst) {
        emit(&app, current_status(&app), true);
        return Ok(());
    }
    std::thread::spawn(move || install_and_restart(&app, &update));
    Ok(())
}

/// "Later": automatic checks stop pointing out this update.
#[tauri::command]
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
    let show = trigger == Trigger::User;
    if state.installing.load(Ordering::SeqCst) || state.busy.swap(true, Ordering::SeqCst) {
        if show {
            emit(app, current_status(app), true);
        }
        return;
    }
    let current = app.package_info().version.to_string();
    let previous = current_status(app);
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
    let found = tauri::async_runtime::block_on(async {
        app.updater()
            .map_err(|err| err.to_string())?
            .check()
            .await
            .map_err(|err| err.to_string())
    });
    // An install started meanwhile owns the status now.
    if state.installing.load(Ordering::SeqCst) {
        state.busy.store(false, Ordering::SeqCst);
        return;
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
            *lock(&state.pending) = Some(update);
            set_status(app, status, show);
        }
        Ok(None) => {
            *lock(&state.pending) = None;
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
            if show {
                set_status(
                    app,
                    UpdateStatus::Failed {
                        current,
                        message: err,
                        info: None,
                    },
                    true,
                );
            } else {
                // A background failure is not worth reporting: put back
                // what was there before the check.
                let restored = match previous {
                    UpdateStatus::Checking { current } => UpdateStatus::Idle { current },
                    other => other,
                };
                set_status(app, restored, false);
            }
        }
    }
    state.busy.store(false, Ordering::SeqCst);
}

/// Downloads and installs `update`, reporting progress, then restarts.
/// Blocks, so it must not run on the main thread. The caller has set
/// [`UpdateState::installing`].
fn install_and_restart(app: &AppHandle, update: &Update) {
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
    let installed = tauri::async_runtime::block_on(update.download_and_install(
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
    ));
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

    fn changes(version: &str, items: &[&str]) -> Changes {
        Changes {
            version: version.into(),
            items: items.iter().map(|item| item.to_string()).collect(),
        }
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
