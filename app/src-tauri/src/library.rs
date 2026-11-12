//! The capture library: `library.db` in the app data directory.
//!
//! Each capture is one row in `shots`, keyed by its unique full path, with
//! the fields from its `meta.json` sidecar, a 400 px thumbnail in its own
//! save folder's `thumbs/`, tags and notes. The PNG and its sidecars stay
//! the source of truth: rows are added for new files when a save folder is
//! scanned, and a row is dropped only when its file is gone. Changing the
//! save folder leaves older captures (and their rows) where they are.

use std::{
    collections::HashSet,
    fmt, fs, io,
    path::{Path, PathBuf},
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::UNIX_EPOCH,
};

use chrono::DateTime;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    capture::{self, CaptureMeta, ORIGINALS_DIR},
    commands::{SettingsState, lock},
    editor::EditorState,
    windows,
};

pub const LIBRARY_FILE: &str = "library.db";
pub const THUMBS_DIR: &str = "thumbs";
/// Thumbnails fit inside a square of this many pixels.
pub const THUMB_SIZE: u32 = 400;
/// Emitted to every window when shots are added, changed or removed.
pub const LIBRARY_CHANGED_EVENT: &str = "library-changed";
/// The most shots one page may hold.
pub const MAX_PAGE: u32 = 500;
const MAX_TAG_CHARS: usize = 64;

/// Schema migrations; `PRAGMA user_version` is how many have run.
/// Append new ones, never edit old ones.
const MIGRATIONS: &[&str] = &[
    // 1: shots and their tags.
    "CREATE TABLE shots (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        thumb_path TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        mode TEXT,
        app TEXT,
        window_title TEXT,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX shots_newest ON shots (captured_at DESC, id DESC);
    CREATE TABLE shot_tags (
        shot_id INTEGER NOT NULL REFERENCES shots (id) ON DELETE CASCADE,
        tag TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (shot_id, tag)
    );
    CREATE INDEX shot_tags_tag ON shot_tags (tag);",
];

#[derive(Debug)]
pub enum LibraryError {
    Sql(rusqlite::Error),
    Io(io::Error),
    Image(image::ImageError),
    /// No shot has this id.
    NotFound(i64),
    /// The database was written by a newer Grab-it.
    TooNew(i64),
}

impl fmt::Display for LibraryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sql(err) => write!(f, "library database error: {err}"),
            Self::Io(err) => write!(f, "{err}"),
            Self::Image(err) => write!(f, "could not read the capture: {err}"),
            Self::NotFound(id) => write!(f, "no capture with id {id} in the library"),
            Self::TooNew(version) => write!(
                f,
                "the library was created by a newer Grab-it (schema {version})"
            ),
        }
    }
}

impl std::error::Error for LibraryError {}

impl From<rusqlite::Error> for LibraryError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Sql(err)
    }
}

impl From<io::Error> for LibraryError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<image::ImageError> for LibraryError {
    fn from(err: image::ImageError) -> Self {
        Self::Image(err)
    }
}

pub type LibraryResult<T> = std::result::Result<T, LibraryError>;

/// One capture. Mirrors `Shot` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub id: i64,
    pub path: PathBuf,
    pub file_name: String,
    pub thumb_path: PathBuf,
    /// Milliseconds since the Unix epoch.
    pub captured_at: i64,
    pub mode: Option<String>,
    pub app: Option<String>,
    pub window_title: Option<String>,
    pub width: u32,
    pub height: u32,
    pub tags: Vec<String>,
    pub notes: String,
}

/// One page of shots, newest first. Mirrors `ShotPage` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotPage {
    pub shots: Vec<Shot>,
    pub offset: u32,
    /// Every shot in the library.
    pub total: u32,
}

/// What a rescan changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RescanReport {
    pub added: usize,
    pub removed: usize,
}

impl RescanReport {
    pub fn changed(self) -> bool {
        self.added > 0 || self.removed > 0
    }
}

pub struct Library {
    conn: Connection,
}

