//! The capture library: `library.db` in the app data directory.
//!
//! Each capture is one row in `shots`, keyed by its unique full path, with
//! the fields from its `meta.json` sidecar, a 400 px thumbnail in its own
//! save folder's `thumbs/`, tags and notes. The PNG and its sidecars stay
//! the source of truth: rows are added for new files when a save folder is
//! scanned, and a row is dropped only when its file is gone. Changing the
//! save folder leaves older captures (and their rows) where they are.
//!
//! Recordings (MP4s and GIFs in the save folder's `recordings/`) are rows
//! too, with `kind` saying which. They are never read by OCR or described,
//! and their thumbnail is a frame ffmpeg decodes (a GIF's first, without it).

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
use tauri::{Emitter, Manager, State};

use crate::rt::AppHandle;
use crate::{
    capture::{self, CaptureMeta, ORIGINALS_DIR},
    commands::{SettingsState, lock},
    editor::EditorState,
    ocr::OcrLine,
    record::RECORDINGS_DIR,
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

/// The statement that (re)writes shot `$id`'s row in `shots_fts` from
/// schema 3 on, with every indexed field.
macro_rules! fts_v3_row {
    ($id:literal) => {
        concat!(
            "INSERT INTO shots_fts (rowid, ocr_text, tags, notes, app, window_title, ai_description, ai_tags)
            SELECT s.id, coalesce(s.ocr_text, ''),
                   coalesce((SELECT group_concat(t.tag, ' ') FROM shot_tags t WHERE t.shot_id = s.id), ''),
                   s.notes, coalesce(s.app, ''), coalesce(s.window_title, ''),
                   coalesce(s.ai_description, ''),
                   coalesce((SELECT group_concat(a.tag, ' ') FROM shot_ai_tags a WHERE a.shot_id = s.id), '')
            FROM shots s WHERE s.id = ",
            $id,
            ";"
        )
    };
}

/// Schema migrations; `PRAGMA user_version` is how many have run.
/// Append new ones, never edit old ones.
pub(crate) const MIGRATIONS: &[&str] = &[
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
    // 2: OCR text and the full-text index over it and the metadata.
    // `ocr_state` is 0 while waiting for OCR, 1 when read, 2 when the
    // image could not be read. Triggers keep `shots_fts` (rowid = shot id)
    // in step with `shots` and `shot_tags`.
    "ALTER TABLE shots ADD COLUMN ocr_text TEXT;
    ALTER TABLE shots ADD COLUMN ocr_state INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX shots_ocr_queue ON shots (ocr_state, captured_at DESC, id DESC);
    CREATE VIRTUAL TABLE shots_fts USING fts5 (
        ocr_text, tags, notes, app, window_title,
        tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER shots_fts_insert AFTER INSERT ON shots BEGIN
        INSERT INTO shots_fts (rowid, ocr_text, tags, notes, app, window_title)
        SELECT s.id, coalesce(s.ocr_text, ''),
               coalesce((SELECT group_concat(t.tag, ' ') FROM shot_tags t WHERE t.shot_id = s.id), ''),
               s.notes, coalesce(s.app, ''), coalesce(s.window_title, '')
        FROM shots s WHERE s.id = new.id;
    END;
    CREATE TRIGGER shots_fts_update AFTER UPDATE OF ocr_text, notes, app, window_title ON shots BEGIN
        DELETE FROM shots_fts WHERE rowid = old.id;
        INSERT INTO shots_fts (rowid, ocr_text, tags, notes, app, window_title)
        SELECT s.id, coalesce(s.ocr_text, ''),
               coalesce((SELECT group_concat(t.tag, ' ') FROM shot_tags t WHERE t.shot_id = s.id), ''),
               s.notes, coalesce(s.app, ''), coalesce(s.window_title, '')
        FROM shots s WHERE s.id = new.id;
    END;
    CREATE TRIGGER shots_fts_delete AFTER DELETE ON shots BEGIN
        DELETE FROM shots_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER shot_tags_fts_insert AFTER INSERT ON shot_tags BEGIN
        DELETE FROM shots_fts WHERE rowid = new.shot_id;
        INSERT INTO shots_fts (rowid, ocr_text, tags, notes, app, window_title)
        SELECT s.id, coalesce(s.ocr_text, ''),
               coalesce((SELECT group_concat(t.tag, ' ') FROM shot_tags t WHERE t.shot_id = s.id), ''),
               s.notes, coalesce(s.app, ''), coalesce(s.window_title, '')
        FROM shots s WHERE s.id = new.shot_id;
    END;
    CREATE TRIGGER shot_tags_fts_delete AFTER DELETE ON shot_tags BEGIN
        DELETE FROM shots_fts WHERE rowid = old.shot_id;
        INSERT INTO shots_fts (rowid, ocr_text, tags, notes, app, window_title)
        SELECT s.id, coalesce(s.ocr_text, ''),
               coalesce((SELECT group_concat(t.tag, ' ') FROM shot_tags t WHERE t.shot_id = s.id), ''),
               s.notes, coalesce(s.app, ''), coalesce(s.window_title, '')
        FROM shots s WHERE s.id = old.shot_id;
    END;
    INSERT INTO shots_fts (rowid, ocr_text, tags, notes, app, window_title)
    SELECT s.id, coalesce(s.ocr_text, ''),
           coalesce((SELECT group_concat(t.tag, ' ') FROM shot_tags t WHERE t.shot_id = s.id), ''),
           s.notes, coalesce(s.app, ''), coalesce(s.window_title, '')
    FROM shots s;",
    // 3: AI descriptions. `ai_state` is 0 while waiting to be described,
    // 1 when described, 2 when describing failed and 3 when skipped (made
    // before describing was turned on, or cleared by the user). AI tags
    // live apart from the user's tags. `shots_fts` is rebuilt with the
    // description and AI tags as two more columns.
    concat!(
        "ALTER TABLE shots ADD COLUMN ai_description TEXT;
        ALTER TABLE shots ADD COLUMN ai_category TEXT;
        ALTER TABLE shots ADD COLUMN ai_model TEXT;
        ALTER TABLE shots ADD COLUMN ai_state INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX shots_ai_queue ON shots (ai_state, captured_at DESC, id DESC);
        CREATE INDEX shots_ai_category ON shots (ai_category);
        CREATE TABLE shot_ai_tags (
            shot_id INTEGER NOT NULL REFERENCES shots (id) ON DELETE CASCADE,
            tag TEXT NOT NULL COLLATE NOCASE,
            PRIMARY KEY (shot_id, tag)
        );
        CREATE INDEX shot_ai_tags_tag ON shot_ai_tags (tag);
        DROP TRIGGER shots_fts_insert;
        DROP TRIGGER shots_fts_update;
        DROP TRIGGER shots_fts_delete;
        DROP TRIGGER shot_tags_fts_insert;
        DROP TRIGGER shot_tags_fts_delete;
        DROP TABLE shots_fts;
        CREATE VIRTUAL TABLE shots_fts USING fts5 (
            ocr_text, tags, notes, app, window_title, ai_description, ai_tags,
            tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER shots_fts_insert AFTER INSERT ON shots BEGIN ",
        fts_v3_row!("new.id"),
        " END;
        CREATE TRIGGER shots_fts_update
        AFTER UPDATE OF ocr_text, notes, app, window_title, ai_description ON shots BEGIN
            DELETE FROM shots_fts WHERE rowid = old.id; ",
        fts_v3_row!("new.id"),
        " END;
        CREATE TRIGGER shots_fts_delete AFTER DELETE ON shots BEGIN
            DELETE FROM shots_fts WHERE rowid = old.id;
        END;
        CREATE TRIGGER shot_tags_fts_insert AFTER INSERT ON shot_tags BEGIN
            DELETE FROM shots_fts WHERE rowid = new.shot_id; ",
        fts_v3_row!("new.shot_id"),
        " END;
        CREATE TRIGGER shot_tags_fts_delete AFTER DELETE ON shot_tags BEGIN
            DELETE FROM shots_fts WHERE rowid = old.shot_id; ",
        fts_v3_row!("old.shot_id"),
        " END;
        CREATE TRIGGER shot_ai_tags_fts_insert AFTER INSERT ON shot_ai_tags BEGIN
            DELETE FROM shots_fts WHERE rowid = new.shot_id; ",
        fts_v3_row!("new.shot_id"),
        " END;
        CREATE TRIGGER shot_ai_tags_fts_delete AFTER DELETE ON shot_ai_tags BEGIN
            DELETE FROM shots_fts WHERE rowid = old.shot_id; ",
        fts_v3_row!("old.shot_id"),
        " END;
        INSERT INTO shots_fts (rowid, ocr_text, tags, notes, app, window_title, ai_description, ai_tags)
        SELECT s.id, coalesce(s.ocr_text, ''),
               coalesce((SELECT group_concat(t.tag, ' ') FROM shot_tags t WHERE t.shot_id = s.id), ''),
               s.notes, coalesce(s.app, ''), coalesce(s.window_title, ''), '', ''
        FROM shots s;"
    ),
    // 4: recordings. `kind` is 'image' for a capture, 'video' for an MP4
    // and 'gif' for a GIF recording; recordings know how long they run and
    // their file size.
    "ALTER TABLE shots ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';
    ALTER TABLE shots ADD COLUMN duration_ms INTEGER;
    ALTER TABLE shots ADD COLUMN bytes INTEGER;
    CREATE INDEX shots_kind ON shots (kind, captured_at DESC, id DESC);",
    // 5: the Keep forever star. A starred item is never removed by cleanup.
    "ALTER TABLE shots ADD COLUMN keep INTEGER NOT NULL DEFAULT 0;",
    // 6: where OCR found each line and word, as JSON (`ocr::OcrLine`s, in
    // image pixels). NULL for recordings and for captures read before it.
    "ALTER TABLE shots ADD COLUMN ocr_words TEXT;",
];

/// `ai_state` values, for tests; the queries spell them out.
#[cfg(test)]
pub const AI_WAITING: i64 = 0;
#[cfg(test)]
pub const AI_DONE: i64 = 1;
#[cfg(test)]
pub const AI_FAILED: i64 = 2;
#[cfg(test)]
pub const AI_SKIPPED: i64 = 3;

#[derive(Debug)]
pub enum LibraryError {
    Sql(rusqlite::Error),
    Io(io::Error),
    Image(image::ImageError),
    /// No shot has this id.
    NotFound(i64),
    /// A recording's preview needs ffmpeg, which is not ready.
    NoPreview,
    /// An edited capture has no thumbnail yet; the Library draws one with
    /// its edits.
    NoThumbnail,
    /// A thumbnail was drawn from edits that have since been saved again.
    OutOfDate,
    /// The database was written by a newer Grab-it.
    TooNew(i64),
    /// A file cannot be given this name; says why.
    BadName(String),
    /// Another file already has this name.
    NameTaken(String),
}

impl fmt::Display for LibraryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sql(err) => write!(f, "library database error: {err}"),
            Self::Io(err) => write!(f, "{err}"),
            Self::Image(err) => write!(f, "could not read the capture: {err}"),
            Self::NotFound(id) => write!(f, "no capture with id {id} in the library"),
            Self::NoPreview => write!(
                f,
                "the recording's preview needs ffmpeg, which is not ready"
            ),
            Self::NoThumbnail => write!(f, "the edited capture has no thumbnail yet"),
            Self::OutOfDate => write!(f, "the capture was edited again while it was drawn"),
            Self::TooNew(version) => write!(
                f,
                "the library was created by a newer Grab-it (schema {version})"
            ),
            Self::BadName(why) => write!(f, "{why}"),
            Self::NameTaken(name) => write!(f, "There is already a file called {name}."),
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

/// What a library item is. Mirrors `ShotKind` in src/library/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ShotKind {
    /// A capture: a PNG in `originals/`.
    #[default]
    Image,
    /// An MP4 recording.
    Video,
    /// A GIF recording.
    Gif,
}

impl ShotKind {
    /// How `kind` stores it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
            Self::Gif => "gif",
        }
    }

    pub(crate) fn from_column(value: &str) -> Self {
        match value {
            "video" => Self::Video,
            "gif" => Self::Gif,
            _ => Self::Image,
        }
    }

    /// The kind of recording at `path`, by its extension; `None` when it
    /// is not one.
    pub fn of_recording(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
        match ext.as_str() {
            "mp4" => Some(Self::Video),
            "gif" => Some(Self::Gif),
            _ => None,
        }
    }

    pub fn is_recording(self) -> bool {
        self != Self::Image
    }
}

/// One capture or recording. Mirrors `Shot` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub id: i64,
    pub kind: ShotKind,
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
    /// One or two sentences from the vision model, once described.
    pub ai_description: Option<String>,
    /// One of `ai::CATEGORIES`, once described.
    pub ai_category: Option<String>,
    /// Tags the vision model gave; the user's own are in `tags`.
    pub ai_tags: Vec<String>,
    /// How long a recording runs, once known.
    pub duration_ms: Option<u64>,
    /// A recording's file size, once known.
    pub bytes: Option<u64>,
    /// Starred Keep forever: cleanup never removes it.
    pub keep: bool,
    /// When its annotations sidecar was last saved, in milliseconds since
    /// the Unix epoch; `None` for a capture never edited.
    pub edited_at: Option<i64>,
    /// It has edits, and its thumbnail is missing or older than them, so
    /// the Library draws a new one with the edits (see
    /// [`library_save_thumbnail`]).
    pub thumb_stale: bool,
}

/// The columns [`shot_from_row`] reads, in order, from `shots` as `s`.
pub(crate) const SHOT_COLUMNS: &str = "s.id, s.path, s.thumb_path, s.captured_at, s.mode, s.app, \
     s.window_title, s.width, s.height, s.notes, s.ai_description, s.ai_category, s.kind, \
     s.duration_ms, s.bytes, s.keep";
/// How many columns [`SHOT_COLUMNS`] holds.
pub(crate) const SHOT_COLUMN_COUNT: usize = 16;

/// The text in a shot, as far as OCR has got. Mirrors `ShotText` in
/// src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ShotText {
    /// OCR has not read it yet.
    Waiting,
    /// OCR read it; `text` is empty when it found none.
    Read { text: String },
    /// OCR could not read the image.
    Failed,
}

/// One page of shots, newest first. Mirrors `ShotPage` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
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
    /// Rows whose length or file size were filled in.
    pub refreshed: usize,
}

impl RescanReport {
    pub fn changed(self) -> bool {
        self.added > 0 || self.removed > 0 || self.refreshed > 0
    }
}

/// A shot waiting to be described, with what helps describe it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiJob {
    pub id: i64,
    pub path: PathBuf,
    /// `None` when OCR could not read the image.
    pub ocr_text: Option<String>,
    pub app: Option<String>,
    pub window_title: Option<String>,
}

