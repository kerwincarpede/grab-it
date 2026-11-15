//! What the library takes up on disk: each kind's count and size, from the
//! `bytes` the library records for every item, and the free and total space
//! on the save folder's disk. The Library's storage pill and its Storage
//! popover show them.
//!
//! Cleanup removes items older than their kind's Keep setting, by when
//! they were captured, to the Trash or for good. Protected items are never
//! removed: starred Keep forever, tagged by the user, with notes, or with
//! annotations or recording edits. It runs when Grab-it starts, once a
//! day and from the Library's Clean up dialog, one cleanup at a time. Every
//! run tells the windows how far it has got, and can be stopped.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{SettingsState, lock};
use crate::library::{
    LIBRARY_CHANGED_EVENT, Library, LibraryError, LibraryResult, LibraryState, SHOT_COLUMNS, Shot,
    ShotKind, current_save_folder, extra_files, remove_if_present, shot_from_row,
};
use crate::settings::{Removal, Retention};

/// Emitted with a [`Cleaned`] when an automatic cleanup removed something.
pub const LIBRARY_CLEANED_EVENT: &str = "library-cleaned";
/// Emitted with a [`Progress`] after each item any cleanup looks at,
/// automatic or from the Library.
pub const CLEANUP_PROGRESS_EVENT: &str = "cleanup-progress";
/// Emitted with a [`Cleaned`] when a cleanup ends: done, stopped or failed.
pub const CLEANUP_DONE_EVENT: &str = "cleanup-done";

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// How often the cleanup thread checks whether a day has passed. Short, so
/// a computer that slept through the day still cleans up soon after.
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);

/// How many items of one kind the library holds and their total size.
/// Mirrors `KindUsage` in src/library/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindUsage {
    pub count: u32,
    /// The sum of the items' file sizes; items whose size is not known yet
    /// count as nothing.
    pub bytes: u64,
}

/// The library's items by kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub image: KindUsage,
    pub gif: KindUsage,
    pub video: KindUsage,
}

/// Space on a disk, in bytes. Mirrors `DiskSpace` in src/library/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
    /// What Grab-it may still write.
    pub free: u64,
    pub total: u64,
}

/// What `library_storage` answers. Mirrors `LibraryStorage` in
/// src/library/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStorage {
    pub image: KindUsage,
    pub gif: KindUsage,
    pub video: KindUsage,
    /// The save folder's disk; `None` when it cannot be read.
    pub disk: Option<DiskSpace>,
    /// The items of each kind older than its Keep setting and not
    /// protected: what the next cleanup removes.
    pub due: Usage,
}

/// Counts and sizes the library's items by kind.
pub fn usage(library: &Library) -> LibraryResult<Usage> {
    let mut stmt = library.connection().prepare(
        "SELECT kind, COUNT(*), coalesce(SUM(bytes), 0)
         FROM shots GROUP BY kind",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, u32>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    let mut usage = Usage::default();
    for row in rows {
        let (kind, count, bytes) = row?;
        let slot = match ShotKind::from_column(&kind) {
            ShotKind::Image => &mut usage.image,
            ShotKind::Gif => &mut usage.gif,
            ShotKind::Video => &mut usage.video,
        };
        slot.count += count;
        slot.bytes += bytes.max(0) as u64;
    }
    Ok(usage)
}

/// The free and total space on the disk that holds `folder`. A folder not
/// made yet is measured on its nearest existing parent's disk.
pub fn disk_space(folder: &Path) -> Option<DiskSpace> {
    let existing = folder.ancestors().find(|path| path.is_dir())?;
    let stats = fs4::statvfs(existing).ok()?;
    (stats.total_space() > 0).then(|| DiskSpace {
        free: stats.available_space(),
        total: stats.total_space(),
    })
}

/// Whether cleanup must leave `shot` alone: starred Keep forever, tagged by
/// the user (AI tags do not count), with notes, or with annotations or
/// recording edits saved beside it.
pub fn is_protected(shot: &Shot) -> bool {
    shot.keep || !shot.tags.is_empty() || !shot.notes.trim().is_empty() || has_edits(shot)
}

fn has_edits(shot: &Shot) -> bool {
    crate::capture::annotations_path(&shot.path).exists()
        || (shot.kind.is_recording() && crate::recording_editor::edits_path(&shot.path).exists())
}

/// The items older than their kind's Keep setting at `now_ms` and not
/// protected, oldest first.
pub fn due(library: &Library, retention: &Retention, now_ms: i64) -> LibraryResult<Vec<Shot>> {
    let mut stmt = library.connection().prepare(&format!(
        "SELECT {SHOT_COLUMNS} FROM shots s
         WHERE s.kind = ?1 AND s.captured_at < ?2 AND s.keep = 0
           AND trim(s.notes) = ''
           AND NOT EXISTS (SELECT 1 FROM shot_tags t WHERE t.shot_id = s.id)
         ORDER BY s.captured_at, s.id"
    ))?;
    let mut due = Vec::new();
    for kind in [ShotKind::Image, ShotKind::Gif, ShotKind::Video] {
        let Some(days) = retention.days(kind) else {
            continue;
        };
        let cutoff = now_ms.saturating_sub(i64::from(days) * DAY_MS);
        let shots = stmt
            .query_map(rusqlite::params![kind.as_str(), cutoff], shot_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        due.extend(shots.into_iter().filter(|shot| !has_edits(shot)));
    }
    Ok(due)
}

/// The count and size by kind of what [`due`] finds.
pub fn due_usage(library: &Library, retention: &Retention, now_ms: i64) -> LibraryResult<Usage> {
    let mut usage = Usage::default();
    for shot in due(library, retention, now_ms)? {
        let slot = match shot.kind {
            ShotKind::Image => &mut usage.image,
            ShotKind::Gif => &mut usage.gif,
            ShotKind::Video => &mut usage.video,
        };
        slot.count += 1;
        slot.bytes += shot.bytes.unwrap_or(0);
    }
    Ok(usage)
}

/// Milliseconds since the Unix epoch, as `captured_at` counts them.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

/// What a cleanup removed. Mirrors `Cleaned` in src/library/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cleaned {
    pub count: u32,
    pub bytes: u64,
}

/// How far a cleanup has got. Mirrors `CleanupProgress` in
/// src/library/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Items looked at so far, removed or not.
    pub done: u32,
    pub total: u32,
    /// What the items removed so far took up.
    pub bytes: u64,
}