impl Library {
    /// Opens (or creates) the database at `path` and migrates it.
    pub fn open(path: &Path) -> LibraryResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        Self::init(Connection::open(path)?)
    }

    /// A library that lives only in memory, for tests and as a stand-in
    /// when `library.db` cannot be opened.
    pub fn open_in_memory() -> LibraryResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> LibraryResult<Self> {
        conn.pragma_update(None, "foreign_keys", true)?;
        let mut library = Self { conn };
        library.migrate()?;
        Ok(library)
    }

    /// The schema version, from `PRAGMA user_version`.
    pub fn schema_version(&self) -> LibraryResult<i64> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    fn migrate(&mut self) -> LibraryResult<()> {
        let current = self.schema_version()?;
        let latest = MIGRATIONS.len() as i64;
        if current > latest {
            return Err(LibraryError::TooNew(current));
        }
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", index as i64 + 1)?;
            tx.commit()?;
        }
        Ok(())
    }

    /// Adds a capture, or refreshes its row when the path is already known.
    /// Its thumbnail is created if missing. The app uses
    /// [`LibraryState::add_capture`], which makes it without the lock.
    #[cfg(test)]
    pub fn add_capture(&mut self, png: &Path) -> LibraryResult<Shot> {
        let prepared = prepare_capture(png)?;
        self.insert(&prepared)
    }

    /// Stores a capture read by [`prepare_capture`], or refreshes its row
    /// when the path is already known. Tags and notes are kept.
    pub fn insert(&mut self, shot: &PreparedShot) -> LibraryResult<Shot> {
        let id = insert_prepared(&self.conn, shot)?;
        self.get(id)
    }

    /// Brings the library up to date with `save_folder`: rows whose file is
    /// gone are dropped (in any folder), new PNGs in its `originals/` are
    /// added, and missing thumbnails are regenerated. Rows for captures in
    /// other folders are kept while their files exist.
    ///
    /// Single-owner shortcut for tests; the app uses [`LibraryState::rescan`],
    /// which does the file work without holding the lock.
    #[cfg(test)]
    pub fn rescan(&mut self, save_folder: &Path) -> LibraryResult<RescanReport> {
        let known = self.known()?;
        let scan = scan_files(&known, save_folder)?;
        self.apply(&scan)
    }

    /// Every row's id, path and thumbnail path.
    pub fn known(&self) -> LibraryResult<Vec<KnownShot>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, path, thumb_path FROM shots")?;
        let known = stmt
            .query_map([], |row| {
                Ok(KnownShot {
                    id: row.get(0)?,
                    path: PathBuf::from(row.get::<_, String>(1)?),
                    thumb_path: PathBuf::from(row.get::<_, String>(2)?),
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(known)
    }

    /// Stores what [`scan_files`] found. The files are checked again, so a
    /// capture recorded or restored while the scan ran is neither added
    /// twice nor dropped.
    pub fn apply(&mut self, scan: &ScanResult) -> LibraryResult<RescanReport> {
        let mut report = RescanReport::default();
        let tx = self.conn.transaction()?;
        for id in &scan.gone {
            let path: Option<String> = tx
                .query_row("SELECT path FROM shots WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .optional()?;
            if path.is_some_and(|path| !Path::new(&path).is_file()) {
                tx.execute("DELETE FROM shots WHERE id = ?1", [id])?;
                report.removed += 1;
            }
        }
        for shot in &scan.new {
            let known: Option<i64> = tx
                .query_row(
                    "SELECT id FROM shots WHERE path = ?1",
                    [path_text(&shot.path)],
                    |row| row.get(0),
                )
                .optional()?;
            if known.is_none() && shot.path.is_file() {
                insert_prepared(&tx, shot)?;
                report.added += 1;
            }
        }
        tx.commit()?;
        Ok(report)
    }

    /// How many shots the library holds.
    pub fn count(&self) -> LibraryResult<u32> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM shots", [], |row| row.get(0))?)
    }

    /// Up to `limit` shots, newest first, skipping the first `offset`.
    pub fn list(&self, offset: u32, limit: u32) -> LibraryResult<ShotPage> {
        let limit = limit.clamp(1, MAX_PAGE);
        let mut stmt = self.conn.prepare(
            "SELECT id, path, thumb_path, captured_at, mode, app, window_title, width, height, notes
             FROM shots ORDER BY captured_at DESC, id DESC LIMIT ?1 OFFSET ?2",
        )?;
        let mut shots = stmt
            .query_map(params![limit, offset], shot_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for shot in &mut shots {
            shot.tags = self.tags_of(shot.id)?;
        }
        Ok(ShotPage {
            shots,
            offset,
            total: self.count()?,
        })
    }

    pub fn get(&self, id: i64) -> LibraryResult<Shot> {
        let mut shot = self
            .conn
            .query_row(
                "SELECT id, path, thumb_path, captured_at, mode, app, window_title, width, height, notes
                 FROM shots WHERE id = ?1",
                [id],
                shot_from_row,
            )
            .optional()?
            .ok_or(LibraryError::NotFound(id))?;
        shot.tags = self.tags_of(id)?;
        Ok(shot)
    }

    fn tags_of(&self, id: i64) -> LibraryResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT tag FROM shot_tags WHERE shot_id = ?1 ORDER BY tag COLLATE NOCASE")?;
        let tags = stmt
            .query_map([id], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(tags)
    }

    /// Replaces a shot's tags. Tags are trimmed; empty ones and
    /// case-insensitive duplicates are dropped.
    pub fn set_tags(&mut self, id: i64, tags: &[String]) -> LibraryResult<Shot> {
        let tags = normalize_tags(tags);
        let tx = self.conn.transaction()?;
        let exists: Option<i64> = tx
            .query_row("SELECT id FROM shots WHERE id = ?1", [id], |row| row.get(0))
            .optional()?;
        if exists.is_none() {
            return Err(LibraryError::NotFound(id));
        }
        tx.execute("DELETE FROM shot_tags WHERE shot_id = ?1", [id])?;
        for tag in &tags {
            tx.execute(
                "INSERT INTO shot_tags (shot_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )?;
        }
        tx.commit()?;
        self.get(id)
    }

    pub fn set_notes(&mut self, id: i64, notes: &str) -> LibraryResult<Shot> {
        let changed = self.conn.execute(
            "UPDATE shots SET notes = ?1 WHERE id = ?2",
            params![notes, id],
        )?;
        if changed == 0 {
            return Err(LibraryError::NotFound(id));
        }
        self.get(id)
    }

    /// Deletes a shot's PNG, its sidecars and its thumbnail, then its row.
    /// If the PNG cannot be removed nothing else is touched.
    pub fn delete(&mut self, id: i64) -> LibraryResult<Shot> {
        let shot = self.get(id)?;
        remove_if_present(&shot.path)?;
        for extra in [
            capture::meta_path(&shot.path),
            capture::annotations_path(&shot.path),
            shot.thumb_path.clone(),
        ] {
            if let Err(err) = remove_if_present(&extra) {
                eprintln!("Grab-it: could not delete {}: {err}", extra.display());
            }
        }
        self.conn.execute("DELETE FROM shots WHERE id = ?1", [id])?;
        Ok(shot)
    }

    /// The shot's thumbnail PNG, regenerated if it is missing.
    #[cfg(test)]
    pub fn thumbnail(&self, id: i64) -> LibraryResult<Vec<u8>> {
        thumbnail_bytes(&self.get(id)?)
    }
}

/// A row as [`Library::known`] reads it for a rescan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownShot {
    pub id: i64,
    pub path: PathBuf,
    pub thumb_path: PathBuf,
}

/// A capture's row, read from disk (with its thumbnail made) without
/// touching the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedShot {
    pub path: PathBuf,
    pub thumb_path: PathBuf,
    pub captured_at: i64,
    pub mode: Option<String>,
    pub app: Option<String>,
    pub window_title: Option<String>,
    pub width: u32,
    pub height: u32,
}

/// The file work of a rescan, for [`Library::apply`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanResult {
    /// Rows whose file was missing.
    pub gone: Vec<i64>,
    /// New captures in the save folder.
    pub new: Vec<PreparedShot>,
}

/// Reads a capture's meta sidecar and size, and makes its thumbnail if
/// missing. Touches only files, so it runs without the library lock.
pub fn prepare_capture(png: &Path) -> LibraryResult<PreparedShot> {
    let path = canonical(png);
    let thumb_path = thumb_path(&path);
    ensure_thumbnail(&path, &thumb_path)?;
    let meta = read_meta(&path);
    let captured_at = meta
        .as_ref()
        .and_then(|meta| DateTime::parse_from_rfc3339(&meta.captured_at).ok())
        .map(|time| time.timestamp_millis())
        .unwrap_or_else(|| modified_millis(&path));
    let (width, height) = match &meta {
        Some(meta) if meta.width > 0 && meta.height > 0 => (meta.width, meta.height),
        _ => image::image_dimensions(&path)?,
    };
    let mode = meta.as_ref().and_then(|meta| {
        serde_json::to_value(meta.mode)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
    });
    let (app, window_title) = meta
        .map(|meta| (meta.app, meta.window_title))
        .unwrap_or_default();
    Ok(PreparedShot {
        path,
        thumb_path,
        captured_at,
        mode,
        app,
        window_title,
        width,
        height,
    })
}

/// The file side of a rescan: finds rows whose file is gone, regenerates
/// missing thumbnails and prepares new PNGs in `<save_folder>/originals/`.
/// Touches only files, so it runs without the library lock.
pub fn scan_files(known: &[KnownShot], save_folder: &Path) -> LibraryResult<ScanResult> {
    let mut scan = ScanResult::default();
    for shot in known {
        if shot.path.is_file() {
            if let Err(err) = ensure_thumbnail(&shot.path, &shot.thumb_path) {
                eprintln!(
                    "Grab-it: could not make a thumbnail for {}: {err}",
                    shot.path.display()
                );
            }
        } else {
            scan.gone.push(shot.id);
        }
    }
    let paths: HashSet<&Path> = known.iter().map(|shot| shot.path.as_path()).collect();
    for png in originals_in(save_folder)? {
        let path = canonical(&png);
        if paths.contains(path.as_path()) {
            continue;
        }
        match prepare_capture(&path) {
            Ok(shot) => scan.new.push(shot),
            Err(err) => eprintln!("Grab-it: skipped {}: {err}", path.display()),
        }
    }
    Ok(scan)
}

/// Upserts a prepared capture and returns its id.
fn insert_prepared(conn: &Connection, shot: &PreparedShot) -> LibraryResult<i64> {
    conn.execute(
        "INSERT INTO shots (path, thumb_path, captured_at, mode, app, window_title, width, height)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (path) DO UPDATE SET
            thumb_path = excluded.thumb_path,
            captured_at = excluded.captured_at,
            mode = excluded.mode,
            app = excluded.app,
            window_title = excluded.window_title,
            width = excluded.width,
            height = excluded.height",
        params![
            path_text(&shot.path),
            path_text(&shot.thumb_path),
            shot.captured_at,
            shot.mode,
            shot.app,
            shot.window_title,
            shot.width,
            shot.height
        ],
    )?;
    Ok(conn.query_row(
        "SELECT id FROM shots WHERE path = ?1",
        [path_text(&shot.path)],
        |row| row.get(0),
    )?)
}

/// A shot's thumbnail PNG bytes, regenerated if missing.
fn thumbnail_bytes(shot: &Shot) -> LibraryResult<Vec<u8>> {
    ensure_thumbnail(&shot.path, &shot.thumb_path)?;
    Ok(fs::read(&shot.thumb_path)?)
}

fn shot_from_row(row: &Row<'_>) -> rusqlite::Result<Shot> {
    let path = PathBuf::from(row.get::<_, String>(1)?);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Shot {
        id: row.get(0)?,
        file_name,
        path,
        thumb_path: PathBuf::from(row.get::<_, String>(2)?),
        captured_at: row.get(3)?,
        mode: row.get(4)?,
        app: row.get(5)?,
        window_title: row.get(6)?,
        width: row.get(7)?,
        height: row.get(8)?,
        tags: Vec::new(),
        notes: row.get(9)?,
    })
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The full path, resolving symlinks and `..` when the file exists, so the
/// same capture always maps to the same row.
fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|dir| dir.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        }
    })
}