/// What the vision model said about a shot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AiDescription {
    pub description: String,
    pub category: String,
    pub tags: Vec<String>,
}

/// Progress of the describing queue: `done` counts described and failed
/// shots, `total` every shot that is not skipped.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AiCounts {
    pub done: u32,
    pub total: u32,
}

/// A shot waiting for OCR.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcrJob {
    pub id: i64,
    pub path: PathBuf,
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

    /// The database connection, for queries that live in other modules
    /// (see `search.rs`).
    pub(crate) fn connection(&self) -> &Connection {
        &self.conn
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
        let scan = scan_files(&known, save_folder, None)?;
        self.apply(&scan)
    }

    /// Every row's id, path, thumbnail path and kind, and whether a
    /// recording's length and a row's file size are known.
    pub fn known(&self) -> LibraryResult<Vec<KnownShot>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, thumb_path, kind, duration_ms IS NOT NULL, bytes IS NOT NULL
             FROM shots",
        )?;
        let known = stmt
            .query_map([], |row| {
                Ok(KnownShot {
                    id: row.get(0)?,
                    path: PathBuf::from(row.get::<_, String>(1)?),
                    thumb_path: PathBuf::from(row.get::<_, String>(2)?),
                    kind: ShotKind::from_column(&row.get::<_, String>(3)?),
                    has_duration: row.get(4)?,
                    has_bytes: row.get(5)?,
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
        for shot in &scan.refreshed {
            let known: Option<i64> = tx
                .query_row(
                    "SELECT id FROM shots WHERE path = ?1",
                    [path_text(&shot.path)],
                    |row| row.get(0),
                )
                .optional()?;
            if known.is_some() && shot.path.is_file() {
                insert_prepared(&tx, shot)?;
                report.refreshed += 1;
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
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {SHOT_COLUMNS} FROM shots s
             ORDER BY s.captured_at DESC, s.id DESC LIMIT ?1 OFFSET ?2"
        ))?;
        let mut shots = stmt
            .query_map(params![limit, offset], shot_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for shot in &mut shots {
            self.fill_tags(shot)?;
        }
        Ok(ShotPage {
            shots,
            offset,
            total: self.count()?,
        })
    }

    /// The id of the shot stored for `png`, however the path is spelled.
    pub fn id_for_path(&self, png: &Path) -> LibraryResult<Option<i64>> {
        let lookup = |path: &Path| {
            self.conn
                .query_row(
                    "SELECT id FROM shots WHERE path = ?1",
                    [path_text(path)],
                    |row| row.get(0),
                )
                .optional()
        };
        if let Some(id) = lookup(png)? {
            return Ok(Some(id));
        }
        match fs::canonicalize(png) {
            Ok(canonical) if canonical != png => Ok(lookup(&canonical)?),
            _ => Ok(None),
        }
    }

    pub fn get(&self, id: i64) -> LibraryResult<Shot> {
        let mut shot = self
            .conn
            .query_row(
                &format!("SELECT {SHOT_COLUMNS} FROM shots s WHERE s.id = ?1"),
                [id],
                shot_from_row,
            )
            .optional()?
            .ok_or(LibraryError::NotFound(id))?;
        self.fill_tags(&mut shot)?;
        Ok(shot)
    }

    /// Reads a shot's user and AI tags into it.
    pub(crate) fn fill_tags(&self, shot: &mut Shot) -> LibraryResult<()> {
        shot.tags = self.tags_in("shot_tags", shot.id)?;
        shot.ai_tags = self.tags_in("shot_ai_tags", shot.id)?;
        Ok(())
    }

    fn tags_in(&self, table: &str, id: i64) -> LibraryResult<Vec<String>> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT tag FROM {table} WHERE shot_id = ?1 ORDER BY tag COLLATE NOCASE"
        ))?;
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

    /// Stars or unstars a shot Keep forever.
    pub fn set_keep(&mut self, id: i64, keep: bool) -> LibraryResult<Shot> {
        let changed = self.conn.execute(
            "UPDATE shots SET keep = ?1 WHERE id = ?2",
            params![keep, id],
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
        for extra in extra_files(&shot) {
            if let Err(err) = remove_if_present(&extra) {
                eprintln!("Grab-it: could not delete {}: {err}", extra.display());
            }
        }
        remove_assets(&shot.path);
        self.forget(id)?;
        Ok(shot)
    }

    /// Drops a shot's row, leaving its files alone.
    pub(crate) fn forget(&mut self, id: i64) -> LibraryResult<()> {
        self.conn.execute("DELETE FROM shots WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Renames a shot's file to `name` (its extension is kept, and added
    /// when `name` leaves it out), moving its sidecars and thumbnail with
    /// it, and points its row at the new file. A name another file, or
    /// another row, already has is refused, as are names a file cannot have
    /// on any of the systems Grab-it runs on. If the file cannot be renamed
    /// nothing else is touched.
    pub fn rename(&mut self, id: i64, name: &str) -> LibraryResult<Shot> {
        let shot = self.get(id)?;
        let Some(target) = self.rename_target(&shot, name)? else {
            return Ok(shot);
        };
        // Images added in the editor move with the capture, so its sidecar still finds them.
        let (assets_from, assets_to) = (
            capture::assets_dir(&shot.path),
            capture::assets_dir(&target.path),
        );
        let has_assets = assets_from.try_exists()?;
        fs::rename(&shot.path, &target.path)?;
        if has_assets && let Err(err) = fs::rename(&assets_from, &assets_to) {
            fs::rename(&target.path, &shot.path)?;
            return Err(err.into());
        }
        for (from, to) in extra_files(&shot).into_iter().zip(extra_files(&target)) {
            if from.exists()
                && let Err(err) = fs::rename(&from, &to)
            {
                eprintln!(
                    "Grab-it: could not rename {} to {}: {err}",
                    from.display(),
                    to.display()
                );
            }
        }
        let updated = self.conn.execute(
            "UPDATE shots SET path = ?1, thumb_path = ?2 WHERE id = ?3",
            params![path_text(&target.path), path_text(&target.thumb_path), id],
        );
        if let Err(err) = updated {
            // Put the file back so the row still finds it.
            if let Err(back) = fs::rename(&target.path, &shot.path) {
                eprintln!(
                    "Grab-it: could not rename {} back: {back}",
                    target.path.display()
                );
            }
            for (from, to) in extra_files(&shot).into_iter().zip(extra_files(&target)) {
                if to.exists() {
                    let _ = fs::rename(&to, &from);
                }
            }
            if has_assets {
                let _ = fs::rename(&assets_to, &assets_from);
            }
            return Err(err.into());
        }
        self.get(id)
    }

    /// `shot` as a rename to `name` leaves it, or `None` when the name is
    /// the one it has. Refuses names a file cannot have, names whose file
    /// or any sidecar's would be longer than [`MAX_NAME_BYTES`], and names
    /// another file or row has (see [`Library::is_free`]). Touches nothing,
    /// so a rename can be checked before its editor is closed.
    pub fn rename_target(&self, shot: &Shot, name: &str) -> LibraryResult<Option<Shot>> {
        let file_name = renamed_file_name(&shot.path, name)?;
        if file_name == shot.file_name {
            return Ok(None);
        }
        let target = moved_to(shot, shot.path.with_file_name(&file_name));
        let too_long = std::iter::once(target.path.clone())
            .chain(extra_files(&target))
            .any(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().len() > MAX_NAME_BYTES)
            });
        if too_long {
            return Err(LibraryError::BadName("That name is too long.".into()));
        }
        if !self.is_free(&target, Some(shot))? {
            return Err(LibraryError::NameTaken(file_name));
        }
        Ok(Some(target))
    }

    /// Where a copy of `shot` goes: beside it, as "<name> copy", then
    /// "<name> copy 2" and so on, the first name no file or row has.
    pub fn copy_target(&self, shot: &Shot) -> LibraryResult<Shot> {
        let stem = shot
            .path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        let extension = shot
            .path
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()))
            .unwrap_or_default();
        for n in 1..=MAX_COPIES {
            let name = if n == 1 {
                format!("{stem} copy{extension}")
            } else {
                format!("{stem} copy {n}{extension}")
            };
            let target = moved_to(shot, shot.path.with_file_name(name));
            if self.is_free(&target, None)? {
                return Ok(target);
            }
        }
        Err(LibraryError::NameTaken(format!(
            "{stem} copy {MAX_COPIES}{extension}"
        )))
    }

    /// Whether `target`'s file and sidecars are free to be written: no file
    /// is there, besides `current`'s own (a rename that only changes the
    /// case of a name, on a disk that ignores case), and no other row has
    /// its path. A thumbnail left there is Grab-it's own and is replaced.
    fn is_free(&self, target: &Shot, current: Option<&Shot>) -> LibraryResult<bool> {
        let taken = |to: &Path, from: Option<&Path>| {
            to.exists() && !from.is_some_and(|from| same_file(from, to))
        };
        if taken(
            target.path.as_path(),
            current.map(|shot| shot.path.as_path()),
        ) {
            return Ok(false);
        }
        // A folder of added images under the new name would be taken over.
        if taken(
            &capture::assets_dir(&target.path),
            current
                .map(|shot| capture::assets_dir(&shot.path))
                .as_deref(),
        ) {
            return Ok(false);
        }
        let currents = current.map(extra_files);
        for (index, to) in extra_files(target).iter().enumerate() {
            if *to == target.thumb_path {
                continue;
            }
            let from = currents.as_ref().and_then(|files| files.get(index));
            if taken(to.as_path(), from.map(PathBuf::as_path)) {
                return Ok(false);
            }
        }
        let row: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM shots WHERE path = ?1",
                [path_text(&target.path)],
                |row| row.get(0),
            )
            .optional()?;
        Ok(row.is_none_or(|row| current.is_some_and(|shot| shot.id == row)))
    }

    /// The newest shot still waiting for OCR, if any.
    pub fn next_for_ocr(&self) -> LibraryResult<Option<OcrJob>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, path FROM shots WHERE ocr_state = 0 AND kind = 'image'
                 ORDER BY captured_at DESC, id DESC LIMIT 1",
                [],
                |row| {
                    Ok(OcrJob {
                        id: row.get(0)?,
                        path: PathBuf::from(row.get::<_, String>(1)?),
                    })
                },
            )
            .optional()?)
    }

    /// How many shots are waiting for OCR.
    pub fn pending_ocr_count(&self) -> LibraryResult<u32> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM shots WHERE ocr_state = 0 AND kind = 'image'",
            [],
            |row| row.get(0),
        )?)
    }

    /// Stores the text OCR found in a shot; it becomes searchable at once.
    pub fn set_ocr_text(&mut self, id: i64, text: &str) -> LibraryResult<()> {
        let changed = self.conn.execute(
            "UPDATE shots SET ocr_text = ?1, ocr_state = 1 WHERE id = ?2",
            params![text, id],
        )?;
        if changed == 0 {
            return Err(LibraryError::NotFound(id));
        }
        Ok(())
    }

    /// Stores the lines OCR read in a shot: their text, searchable at once,
    /// and their word boxes.
    pub fn set_ocr_lines(&mut self, id: i64, lines: &[OcrLine]) -> LibraryResult<()> {
        let words =
            serde_json::to_string(lines).map_err(|err| LibraryError::Io(io::Error::other(err)))?;
        let changed = self.conn.execute(
            "UPDATE shots SET ocr_text = ?1, ocr_words = ?2, ocr_state = 1 WHERE id = ?3",
            params![crate::ocr::lines_text(lines), words, id],
        )?;
        if changed == 0 {
            return Err(LibraryError::NotFound(id));
        }
        Ok(())
    }

    /// The lines OCR read in a shot, with their word boxes; `None` for a
    /// recording, a capture waiting for or failing OCR, or one read before
    /// the boxes were stored.
    pub fn lines(&self, id: i64) -> LibraryResult<Option<Vec<OcrLine>>> {
        let words = self
            .conn
            .query_row(
                "SELECT CASE WHEN ocr_state = 1 AND kind = 'image' THEN ocr_words END
                 FROM shots WHERE id = ?1",
                [id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .ok_or(LibraryError::NotFound(id))?;
        let Some(words) = words else {
            return Ok(None);
        };
        match serde_json::from_str(&words) {
            Ok(lines) => Ok(Some(lines)),
            Err(err) => {
                eprintln!("Grab-it: the word boxes of shot {id} are unreadable: {err}");
                Ok(None)
            }
        }
    }

    /// The text OCR found in a shot, or why there is none yet.
    pub fn text(&self, id: i64) -> LibraryResult<ShotText> {
        let (state, text) = self
            .conn
            .query_row(
                "SELECT ocr_state, ocr_text FROM shots WHERE id = ?1",
                [id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .ok_or(LibraryError::NotFound(id))?;
        Ok(match state {
            0 => ShotText::Waiting,
            1 => ShotText::Read {
                text: text.unwrap_or_default(),
            },
            _ => ShotText::Failed,
        })
    }

    /// Marks a shot whose image OCR could not read, so it is not retried.
    pub fn mark_ocr_failed(&mut self, id: i64) -> LibraryResult<()> {
        self.conn
            .execute("UPDATE shots SET ocr_state = 2 WHERE id = ?1", [id])?;
        Ok(())
    }

    /// The newest shot waiting to be described whose OCR is finished
    /// (read, or failed: then it is described without text).
    pub fn next_for_ai(&self) -> LibraryResult<Option<AiJob>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, path, CASE WHEN ocr_state = 1 THEN ocr_text END, app, window_title
                 FROM shots WHERE ai_state = 0 AND ocr_state <> 0 AND kind = 'image'
                 ORDER BY captured_at DESC, id DESC LIMIT 1",
                [],
                |row| {
                    Ok(AiJob {
                        id: row.get(0)?,
                        path: PathBuf::from(row.get::<_, String>(1)?),
                        ocr_text: row.get(2)?,
                        app: row.get(3)?,
                        window_title: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    /// How many captures a whole-library request would describe: every
    /// image, or with `waiting` only those not yet described or skipped.
    pub fn ai_capture_count(&self, waiting: bool) -> LibraryResult<u32> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM shots WHERE kind = 'image' AND (?1 = 0 OR ai_state = 0)",
            [waiting],
            |row| row.get(0),
        )?)
    }

    /// How far the describing queue has got.
    pub fn ai_counts(&self) -> LibraryResult<AiCounts> {
        Ok(self.conn.query_row(
            "SELECT coalesce(sum(ai_state IN (1, 2)), 0), coalesce(sum(ai_state <> 3), 0)
             FROM shots WHERE kind = 'image'",
            [],
            |row| {
                Ok(AiCounts {
                    done: row.get(0)?,
                    total: row.get(1)?,
                })
            },
        )?)
    }

    /// A shot's `ai_state`.
    #[cfg(test)]
    pub fn ai_state(&self, id: i64) -> LibraryResult<i64> {
        self.conn
            .query_row("SELECT ai_state FROM shots WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or(LibraryError::NotFound(id))
    }

    /// The model that wrote a shot's description, if any.
    #[cfg(test)]
    pub fn ai_model(&self, id: i64) -> LibraryResult<Option<String>> {
        self.conn
            .query_row("SELECT ai_model FROM shots WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or(LibraryError::NotFound(id))
    }

    /// Stores what `model` said about a shot; it becomes searchable at once.
    pub fn set_ai_description(
        &mut self,
        id: i64,
        description: &AiDescription,
        model: &str,
    ) -> LibraryResult<()> {
        let tags = normalize_tags(&description.tags);
        let tx = self.conn.transaction()?;
        let changed = tx.execute(
            "UPDATE shots SET ai_description = ?1, ai_category = ?2, ai_model = ?3, ai_state = 1
             WHERE id = ?4",
            params![description.description, description.category, model, id],
        )?;
        if changed == 0 {
            return Err(LibraryError::NotFound(id));
        }
        tx.execute("DELETE FROM shot_ai_tags WHERE shot_id = ?1", [id])?;
        for tag in &tags {
            tx.execute(
                "INSERT INTO shot_ai_tags (shot_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Takes one tag the AI added off a shot, leaving the rest of its
    /// description alone.
    pub fn remove_ai_tag(&mut self, id: i64, tag: &str) -> LibraryResult<Shot> {
        self.conn.execute(
            "DELETE FROM shot_ai_tags WHERE shot_id = ?1 AND tag = ?2 COLLATE NOCASE",
            params![id, tag],
        )?;
        self.get(id)
    }

    /// Marks a shot that could not be described, so it is not retried
    /// until the user asks. An earlier description is kept.
    pub fn mark_ai_failed(&mut self, id: i64) -> LibraryResult<()> {
        let changed = self
            .conn
            .execute("UPDATE shots SET ai_state = 2 WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(LibraryError::NotFound(id));
        }
        Ok(())
    }

    /// Queues one shot to be described again. Its current description
    /// stays until the new one replaces it.
    pub fn requeue_ai(&mut self, id: i64) -> LibraryResult<()> {
        let changed = self.conn.execute(
            "UPDATE shots SET ai_state = 0 WHERE id = ?1 AND kind = 'image'",
            [id],
        )?;
        if changed == 0 {
            return Err(LibraryError::NotFound(id));
        }
        Ok(())
    }

    /// Queues every shot, skipped ones included, to be described again.
    pub fn requeue_all_ai(&mut self) -> LibraryResult<usize> {
        Ok(self.conn.execute(
            "UPDATE shots SET ai_state = 0 WHERE ai_state <> 0 AND kind = 'image'",
            [],
        )?)
    }

    /// Drops a shot's description, category and AI tags and skips it.
    pub fn clear_ai(&mut self, id: i64) -> LibraryResult<()> {
        let tx = self.conn.transaction()?;
        let changed = tx.execute(
            "UPDATE shots SET ai_description = NULL, ai_category = NULL, ai_model = NULL,
                    ai_state = 3
             WHERE id = ?1",
            [id],
        )?;
        if changed == 0 {
            return Err(LibraryError::NotFound(id));
        }
        tx.execute("DELETE FROM shot_ai_tags WHERE shot_id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Skips every shot still waiting to be described: describing was just
    /// turned on for new captures only.
    pub fn skip_waiting_ai(&mut self) -> LibraryResult<usize> {
        Ok(self
            .conn
            .execute("UPDATE shots SET ai_state = 3 WHERE ai_state = 0", [])?)
    }

    /// The text OCR found in a shot, or `None` while it waits for OCR.
    #[cfg(test)]
    pub fn ocr_text(&self, id: i64) -> LibraryResult<Option<String>> {
        self.conn
            .query_row("SELECT ocr_text FROM shots WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or(LibraryError::NotFound(id))
    }

    /// The shot's thumbnail PNG, regenerated if it is missing.
    #[cfg(test)]
    pub fn thumbnail(&self, id: i64) -> LibraryResult<Vec<u8>> {
        thumbnail_bytes(&self.get(id)?, None)
    }
}

/// A row as [`Library::known`] reads it for a rescan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownShot {
    pub id: i64,
    pub path: PathBuf,
    pub thumb_path: PathBuf,
    pub kind: ShotKind,
    /// A recording's length is known (always true of a capture's row
    /// that needs none).
    pub has_duration: bool,
    /// The file's size is known. Captures stored before sizes were
    /// recorded have none until a rescan fills it in.
    pub has_bytes: bool,
}

/// A capture's or recording's row, read from disk (with a capture's
/// thumbnail made) without touching the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedShot {
    pub kind: ShotKind,
    pub path: PathBuf,
    pub thumb_path: PathBuf,
    pub captured_at: i64,
    pub mode: Option<String>,
    pub app: Option<String>,
    pub window_title: Option<String>,
    pub width: u32,
    pub height: u32,
    /// How long a recording runs, when known.
    pub duration_ms: Option<u64>,
    /// The main file's size: the PNG's or the recording's.
    pub bytes: Option<u64>,
}

/// The file work of a rescan, for [`Library::apply`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanResult {
    /// Rows whose file was missing.
    pub gone: Vec<i64>,
    /// New captures and recordings in the save folder.
    pub new: Vec<PreparedShot>,
    /// Known rows read again: recordings now that ffmpeg can say how long
    /// they run, and rows stored without their file size.
    pub refreshed: Vec<PreparedShot>,
}

/// Reads a capture's meta sidecar and size, and makes its thumbnail if
/// missing. Touches only files, so it runs without the library lock.
pub fn prepare_capture(png: &Path) -> LibraryResult<PreparedShot> {
    let path = canonical(png);
    let thumb_path = thumb_path(&path);
    if !is_edited(&path) {
        ensure_thumbnail(&path, &thumb_path)?;
    }
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
    let bytes = fs::metadata(&path).map(|meta| meta.len()).ok();
    Ok(PreparedShot {
        kind: ShotKind::Image,
        path,
        thumb_path,
        captured_at,
        mode,
        app,
        window_title,
        width,
        height,
        duration_ms: None,
        bytes,
    })
}

/// Reads a recording's length, size and file size: `duration_ms` when the
/// recorder knows it, else what ffmpeg says, when it is ready. Its preview
/// is made when it is first shown. Touches only files.
pub fn prepare_recording(
    video: &Path,
    duration_ms: Option<u64>,
    ffmpeg: Option<&Path>,
) -> LibraryResult<PreparedShot> {
    let path = canonical(video);
    let kind = ShotKind::of_recording(&path).ok_or_else(|| {
        LibraryError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a recording", path.display()),
        ))
    })?;
    let meta = fs::metadata(&path)?;
    let probe = ffmpeg
        .map(|ffmpeg| crate::ffmpeg::probe_file(ffmpeg, &path))
        .unwrap_or_default();
    let size = probe.size.or_else(|| {
        (kind == ShotKind::Gif)
            .then(|| image::image_dimensions(&path).ok())
            .flatten()
    });
    let (width, height) = size.unwrap_or((0, 0));
    Ok(PreparedShot {
        kind,
        thumb_path: thumb_path(&path),
        captured_at: modified_millis(&path),
        mode: None,
        app: None,
        window_title: None,
        width,
        height,
        duration_ms: duration_ms.or(probe.duration_ms),
        bytes: Some(meta.len()),
        path,
    })
}

/// The file side of a rescan: finds rows whose file is gone, regenerates
/// missing thumbnails and prepares new PNGs in `<save_folder>/originals/`.
/// Touches only files, so it runs without the library lock.
pub fn scan_files(
    known: &[KnownShot],
    save_folder: &Path,
    ffmpeg: Option<&Path>,
) -> LibraryResult<ScanResult> {
    let mut scan = ScanResult::default();
    for shot in known {
        if shot.path.is_file() && shot.kind.is_recording() {
            // Previews are made when first shown; a length ffmpeg could
            // not tell before is asked again, and a missing size is read.
            let wants_duration = !shot.has_duration && ffmpeg.is_some();
            if wants_duration || !shot.has_bytes {
                match prepare_recording(&shot.path, None, ffmpeg) {
                    Ok(prepared) if prepared.duration_ms.is_some() || !shot.has_bytes => {
                        scan.refreshed.push(prepared);
                    }
                    Ok(_) => {}
                    Err(err) => eprintln!("Grab-it: skipped {}: {err}", shot.path.display()),
                }
            }
        } else if shot.path.is_file() && !shot.has_bytes {
            // Stored before sizes were recorded: read it again, which also
            // makes a missing thumbnail.
            match prepare_capture(&shot.path) {
                Ok(prepared) => scan.refreshed.push(prepared),
                Err(err) => eprintln!("Grab-it: skipped {}: {err}", shot.path.display()),
            }
        } else if shot.path.is_file() {
            // An edited capture's thumbnail is drawn by the Library with
            // its edits, never from the original.
            if !is_edited(&shot.path)
                && let Err(err) = ensure_thumbnail(&shot.path, &shot.thumb_path)
            {
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
    for video in recordings_in(save_folder)? {
        let path = canonical(&video);
        if paths.contains(path.as_path()) {
            continue;
        }
        match prepare_recording(&path, None, ffmpeg) {
            Ok(shot) => scan.new.push(shot),
            Err(err) => eprintln!("Grab-it: skipped {}: {err}", path.display()),
        }
    }
    Ok(scan)
}

/// Upserts a prepared capture and returns its id.
fn insert_prepared(conn: &Connection, shot: &PreparedShot) -> LibraryResult<i64> {
    // A recording has no text to read and is not described: it starts out
    // read (with no text) and skipped.
    let recording = shot.kind.is_recording();
    conn.execute(
        "INSERT INTO shots (path, thumb_path, captured_at, mode, app, window_title, width, height,
                            kind, duration_ms, bytes, ocr_text, ocr_state, ai_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                 CASE WHEN ?12 THEN '' END, CASE WHEN ?12 THEN 1 ELSE 0 END,
                 CASE WHEN ?12 THEN 3 ELSE 0 END)
         ON CONFLICT (path) DO UPDATE SET
            thumb_path = excluded.thumb_path,
            captured_at = excluded.captured_at,
            mode = excluded.mode,
            app = excluded.app,
            window_title = excluded.window_title,
            width = CASE WHEN excluded.width > 0 THEN excluded.width ELSE width END,
            height = CASE WHEN excluded.width > 0 THEN excluded.height ELSE height END,
            kind = excluded.kind,
            duration_ms = coalesce(excluded.duration_ms, duration_ms),
            bytes = coalesce(excluded.bytes, bytes)",
        params![
            path_text(&shot.path),
            path_text(&shot.thumb_path),
            shot.captured_at,
            shot.mode,
            shot.app,
            shot.window_title,
            shot.width,
            shot.height,
            shot.kind.as_str(),
            shot.duration_ms.map(|ms| ms as i64),
            shot.bytes.map(|bytes| bytes as i64),
            recording,
        ],
    )?;
    Ok(conn.query_row(
        "SELECT id FROM shots WHERE path = ?1",
        [path_text(&shot.path)],
        |row| row.get(0),
    )?)
}

/// A shot's thumbnail PNG, made first when missing. An MP4's is a frame
/// ffmpeg decodes, so it needs `ffmpeg`; a GIF's is its first frame. An
/// edited capture's is never made from the original: without one it is
/// [`LibraryError::NoThumbnail`].
fn thumbnail_bytes(shot: &Shot, ffmpeg: Option<&Path>) -> LibraryResult<Vec<u8>> {
    if shot.kind == ShotKind::Video {
        ensure_video_thumbnail(&shot.path, &shot.thumb_path, shot.duration_ms, ffmpeg)?;
    } else if is_edited(&shot.path) {
        if !shot.thumb_path.is_file() {
            return Err(LibraryError::NoThumbnail);
        }
    } else {
        ensure_thumbnail(&shot.path, &shot.thumb_path)?;
    }
    Ok(fs::read(&shot.thumb_path)?)
}

/// Makes the thumbnail of the MP4 at `video` from a frame ffmpeg decodes,
/// unless it exists.
pub fn ensure_video_thumbnail(
    video: &Path,
    thumb: &Path,
    duration_ms: Option<u64>,
    ffmpeg: Option<&Path>,
) -> LibraryResult<()> {
    if thumb.is_file() {
        return Ok(());
    }
    let ffmpeg = ffmpeg.ok_or(LibraryError::NoPreview)?;
    let frame = crate::ffmpeg::video_frame(
        ffmpeg,
        video,
        crate::ffmpeg::preview_at_ms(duration_ms),
        THUMB_SIZE,
    )
    .map_err(|err| LibraryError::Io(io::Error::other(err)))?;
    write_thumbnail(&frame, thumb)
}

pub(crate) fn shot_from_row(row: &Row<'_>) -> rusqlite::Result<Shot> {
    let path = PathBuf::from(row.get::<_, String>(1)?);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let kind = ShotKind::from_column(&row.get::<_, String>(12)?);
    let thumb_path = PathBuf::from(row.get::<_, String>(2)?);
    let (edited_at, thumb_stale) = edit_state(kind, &path, &thumb_path);
    Ok(Shot {
        id: row.get(0)?,
        file_name,
        path,
        thumb_path,
        captured_at: row.get(3)?,
        mode: row.get(4)?,
        app: row.get(5)?,
        window_title: row.get(6)?,
        width: row.get(7)?,
        height: row.get(8)?,
        tags: Vec::new(),
        notes: row.get(9)?,
        ai_description: row.get(10)?,
        ai_category: row.get(11)?,
        ai_tags: Vec::new(),
        kind,
        duration_ms: row.get::<_, Option<i64>>(13)?.map(|ms| ms.max(0) as u64),
        bytes: row
            .get::<_, Option<i64>>(14)?
            .map(|bytes| bytes.max(0) as u64),
        keep: row.get::<_, i64>(15)? != 0,
        edited_at,
        thumb_stale,
    })
}

/// Whether the capture at `png` has edits: an annotations sidecar on disk.
fn is_edited(png: &Path) -> bool {
    capture::annotations_path(png).is_file()
}

/// When a capture's edits were saved, and whether its thumbnail is missing
/// or older than them. Recordings have no edits.
fn edit_state(kind: ShotKind, path: &Path, thumb: &Path) -> (Option<i64>, bool) {
    if kind.is_recording() {
        return (None, false);
    }
    let Some(edited_at) = modified_at(&capture::annotations_path(path)) else {
        return (None, false);
    };
    let stale = modified_at(thumb).is_none_or(|drawn| drawn < edited_at);
    (Some(edited_at), stale)
}

/// A file's modified time in milliseconds since the Unix epoch, or `None`
/// when it is missing.
fn modified_at(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .ok()
        .filter(|meta| meta.is_file())
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| age.as_millis() as i64)
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
    write_thumbnail(&image::open(png)?, thumb)
}

/// Saves the PNG `png`, the capture at `capture` drawn with the edits saved
/// at `drawn_from` (ms, from [`ShotAnnotations::edited_at`]), fitted inside
/// [`THUMB_SIZE`], as the thumbnail `thumb`. Edits saved again since are
/// [`LibraryError::OutOfDate`] and nothing is written. The thumbnail is
/// stamped with `drawn_from`, not the time it is written, so edits saved
/// while it is written still leave it stale and it is drawn again.
pub fn save_thumbnail(
    capture: &Path,
    png: &[u8],
    thumb: &Path,
    drawn_from: i64,
) -> LibraryResult<()> {
    let newer = |path: &Path| modified_at(path).is_some_and(|saved| saved > drawn_from);
    let sidecar = capture::annotations_path(capture);
    if newer(&sidecar) {
        return Err(LibraryError::OutOfDate);
    }
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)?;
    write_thumbnail(&image, thumb)?;
    let stamp = UNIX_EPOCH + std::time::Duration::from_millis(drawn_from.max(0) as u64);
    fs::File::options()
        .write(true)
        .open(thumb)
        .and_then(|file| file.set_modified(stamp))?;
    Ok(())
}

/// Saves `image`, fitted inside [`THUMB_SIZE`], as the PNG `thumb`.
fn write_thumbnail(image: &image::DynamicImage, thumb: &Path) -> LibraryResult<()> {
    let small = if image.width() > THUMB_SIZE || image.height() > THUMB_SIZE {
        image.thumbnail(THUMB_SIZE, THUMB_SIZE)
    } else {
        image.clone()
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
    capture::read_meta(png)
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

/// The MP4s and GIFs in `<save_folder>/recordings/`, sorted by name.
fn recordings_in(save_folder: &Path) -> LibraryResult<Vec<PathBuf>> {
    let dir = save_folder.join(RECORDINGS_DIR);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };
    let mut videos: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_file() && ShotKind::of_recording(path).is_some())
        .collect();
    videos.sort();
    Ok(videos)
}

/// The files that go with a shot besides its main file: its sidecars and
/// its thumbnail. [`Library::delete`] removes them, and so does cleanup.
pub(crate) fn extra_files(shot: &Shot) -> Vec<PathBuf> {
    let mut extras = vec![
        capture::meta_path(&shot.path),
        capture::annotations_path(&shot.path),
        shot.thumb_path.clone(),
    ];
    if shot.kind.is_recording() {
        extras.push(crate::record::cursor_path(&shot.path));
        extras.push(crate::recording_editor::edits_path(&shot.path));
        extras.push(crate::record::sound_path(&shot.path));
    }
    extras
}

/// What goes to the Trash with a shot: its main file first, then its
/// sidecars. Not its thumbnail, which is Grab-it's own and is made again
/// if the item comes back, so it is deleted instead.
pub(crate) fn trashed_files(shot: &Shot) -> Vec<PathBuf> {
    let mut files = vec![shot.path.clone()];
    files.extend(
        extra_files(shot)
            .into_iter()
            .filter(|path| *path != shot.thumb_path),
    );
    files
}

/// How many "<name> copy N" names a duplicate tries.
const MAX_COPIES: u32 = 999;

/// The longest name, in characters, a rename gives a file.
const MAX_NAME_CHARS: usize = 200;

/// The longest file name, in bytes, most disks take (ext4, APFS and NTFS
/// all stop near 255). A rename checks it against every file it renames,
/// sidecars included, so none is left behind under the old name.
const MAX_NAME_BYTES: usize = 255;

/// Characters no file name may hold on Windows, refused everywhere so the
/// save folder can move between systems.
const BAD_NAME_CHARS: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// The file name a rename to `name` gives the file at `path`: `name`,
/// trimmed, with the file's extension (kept when `name` already ends in
/// it). Refuses names a file cannot have.
pub(crate) fn renamed_file_name(path: &Path, name: &str) -> LibraryResult<String> {
    let bad = |why: &str| Err(LibraryError::BadName(why.to_owned()));
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().into_owned());
    let mut stem = name.trim();
    if let Some(ext) = &extension {
        let suffix = format!(".{ext}");
        if stem.len() > suffix.len()
            && stem.is_char_boundary(stem.len() - suffix.len())
            && stem[stem.len() - suffix.len()..].eq_ignore_ascii_case(&suffix)
        {
            stem = stem[..stem.len() - suffix.len()].trim_end();
        }
    }
    if stem.is_empty() {
        return bad("Give it a name.");
    }
    if stem
        .chars()
        .any(|c| c.is_control() || BAD_NAME_CHARS.contains(&c))
    {
        return bad("A name can't contain / \\ : * ? \" < > | or control characters.");
    }
    if stem.starts_with('.') {
        return bad("A name can't start with a dot.");
    }
    if stem.ends_with('.') {
        return bad("A name can't end with a dot.");
    }
    if stem.chars().count() > MAX_NAME_CHARS {
        return bad("That name is too long.");
    }
    let device = stem.split('.').next().unwrap_or(stem).to_ascii_uppercase();
    let reserved = matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((device.starts_with("COM") || device.starts_with("LPT"))
            && device.len() == 4
            && device.as_bytes()[3].is_ascii_digit()
            && device.as_bytes()[3] != b'0');
    if reserved {
        return bad("Windows keeps that name for itself.");
    }
    Ok(match extension {
        Some(ext) => format!("{stem}.{ext}"),
        None => stem.to_owned(),
    })
}

/// `shot` as it would be with its main file at `path`: its file name and
/// thumbnail follow.
fn moved_to(shot: &Shot, path: PathBuf) -> Shot {
    let mut moved = shot.clone();
    moved.file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    moved.thumb_path = thumb_path(&path);
    moved.path = path;
    moved
}

/// Whether two paths name the same file on disk, as two spellings of one
/// name do on a disk that ignores case.
fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(a), fs::metadata(b)) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        match (fs::canonicalize(a), fs::canonicalize(b)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }
}

/// Copies `shot`'s file, sidecars and thumbnail to `target`'s (from
/// [`Library::copy_target`]) and returns the copy's row, which keeps the
/// original's time, size and metadata. The file is never written over:
/// if something took its name meanwhile, or it cannot be copied, nothing
/// is left behind. Touches only files, so it runs without the lock.
pub fn copy_files(shot: &Shot, target: &Shot) -> LibraryResult<PreparedShot> {
    copy_new(&shot.path, &target.path)?;
    if let Err(err) = copy_assets(
        &capture::assets_dir(&shot.path),
        &capture::assets_dir(&target.path),
    ) {
        fs::remove_file(&target.path)?;
        return Err(err);
    }
    for (from, to) in extra_files(shot).into_iter().zip(extra_files(target)) {
        if from.is_file()
            && let Err(err) = fs::copy(&from, &to)
        {
            eprintln!(
                "Grab-it: could not copy {} to {}: {err}",
                from.display(),
                to.display()
            );
        }
    }
    Ok(PreparedShot {
        kind: shot.kind,
        path: target.path.clone(),
        thumb_path: target.thumb_path.clone(),
        captured_at: shot.captured_at,
        mode: shot.mode.clone(),
        app: shot.app.clone(),
        window_title: shot.window_title.clone(),
        width: shot.width,
        height: shot.height,
        duration_ms: shot.duration_ms,
        bytes: fs::metadata(&target.path)
            .map(|meta| meta.len())
            .ok()
            .or(shot.bytes),
    })
}

/// Copies the images added to a capture in the editor (a flat folder) to
/// its copy's folder, so the copy's sidecar finds them.
fn copy_assets(from: &Path, to: &Path) -> LibraryResult<()> {
    let mut entries = match fs::read_dir(from) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    fs::create_dir(to)?;
    let result = entries.try_for_each(|entry| -> LibraryResult<()> {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            copy_new(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    });
    if result.is_err() {
        fs::remove_dir_all(to)?;
    }
    result
}

/// Copies `from` to `to`, which must not exist yet; a half-written copy
/// is removed.
fn copy_new(from: &Path, to: &Path) -> LibraryResult<()> {
    let mut source = fs::File::open(from)?;
    let mut copy = match fs::OpenOptions::new().write(true).create_new(true).open(to) {
        Ok(copy) => copy,
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            let name = to
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            return Err(LibraryError::NameTaken(name));
        }
        Err(err) => return Err(err.into()),
    };
    if let Err(err) = io::copy(&mut source, &mut copy).and_then(|_| copy.sync_all()) {
        drop(copy);
        let _ = fs::remove_file(to);
        return Err(err.into());
    }
    Ok(())
}

/// The JPEG quality screenshots are exported at.
const JPEG_QUALITY: u8 = 92;

/// The image format a screenshot exported to `target` is written in, by
/// its extension: PNG, JPG or WebP.
fn export_format(target: &Path) -> Option<image::ImageFormat> {
    let extension = target.extension()?.to_string_lossy().to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some(image::ImageFormat::Png),
        "jpg" | "jpeg" => Some(image::ImageFormat::Jpeg),
        "webp" => Some(image::ImageFormat::WebP),
        _ => None,
    }
}

/// Where an export of `shot` to `target` is written: `target` itself, or,
/// when it is a folder, the shot's own file name there, as "<name> 2",
/// "<name> 3" and so on when a file already has it.
pub(crate) fn export_path(shot: &Shot, target: &Path) -> LibraryResult<PathBuf> {
    if !target.is_dir() {
        return Ok(target.to_path_buf());
    }
    let stem = shot
        .path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = shot
        .path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..=MAX_COPIES {
        let name = if n == 1 {
            format!("{stem}{extension}")
        } else {
            format!("{stem} {n}{extension}")
        };
        let path = target.join(name);
        if !path.exists() {
            return Ok(path);
        }
    }
    Err(LibraryError::NameTaken(format!(
        "{stem} {MAX_COPIES}{extension}"
    )))
}

/// Exports `shot`'s original file to `target`, a file or a folder (see
/// [`export_path`]), and returns where it went. A screenshot is written as
/// PNG, JPG or WebP by the target's extension; a recording is copied as it
/// is, so its target keeps its extension. The shot's own file and sidecars
/// are never written over ([`crate::editor::check_export_target`]); any other
/// file there is, as the save dialog has asked. The export is written beside
/// the target first, so a failure leaves nothing half-written.
pub fn export_shot(shot: &Shot, target: &Path) -> Result<PathBuf, String> {
    let target = export_path(shot, target).map_err(to_message)?;
    crate::editor::check_export_target(&shot.path, &target)?;
    let protected = extra_files(shot)
        .into_iter()
        .any(|path| path == target || same_file(&path, &target));
    if protected {
        return Err("export would overwrite the original capture; choose another file".to_owned());
    }
    let source_extension = shot
        .path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let target_extension = target
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let format = if shot.kind.is_recording() {
        if target_extension != source_extension {
            return Err(format!(
                "A recording is exported as it is: give the file a .{source_extension} name."
            ));
        }
        None
    } else {
        let format = export_format(&target).ok_or(
            "A screenshot exports as .png, .jpg or .webp: give the file one of those names.",
        )?;
        // A PNG to PNG export is the original's bytes.
        (format != image::ImageFormat::Png || source_extension != "png").then_some(format)
    };
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = target.with_file_name(format!(".{name}.{}.export.tmp", std::process::id()));
    let written = match format {
        None => fs::copy(&shot.path, &tmp)
            .map(|_| ())
            .map_err(|err| format!("could not export it: {err}")),
        Some(format) => image::open(&shot.path)
            .map_err(|err| format!("could not open {}: {err}", shot.path.display()))
            .and_then(|image| write_image(&image, format, &tmp)),
    }
    .and_then(|()| fs::rename(&tmp, &target).map_err(|err| format!("could not export it: {err}")));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written.map(|()| target)
}

/// Writes `image` to `path` as `format`: a JPG without its alpha, a WebP
/// losslessly.
fn write_image(
    image: &image::DynamicImage,
    format: image::ImageFormat,
    path: &Path,
) -> Result<(), String> {
    use std::io::Write;
    let fail = |err: image::ImageError| format!("could not export it: {err}");
    let mut writer = io::BufWriter::new(
        fs::File::create(path).map_err(|err| format!("could not export it: {err}"))?,
    );
    match format {
        image::ImageFormat::Jpeg => image::DynamicImage::ImageRgb8(image.to_rgb8())
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut writer,
                JPEG_QUALITY,
            ))
            .map_err(fail)?,
        image::ImageFormat::WebP => image::DynamicImage::ImageRgba8(image.to_rgba8())
            .write_with_encoder(image::codecs::webp::WebPEncoder::new_lossless(&mut writer))
            .map_err(fail)?,
        _ => image
            .write_with_encoder(image::codecs::png::PngEncoder::new(&mut writer))
            .map_err(fail)?,
    }
    writer
        .flush()
        .and_then(|()| writer.get_ref().sync_all())
        .map_err(|err| format!("could not export it: {err}"))
}