/// Removes an item's files: its main file first, then its sidecars. Fails
/// only when the main file could not be removed. Faked in tests.
pub type RemoveFiles<'a> = dyn Fn(&[PathBuf], Removal) -> io::Result<()> + Sync + 'a;

/// Moves `files` to the system Trash or deletes them. The first is the
/// item's main file; the rest are its sidecars, whose failures are logged.
/// Files already gone are skipped.
pub fn remove_files(files: &[PathBuf], removal: Removal) -> io::Result<()> {
    let Some((main, sidecars)) = files.split_first() else {
        return Ok(());
    };
    match removal {
        Removal::Trash => {
            if main.exists() {
                trash::delete(main).map_err(io::Error::other)?;
            }
            for sidecar in sidecars.iter().filter(|path| path.exists()) {
                if let Err(err) = trash::delete(sidecar) {
                    eprintln!(
                        "Grab-it: could not move {} to the Trash: {err}",
                        sidecar.display()
                    );
                }
            }
        }
        Removal::Permanent => {
            remove_if_present(main)?;
            for sidecar in sidecars {
                if let Err(err) = remove_if_present(sidecar) {
                    eprintln!("Grab-it: could not delete {}: {err}", sidecar.display());
                }
            }
        }
    }
    Ok(())
}

/// Lets one cleanup run at a time, and lets Stop end the one running.
/// Whether one runs and whether it was asked to stop change together under
/// one lock, so a Stop that comes as a run ends cannot outlive it and cut
/// the next one short.
#[derive(Debug, Default)]
pub struct CleanupLock(Mutex<RunState>);

#[derive(Debug, Default)]
struct RunState {
    running: bool,
    stop: bool,
}

impl CleanupLock {
    fn state(&self) -> MutexGuard<'_, RunState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `None` while another cleanup runs.
    fn try_begin(&self) -> Option<CleanupGuard<'_>> {
        let mut state = self.state();
        if state.running {
            return None;
        }
        *state = RunState {
            running: true,
            stop: false,
        };
        Some(CleanupGuard(self))
    }

    /// Asks the running cleanup to stop before its next item. Does nothing,
    /// and says so, when none runs.
    pub fn request_stop(&self) -> bool {
        let mut state = self.state();
        state.stop = state.running;
        state.running
    }

    fn stop_requested(&self) -> bool {
        self.state().stop
    }

    #[cfg(test)]
    fn is_running(&self) -> bool {
        self.state().running
    }
}

struct CleanupGuard<'a>(&'a CleanupLock);

impl Drop for CleanupGuard<'_> {
    fn drop(&mut self) {
        *self.0.state() = RunState::default();
    }
}

#[derive(Debug)]
pub enum CleanupError {
    /// Another cleanup is running.
    Busy,
    /// More is due than the user confirmed removing, as when a Keep setting
    /// was shortened or items aged past it since the Clean up dialog looked.
    MoreDue(KindUsage),
    Library(LibraryError),
}

impl std::fmt::Display for CleanupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => f.write_str("a cleanup is already running"),
            Self::MoreDue(due) => write!(
                f,
                "More is due now than when you confirmed: {} {}. Check what Clean up removes and confirm again.",
                due.count,
                if due.count == 1 { "item" } else { "items" }
            ),
            Self::Library(err) => write!(f, "{err}"),
        }
    }
}

impl From<LibraryError> for CleanupError {
    fn from(err: LibraryError) -> Self {
        Self::Library(err)
    }
}