/// Where a capture's thumbnail lives: `thumbs/` in its own save folder,
/// beside `originals/`, with the same file stem.
pub fn thumb_path(png: &Path) -> PathBuf {
    let parent = png.parent().unwrap_or_else(|| Path::new(""));
    let folder = if parent.file_name().is_some_and(|name| name == ORIGINALS_DIR) {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };
    let stem = png
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    folder.join(THUMBS_DIR).join(format!("{stem}.png"))
}

/// Writes a thumbnail fitting in [`THUMB_SIZE`] unless one already exists.
pub fn ensure_thumbnail(png: &Path, thumb: &Path) -> LibraryResult<()> {
    if thumb.is_file() {
        return Ok(());
    }
    let image = image::open(png)?;
    let small = if image.width() > THUMB_SIZE || image.height() > THUMB_SIZE {
        image.thumbnail(THUMB_SIZE, THUMB_SIZE)
    } else {
        image
    };
    if let Some(dir) = thumb.parent() {
        fs::create_dir_all(dir)?;
    }
    // Written beside the target first so a half-written thumbnail is never
    // mistaken for a finished one. The name is unique so a rescan and the
    // Library window can make the same thumbnail at once.
    static NEXT_TMP: AtomicU64 = AtomicU64::new(0);
    let tmp = thumb.with_extension(format!(
        "png.{}-{}.tmp",
        std::process::id(),
        NEXT_TMP.fetch_add(1, Ordering::Relaxed)
    ));
    let written = small
        .save_with_format(&tmp, image::ImageFormat::Png)
        .map_err(LibraryError::from)
        .and_then(|()| fs::rename(&tmp, thumb).map_err(LibraryError::from));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

fn read_meta(png: &Path) -> Option<CaptureMeta> {
    let text = fs::read_to_string(capture::meta_path(png)).ok()?;
    serde_json::from_str(&text).ok()
}

fn modified_millis(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| age.as_millis() as i64)
        .unwrap_or(0)
}