/// Deletes the images added to the capture at `png` in the editor, if it
/// has any. A failure is logged, not returned: the capture is already gone.
pub(crate) fn remove_assets(png: &Path) {
    let dir = capture::assets_dir(png);
    match fs::remove_dir_all(&dir) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => {
            eprintln!("Grab-it: could not delete {}: {err}", dir.display());
        }
        _ => {}
    }
}

pub(crate) fn remove_if_present(path: &Path) -> io::Result<()> {
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
    pub fn rescan(&self, save_folder: &Path, ffmpeg: Option<&Path>) -> LibraryResult<RescanReport> {
        let known = self.lock().known()?;
        let scan = scan_files(&known, save_folder, ffmpeg)?;
        self.lock().apply(&scan)
    }

    /// [`Library::add_capture`], making the thumbnail without the lock.
    pub fn add_capture(&self, png: &Path) -> LibraryResult<Shot> {
        let prepared = prepare_capture(png)?;
        self.lock().insert(&prepared)
    }

    /// Copies a shot beside itself (see [`Library::copy_target`]) with its
    /// sidecars and thumbnail, and adds the copy, with the original's tags
    /// and notes. Files are copied without the lock, so a long recording
    /// does not hold up the Library.
    pub fn duplicate(&self, id: i64) -> LibraryResult<Shot> {
        let (shot, target) = {
            let library = self.lock();
            let shot = library.get(id)?;
            let target = library.copy_target(&shot)?;
            (shot, target)
        };
        let prepared = copy_files(&shot, &target)?;
        let mut library = self.lock();
        let copy = library.insert(&prepared)?;
        if !shot.notes.is_empty() {
            library.set_notes(copy.id, &shot.notes)?;
        }
        library.set_tags(copy.id, &shot.tags)
    }

    /// Moves a shot's file and sidecars to the Trash with `remove` (see
    /// [`trashed_files`]), deletes its thumbnail and drops its row. If the
    /// file cannot be moved nothing else is touched. The files are moved
    /// without the lock: the Trash may be on another disk.
    pub fn trash(&self, id: i64, remove: &crate::storage::RemoveFiles) -> LibraryResult<Shot> {
        let shot = self.lock().get(id)?;
        remove(&trashed_files(&shot), crate::settings::Removal::Trash)?;
        if let Err(err) = remove_if_present(&shot.thumb_path) {
            eprintln!(
                "Grab-it: could not delete {}: {err}",
                shot.thumb_path.display()
            );
        }
        self.lock().forget(id)?;
        Ok(shot)
    }

    /// A shot's thumbnail PNG, regenerated without the lock if missing.
    pub fn thumbnail(&self, id: i64, ffmpeg: Option<&Path>) -> LibraryResult<Vec<u8>> {
        let shot = self.lock().get(id)?;
        thumbnail_bytes(&shot, ffmpeg)
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
    std::thread::spawn(move || rescan_now(&app, &save_folder));
}

/// Rescans `save_folder` on the calling thread and tells the windows when
/// something changed.
pub fn rescan_now(app: &AppHandle, save_folder: &Path) {
    let Some(state) = app.try_state::<LibraryState>() else {
        return;
    };
    let ffmpeg = crate::ffmpeg::ready(app).map(|ready| ready.path);
    let report = state.rescan(save_folder, ffmpeg.as_deref());
    // Captures found by the scan, or left over from an earlier run,
    // wait for OCR and to be described.
    crate::ocr::wake(app);
    crate::ai::wake(app);
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
            crate::ocr::wake(app);
            crate::ai::wake(app);
        }
        Err(err) => eprintln!(
            "Grab-it: saved, but could not add {} to the library: {err}",
            png.display()
        ),
    }
}