/// Removes the items [`due`] finds at `now_ms`, oldest first, with
/// `remove`, telling `progress` after each one. Removes nothing when more
/// is due than `confirmed`, when given: what the user agreed to remove.
/// Stops before the next item once [`CleanupLock::request_stop`] asks. An item starred, tagged or edited since the list was
/// made is spared, and one whose file cannot be removed stays in the
/// library. The library is locked one item at a time, so the windows keep
/// working while it runs.
#[allow(clippy::too_many_arguments)]
pub fn cleanup(
    running: &CleanupLock,
    library: &LibraryState,
    retention: &Retention,
    removal: Removal,
    now_ms: i64,
    remove: &RemoveFiles<'_>,
    progress: &mut dyn FnMut(Progress),
    confirmed: Option<KindUsage>,
) -> Result<Cleaned, CleanupError> {
    let _guard = running.try_begin().ok_or(CleanupError::Busy)?;
    let items = due(&library.lock(), retention, now_ms)?;
    let total = items.len() as u32;
    if let Some(confirmed) = confirmed {
        let found = KindUsage {
            count: total,
            bytes: items.iter().map(|item| item.bytes.unwrap_or(0)).sum(),
        };
        if found.count > confirmed.count || found.bytes > confirmed.bytes {
            return Err(CleanupError::MoreDue(found));
        }
    }
    let mut cleaned = Cleaned::default();
    for (index, item) in items.into_iter().enumerate() {
        if running.stop_requested() {
            break;
        }
        let shot = match library.lock().get(item.id) {
            Ok(shot) => Some(shot),
            Err(LibraryError::NotFound(_)) => None,
            Err(err) => return Err(err.into()),
        };
        if let Some(shot) = shot.filter(|shot| !is_protected(shot)) {
            // The thumbnail is Grab-it's own, made again if the item comes
            // back, so it is deleted rather than put in the Trash.
            let mut files = vec![shot.path.clone()];
            files.extend(
                extra_files(&shot)
                    .into_iter()
                    .filter(|path| *path != shot.thumb_path),
            );
            match remove(&files, removal) {
                Ok(()) => {
                    if let Err(err) = remove_if_present(&shot.thumb_path) {
                        eprintln!(
                            "Grab-it: could not delete {}: {err}",
                            shot.thumb_path.display()
                        );
                    }
                    library.lock().forget(shot.id)?;
                    cleaned.count += 1;
                    cleaned.bytes += shot.bytes.unwrap_or(0);
                }
                Err(err) => eprintln!(
                    "Grab-it: cleanup could not remove {}: {err}",
                    shot.path.display()
                ),
            }
        }
        progress(Progress {
            done: index as u32 + 1,
            total,
            bytes: cleaned.bytes,
        });
    }
    Ok(cleaned)
}

/// Rescans the save folder, then cleans up, and again whenever a day has
/// passed since, on a thread of its own.
pub fn start(app: &AppHandle, save_folder: PathBuf) {
    app.manage(CleanupLock::default());
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("grab-it-cleanup".into())
        .spawn(move || {
            crate::library::rescan_now(&app, &save_folder);
            let mut last = now_ms();
            clean_up_automatically(&app);
            loop {
                std::thread::sleep(CHECK_EVERY);
                if now_ms() - last >= DAY_MS {
                    last = now_ms();
                    clean_up_automatically(&app);
                }
            }
        });
    if let Err(err) = spawned {
        eprintln!("Grab-it: could not start cleanup: {err}");
    }
}

/// Removes what the Keep settings say is due, the way Settings says, and
/// tells the windows what went.
pub fn clean_up_automatically(app: &AppHandle) {
    let retention = lock(&app.state::<SettingsState>()).get().retention;
    if retention.image.is_none() && retention.gif.is_none() && retention.video.is_none() {
        return;
    }
    match clean_up(app, &retention, retention.removal, None) {
        Ok(cleaned) if cleaned.count > 0 => {
            let _ = app.emit(LIBRARY_CLEANED_EVENT, cleaned);
        }
        Ok(_) | Err(CleanupError::Busy) => {}
        Err(err) => eprintln!("Grab-it: cleanup failed: {err}"),
    }
}

/// Removes what `retention` says is due, by `removal`, telling the windows
/// how far it has got, when it ends, and that the library changed.
fn clean_up(
    app: &AppHandle,
    retention: &Retention,
    removal: Removal,
    confirmed: Option<KindUsage>,
) -> Result<Cleaned, CleanupError> {
    let (Some(running), Some(library)) = (
        app.try_state::<CleanupLock>(),
        app.try_state::<LibraryState>(),
    ) else {
        return Ok(Cleaned::default());
    };
    let remove = |files: &[PathBuf], removal: Removal| -> io::Result<()> {
        // An item open in an editor may have unsaved changes; it waits for
        // the next cleanup.
        if let Some(main) = files.first()
            && is_open_in_editor(app, main)
        {
            return Err(io::Error::other("it is open in an editor"));
        }
        remove_files(files, removal)
    };
    let result = cleanup(
        &running,
        &library,
        retention,
        removal,
        now_ms(),
        &remove,
        &mut |progress| {
            let _ = app.emit(CLEANUP_PROGRESS_EVENT, progress);
        },
        confirmed,
    );
    match &result {
        Err(CleanupError::Busy) => {}
        // Nothing was removed; the dialog asks again.
        Err(CleanupError::MoreDue(_)) => {
            let _ = app.emit(CLEANUP_DONE_EVENT, Cleaned::default());
        }
        Ok(cleaned) => {
            let _ = app.emit(CLEANUP_DONE_EVENT, cleaned);
            if cleaned.count > 0 {
                let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
            }
        }
        Err(_) => {
            let _ = app.emit(CLEANUP_DONE_EVENT, Cleaned::default());
            // Items removed before it failed are gone from the library.
            let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
        }
    }
    result
}