/// The PNGs in `<save_folder>/originals/`, sorted by name.
fn originals_in(save_folder: &Path) -> LibraryResult<Vec<PathBuf>> {
    let dir = save_folder.join(ORIGINALS_DIR);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };
    let mut pngs: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
        })
        .collect();
    pngs.sort();
    Ok(pngs)
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

/// Trims tags, drops empty ones and keeps the first of case-insensitive
/// duplicates. Long tags are cut to 64 characters.
pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag: String = tag
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(MAX_TAG_CHARS)
            .collect();
        if tag.is_empty()
            || out
                .iter()
                .any(|seen| seen.to_lowercase() == tag.to_lowercase())
        {
            continue;
        }
        out.push(tag);
    }
    out
}

/// The app's library, managed as Tauri state.
pub struct LibraryState(Mutex<Library>);

impl LibraryState {
    pub fn new(library: Library) -> Self {
        Self(Mutex::new(library))
    }

    pub fn lock(&self) -> MutexGuard<'_, Library> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// [`Library::rescan`], holding the lock only to read and write rows:
    /// thumbnails are made unlocked, so the Library window and new
    /// captures are not held up by a scan of a large folder.
    pub fn rescan(&self, save_folder: &Path) -> LibraryResult<RescanReport> {
        let known = self.lock().known()?;
        let scan = scan_files(&known, save_folder)?;
        self.lock().apply(&scan)
    }