/// Adds a just-saved recording, or an export of one, to the library.
/// `duration_ms` is how long the recorder says it runs.
pub fn record_recording(app: &AppHandle, video: &Path, duration_ms: u64) {
    let Some(state) = app.try_state::<LibraryState>() else {
        return;
    };
    let ffmpeg = crate::ffmpeg::ready(app).map(|ready| ready.path);
    let result = prepare_recording(video, Some(duration_ms), ffmpeg.as_deref())
        .and_then(|prepared| state.lock().insert(&prepared));
    match result {
        Ok(_) => {
            let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
        }
        Err(err) => eprintln!(
            "Grab-it: saved, but could not add {} to the library: {err}",
            video.display()
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
#[specta::specta]
pub fn library_list(
    offset: u32,
    limit: u32,
    state: State<'_, LibraryState>,
) -> Result<ShotPage, String> {
    state.lock().list(offset, limit).map_err(to_message)
}

/// The ffmpeg to decode an MP4's preview with. While ffmpeg is still being
/// checked or downloaded, as it is for a while after launch, waits for it
/// (up to [`PREVIEW_FFMPEG_WAIT`]) rather than leave the tile without a
/// preview until the Library is opened again.
fn ffmpeg_for_preview(app: &AppHandle) -> Option<PathBuf> {
    use crate::ffmpeg::FfmpegStatus;
    let deadline = std::time::Instant::now() + PREVIEW_FFMPEG_WAIT;
    loop {
        if let Some(ready) = crate::ffmpeg::ready(app) {
            return Some(ready.path);
        }
        let preparing = matches!(
            crate::ffmpeg::status(app),
            FfmpegStatus::Checking | FfmpegStatus::Downloading { .. }
        );
        if !preparing || std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

/// How long an MP4's preview waits for ffmpeg to be ready.
const PREVIEW_FFMPEG_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// A shot's thumbnail PNG bytes.
#[tauri::command(async)]
pub fn library_thumbnail(
    id: i64,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<tauri::ipc::Response, String> {
    let shot = state.lock().get(id).map_err(to_message)?;
    let ffmpeg = if shot.kind == ShotKind::Video && !shot.thumb_path.is_file() {
        ffmpeg_for_preview(&app)
    } else {
        None
    };
    let bytes = state.thumbnail(id, ffmpeg.as_deref()).map_err(to_message)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command(async)]
#[specta::specta]
pub fn library_set_tags(
    id: i64,
    tags: Vec<String>,
    state: State<'_, LibraryState>,
) -> Result<Shot, String> {
    state.lock().set_tags(id, &tags).map_err(to_message)
}

#[tauri::command(async)]
#[specta::specta]
pub fn library_remove_ai_tag(
    id: i64,
    tag: String,
    state: State<'_, LibraryState>,
) -> Result<Shot, String> {
    state.lock().remove_ai_tag(id, &tag).map_err(to_message)
}

/// Stars or unstars a shot Keep forever.
#[tauri::command(async)]
#[specta::specta]
pub fn library_set_keep(
    id: i64,
    keep: bool,
    state: State<'_, LibraryState>,
) -> Result<Shot, String> {
    state.lock().set_keep(id, keep).map_err(to_message)
}

#[tauri::command(async)]
#[specta::specta]
pub fn library_set_notes(
    id: i64,
    notes: String,
    state: State<'_, LibraryState>,
) -> Result<Shot, String> {
    state.lock().set_notes(id, &notes).map_err(to_message)
}

/// Deletes a shot from disk and the library, closing its editor first.
#[tauri::command(async)]
#[specta::specta]
pub fn library_delete(
    id: i64,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    let path = state.lock().get(id).map_err(to_message)?.path;
    close_editor(&app, &path);
    state.lock().delete(id).map_err(to_message)?;
    let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
    Ok(())
}

/// Closes the image or recording editor open on `path`, if any, before
/// its file is moved or removed.
fn close_editor(app: &AppHandle, path: &Path) {
    let editor = app.state::<EditorState>().label_for(path).or_else(|| {
        app.state::<crate::recording_editor::RecordingEditorState>()
            .label_for(path)
    });
    if let Some(window) = editor.and_then(|label| app.get_webview_window(&label)) {
        let _ = window.destroy();
    }
}

/// Moves a shot's file and sidecars to the system Trash and drops it from
/// the library, closing its editor first.
#[tauri::command(async)]
#[specta::specta]
pub fn library_trash(
    id: i64,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    let path = state.lock().get(id).map_err(to_message)?.path;
    close_editor(&app, &path);
    state
        .trash(id, &crate::storage::remove_files)
        .map_err(|err| format!("could not move it to the Trash: {err}"))?;
    let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
    Ok(())
}

/// Renames a shot's file, with its sidecars and thumbnail, and returns
/// the shot as it now is. `name` is the new name; the file keeps its
/// extension. Its editor is closed first, since it saves to the old path.
#[tauri::command(async)]
#[specta::specta]
pub fn library_rename(
    id: i64,
    name: String,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<Shot, String> {
    let shot = state.lock().get(id).map_err(to_message)?;
    if !shot.path.is_file() {
        return Err(format!("{} no longer exists", shot.path.display()));
    }
    // Checked before the editor is closed, so a name that is refused,
    // whether not allowed or taken, leaves it open with its edits.
    let target = state
        .lock()
        .rename_target(&shot, &name)
        .map_err(to_message)?;
    if target.is_some() {
        close_editor(&app, &shot.path);
    }
    let renamed = state.lock().rename(id, &name).map_err(to_message)?;
    let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
    Ok(renamed)
}

/// Copies a shot beside itself as "<name> copy" with its sidecars, adds
/// the copy to the library and returns it.
#[tauri::command(async)]
#[specta::specta]
pub fn library_duplicate(
    id: i64,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<Shot, String> {
    existing_path(&app, id)?;
    let copy = state
        .duplicate(id)
        .map_err(|err| format!("could not duplicate it: {err}"))?;
    let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
    Ok(copy)
}

/// Whether [`library_open_with`] can ask which app to use here: through
/// the OpenURI portal on Linux and the Open With dialog on Windows. macOS
/// has no system chooser an app can show.
#[tauri::command]
#[specta::specta]
pub fn library_open_with_supported() -> bool {
    cfg!(any(target_os = "linux", target_os = "windows"))
}

/// Asks the system which app to open a shot's file with, and opens it
/// there. Resolves once the choice is made; backing out is not a failure.
#[tauri::command]
#[specta::specta]
pub async fn library_open_with(id: i64, app: AppHandle) -> Result<(), String> {
    let path = existing_path(&app, id)?;
    #[cfg(target_os = "linux")]
    {
        crate::portal::open_with(&path).await
    }
    #[cfg(target_os = "windows")]
    {
        // The dialog is modal and blocks until it closes.
        tauri::async_runtime::spawn_blocking(move || open_with_dialog(&path))
            .await
            .map_err(|err| format!("the Open With dialog failed: {err}"))?
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = path;
        Err("Open with is not available on this system.".into())
    }
}

/// Shows Windows' Open With dialog for `path`, which opens it in the app
/// picked there.
#[cfg(target_os = "windows")]
fn open_with_dialog(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    // `::windows` is the crate; `windows` alone is Grab-it's own module.
    use ::windows::Win32::Foundation::ERROR_CANCELLED;
    use ::windows::Win32::UI::Shell::{
        OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OAIF_REGISTER_EXT, OPENASINFO, SHOpenWithDialog,
    };
    use ::windows::core::{HRESULT, PCWSTR};
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let info = OPENASINFO {
        pcszFile: PCWSTR(wide.as_ptr()),
        pcszClass: PCWSTR::null(),
        oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_EXEC,
    };
    // SAFETY: `info` and the name it points to outlive the call.
    match unsafe { SHOpenWithDialog(None, &info) } {
        Ok(()) => Ok(()),
        Err(err) if err.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => Ok(()),
        Err(err) => Err(format!("could not show the Open With dialog: {err}")),
    }
}

/// Opens a shot in its editor: a capture in the image editor, an MP4 in
/// the recording editor. A GIF, which has no editor, plays. Async so the
/// window is not created on the main thread inside a command, which
/// deadlocks on Windows.
#[tauri::command]
#[specta::specta]
pub async fn library_open(id: i64, app: AppHandle) -> Result<(), String> {
    let shot = app
        .state::<LibraryState>()
        .lock()
        .get(id)
        .map_err(to_message)?;
    let path = shot.path;
    if !path.is_file() {
        return Err(format!("{} no longer exists", path.display()));
    }
    match shot.kind {
        ShotKind::Image => windows::show_editor(&app, &path).map_err(|err| err.to_string()),
        ShotKind::Video => {
            windows::show_recording_editor(&app, &path).map_err(|err| err.to_string())
        }
        ShotKind::Gif => play(&app, &path),
    }
}

/// Opens a recording in the app that plays it.
fn play(app: &AppHandle, path: &Path) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|err| format!("could not play the recording: {err}"))
}

/// Plays a recording in the app that plays its kind of file.
#[tauri::command(async)]
#[specta::specta]
pub fn library_play(id: i64, app: AppHandle) -> Result<(), String> {
    play(&app, &existing_path(&app, id)?)
}

/// The path of a capture (not a recording) that is still on disk.
fn existing_image(app: &AppHandle, id: i64) -> Result<PathBuf, String> {
    let kind = app
        .state::<LibraryState>()
        .lock()
        .get(id)
        .map_err(to_message)?
        .kind;
    if kind.is_recording() {
        return Err("That works on screenshots, not recordings.".into());
    }
    existing_path(app, id)
}

/// The path of a shot that is still on disk.
fn existing_path(app: &AppHandle, id: i64) -> Result<PathBuf, String> {
    let path = app
        .state::<LibraryState>()
        .lock()
        .get(id)
        .map_err(to_message)?
        .path;
    if !path.is_file() {
        return Err(format!("{} no longer exists", path.display()));
    }
    Ok(path)
}

/// A capture's original PNG bytes, for the Library to draw it with its
/// edits.
#[tauri::command(async)]
pub fn library_image(id: i64, app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let path = existing_image(&app, id)?;
    let bytes =
        fs::read(&path).map_err(|err| format!("could not open {}: {err}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// A capture's saved annotations and pixels per point, for drawing it
/// with its edits. Mirrors `ShotAnnotations` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShotAnnotations {
    /// The sidecar, or `None` when the capture has no edits.
    pub annotations: Option<serde_json::Value>,
    /// From the capture's `meta.json`; `None` when it was not recorded.
    pub scale_factor: Option<f64>,
    /// When the sidecar read was saved (ms since the Unix epoch), to send
    /// back with the thumbnail drawn from it; `None` without edits.
    pub edited_at: Option<i64>,
}

/// Reads `png`'s annotations sidecar and scale. An unreadable or unknown
/// sidecar is an error, so the original is never passed off as edited.
pub fn shot_annotations(png: &Path) -> Result<ShotAnnotations, String> {
    // Read before the sidecar, so a save in between only makes it look older.
    let edited_at = modified_at(&capture::annotations_path(png));
    let annotations = crate::editor::read_annotations(png)?;
    let scale_factor = capture::valid_scale(read_meta(png).and_then(|meta| meta.scale_factor));
    Ok(ShotAnnotations {
        annotations,
        scale_factor,
        edited_at,
    })
}

/// A capture's saved annotations and scale. See [`shot_annotations`].
#[tauri::command(async)]
#[specta::specta]
pub fn library_annotations(id: i64, app: AppHandle) -> Result<ShotAnnotations, String> {
    shot_annotations(&existing_image(&app, id)?)
}

/// Saves the PNG in the request body, a capture drawn with its edits, as
/// that capture's thumbnail, so it is drawn only once per edit.
#[tauri::command(async)]
pub fn library_save_thumbnail(
    request: tauri::ipc::Request<'_>,
    app: AppHandle,
) -> Result<(), String> {
    let id = request
        .headers()
        .get(THUMBNAIL_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or("missing the capture's id")?;
    let drawn_from = request
        .headers()
        .get(THUMBNAIL_EDITED_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or("missing when the edits were saved")?;
    let tauri::ipc::InvokeBody::Raw(png) = request.body() else {
        return Err("expected image bytes".to_owned());
    };
    let shot = app
        .state::<LibraryState>()
        .lock()
        .get(id)
        .map_err(to_message)?;
    if shot.kind.is_recording() {
        return Err("That works on screenshots, not recordings.".into());
    }
    save_thumbnail(&shot.path, png, &shot.thumb_path, drawn_from).map_err(to_message)
}

/// The header [`library_save_thumbnail`] reads the capture's id from.
pub const THUMBNAIL_ID_HEADER: &str = "x-grab-it-shot";
/// The header [`library_save_thumbnail`] reads, in ms, when the edits it
/// was drawn from were saved.
pub const THUMBNAIL_EDITED_HEADER: &str = "x-grab-it-edited";

/// Copies a shot's original image to the clipboard.
#[tauri::command(async)]
#[specta::specta]
pub fn library_copy(id: i64, app: AppHandle) -> Result<(), String> {
    crate::quick::copy_file(&app, &existing_image(&app, id)?)
}

/// Puts a shot's file on the clipboard as a file, screenshot or
/// recording, to paste into a file manager or attach in another app.
#[tauri::command(async)]
#[specta::specta]
pub fn library_copy_file(id: i64, app: AppHandle) -> Result<(), String> {
    let path = existing_path(&app, id)?;
    crate::file_clipboard::copy_files(&app, &[path])
}

/// Exports a shot's original file to `target`, a file or a folder, and
/// returns the path written: a screenshot as PNG, JPG or WebP by the
/// target's extension, a recording as a copy. See [`export_shot`].
#[tauri::command(async)]
#[specta::specta]
pub fn library_export(
    id: i64,
    target: PathBuf,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<PathBuf, String> {
    existing_path(&app, id)?;
    let shot = state.lock().get(id).map_err(to_message)?;
    export_shot(&shot, &target)
}

/// The text in a shot, as far as OCR has got.
#[tauri::command(async)]
#[specta::specta]
pub fn library_text(id: i64, state: State<'_, LibraryState>) -> Result<ShotText, String> {
    state.lock().text(id).map_err(to_message)
}

/// The lines of text in a shot with their word boxes, in image pixels, or
/// None when OCR has not read them (see [`Library::lines`]).
#[tauri::command(async)]
#[specta::specta]
pub fn library_words(
    id: i64,
    state: State<'_, LibraryState>,
) -> Result<Option<Vec<OcrLine>>, String> {
    state.lock().lines(id).map_err(to_message)
}

/// The library id of the capture at `path`, or None when the library does
/// not know it, so windows that only have a path can use the id commands.
#[tauri::command(async)]
#[specta::specta]
pub fn library_shot_id(
    path: PathBuf,
    state: State<'_, LibraryState>,
) -> Result<Option<i64>, String> {
    state.lock().id_for_path(&path).map_err(to_message)
}

/// Copies the text in a shot and returns it. A shot OCR has not read yet,
/// or could not read, is read now, with the values of any codes in it, and
/// what it finds is stored, so it is searchable and can be described.
#[tauri::command(async)]
#[specta::specta]
pub fn library_copy_text(id: i64, app: AppHandle) -> Result<String, String> {
    let library = app.state::<LibraryState>();
    let known = library.lock().text(id).map_err(to_message)?;
    let text = match known {
        ShotText::Read { text } => text,
        ShotText::Waiting | ShotText::Failed => {
            let path = existing_image(&app, id)?;
            let image = image::open(&path)
                .map_err(|err| format!("could not open {}: {err}", path.display()))?
                .into_rgba8();
            let lines = crate::ocr::read_now(&app, &image)
                .map_err(|err| format!("could not read the text: {err}"))?;
            let text = crate::ocr::lines_text(&lines);
            // Stored before its codes are decoded, as the OCR queue does.
            match crate::ocr::store_text(&library, id, &lines, &image) {
                Ok(stored) => {
                    let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
                    crate::ai::wake(&app);
                    stored
                }
                Err(err) => {
                    eprintln!("Grab-it: could not store the text of shot {id}: {err}");
                    text
                }
            }
        }
    };
    if text.trim().is_empty() {
        return Err("No text found in this capture.".into());
    }
    crate::file_clipboard::copy_text(&app, &text)
        .map_err(|err| format!("could not copy the text: {err}"))?;
    Ok(text)
}

/// Floats a shot above other windows. Async for the same reason as
/// [`library_open`].
#[tauri::command]
#[specta::specta]
pub async fn library_pin(id: i64, app: AppHandle) -> Result<(), String> {
    crate::pin::open(&app, &existing_image(&app, id)?, false)
}

/// Shows a shot's file in the system file manager.
#[tauri::command(async)]
#[specta::specta]
pub fn library_reveal(id: i64, app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(existing_path(&app, id)?)
        .map_err(|err| format!("could not show the capture in its folder: {err}"))
}

/// Opens the folder a shot's file is in, without picking the file out as
/// [`library_reveal`] does.
#[tauri::command(async)]
#[specta::specta]
pub fn library_open_folder(id: i64, app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = existing_path(&app, id)?;
    let folder = path
        .parent()
        .ok_or_else(|| format!("{} has no folder", path.display()))?;
    app.opener()
        .open_path(folder.to_string_lossy(), None::<&str>)
        .map_err(|err| format!("could not open the folder: {err}"))
}

/// Opens a shot's file in the app the system opens its kind of file with.
#[tauri::command(async)]
#[specta::specta]
pub fn library_open_external(id: i64, app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(existing_path(&app, id)?.to_string_lossy(), None::<&str>)
        .map_err(|err| format!("could not open the file: {err}"))
}

/// Puts the full path of a shot's file on the clipboard and returns it.
#[tauri::command(async)]
#[specta::specta]
pub fn library_copy_path(id: i64, app: AppHandle) -> Result<String, String> {
    let path = existing_path(&app, id)?.to_string_lossy().into_owned();
    crate::file_clipboard::copy_text(&app, &path)
        .map_err(|err| format!("could not copy the path: {err}"))?;
    Ok(path)
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
            None,
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

    /// A 2-frame GIF recording in `<folder>/recordings/`.
    fn record_gif(folder: &Path, name: &str) -> PathBuf {
        use image::{Delay, Frame, codecs::gif::GifEncoder};
        let dir = folder.join(RECORDINGS_DIR);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let mut encoder = GifEncoder::new(fs::File::create(&path).unwrap());
        for shade in [40u8, 200] {
            let image = RgbaImage::from_pixel(64, 32, Rgba([shade, 0, 0, 255]));
            let delay = Delay::from_numer_denom_ms(100, 1);
            encoder
                .encode_frame(Frame::from_parts(image, 0, 0, delay))
                .unwrap();
        }
        drop(encoder);
        path
    }

    /// An MP4 recording in `<folder>/recordings/`, with its sidecars. Its
    /// bytes are not a real video: without ffmpeg nothing decodes them.
    fn record_mp4(folder: &Path, name: &str) -> PathBuf {
        let dir = folder.join(RECORDINGS_DIR);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, b"not really a video").unwrap();
        fs::write(crate::record::cursor_path(&path), b"{}").unwrap();
        fs::write(crate::recording_editor::edits_path(&path), b"{}").unwrap();
        fs::write(crate::record::sound_path(&path), b"not really sound").unwrap();
        path
    }

    #[test]
    fn rescan_adds_recordings_which_are_never_read_or_described() {
        let dir = TempDir::new().unwrap();
        shoot(dir.path(), 1, (40, 20));
        let gif = record_gif(dir.path(), "Grab-it 2026-03-07 09-05-02.gif");
        let mp4 = record_mp4(dir.path(), "Grab-it 2026-03-07 09-05-03.mp4");
        // Not recordings.
        fs::write(dir.path().join(RECORDINGS_DIR).join("notes.txt"), b"x").unwrap();
        let mut library = Library::open_in_memory().unwrap();

        let report = library.rescan(dir.path()).unwrap();

        assert_eq!(report.added, 3);
        let shots = library.list(0, MAX_PAGE).unwrap().shots;
        let kind = |path: &Path| {
            let path = fs::canonicalize(path).unwrap();
            shots.iter().find(|shot| shot.path == path).unwrap().clone()
        };
        let gif = kind(&gif);
        assert_eq!(gif.kind, ShotKind::Gif);
        assert_eq!((gif.width, gif.height), (64, 32));
        assert!(gif.bytes.unwrap() > 0);
        let mp4 = kind(&mp4);
        assert_eq!(mp4.kind, ShotKind::Video);
        assert_eq!(mp4.bytes, Some(18));
        // Without ffmpeg an MP4's length and size are not known yet.
        assert_eq!((mp4.duration_ms, mp4.width), (None, 0));
        let thumbs = fs::canonicalize(dir.path().join(RECORDINGS_DIR))
            .unwrap()
            .join(THUMBS_DIR);
        assert_eq!(
            mp4.thumb_path,
            thumbs.join("Grab-it 2026-03-07 09-05-03.png")
        );

        // Only the capture waits for OCR and to be described, even when
        // every shot is queued again.
        assert_eq!(library.pending_ocr_count().unwrap(), 1);
        library.requeue_all_ai().unwrap();
        assert_eq!(library.ai_counts().unwrap().total, 1);
        assert!(library.requeue_ai(mp4.id).is_err());
        let job = library.next_for_ocr().unwrap().unwrap();
        assert_eq!(library.get(job.id).unwrap().kind, ShotKind::Image);
        assert_eq!(
            library.text(mp4.id).unwrap(),
            ShotText::Read {
                text: String::new()
            }
        );

        assert!(!library.rescan(dir.path()).unwrap().changed());
    }

    #[test]
    fn a_recording_keeps_the_length_the_recorder_gave() {
        let dir = TempDir::new().unwrap();
        let mp4 = record_mp4(dir.path(), "a.mp4");
        let mut library = Library::open_in_memory().unwrap();

        let shot = library
            .insert(&prepare_recording(&mp4, Some(46_120), None).unwrap())
            .unwrap();
        assert_eq!(shot.duration_ms, Some(46_120));

        // A rescan without the recorder's length keeps it.
        let again = library
            .insert(&prepare_recording(&mp4, None, None).unwrap())
            .unwrap();
        assert_eq!((again.id, again.duration_ms), (shot.id, Some(46_120)));
        assert!(prepare_recording(&dir.path().join("x.png"), None, None).is_err());
    }

    #[test]
    fn a_gif_recording_previews_its_first_frame_and_an_mp4_needs_ffmpeg() {
        let dir = TempDir::new().unwrap();
        record_gif(dir.path(), "a.gif");
        record_mp4(dir.path(), "b.mp4");
        let mut library = Library::open_in_memory().unwrap();
        library.rescan(dir.path()).unwrap();
        let shots = library.list(0, MAX_PAGE).unwrap().shots;
        let gif = shots
            .iter()
            .find(|shot| shot.kind == ShotKind::Gif)
            .unwrap();
        let mp4 = shots
            .iter()
            .find(|shot| shot.kind == ShotKind::Video)
            .unwrap();

        let png = library.thumbnail(gif.id).unwrap();
        let thumb = image::load_from_memory(&png).unwrap().into_rgba8();
        assert_eq!(thumb.dimensions(), (64, 32));
        assert_eq!(thumb.get_pixel(0, 0)[0], 40);

        assert!(matches!(
            library.thumbnail(mp4.id),
            Err(LibraryError::NoPreview)
        ));
    }

    #[test]
    fn deleting_a_recording_removes_its_sidecars_and_thumbnail() {
        let dir = TempDir::new().unwrap();
        let mp4 = record_mp4(dir.path(), "a.mp4");
        let mut library = Library::open_in_memory().unwrap();
        library.rescan(dir.path()).unwrap();
        let shot = library.list(0, MAX_PAGE).unwrap().shots.remove(0);
        fs::create_dir_all(shot.thumb_path.parent().unwrap()).unwrap();
        fs::write(&shot.thumb_path, b"png").unwrap();

        library.delete(shot.id).unwrap();

        assert!(!mp4.exists());
        assert!(!crate::record::cursor_path(&mp4).exists());
        assert!(!crate::recording_editor::edits_path(&mp4).exists());
        assert!(!crate::record::sound_path(&mp4).exists());
        assert!(!shot.thumb_path.exists());
        assert_eq!(library.count().unwrap(), 0);
    }

    #[test]
    fn a_library_read_before_word_boxes_keeps_its_text_without_them() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join(LIBRARY_FILE);
        let png = shoot(dir.path(), 1, (40, 20));
        {
            let mut conn = Connection::open(&db).unwrap();
            for (index, sql) in MIGRATIONS.iter().take(5).enumerate() {
                let tx = conn.transaction().unwrap();
                tx.execute_batch(sql).unwrap();
                tx.pragma_update(None, "user_version", index as i64 + 1)
                    .unwrap();
                tx.commit().unwrap();
            }
            conn.execute(
                "INSERT INTO shots (path, thumb_path, captured_at, ocr_text, ocr_state)
                 VALUES (?1, '', 0, 'Read long ago', 1)",
                [path_text(&fs::canonicalize(&png).unwrap())],
            )
            .unwrap();
        }
        let mut library = Library::open(&db).unwrap();
        assert_eq!(library.schema_version().unwrap(), 6);
        let id = library.list(0, MAX_PAGE).unwrap().shots[0].id;
        assert_eq!(
            library.text(id).unwrap(),
            ShotText::Read {
                text: "Read long ago".into()
            }
        );
        // Not read again, and without boxes.
        assert!(library.next_for_ocr().unwrap().is_none());
        assert_eq!(library.lines(id).unwrap(), None);

        let lines = vec![crate::ocr::tests::line("Read again")];
        library.set_ocr_lines(id, &lines).unwrap();
        assert_eq!(library.lines(id).unwrap(), Some(lines));
    }

    #[test]
    fn ocr_lines_are_stored_with_their_text() {
        use crate::capture::Rect;
        use crate::ocr::{OcrLine, OcrWord};
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let shot = library
            .add_capture(&shoot(dir.path(), 1, (200, 60)))
            .unwrap();
        // Unread: no boxes yet.
        assert_eq!(library.lines(shot.id).unwrap(), None);

        let word = |text: &str, x| OcrWord {
            text: text.into(),
            rect: Rect {
                x,
                y: 10,
                width: 40,
                height: 12,
            },
        };
        let lines = vec![
            OcrLine {
                text: "Invoice 42".into(),
                rect: Rect {
                    x: 5,
                    y: 10,
                    width: 90,
                    height: 12,
                },
                words: vec![word("Invoice", 5), word("42", 55)],
            },
            crate::ocr::tests::line("Due today"),
        ];
        library.set_ocr_lines(shot.id, &lines).unwrap();
        assert_eq!(
            library.text(shot.id).unwrap(),
            ShotText::Read {
                text: "Invoice 42\nDue today".into()
            }
        );
        assert_eq!(library.lines(shot.id).unwrap(), Some(lines));
        assert!(library.next_for_ocr().unwrap().is_none());

        assert!(matches!(
            library.set_ocr_lines(999, &[]),
            Err(LibraryError::NotFound(999))
        ));
        assert!(matches!(
            library.lines(999),
            Err(LibraryError::NotFound(999))
        ));
    }

    #[test]
    fn shots_without_stored_lines_have_none() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let text_only = library
            .add_capture(&shoot(dir.path(), 1, (10, 10)))
            .unwrap();
        let failed = library
            .add_capture(&shoot(dir.path(), 2, (10, 10)))
            .unwrap();
        let gif = record_gif(dir.path(), "Grab-it 2026-03-07 09-05-02.gif");
        let recording = library
            .insert(&prepare_recording(&gif, Some(200), None).unwrap())
            .unwrap();

        library.set_ocr_text(text_only.id, "Typed in").unwrap();
        library.mark_ocr_failed(failed.id).unwrap();
        for id in [text_only.id, failed.id, recording.id] {
            assert_eq!(library.lines(id).unwrap(), None, "shot {id}");
        }
    }

    #[test]
    fn an_older_library_keeps_its_captures_as_images() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join(LIBRARY_FILE);
        let png = shoot(dir.path(), 1, (40, 20));
        {
            let mut conn = Connection::open(&db).unwrap();
            for (index, sql) in MIGRATIONS.iter().take(3).enumerate() {
                let tx = conn.transaction().unwrap();
                tx.execute_batch(sql).unwrap();
                tx.pragma_update(None, "user_version", index as i64 + 1)
                    .unwrap();
                tx.commit().unwrap();
            }
            conn.execute(
                "INSERT INTO shots (path, thumb_path, captured_at) VALUES (?1, '', 0)",
                [path_text(&fs::canonicalize(&png).unwrap())],
            )
            .unwrap();
        }
        let library = Library::open(&db).unwrap();
        let shot = library.list(0, MAX_PAGE).unwrap().shots.remove(0);
        assert_eq!(shot.kind, ShotKind::Image);
        assert_eq!((shot.duration_ms, shot.bytes), (None, None));
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
    fn a_shots_id_is_found_from_its_path_and_unknown_paths_have_none() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (10, 10));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        assert_eq!(library.id_for_path(&png).unwrap(), Some(shot.id));
        // The same file through a different spelling of its path.
        let indirect = png
            .parent()
            .unwrap()
            .join("..")
            .join(ORIGINALS_DIR)
            .join(png.file_name().unwrap());
        assert_eq!(library.id_for_path(&indirect).unwrap(), Some(shot.id));

        let unknown = shoot(dir.path(), 2, (10, 10));
        assert_eq!(library.id_for_path(&unknown).unwrap(), None);
        assert_eq!(
            library
                .id_for_path(&dir.path().join("missing.png"))
                .unwrap(),
            None
        );
    }

    #[test]
    fn a_shots_text_waits_for_ocr_then_is_read_or_failed() {
        let dir = TempDir::new().unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let first = library
            .add_capture(&shoot(dir.path(), 1, (10, 10)))
            .unwrap();
        let second = library
            .add_capture(&shoot(dir.path(), 2, (10, 10)))
            .unwrap();
        assert_eq!(library.text(first.id).unwrap(), ShotText::Waiting);

        library.set_ocr_text(first.id, "Invoice 2026-03").unwrap();
        assert_eq!(
            library.text(first.id).unwrap(),
            ShotText::Read {
                text: "Invoice 2026-03".into()
            }
        );
        library.mark_ocr_failed(second.id).unwrap();
        assert_eq!(library.text(second.id).unwrap(), ShotText::Failed);
        assert!(matches!(
            library.text(999),
            Err(LibraryError::NotFound(999))
        ));

        assert_eq!(
            serde_json::to_value(library.text(first.id).unwrap()).unwrap(),
            serde_json::json!({ "state": "read", "text": "Invoice 2026-03" })
        );
        assert_eq!(
            serde_json::to_value(ShotText::Waiting).unwrap(),
            serde_json::json!({ "state": "waiting" })
        );
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
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        fs::write(
            capture::annotations_path(&png),
            r#"{"version":1,"shapes":[]}"#,
        )
        .unwrap();
        library.set_tags(shot.id, &["x".into()]).unwrap();
        let assets = capture::assets_dir(&png);
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("added.png"), b"png").unwrap();

        library.delete(shot.id).unwrap();

        assert!(!png.exists());
        assert!(!assets.exists());
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
                removed: 0,
                refreshed: 0,
            }
        );

        fs::remove_file(&gone).unwrap();
        let fresh = shoot(dir.path(), 3, (4, 4));
        let report = library.rescan(dir.path()).unwrap();
        assert_eq!(
            report,
            RescanReport {
                added: 1,
                removed: 1,
                refreshed: 0,
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
    fn a_capture_records_its_pngs_size() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (40, 20));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        assert_eq!(shot.bytes, Some(fs::metadata(&png).unwrap().len()));
        assert!(shot.bytes.unwrap() > 0);
    }

    #[test]
    fn rescan_fills_in_the_size_of_captures_stored_without_one() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (40, 20));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        library.set_tags(shot.id, &["keep".into()]).unwrap();
        // As a capture stored before sizes were recorded.
        library
            .conn
            .execute("UPDATE shots SET bytes = NULL WHERE id = ?1", [shot.id])
            .unwrap();
        assert_eq!(library.get(shot.id).unwrap().bytes, None);

        assert_eq!(
            library.rescan(dir.path()).unwrap(),
            RescanReport {
                added: 0,
                removed: 0,
                refreshed: 1,
            }
        );
        let refreshed = library.get(shot.id).unwrap();
        assert_eq!(refreshed.bytes, Some(fs::metadata(&png).unwrap().len()));
        assert_eq!(refreshed.tags, vec!["keep"]);
        // Known now: the next scan has nothing to do.
        assert!(!library.rescan(dir.path()).unwrap().changed());
    }

    #[test]
    fn rescan_fills_in_a_recordings_missing_size_without_ffmpeg() {
        let dir = TempDir::new().unwrap();
        let gif = record_gif(dir.path(), "Grab-it 1.gif");
        let mut library = Library::open_in_memory().unwrap();
        library.rescan(dir.path()).unwrap();
        library
            .conn
            .execute("UPDATE shots SET bytes = NULL", [])
            .unwrap();

        assert_eq!(library.rescan(dir.path()).unwrap().refreshed, 1);
        let shot = library.list(0, 1).unwrap().shots.remove(0);
        assert_eq!(shot.bytes, Some(fs::metadata(&gif).unwrap().len()));
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
                removed: 1,
                refreshed: 0,
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
        let scan = scan_files(&known, dir.path(), None).unwrap();
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
        let scan = scan_files(&library.known().unwrap(), dir.path(), None).unwrap();
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
        let scan = scan_files(&[], dir.path(), None).unwrap();
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
            state.rescan(dir.path(), None).unwrap(),
            RescanReport {
                added: 1,
                removed: 0,
                refreshed: 0,
            }
        );
        let fresh = state.add_capture(&shoot(dir.path(), 2, (4, 4))).unwrap();
        assert_eq!(
            state.rescan(dir.path(), None).unwrap(),
            RescanReport::default()
        );
        assert_eq!(state.lock().count().unwrap(), 2);

        fs::remove_file(&fresh.thumb_path).unwrap();
        assert!(!state.thumbnail(fresh.id, None).unwrap().is_empty());
        assert!(fresh.thumb_path.is_file());
    }

    /// Sets `path`'s modified time to `seconds` after the Unix epoch.
    fn touch(path: &Path, seconds: u64) {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(seconds))
            .unwrap();
    }

    fn png_bytes(size: (u32, u32)) -> Vec<u8> {
        let image = RgbaImage::from_pixel(size.0, size.1, Rgba([200, 0, 0, 255]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    #[test]
    fn an_unedited_capture_has_no_edits_and_a_fresh_thumbnail() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();

        let shot = library.add_capture(&png).unwrap();

        assert_eq!(shot.edited_at, None);
        assert!(!shot.thumb_stale);
        assert!(shot.thumb_path.is_file());
    }

    #[test]
    fn an_edited_capture_gets_no_thumbnail_from_its_original() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        fs::write(
            capture::annotations_path(&png),
            r#"{"version":1,"shapes":[]}"#,
        )
        .unwrap();
        touch(&capture::annotations_path(&png), 5_000);
        let mut library = Library::open_in_memory().unwrap();

        let shot = library.add_capture(&png).unwrap();

        assert_eq!(shot.edited_at, Some(5_000_000));
        assert!(shot.thumb_stale);
        assert!(!shot.thumb_path.exists());
        assert!(matches!(
            library.thumbnail(shot.id),
            Err(LibraryError::NoThumbnail)
        ));
        library.rescan(dir.path()).unwrap();
        assert!(
            !shot.thumb_path.exists(),
            "a rescan leaves it to the Library"
        );
    }

    #[test]
    fn a_thumbnail_older_than_the_edits_is_stale_until_it_is_saved_again() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        let original = fs::read(&shot.thumb_path).unwrap();
        fs::write(
            capture::annotations_path(&png),
            r#"{"version":1,"shapes":[]}"#,
        )
        .unwrap();
        touch(&shot.thumb_path, 1_000);
        touch(&capture::annotations_path(&png), 2_000);

        let edited = library.get(shot.id).unwrap();
        assert_eq!(edited.edited_at, Some(2_000_000));
        assert!(edited.thumb_stale);
        // The old thumbnail is still served while the new one is drawn.
        assert_eq!(library.thumbnail(shot.id).unwrap(), original);

        save_thumbnail(&png, &png_bytes((800, 400)), &edited.thumb_path, 2_000_000).unwrap();

        let saved = library.get(shot.id).unwrap();
        assert!(!saved.thumb_stale);
        assert_eq!(
            image::image_dimensions(&saved.thumb_path).unwrap(),
            (THUMB_SIZE, 200)
        );
        let leftovers: Vec<_> = fs::read_dir(saved.thumb_path.parent().unwrap())
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "tmp")
            })
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn a_thumbnail_drawn_from_edits_saved_again_since_is_not_kept() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        let sidecar = capture::annotations_path(&png);
        fs::write(&sidecar, r#"{"version":1,"shapes":[]}"#).unwrap();
        touch(&shot.thumb_path, 1_000);
        touch(&sidecar, 2_000);
        let read = shot_annotations(&png).unwrap();
        assert_eq!(read.edited_at, Some(2_000_000));
        // Saved again while the first edits were being drawn.
        touch(&sidecar, 3_000);
        let before = fs::read(&shot.thumb_path).unwrap();

        assert!(matches!(
            save_thumbnail(&png, &png_bytes((8, 8)), &shot.thumb_path, 2_000_000),
            Err(LibraryError::OutOfDate)
        ));
        assert_eq!(fs::read(&shot.thumb_path).unwrap(), before);
        assert!(library.get(shot.id).unwrap().thumb_stale);
    }

    #[test]
    fn a_saved_thumbnail_is_stamped_with_the_edits_it_was_drawn_from() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        let sidecar = capture::annotations_path(&png);
        fs::write(&sidecar, r#"{"version":1,"shapes":[]}"#).unwrap();
        touch(&sidecar, 2_000);

        save_thumbnail(&png, &png_bytes((8, 8)), &shot.thumb_path, 2_000_000).unwrap();
        assert!(!library.get(shot.id).unwrap().thumb_stale);
        // Edits saved after the check but before the write still leave it stale.
        touch(&sidecar, 2_500);
        assert!(library.get(shot.id).unwrap().thumb_stale);
    }

    #[test]
    fn a_saved_thumbnail_must_be_a_png() {
        let dir = TempDir::new().unwrap();
        let thumb = dir.path().join("thumbs").join("shot.png");
        assert!(save_thumbnail(&dir.path().join("shot.png"), b"not a png", &thumb, 0).is_err());
        assert!(!thumb.exists());
    }

    #[test]
    fn a_shots_annotations_come_with_its_scale_and_a_corrupt_sidecar_is_an_error() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        assert_eq!(shot_annotations(&png).unwrap().annotations, None);
        let doc = serde_json::json!({"version": 1, "shapes": []});
        fs::write(capture::annotations_path(&png), doc.to_string()).unwrap();

        let read = shot_annotations(&png).unwrap();
        assert_eq!(read.annotations, Some(doc));
        assert_eq!(
            read.scale_factor,
            capture::valid_scale(read_meta(&png).and_then(|meta| meta.scale_factor))
        );

        fs::write(capture::annotations_path(&png), "{not json").unwrap();
        assert!(shot_annotations(&png).is_err());
    }

    #[test]
    fn recordings_have_no_edits() {
        let dir = TempDir::new().unwrap();
        let gif = record_gif(dir.path(), "clip.gif");
        fs::write(capture::annotations_path(&gif), "{}").unwrap();
        assert_eq!(
            edit_state(ShotKind::Gif, &gif, &thumb_path(&gif)),
            (None, false)
        );
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

    #[test]
    fn rename_moves_the_file_sidecars_and_thumbnail_and_keeps_the_row() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        fs::write(
            capture::annotations_path(&png),
            r#"{"version":1,"shapes":[]}"#,
        )
        .unwrap();
        library.set_tags(shot.id, &["bug".into()]).unwrap();
        library.set_notes(shot.id, "login page").unwrap();
        let assets = capture::assets_dir(&png);
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("added.png"), b"added").unwrap();

        let renamed = library.rename(shot.id, "  Login bug  ").unwrap();

        assert!(!assets.exists());
        assert_eq!(
            fs::read(capture::assets_dir(&renamed.path).join("added.png")).unwrap(),
            b"added"
        );

        assert_eq!(renamed.id, shot.id);
        assert_eq!(renamed.file_name, "Login bug.png");
        assert_eq!(renamed.path, shot.path.with_file_name("Login bug.png"));
        assert_eq!(renamed.thumb_path, thumb_path(&renamed.path));
        assert_eq!(renamed.tags, vec!["bug".to_string()]);
        assert_eq!(renamed.notes, "login page");
        assert!(renamed.path.is_file());
        assert!(capture::meta_path(&renamed.path).is_file());
        assert!(capture::annotations_path(&renamed.path).is_file());
        assert!(renamed.thumb_path.is_file());
        assert!(!png.exists());
        assert!(!capture::meta_path(&png).exists());
        assert!(!capture::annotations_path(&png).exists());
        assert!(!shot.thumb_path.exists());
        assert_eq!(library.count().unwrap(), 1);
        assert_eq!(library.id_for_path(&renamed.path).unwrap(), Some(shot.id));
    }

    #[test]
    fn rename_keeps_the_extension_whether_or_not_it_is_typed() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();

        assert_eq!(
            library.rename(shot.id, "First.PNG").unwrap().file_name,
            "First.png"
        );
        assert_eq!(
            library.rename(shot.id, "notes.v2").unwrap().file_name,
            "notes.v2.png"
        );
        // The same name changes nothing.
        assert_eq!(
            library.rename(shot.id, "notes.v2").unwrap().file_name,
            "notes.v2.png"
        );
    }

    #[test]
    fn rename_moves_a_recordings_sidecars() {
        let dir = TempDir::new().unwrap();
        let mp4 = record_mp4(dir.path(), "a.mp4");
        let mut library = Library::open_in_memory().unwrap();
        library.rescan(dir.path()).unwrap();
        let shot = library.list(0, MAX_PAGE).unwrap().shots.remove(0);

        let renamed = library.rename(shot.id, "Demo").unwrap();

        assert_eq!(renamed.file_name, "Demo.mp4");
        assert_eq!(renamed.kind, ShotKind::Video);
        assert!(crate::record::cursor_path(&renamed.path).is_file());
        assert!(crate::recording_editor::edits_path(&renamed.path).is_file());
        assert!(crate::record::sound_path(&renamed.path).is_file());
        assert!(!mp4.exists());
        assert!(!crate::record::cursor_path(&mp4).exists());
        assert!(!crate::record::sound_path(&mp4).exists());
    }

    #[test]
    fn rename_refuses_taken_and_invalid_names_and_touches_nothing() {
        let dir = TempDir::new().unwrap();
        let first = shoot(dir.path(), 1, (4, 4));
        let second = shoot(dir.path(), 2, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&first).unwrap();
        let other = library.add_capture(&second).unwrap();
        let other_stem = second.file_stem().unwrap().to_string_lossy().into_owned();
        // A sidecar left without its image still holds the name.
        fs::write(first.with_file_name("Orphan.annotations.json"), "{}").unwrap();

        assert!(matches!(
            library.rename(shot.id, &other_stem),
            Err(LibraryError::NameTaken(_))
        ));
        assert!(matches!(
            library.rename(shot.id, "Orphan"),
            Err(LibraryError::NameTaken(_))
        ));
        for bad in [
            "",
            "   ",
            ".hidden",
            "trailing.",
            "a/b",
            "a\\b",
            "what?",
            "CON",
            "lpt1",
            "tab\there",
        ] {
            assert!(
                matches!(library.rename(shot.id, bad), Err(LibraryError::BadName(_))),
                "{bad:?} is refused"
            );
        }
        assert!(matches!(
            library.rename(shot.id, &"x".repeat(MAX_NAME_CHARS + 1)),
            Err(LibraryError::BadName(_))
        ));
        assert!(matches!(
            library.rename(999, "Fine"),
            Err(LibraryError::NotFound(999))
        ));

        assert!(first.is_file());
        assert!(second.is_file());
        assert_eq!(library.get(shot.id).unwrap().path, shot.path);
        assert_eq!(library.get(other.id).unwrap().path, other.path);
        // Names that only look like reserved ones are fine.
        assert_eq!(
            library.rename(shot.id, "Console").unwrap().file_name,
            "Console.png"
        );
    }

    #[test]
    fn rename_refuses_a_name_whose_assets_folder_exists() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        let stray = capture::assets_dir(&png.with_file_name("Login bug.png"));
        fs::create_dir_all(&stray).unwrap();

        assert!(matches!(
            library.rename(shot.id, "Login bug"),
            Err(LibraryError::NameTaken(_))
        ));
        assert!(png.is_file());
    }

    #[test]
    fn rename_refuses_a_name_too_long_for_a_sidecar_and_touches_nothing() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        fs::write(capture::annotations_path(&png), "{}").unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        // 80 characters of 3 bytes: "<name>.png" fits in 255 bytes, but
        // "<name>.annotations.json" does not.
        let name = "\u{8a9e}".repeat(80);
        assert!(format!("{name}.png").len() <= MAX_NAME_BYTES);

        assert!(matches!(
            library.rename(shot.id, &name),
            Err(LibraryError::BadName(_))
        ));
        assert!(png.is_file());
        assert!(capture::meta_path(&png).is_file());
        assert!(capture::annotations_path(&png).is_file());
        assert_eq!(library.get(shot.id).unwrap().path, shot.path);
        // A shorter multibyte name is fine, sidecars and all.
        let renamed = library.rename(shot.id, &"\u{8a9e}".repeat(20)).unwrap();
        assert!(capture::annotations_path(&renamed.path).is_file());
    }

    #[test]
    fn rename_refuses_a_name_another_row_holds_even_when_its_file_is_gone() {
        let dir = TempDir::new().unwrap();
        let first = shoot(dir.path(), 1, (4, 4));
        let second = shoot(dir.path(), 2, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&first).unwrap();
        let other = library.add_capture(&second).unwrap();
        fs::remove_file(&other.path).unwrap();
        fs::remove_file(capture::meta_path(&other.path)).unwrap();

        let stem = other
            .path
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(matches!(
            library.rename(shot.id, &stem),
            Err(LibraryError::NameTaken(_))
        ));
        assert!(first.is_file());
    }

    #[test]
    fn duplicate_copies_the_file_sidecars_tags_and_notes_to_a_free_name() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        fs::write(
            capture::annotations_path(&png),
            r#"{"version":1,"shapes":[]}"#,
        )
        .unwrap();
        library.set_tags(shot.id, &["bug".into()]).unwrap();
        library.set_notes(shot.id, "login page").unwrap();
        library.set_keep(shot.id, true).unwrap();
        let assets = capture::assets_dir(&png);
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("added.png"), b"added").unwrap();
        let state = LibraryState::new(library);
        let stem = png.file_stem().unwrap().to_string_lossy().into_owned();

        let copy = state.duplicate(shot.id).unwrap();
        assert_eq!(
            fs::read(capture::assets_dir(&copy.path).join("added.png")).unwrap(),
            b"added"
        );
        assert!(
            assets.join("added.png").is_file(),
            "the original keeps its images"
        );
        let again = state.duplicate(shot.id).unwrap();

        assert_ne!(copy.id, shot.id);
        assert_eq!(copy.file_name, format!("{stem} copy.png"));
        assert_eq!(again.file_name, format!("{stem} copy 2.png"));
        assert_eq!(copy.kind, ShotKind::Image);
        assert_eq!(copy.captured_at, shot.captured_at);
        assert_eq!((copy.width, copy.height), (shot.width, shot.height));
        assert_eq!(copy.app, shot.app);
        assert_eq!(copy.tags, vec!["bug".to_string()]);
        assert_eq!(copy.notes, "login page");
        assert!(!copy.keep, "Keep forever is not copied");
        assert_eq!(fs::read(&copy.path).unwrap(), fs::read(&png).unwrap());
        assert!(capture::meta_path(&copy.path).is_file());
        assert!(capture::annotations_path(&copy.path).is_file());
        assert!(copy.thumb_path.is_file());
        assert!(png.is_file(), "the original stays");
        assert_eq!(state.lock().count().unwrap(), 3);
    }

    #[test]
    fn duplicate_copies_a_recording_with_its_length_and_sidecars() {
        let dir = TempDir::new().unwrap();
        record_mp4(dir.path(), "a.mp4");
        let mut library = Library::open_in_memory().unwrap();
        library.rescan(dir.path()).unwrap();
        let shot = library.list(0, MAX_PAGE).unwrap().shots.remove(0);
        let state = LibraryState::new(library);

        let copy = state.duplicate(shot.id).unwrap();

        assert_eq!(copy.file_name, "a copy.mp4");
        assert_eq!(copy.kind, ShotKind::Video);
        assert_eq!(copy.bytes, shot.bytes);
        assert!(crate::record::cursor_path(&copy.path).is_file());
        assert!(crate::recording_editor::edits_path(&copy.path).is_file());
        assert!(crate::record::sound_path(&copy.path).is_file());
    }

    #[test]
    fn duplicate_skips_names_a_file_already_has() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        let stem = png.file_stem().unwrap().to_string_lossy().into_owned();
        fs::write(
            png.with_file_name(format!("{stem} copy.png")),
            b"someone else's",
        )
        .unwrap();
        let state = LibraryState::new(library);

        let copy = state.duplicate(shot.id).unwrap();

        assert_eq!(copy.file_name, format!("{stem} copy 2.png"));
        assert_eq!(
            fs::read(png.with_file_name(format!("{stem} copy.png"))).unwrap(),
            b"someone else's"
        );
    }

    #[test]
    fn trash_moves_the_file_and_sidecars_deletes_the_thumbnail_and_drops_the_row() {
        let dir = TempDir::new().unwrap();
        // The library stores canonical paths: on macOS the temporary folder
        // is under /var, a link to /private/var.
        let folder = dir.path().canonicalize().unwrap();
        let png = shoot(&folder, 1, (4, 4));
        fs::write(capture::annotations_path(&png), "{}").unwrap();
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        let state = LibraryState::new(library);
        let calls = Mutex::new(Vec::new());
        let remove = |files: &[PathBuf], removal: crate::settings::Removal| -> io::Result<()> {
            calls.lock().unwrap().push((files.to_vec(), removal));
            Ok(())
        };

        state.trash(shot.id, &remove).unwrap();

        let calls = calls.into_inner().unwrap();
        assert_eq!(calls.len(), 1);
        let (files, removal) = &calls[0];
        assert_eq!(removal, &crate::settings::Removal::Trash);
        assert_eq!(files[0], png, "the main file goes first");
        assert!(files.contains(&capture::meta_path(&png)));
        assert!(files.contains(&capture::annotations_path(&png)));
        assert!(
            !files.contains(&shot.thumb_path),
            "the thumbnail is not put in the Trash"
        );
        assert!(!shot.thumb_path.exists(), "the thumbnail is deleted");
        assert_eq!(state.lock().count().unwrap(), 0);
    }

    #[test]
    fn trash_that_fails_keeps_the_row_and_thumbnail() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        let state = LibraryState::new(library);
        let remove = |_: &[PathBuf], _: crate::settings::Removal| -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "no Trash here",
            ))
        };

        assert!(state.trash(shot.id, &remove).is_err());

        assert!(shot.thumb_path.is_file());
        assert_eq!(state.lock().get(shot.id).unwrap().path, shot.path);
        assert!(matches!(
            state.trash(999, &remove),
            Err(LibraryError::NotFound(999))
        ));
    }

    #[test]
    fn export_writes_a_screenshot_as_png_jpg_or_webp_by_extension() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (6, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        let out = dir.path().join("out");
        fs::create_dir_all(&out).unwrap();

        let as_png = export_shot(&shot, &out.join("a.png")).unwrap();
        assert_eq!(as_png, out.join("a.png"));
        assert_eq!(
            fs::read(&as_png).unwrap(),
            fs::read(&png).unwrap(),
            "the original's bytes"
        );

        for (name, format) in [
            ("b.jpg", image::ImageFormat::Jpeg),
            ("c.JPEG", image::ImageFormat::Jpeg),
            ("d.webp", image::ImageFormat::WebP),
        ] {
            let written = export_shot(&shot, &out.join(name)).unwrap();
            let bytes = fs::read(&written).unwrap();
            assert_eq!(image::guess_format(&bytes).unwrap(), format, "{name}");
            let decoded = image::load_from_memory(&bytes).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (6, 4), "{name}");
        }
        let webp = image::open(out.join("d.webp")).unwrap().to_rgba8();
        assert_eq!(
            webp.get_pixel(0, 0),
            &Rgba([10, 20, 30, 255]),
            "WebP is lossless"
        );
        // Nothing is left beside the exports.
        let mut names: Vec<String> = fs::read_dir(&out)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["a.png", "b.jpg", "c.JPEG", "d.webp"]);
    }

    #[test]
    fn export_replaces_another_file_but_refuses_other_formats() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        let target = dir.path().join("there.png");
        fs::write(&target, b"old").unwrap();

        export_shot(&shot, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), fs::read(&png).unwrap());

        let gif = dir.path().join("x.gif");
        assert!(export_shot(&shot, &gif).is_err());
        assert!(export_shot(&shot, &dir.path().join("no-extension")).is_err());
        assert!(!gif.exists());
    }

    #[test]
    fn export_to_a_folder_takes_the_shots_name_or_the_next_free_one() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        let out = dir.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let stem = png.file_stem().unwrap().to_string_lossy().into_owned();

        let first = export_shot(&shot, &out).unwrap();
        let second = export_shot(&shot, &out).unwrap();
        let third = export_shot(&shot, &out).unwrap();

        assert_eq!(first, out.join(format!("{stem}.png")));
        assert_eq!(second, out.join(format!("{stem} 2.png")));
        assert_eq!(third, out.join(format!("{stem} 3.png")));
        assert_eq!(fs::read(&first).unwrap(), fs::read(&png).unwrap());
        assert_eq!(fs::read(&second).unwrap(), fs::read(&png).unwrap());
    }

    #[test]
    fn export_copies_a_recording_and_keeps_its_extension() {
        let dir = TempDir::new().unwrap();
        let mp4 = record_mp4(dir.path(), "a.mp4");
        let mut library = Library::open_in_memory().unwrap();
        library.rescan(dir.path()).unwrap();
        let shot = library.list(0, MAX_PAGE).unwrap().shots.remove(0);
        let out = dir.path().join("out");
        fs::create_dir_all(&out).unwrap();

        let copy = export_shot(&shot, &out.join("Demo.mp4")).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), fs::read(&mp4).unwrap());
        let into_folder = export_shot(&shot, &out).unwrap();
        assert_eq!(into_folder, out.join("a.mp4"));

        assert!(export_shot(&shot, &out.join("Demo.png")).is_err());
        assert!(!out.join("Demo.png").exists());
    }

    #[test]
    fn export_never_overwrites_the_shot_or_its_sidecars() {
        let dir = TempDir::new().unwrap();
        let png = shoot(dir.path(), 1, (4, 4));
        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        fs::write(capture::annotations_path(&png), "{}").unwrap();
        let original = fs::read(&png).unwrap();
        let thumbnail = fs::read(&shot.thumb_path).unwrap();

        assert!(export_shot(&shot, &png).is_err());
        // Another spelling of the same file.
        let spelled = png
            .parent()
            .unwrap()
            .join("..")
            .join(ORIGINALS_DIR)
            .join(png.file_name().unwrap());
        assert!(export_shot(&shot, &spelled).is_err());
        assert!(export_shot(&shot, &capture::meta_path(&png)).is_err());
        assert!(export_shot(&shot, &capture::annotations_path(&png)).is_err());
        assert!(export_shot(&shot, &shot.thumb_path).is_err());

        let mp4 = record_mp4(dir.path(), "b.mp4");
        library.rescan(dir.path()).unwrap();
        let recording = library
            .get(library.id_for_path(&mp4).unwrap().unwrap())
            .unwrap();
        assert!(export_shot(&recording, &crate::record::cursor_path(&mp4)).is_err());
        assert!(export_shot(&recording, &crate::recording_editor::edits_path(&mp4)).is_err());

        assert_eq!(fs::read(&png).unwrap(), original);
        assert_eq!(fs::read(&shot.thumb_path).unwrap(), thumbnail);
        assert_eq!(
            fs::read_to_string(capture::annotations_path(&png)).unwrap(),
            "{}"
        );
    }
}