/// Removes what the saved Keep settings say is due, to the Trash or for
/// good as the Clean up dialog chose, on a worker thread. `confirmed` is
/// what the dialog showed and the user agreed to; when more is due now it
/// removes nothing and fails, so the dialog can ask again. Resolves to what
/// went once it is done or stopped; fails while another cleanup runs.
#[tauri::command]
pub async fn library_clean_up(
    removal: Removal,
    confirmed: KindUsage,
    app: AppHandle,
) -> Result<Cleaned, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let retention = lock(&app.state::<SettingsState>()).get().retention;
        clean_up(&app, &retention, removal, Some(confirmed))
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

/// Stops the running cleanup, automatic or from the Library, before its
/// next item. Does nothing when none runs.
#[tauri::command]
pub fn library_stop_clean_up(app: AppHandle) {
    if let Some(running) = app.try_state::<CleanupLock>() {
        running.request_stop();
    }
}

fn is_open_in_editor(app: &AppHandle, path: &Path) -> bool {
    app.try_state::<crate::editor::EditorState>()
        .is_some_and(|editors| editors.label_for(path).is_some())
        || app
            .try_state::<crate::recording_editor::RecordingEditorState>()
            .is_some_and(|editors| editors.label_for(path).is_some())
}

/// The library's size by kind, the save folder's disk, and what cleanup
/// would remove: under the saved Keep settings, or under `candidate` when
/// Settings asks before saving a shorter one.
#[tauri::command(async)]
pub fn library_storage(
    candidate: Option<Retention>,
    app: AppHandle,
    state: State<'_, LibraryState>,
    settings: State<'_, SettingsState>,
) -> Result<LibraryStorage, String> {
    let retention = candidate.unwrap_or_else(|| lock(&settings).get().retention);
    let (usage, due) = {
        let library = state.lock();
        let usage = usage(&library).map_err(|err| err.to_string())?;
        let due = due_usage(&library, &retention, now_ms()).map_err(|err| err.to_string())?;
        (usage, due)
    };
    let disk = disk_space(&current_save_folder(&app));
    Ok(LibraryStorage {
        image: usage.image,
        gif: usage.gif,
        video: usage.video,
        disk,
        due,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::PreparedShot;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn item(kind: ShotKind, name: &str, bytes: Option<u64>) -> PreparedShot {
        let path = PathBuf::from(format!("/nowhere/{name}"));
        PreparedShot {
            kind,
            thumb_path: PathBuf::from(format!("/nowhere/thumbs/{name}.png")),
            path,
            captured_at: 0,
            mode: None,
            app: None,
            window_title: None,
            width: 10,
            height: 10,
            duration_ms: None,
            bytes,
        }
    }

    #[test]
    fn an_empty_library_uses_nothing() {
        let library = Library::open_in_memory().unwrap();
        assert_eq!(usage(&library).unwrap(), Usage::default());
    }

    #[test]
    fn usage_counts_and_sizes_each_kind() {
        let mut library = Library::open_in_memory().unwrap();
        library
            .insert(&item(ShotKind::Image, "a.png", Some(1_000)))
            .unwrap();
        library
            .insert(&item(ShotKind::Image, "b.png", Some(2_500)))
            .unwrap();
        // A capture whose size is not known yet counts, at no size.
        library
            .insert(&item(ShotKind::Image, "c.png", None))
            .unwrap();
        library
            .insert(&item(ShotKind::Gif, "d.gif", Some(40_000)))
            .unwrap();
        library
            .insert(&item(ShotKind::Video, "e.mp4", Some(9_000_000)))
            .unwrap();
        library
            .insert(&item(ShotKind::Video, "f.mp4", Some(1_000_000)))
            .unwrap();

        assert_eq!(
            usage(&library).unwrap(),
            Usage {
                image: KindUsage {
                    count: 3,
                    bytes: 3_500,
                },
                gif: KindUsage {
                    count: 1,
                    bytes: 40_000,
                },
                video: KindUsage {
                    count: 2,
                    bytes: 10_000_000,
                },
            }
        );
    }

    #[test]
    fn usage_serializes_for_the_library_window() {
        let storage = LibraryStorage {
            image: KindUsage {
                count: 2,
                bytes: 30,
            },
            gif: KindUsage::default(),
            video: KindUsage::default(),
            disk: Some(DiskSpace {
                free: 5,
                total: 100,
            }),
            due: Usage {
                gif: KindUsage {
                    count: 1,
                    bytes: 10,
                },
                ..Usage::default()
            },
        };
        assert_eq!(
            serde_json::to_value(storage).unwrap(),
            serde_json::json!({
                "image": { "count": 2, "bytes": 30 },
                "gif": { "count": 0, "bytes": 0 },
                "video": { "count": 0, "bytes": 0 },
                "disk": { "free": 5, "total": 100 },
                "due": {
                    "image": { "count": 0, "bytes": 0 },
                    "gif": { "count": 1, "bytes": 10 },
                    "video": { "count": 0, "bytes": 0 },
                },
            })
        );
    }

    const NOW: i64 = 1_000 * DAY_MS;

    /// A library item of `kind` captured `days_old` days before [`NOW`],
    /// with its file and thumbnail on disk in `dir`.
    fn aged(library: &mut Library, dir: &Path, kind: ShotKind, name: &str, days_old: i64) -> Shot {
        let path = dir.join(name);
        std::fs::write(&path, b"item").unwrap();
        let thumb_path = dir.join(format!("{name}.thumb.png"));
        std::fs::write(&thumb_path, b"thumb").unwrap();
        library
            .insert(&PreparedShot {
                kind,
                path,
                thumb_path,
                captured_at: NOW - days_old * DAY_MS,
                mode: None,
                app: None,
                window_title: None,
                width: 10,
                height: 10,
                duration_ms: None,
                bytes: Some(100),
            })
            .unwrap()
    }

    fn keep(image: Option<u32>, gif: Option<u32>, video: Option<u32>) -> Retention {
        Retention {
            image,
            gif,
            video,
            removal: Removal::Trash,
        }
    }

    fn ids(shots: &[Shot]) -> Vec<i64> {
        shots.iter().map(|shot| shot.id).collect()
    }

    #[test]
    fn items_older_than_their_kinds_keep_setting_are_due() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let old_image = aged(&mut library, dir.path(), ShotKind::Image, "a.png", 40);
        let _new_image = aged(&mut library, dir.path(), ShotKind::Image, "b.png", 20);
        let old_gif = aged(&mut library, dir.path(), ShotKind::Gif, "c.gif", 8);
        let _new_gif = aged(&mut library, dir.path(), ShotKind::Gif, "d.gif", 6);
        // Videos are kept forever.
        let _old_video = aged(&mut library, dir.path(), ShotKind::Video, "e.mp4", 900);

        let retention = keep(Some(30), Some(7), None);
        assert_eq!(
            ids(&due(&library, &retention, NOW).unwrap()),
            vec![old_image.id, old_gif.id]
        );
        assert_eq!(
            due_usage(&library, &retention, NOW).unwrap(),
            Usage {
                image: KindUsage {
                    count: 1,
                    bytes: 100,
                },
                gif: KindUsage {
                    count: 1,
                    bytes: 100,
                },
                video: KindUsage::default(),
            }
        );
    }

    #[test]
    fn nothing_is_due_when_everything_is_kept_forever() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        aged(&mut library, dir.path(), ShotKind::Image, "a.png", 5_000);
        aged(&mut library, dir.path(), ShotKind::Video, "b.mp4", 5_000);
        assert!(
            due(&library, &Retention::default(), NOW)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn starred_tagged_noted_and_edited_items_are_never_due() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let starred = aged(&mut library, dir.path(), ShotKind::Image, "star.png", 90);
        library.set_keep(starred.id, true).unwrap();
        let tagged = aged(&mut library, dir.path(), ShotKind::Image, "tag.png", 90);
        library.set_tags(tagged.id, &["receipts".into()]).unwrap();
        let noted = aged(&mut library, dir.path(), ShotKind::Image, "note.png", 90);
        library.set_notes(noted.id, "the invoice").unwrap();
        let annotated = aged(&mut library, dir.path(), ShotKind::Image, "ann.png", 90);
        std::fs::write(crate::capture::annotations_path(&annotated.path), "{}").unwrap();
        let edited = aged(&mut library, dir.path(), ShotKind::Video, "cut.mp4", 90);
        std::fs::write(crate::recording_editor::edits_path(&edited.path), "{}").unwrap();
        // Blank notes and AI tags do not protect an item.
        let blank = aged(&mut library, dir.path(), ShotKind::Image, "blank.png", 90);
        library.set_notes(blank.id, "   ").unwrap();
        let described = aged(&mut library, dir.path(), ShotKind::Image, "ai.png", 90);
        library
            .set_ai_description(
                described.id,
                &crate::library::AiDescription {
                    description: "A receipt.".into(),
                    category: "receipt".into(),
                    tags: vec!["receipts".into()],
                },
                "test-model",
            )
            .unwrap();
        let plain = aged(&mut library, dir.path(), ShotKind::Video, "plain.mp4", 90);

        let retention = keep(Some(30), Some(30), Some(30));
        assert_eq!(
            ids(&due(&library, &retention, NOW).unwrap()),
            vec![blank.id, described.id, plain.id]
        );
        let described = library.get(described.id).unwrap();
        assert_eq!(described.ai_tags, vec!["receipts".to_string()]);
        assert!(!is_protected(&described));
        for id in [starred.id, tagged.id, noted.id] {
            assert!(is_protected(&library.get(id).unwrap()));
        }
        assert!(is_protected(&library.get(annotated.id).unwrap()));
        assert!(is_protected(&library.get(edited.id).unwrap()));
        assert!(!is_protected(&library.get(plain.id).unwrap()));
    }

    #[test]
    fn unstarring_makes_an_item_due_again() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let shot = aged(&mut library, dir.path(), ShotKind::Gif, "a.gif", 90);
        assert!(library.set_keep(shot.id, true).unwrap().keep);
        let retention = keep(None, Some(30), None);
        assert!(due(&library, &retention, NOW).unwrap().is_empty());
        assert!(!library.set_keep(shot.id, false).unwrap().keep);
        assert_eq!(ids(&due(&library, &retention, NOW).unwrap()), vec![shot.id]);
    }

    /// What a cleanup asked its remover to do.
    type RemoveCall = (Vec<PathBuf>, Removal);

    /// Runs a cleanup with a remover that records what it was asked to do
    /// and deletes the files.
    fn clean(
        library: &LibraryState,
        retention: &Retention,
        removal: Removal,
    ) -> (Cleaned, Vec<RemoveCall>, Vec<Progress>) {
        let calls = std::sync::Mutex::new(Vec::new());
        let remove = |files: &[PathBuf], removal: Removal| -> io::Result<()> {
            calls.lock().unwrap().push((files.to_vec(), removal));
            remove_files(files, Removal::Permanent)
        };
        let mut seen = Vec::new();
        let cleaned = cleanup(
            &CleanupLock::default(),
            library,
            retention,
            removal,
            NOW,
            &remove,
            &mut |progress| seen.push(progress),
            None,
        )
        .unwrap();
        (cleaned, calls.into_inner().unwrap(), seen)
    }

    #[test]
    fn cleanup_moves_due_items_to_the_trash_and_forgets_them() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let old = aged(&mut library, dir.path(), ShotKind::Video, "old.mp4", 60);
        let cursor = crate::record::cursor_path(&old.path);
        std::fs::write(&cursor, "[]").unwrap();
        let kept = aged(&mut library, dir.path(), ShotKind::Video, "new.mp4", 10);
        let state = LibraryState::new(library);

        let (cleaned, calls, progress) = clean(&state, &keep(None, None, Some(30)), Removal::Trash);

        assert_eq!(
            cleaned,
            Cleaned {
                count: 1,
                bytes: 100,
            }
        );
        assert_eq!(calls.len(), 1);
        let (files, removal) = &calls[0];
        assert_eq!(removal, &Removal::Trash);
        assert_eq!(files[0], old.path, "the main file goes first");
        assert!(files.contains(&cursor));
        assert!(
            !files.contains(&old.thumb_path),
            "the thumbnail is not put in the Trash"
        );
        assert!(!old.thumb_path.exists(), "the thumbnail is deleted");
        assert_eq!(
            progress,
            vec![Progress {
                done: 1,
                total: 1,
                bytes: 100,
            }]
        );
        let library = state.lock();
        assert!(matches!(
            library.get(old.id),
            Err(LibraryError::NotFound(_))
        ));
        assert!(library.get(kept.id).is_ok());
        assert!(kept.path.exists());
    }

    #[test]
    fn cleanup_can_delete_permanently() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let old = aged(&mut library, dir.path(), ShotKind::Image, "old.png", 400);
        let meta = crate::capture::meta_path(&old.path);
        std::fs::write(&meta, "{}").unwrap();
        let state = LibraryState::new(library);

        let (cleaned, calls, _) = clean(&state, &keep(Some(365), None, None), Removal::Permanent);

        assert_eq!(cleaned.count, 1);
        assert_eq!(calls[0].1, Removal::Permanent);
        assert!(!old.path.exists());
        assert!(!meta.exists());
        assert_eq!(state.lock().count().unwrap(), 0);
    }

    #[test]
    fn remove_files_deletes_permanently_and_skips_missing_files() {
        let dir = TempDir::new().unwrap();
        let main = dir.path().join("a.png");
        std::fs::write(&main, b"x").unwrap();
        let missing = dir.path().join("a.meta.json");
        remove_files(&[main.clone(), missing], Removal::Permanent).unwrap();
        assert!(!main.exists());
        // An item whose files are already gone is nothing to remove.
        remove_files(&[dir.path().join("gone.png")], Removal::Trash).unwrap();
    }

    #[test]
    fn an_item_whose_file_cannot_be_removed_stays() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let old = aged(&mut library, dir.path(), ShotKind::Gif, "old.gif", 60);
        let state = LibraryState::new(library);
        let refuse =
            |_: &[PathBuf], _: Removal| -> io::Result<()> { Err(io::Error::other("in use")) };
        let cleaned = cleanup(
            &CleanupLock::default(),
            &state,
            &keep(None, Some(30), None),
            Removal::Trash,
            NOW,
            &refuse,
            &mut |_| {},
            None,
        )
        .unwrap();
        assert_eq!(cleaned, Cleaned::default());
        assert!(state.lock().get(old.id).is_ok());
        assert!(old.thumb_path.exists());
    }

    #[test]
    fn an_item_starred_after_the_list_was_made_is_spared() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let first = aged(&mut library, dir.path(), ShotKind::Image, "a.png", 60);
        let second = aged(&mut library, dir.path(), ShotKind::Image, "b.png", 50);
        let state = LibraryState::new(library);
        // Starring the second while the first is removed.
        let remove = |files: &[PathBuf], removal: Removal| -> io::Result<()> {
            if files[0] == first.path {
                state.lock().set_keep(second.id, true).unwrap();
            }
            remove_files(files, removal)
        };
        let cleaned = cleanup(
            &CleanupLock::default(),
            &state,
            &keep(Some(30), None, None),
            Removal::Permanent,
            NOW,
            &remove,
            &mut |_| {},
            None,
        )
        .unwrap();
        assert_eq!(cleaned.count, 1);
        assert!(state.lock().get(second.id).is_ok());
        assert!(second.path.exists());
    }

    #[test]
    fn stop_ends_a_cleanup_before_the_next_item() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        for name in ["a.png", "b.png", "c.png"] {
            aged(&mut library, dir.path(), ShotKind::Image, name, 60);
        }
        let state = LibraryState::new(library);
        let running = CleanupLock::default();
        let mut seen = Vec::new();
        let cleaned = cleanup(
            &running,
            &state,
            &keep(Some(30), None, None),
            Removal::Permanent,
            NOW,
            &remove_files,
            &mut |progress| {
                seen.push(progress);
                assert!(running.request_stop(), "a running cleanup can be stopped");
            },
            None,
        )
        .unwrap();
        assert_eq!(cleaned.count, 1);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].total, 3);
        assert_eq!(state.lock().count().unwrap(), 2);
    }

    #[test]
    fn one_cleanup_runs_at_a_time() {
        let state = LibraryState::new(Library::open_in_memory().unwrap());
        let running = CleanupLock::default();
        let held = running.try_begin().expect("the first cleanup starts");
        assert!(running.is_running());
        let busy = cleanup(
            &running,
            &state,
            &Retention::default(),
            Removal::Trash,
            NOW,
            &remove_files,
            &mut |_| {},
            None,
        );
        assert!(matches!(busy, Err(CleanupError::Busy)));
        drop(held);
        assert!(!running.is_running());
        assert!(
            cleanup(
                &running,
                &state,
                &Retention::default(),
                Removal::Trash,
                NOW,
                &remove_files,
                &mut |_| {},
                None,
            )
            .is_ok()
        );
    }

    #[test]
    fn every_item_a_cleanup_looks_at_is_reported() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        aged(&mut library, dir.path(), ShotKind::Image, "a.png", 60);
        let spared = aged(&mut library, dir.path(), ShotKind::Image, "b.png", 50);
        aged(&mut library, dir.path(), ShotKind::Gif, "c.gif", 40);
        let state = LibraryState::new(library);
        // An item that cannot be removed still counts as looked at.
        let remove = |files: &[PathBuf], removal: Removal| -> io::Result<()> {
            if files[0] == spared.path {
                return Err(io::Error::other("open in an editor"));
            }
            remove_files(files, removal)
        };
        let mut seen = Vec::new();
        let cleaned = cleanup(
            &CleanupLock::default(),
            &state,
            &keep(Some(30), Some(30), None),
            Removal::Permanent,
            NOW,
            &remove,
            &mut |progress| seen.push(progress),
            None,
        )
        .unwrap();

        assert_eq!(
            cleaned,
            Cleaned {
                count: 2,
                bytes: 200,
            }
        );
        assert_eq!(
            seen,
            vec![
                Progress {
                    done: 1,
                    total: 3,
                    bytes: 100,
                },
                Progress {
                    done: 2,
                    total: 3,
                    bytes: 100,
                },
                Progress {
                    done: 3,
                    total: 3,
                    bytes: 200,
                },
            ]
        );
    }

    #[test]
    fn progress_serializes_for_the_windows() {
        assert_eq!(
            serde_json::to_value(Progress {
                done: 2,
                total: 5,
                bytes: 300,
            })
            .unwrap(),
            serde_json::json!({ "done": 2, "total": 5, "bytes": 300 })
        );
        assert_eq!(
            serde_json::to_value(Cleaned {
                count: 1,
                bytes: 100,
            })
            .unwrap(),
            serde_json::json!({ "count": 1, "bytes": 100 })
        );
    }

    #[test]
    fn a_stop_asked_for_mid_run_ends_only_that_run() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        for name in ["a.png", "b.png", "c.png", "d.png"] {
            aged(&mut library, dir.path(), ShotKind::Image, name, 60);
        }
        let state = LibraryState::new(library);
        let running = CleanupLock::default();
        let mut seen = Vec::new();
        // Stop is pressed while the second item is removed, as
        // `library_stop_clean_up` does.
        let removed = std::sync::atomic::AtomicU32::new(0);
        let cleaned = cleanup(
            &running,
            &state,
            &keep(Some(30), None, None),
            Removal::Trash,
            NOW,
            &|files: &[PathBuf], _: Removal| {
                if removed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 1 {
                    assert!(running.request_stop(), "a running cleanup can be stopped");
                }
                remove_files(files, Removal::Permanent)
            },
            &mut |progress| seen.push(progress),
            None,
        )
        .unwrap();

        assert_eq!(cleaned.count, 2);
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[1].done, 2);
        assert_eq!(seen[1].total, 4);
        assert_eq!(state.lock().count().unwrap(), 2);
        assert!(!running.stop_requested(), "the stop ends with its run");

        // The next cleanup removes the rest.
        let rest = cleanup(
            &running,
            &state,
            &keep(Some(30), None, None),
            Removal::Permanent,
            NOW,
            &remove_files,
            &mut |_| {},
            None,
        )
        .unwrap();
        assert_eq!(rest.count, 2);
        assert_eq!(state.lock().count().unwrap(), 0);
    }

    #[test]
    fn a_stop_that_comes_after_a_run_ends_is_dropped() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        for name in ["a.png", "b.png"] {
            aged(&mut library, dir.path(), ShotKind::Image, name, 60);
        }
        let state = LibraryState::new(library);
        let running = CleanupLock::default();
        // Stop pressed just after the last run ended, or while none runs.
        assert!(!running.request_stop());
        assert!(!running.stop_requested());

        let cleaned = cleanup(
            &running,
            &state,
            &keep(Some(30), None, None),
            Removal::Permanent,
            NOW,
            &remove_files,
            &mut |_| {},
            None,
        )
        .unwrap();
        assert_eq!(cleaned.count, 2, "the next run is not cut short");
    }

    #[test]
    fn a_stop_left_from_an_earlier_run_is_cleared_when_the_next_begins() {
        let running = CleanupLock::default();
        {
            let _first = running.try_begin().expect("the first cleanup starts");
            assert!(running.request_stop());
        }
        assert!(!running.stop_requested());
        let _second = running.try_begin().expect("the second cleanup starts");
        assert!(!running.stop_requested());
        // A stop asked of the second run is its own.
        assert!(running.request_stop());
        assert!(running.stop_requested());
    }

    #[test]
    fn a_busy_cleanup_leaves_the_stop_for_the_one_running() {
        let state = LibraryState::new(Library::open_in_memory().unwrap());
        let running = CleanupLock::default();
        let _held = running.try_begin().expect("the first cleanup starts");
        assert!(running.request_stop());
        let busy = cleanup(
            &running,
            &state,
            &Retention::default(),
            Removal::Trash,
            NOW,
            &remove_files,
            &mut |_| {},
            None,
        );
        assert!(matches!(busy, Err(CleanupError::Busy)));
        assert!(running.stop_requested());
    }

    #[test]
    fn a_cleanup_removes_nothing_when_more_is_due_than_confirmed() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        aged(&mut library, dir.path(), ShotKind::Video, "a.mp4", 40);
        aged(&mut library, dir.path(), ShotKind::Video, "b.mp4", 10);
        let state = LibraryState::new(library);
        // The dialog showed one video due under 30 days; Keep is 7 days now.
        let shown = KindUsage {
            count: 1,
            bytes: 100,
        };
        let more = cleanup(
            &CleanupLock::default(),
            &state,
            &keep(None, None, Some(7)),
            Removal::Permanent,
            NOW,
            &remove_files,
            &mut |_| {},
            Some(shown),
        );
        assert!(matches!(
            more,
            Err(CleanupError::MoreDue(KindUsage {
                count: 2,
                bytes: 200,
            }))
        ));
        assert_eq!(state.lock().count().unwrap(), 2, "nothing is removed");

        // What was shown, or less, goes ahead.
        let cleaned = cleanup(
            &CleanupLock::default(),
            &state,
            &keep(None, None, Some(30)),
            Removal::Permanent,
            NOW,
            &remove_files,
            &mut |_| {},
            Some(shown),
        )
        .unwrap();
        assert_eq!(cleaned.count, 1);
    }

    #[test]
    fn the_dialogs_confirmed_usage_deserializes() {
        let confirmed: KindUsage =
            serde_json::from_value(serde_json::json!({ "count": 3, "bytes": 42 })).unwrap();
        assert_eq!(
            confirmed,
            KindUsage {
                count: 3,
                bytes: 42,
            }
        );
    }

    #[test]
    fn disk_space_reads_the_folders_disk() {
        let dir = TempDir::new().unwrap();
        let disk = disk_space(dir.path()).expect("the temp folder's disk");
        assert!(disk.total > 0);
        assert!(disk.free <= disk.total);
    }

    #[test]
    fn a_folder_not_made_yet_is_measured_on_its_parents_disk() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("Grab-it").join("not yet");
        assert_eq!(
            disk_space(&missing).map(|disk| disk.total),
            disk_space(dir.path()).map(|disk| disk.total)
        );
    }
}