    /// [`Library::add_capture`], making the thumbnail without the lock.
    pub fn add_capture(&self, png: &Path) -> LibraryResult<Shot> {
        let prepared = prepare_capture(png)?;
        self.lock().insert(&prepared)
    }

    /// A shot's thumbnail PNG, regenerated without the lock if missing.
    pub fn thumbnail(&self, id: i64) -> LibraryResult<Vec<u8>> {
        let shot = self.lock().get(id)?;
        thumbnail_bytes(&shot)
    }
}

/// Opens `library.db` in the app data directory. If that fails the library
/// lives in memory for this run, so captures still work.
pub fn open_for_app(data_dir: &Path) -> LibraryState {
    let path = data_dir.join(LIBRARY_FILE);
    let library = Library::open(&path).or_else(|err| {
        eprintln!(
            "Grab-it: could not open {}, using a temporary library: {err}",
            path.display()
        );
        Library::open_in_memory()
    });
    LibraryState::new(library.expect("an in-memory SQLite database always opens"))
}

/// Rescans `save_folder` off the calling thread and tells the windows when
/// something changed.
pub fn rescan_in_background(app: &AppHandle, save_folder: PathBuf) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(state) = app.try_state::<LibraryState>() else {
            return;
        };
        let report = state.rescan(&save_folder);
        match report {
            Ok(report) if report.changed() => {
                let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
            }
            Ok(_) => {}
            Err(err) => eprintln!(
                "Grab-it: could not scan {} for captures: {err}",
                save_folder.display()
            ),
        }
    });
}

/// Adds a just-saved capture to the library.
pub fn record_capture(app: &AppHandle, png: &Path) {
    let Some(state) = app.try_state::<LibraryState>() else {
        return;
    };
    let result = state.add_capture(png);
    match result {
        Ok(_) => {
            let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
        }
        Err(err) => eprintln!(
            "Grab-it: saved, but could not add {} to the library: {err}",
            png.display()
        ),
    }
}

fn to_message(err: LibraryError) -> String {
    err.to_string()
}

// The library commands run on Tauri's thread pool (`async`), never the main
// thread, so waiting for the lock or making a thumbnail cannot freeze the
// windows or the tray.

#[tauri::command(async)]
pub fn library_list(
    offset: u32,
    limit: u32,
    state: State<'_, LibraryState>,
) -> Result<ShotPage, String> {
    state.lock().list(offset, limit).map_err(to_message)
}

