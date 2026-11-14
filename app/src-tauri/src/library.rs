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
    /// One or two sentences from the vision model, once described.
    pub ai_description: Option<String>,
    /// One of `ai::CATEGORIES`, once described.
    pub ai_category: Option<String>,
    /// Tags the vision model gave; the user's own are in `tags`.
    pub ai_tags: Vec<String>,
}

/// The columns [`shot_from_row`] reads, in order, from `shots` as `s`.
pub(crate) const SHOT_COLUMNS: &str = "s.id, s.path, s.thumb_path, s.captured_at, s.mode, s.app, \
     s.window_title, s.width, s.height, s.notes, s.ai_description, s.ai_category";
/// How many columns [`SHOT_COLUMNS`] holds.
pub(crate) const SHOT_COLUMN_COUNT: usize = 12;

/// The text in a shot, as far as OCR has got. Mirrors `ShotText` in
/// src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

    /// The newest shot still waiting for OCR, if any.
    pub fn next_for_ocr(&self) -> LibraryResult<Option<OcrJob>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, path FROM shots WHERE ocr_state = 0
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
            "SELECT COUNT(*) FROM shots WHERE ocr_state = 0",
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
                 FROM shots WHERE ai_state = 0 AND ocr_state <> 0
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

    /// How far the describing queue has got.
    pub fn ai_counts(&self) -> LibraryResult<AiCounts> {
        Ok(self.conn.query_row(
            "SELECT coalesce(sum(ai_state IN (1, 2)), 0), coalesce(sum(ai_state <> 3), 0)
             FROM shots",
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
        let changed = self
            .conn
            .execute("UPDATE shots SET ai_state = 0 WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(LibraryError::NotFound(id));
        }
        Ok(())
    }

    /// Queues every shot, skipped ones included, to be described again.
    pub fn requeue_all_ai(&mut self) -> LibraryResult<usize> {
        Ok(self
            .conn
            .execute("UPDATE shots SET ai_state = 0 WHERE ai_state <> 0", [])?)
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

pub(crate) fn shot_from_row(row: &Row<'_>) -> rusqlite::Result<Shot> {
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
        ai_description: row.get(10)?,
        ai_category: row.get(11)?,
        ai_tags: Vec::new(),
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
        // Captures found by the scan, or left over from an earlier run,
        // wait for OCR and to be described.
        crate::ocr::wake(&app);
        crate::ai::wake(&app);
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
            crate::ocr::wake(app);
            crate::ai::wake(app);
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
pub fn library_remove_ai_tag(
    id: i64,
    tag: String,
    state: State<'_, LibraryState>,
) -> Result<Shot, String> {
    state.lock().remove_ai_tag(id, &tag).map_err(to_message)
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

/// Copies a shot's original image to the clipboard.
#[tauri::command(async)]
pub fn library_copy(id: i64, app: AppHandle) -> Result<(), String> {
    crate::quick::copy_file(&app, &existing_path(&app, id)?)
}

/// The text in a shot, as far as OCR has got.
#[tauri::command(async)]
pub fn library_text(id: i64, state: State<'_, LibraryState>) -> Result<ShotText, String> {
    state.lock().text(id).map_err(to_message)
}

/// The library id of the capture at `path`, or None when the library does
/// not know it, so windows that only have a path can use the id commands.
#[tauri::command(async)]
pub fn library_shot_id(
    path: PathBuf,
    state: State<'_, LibraryState>,
) -> Result<Option<i64>, String> {
    state.lock().id_for_path(&path).map_err(to_message)
}

/// Copies the text in a shot and returns it. A shot OCR has not read yet,
/// or could not read, is read now, and what it finds is stored, so it is
/// searchable and can be described.
#[tauri::command(async)]
pub fn library_copy_text(id: i64, app: AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let library = app.state::<LibraryState>();
    let known = library.lock().text(id).map_err(to_message)?;
    let text = match known {
        ShotText::Read { text } => text,
        ShotText::Waiting | ShotText::Failed => {
            let path = existing_path(&app, id)?;
            let image = image::open(&path)
                .map_err(|err| format!("could not open {}: {err}", path.display()))?
                .into_rgba8();
            let text = crate::ocr::read_now(&app, &image)
                .map_err(|err| format!("could not read the text: {err}"))?;
            match library.lock().set_ocr_text(id, &text) {
                Ok(()) => {
                    let _ = app.emit(LIBRARY_CHANGED_EVENT, ());
                    crate::ai::wake(&app);
                }
                Err(err) => eprintln!("Grab-it: could not store the text of shot {id}: {err}"),
            }
            text
        }
    };
    if text.trim().is_empty() {
        return Err("No text found in this capture.".into());
    }
    app.clipboard()
        .write_text(text.clone())
        .map_err(|err| format!("could not copy the text: {err}"))?;
    Ok(text)
}

/// Floats a shot above other windows. Async for the same reason as
/// [`library_open`].
#[tauri::command]
pub async fn library_pin(id: i64, app: AppHandle) -> Result<(), String> {
    crate::pin::open(&app, &existing_path(&app, id)?, false)
}

/// Shows a shot's file in the system file manager.
#[tauri::command(async)]
pub fn library_reveal(id: i64, app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(existing_path(&app, id)?)
        .map_err(|err| format!("could not show the capture in its folder: {err}"))
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