/// A shot's thumbnail PNG bytes.
#[tauri::command(async)]
pub fn library_thumbnail(
    id: i64,
    state: State<'_, LibraryState>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = state.thumbnail(id).map_err(to_message)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command(async)]
pub fn library_set_tags(
    id: i64,
    tags: Vec<String>,
    state: State<'_, LibraryState>,
) -> Result<Shot, String> {
    state.lock().set_tags(id, &tags).map_err(to_message)
}

#[tauri::command(async)]
pub fn library_set_notes(
    id: i64,
    notes: String,
    state: State<'_, LibraryState>,
) -> Result<Shot, String> {
    state.lock().set_notes(id, &notes).map_err(to_message)
}

/// Deletes a shot from disk and the library, closing its editor first.
#[tauri::command(async)]
pub fn library_delete(
    id: i64,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    let path = state.lock().get(id).map_err(to_message)?.path;
    if let Some(window) = app
        .state::<EditorState>()
        .label_for(&path)
        .and_then(|label| app.get_webview_window(&label))
    {
        let _ = window.destroy();
    }
    state.lock().delete(id).map_err(to_message)?;
    let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
    Ok(())
}

/// Opens a shot in the editor. Async so the window is not created on the
/// main thread inside a command, which deadlocks on Windows.
#[tauri::command]
pub async fn library_open(id: i64, app: AppHandle) -> Result<(), String> {
    let path = app
        .state::<LibraryState>()
        .lock()
        .get(id)
        .map_err(to_message)?
        .path;
    if !path.is_file() {
        return Err(format!("{} no longer exists", path.display()));
    }
    windows::show_editor(&app, &path).map_err(|err| err.to_string())
}

/// The current save folder, for the startup rescan.
pub fn current_save_folder(app: &AppHandle) -> PathBuf {
    lock(&app.state::<SettingsState>())
        .get()
        .save_folder
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{CaptureMode, Foreground, save_capture};
    use chrono::{Local, TimeZone};
    use image::{Rgba, RgbaImage};
    use tempfile::TempDir;

    fn time(second: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 3, 7, 9, 5, second).unwrap()
    }

    fn shoot(folder: &Path, second: u32, size: (u32, u32)) -> PathBuf {
        let image = RgbaImage::from_pixel(size.0, size.1, Rgba([10, 20, 30, 255]));
        let foreground = Foreground {
            app: Some("firefox".into()),
            window_title: Some("Docs".into()),
        };
        save_capture(
            folder,
            &image,
            CaptureMode::Region,
            &foreground,
            time(second),
        )
        .unwrap()
        .path
    }

    fn names(library: &Library) -> Vec<String> {
        library
            .list(0, MAX_PAGE)
            .unwrap()
            .shots
            .into_iter()
            .map(|shot| shot.file_name)
            .collect()
    }

    #[test]
    fn migrations_set_the_user_version_and_reopen_cleanly() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("data").join(LIBRARY_FILE);
        let library = Library::open(&db).unwrap();
        assert_eq!(library.schema_version().unwrap(), MIGRATIONS.len() as i64);
        drop(library);
        let again = Library::open(&db).unwrap();
        assert_eq!(again.schema_version().unwrap(), MIGRATIONS.len() as i64);
    }

    #[test]
    fn a_newer_schema_is_refused() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join(LIBRARY_FILE);
        let conn = Connection::open(&db).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        drop(conn);
        assert!(matches!(Library::open(&db), Err(LibraryError::TooNew(99))));
    }

    #[test]
    fn adding_a_capture_stores_its_meta_and_a_thumbnail() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (1000, 500));
        let mut library = Library::open_in_memory().unwrap();

        let shot = library.add_capture(&png).unwrap();

        assert_eq!(shot.path, fs::canonicalize(&png).unwrap());
        assert_eq!(shot.app.as_deref(), Some("firefox"));
        assert_eq!(shot.window_title.as_deref(), Some("Docs"));
        assert_eq!(shot.mode.as_deref(), Some("region"));
        assert_eq!((shot.width, shot.height), (1000, 500));
        assert_eq!(shot.captured_at, time(1).timestamp_millis());
        let thumbs = fs::canonicalize(dir.path()).unwrap().join(THUMBS_DIR);
        assert_eq!(shot.thumb_path.parent().unwrap(), thumbs);
        assert_eq!(
            image::image_dimensions(&shot.thumb_path).unwrap(),
            (THUMB_SIZE, 200)
        );
    }

    #[test]
    fn small_captures_keep_their_size_as_thumbnails() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (30, 20));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        assert_eq!(image::image_dimensions(&shot.thumb_path).unwrap(), (30, 20));
    }

    #[test]
    fn adding_the_same_path_twice_keeps_one_row() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (10, 10));
        let mut library = Library::open_in_memory().unwrap();
        let first = library.add_capture(&png).unwrap();
        // The same file through a different spelling of its path.
        let indirect = png
            .parent()
            .unwrap()
            .join("..")
            .join(ORIGINALS_DIR)
            .join(png.file_name().unwrap());
        let second = library.add_capture(&indirect).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(library.count().unwrap(), 1);
    }

    #[test]
    fn a_capture_without_meta_uses_the_image_size() {
        let dir = TempDir::new().unwrap();
        let originals = dir.path().join(ORIGINALS_DIR);
        fs::create_dir_all(&originals).unwrap();
        let png = originals.join("dropped.png");
        RgbaImage::new(7, 5).save(&png).unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        assert_eq!((shot.width, shot.height), (7, 5));
        assert_eq!(shot.app, None);
        assert!(shot.captured_at > 0);
    }

    #[test]
    fn missing_thumbnails_are_regenerated() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (10, 10));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();

        fs::remove_file(&shot.thumb_path).unwrap();
        assert!(!library.thumbnail(shot.id).unwrap().is_empty());
        assert!(shot.thumb_path.is_file());

        fs::remove_file(&shot.thumb_path).unwrap();
        library.rescan(dir.path()).unwrap();
        assert!(shot.thumb_path.is_file());
    }

    #[test]
    fn pages_are_newest_first() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        for second in [3, 1, 2] {
            library
                .add_capture(&shoot(dir.path(), second, (4, 4)))
                .unwrap();
        }
        let page = library.list(0, 2).unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(
            page.shots
                .iter()
                .map(|shot| shot.captured_at)
                .collect::<Vec<_>>(),
            vec![time(3).timestamp_millis(), time(2).timestamp_millis()]
        );
        let rest = library.list(2, 2).unwrap();
        assert_eq!(rest.offset, 2);
        assert_eq!(rest.shots.len(), 1);
        assert_eq!(rest.shots[0].captured_at, time(1).timestamp_millis());
    }

    #[test]
    fn tags_are_normalised_and_replaced() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let id = library
            .add_capture(&shoot(dir.path(), 1, (4, 4)))
            .unwrap()
            .id;

        let shot = library
            .set_tags(
                id,
                &[
                    " bug ".into(),
                    "Work".into(),
                    "".into(),
                    "BUG".into(),
                    "  multi   word ".into(),
                ],
            )
            .unwrap();
        assert_eq!(shot.tags, vec!["bug", "multi word", "Work"]);

        let shot = library.set_tags(id, &["done".into()]).unwrap();
        assert_eq!(shot.tags, vec!["done"]);
        assert_eq!(library.list(0, 10).unwrap().shots[0].tags, vec!["done"]);
        assert!(matches!(
            library.set_tags(id + 100, &[]),
            Err(LibraryError::NotFound(_))
        ));
    }

    #[test]
    fn notes_are_saved() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let id = library
            .add_capture(&shoot(dir.path(), 1, (4, 4)))
            .unwrap()
            .id;
        assert_eq!(
            library.set_notes(id, "login bug").unwrap().notes,
            "login bug"
        );
        assert_eq!(library.get(id).unwrap().notes, "login bug");
        assert!(matches!(
            library.set_notes(id + 1, "x"),
            Err(LibraryError::NotFound(_))
        ));
    }

    #[test]
    fn delete_removes_the_png_sidecars_thumbnail_and_row() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        fs::write(
            capture::annotations_path(&png),
            r#"{"version":1,"shapes":[]}"#,
        )
        .unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        library.set_tags(shot.id, &["x".into()]).unwrap();

        library.delete(shot.id).unwrap();

        assert!(!png.exists());
        assert!(!capture::meta_path(&png).exists());
        assert!(!capture::annotations_path(&png).exists());
        assert!(!shot.thumb_path.exists());
        assert_eq!(library.count().unwrap(), 0);
        assert!(matches!(
            library.delete(shot.id),
            Err(LibraryError::NotFound(_))
        ));
    }

    #[test]
    fn rescan_adds_new_files_and_drops_rows_whose_file_is_gone() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let kept = shoot(dir.path(), 1, (4, 4));
        let gone = shoot(dir.path(), 2, (4, 4));
        // Not a PNG: ignored.
        fs::write(dir.path().join(ORIGINALS_DIR).join("notes.txt"), "x").unwrap();

        let report = library.rescan(dir.path()).unwrap();
        assert_eq!(
            report,
            RescanReport {
                added: 2,
                removed: 0
            }
        );

        fs::remove_file(&gone).unwrap();
        let fresh = shoot(dir.path(), 3, (4, 4));
        let report = library.rescan(dir.path()).unwrap();
        assert_eq!(
            report,
            RescanReport {
                added: 1,
                removed: 1
            }
        );

        let mut expected = vec![
            fresh.file_name().unwrap().to_string_lossy().into_owned(),
            kept.file_name().unwrap().to_string_lossy().into_owned(),
        ];
        expected.sort_by(|a, b| b.cmp(a));
        assert_eq!(names(&library), expected);

        // Nothing changed: nothing to do.
        assert!(!library.rescan(dir.path()).unwrap().changed());
    }

    #[test]
    fn rescan_of_a_missing_folder_is_empty() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let report = library.rescan(&dir.path().join("nope")).unwrap();
        assert_eq!(report, RescanReport::default());
    }

    #[test]
    fn changing_the_save_folder_keeps_old_captures_and_switching_back_adds_no_duplicates() {
        let dir = TempDir::new().unwrap();
        let first = dir.path().join("First");
        let second = dir.path().join("Second");
        let db = dir.path().join(LIBRARY_FILE);

        let mut library = Library::open(&db).unwrap();
        let old = shoot(&first, 1, (4, 4));
        library.add_capture(&old).unwrap();
        library.rescan(&first).unwrap();
        let old_id = library.list(0, 1).unwrap().shots[0].id;
        library.set_tags(old_id, &["old".into()]).unwrap();
        assert_eq!(library.count().unwrap(), 1);

        // The user picks a new folder; new captures land there.
        library.rescan(&second).unwrap();
        let new = shoot(&second, 2, (4, 4));
        library.add_capture(&new).unwrap();
        assert_eq!(library.count().unwrap(), 2);
        // Captures in the old folder stay put and stay in the library.
        assert!(old.is_file());
        drop(library);

        // Restart with the second folder, then switch back to the first.
        let mut library = Library::open(&db).unwrap();
        assert_eq!(library.rescan(&second).unwrap(), RescanReport::default());
        assert_eq!(library.rescan(&first).unwrap(), RescanReport::default());
        assert_eq!(library.count().unwrap(), 2);
        let shots = library.list(0, 10).unwrap().shots;
        assert_eq!(shots[1].tags, vec!["old"]);
        // Each thumbnail lives in its own folder's thumbs/.
        assert!(
            shots[0]
                .thumb_path
                .starts_with(fs::canonicalize(&second).unwrap())
        );
        assert!(
            shots[1]
                .thumb_path
                .starts_with(fs::canonicalize(&first).unwrap())
        );

        // A capture removed from the old folder is dropped on the next scan,
        // whichever folder is current.
        fs::remove_file(&old).unwrap();
        assert_eq!(
            library.rescan(&second).unwrap(),
            RescanReport {
                added: 0,
                removed: 1
            }
        );
        assert_eq!(
            names(&library),
            vec![new.file_name().unwrap().to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn a_capture_recorded_while_files_are_scanned_is_not_added_twice() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();

        // The scan's file work runs unlocked; meanwhile the capture is
        // recorded through the usual path.
        let known = library.known().unwrap();
        let scan = scan_files(&known, dir.path()).unwrap();
        assert_eq!(scan.new.len(), 1);
        library.add_capture(&png).unwrap();

        assert_eq!(library.apply(&scan).unwrap(), RescanReport::default());
        assert_eq!(library.count().unwrap(), 1);
    }

    #[test]
    fn a_file_restored_while_files_are_scanned_keeps_its_row() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        library.set_tags(shot.id, &["keep".into()]).unwrap();

        let bytes = fs::read(&png).unwrap();
        fs::remove_file(&png).unwrap();
        let scan = scan_files(&library.known().unwrap(), dir.path()).unwrap();
        assert_eq!(scan.gone, vec![shot.id]);
        fs::write(&png, bytes).unwrap();

        assert_eq!(library.apply(&scan).unwrap(), RescanReport::default());
        assert_eq!(library.get(shot.id).unwrap().tags, vec!["keep"]);
    }

    #[test]
    fn scanning_files_needs_no_library_and_makes_thumbnails() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (800, 400));
        // Only the rows, read up front; the scan itself gets no `Library`.
        let scan = scan_files(&[], dir.path()).unwrap();
        assert_eq!(scan.gone, Vec::<i64>::new());
        assert_eq!(scan.new.len(), 1);
        let shot = &scan.new[0];
        assert_eq!(shot.path, fs::canonicalize(&png).unwrap());
        assert_eq!((shot.width, shot.height), (800, 400));
        assert_eq!(
            image::image_dimensions(&shot.thumb_path).unwrap(),
            (THUMB_SIZE, 200)
        );
        // No temporary thumbnails are left behind.
        let leftovers: Vec<_> = fs::read_dir(shot.thumb_path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn the_shared_state_rescans_records_and_serves_thumbnails() {
        let dir = TempDir::new().unwrap();
        let state = LibraryState::new(Library::open_in_memory().unwrap());
        shoot(dir.path(), 1, (4, 4));
        assert_eq!(
            state.rescan(dir.path()).unwrap(),
            RescanReport {
                added: 1,
                removed: 0
            }
        );
        let fresh = state.add_capture(&shoot(dir.path(), 2, (4, 4))).unwrap();
        assert_eq!(state.rescan(dir.path()).unwrap(), RescanReport::default());
        assert_eq!(state.lock().count().unwrap(), 2);

        fs::remove_file(&fresh.thumb_path).unwrap();
        assert!(!state.thumbnail(fresh.id).unwrap().is_empty());
        assert!(fresh.thumb_path.is_file());
    }

    #[test]
    fn thumbnails_go_beside_originals() {
        assert_eq!(
            thumb_path(Path::new("/p/Grab-it/originals/Grab-it 1.png")),
            PathBuf::from("/p/Grab-it/thumbs/Grab-it 1.png")
        );
        assert_eq!(
            thumb_path(Path::new("/elsewhere/shot.png")),
            PathBuf::from("/elsewhere/thumbs/shot.png")
        );
    }
}
