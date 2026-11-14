//! Searching the library: full-text search over OCR text, tags, notes,
//! app, window title and the AI description and tags (the `shots_fts`
//! index, see `library.rs`), with date, app, tag and category filters and
//! highlighted snippets.

use rusqlite::{params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::library::{
    Library, LibraryResult, LibraryState, MAX_PAGE, SHOT_COLUMN_COUNT, SHOT_COLUMNS, Shot,
    shot_from_row,
};

/// Marks the start and end of a match in snippets. Private-use characters,
/// so they never clash with real text.
const HIT_START: char = '\u{E000}';
const HIT_END: char = '\u{E001}';
/// Roughly how many words a snippet holds.
const SNIPPET_TOKENS: u32 = 12;

/// What to look for. Mirrors `SearchQuery` in src/library/api.ts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchQuery {
    /// Words to find; each matches as a prefix, and all must match.
    pub text: String,
    /// Captured at or after, in milliseconds since the Unix epoch.
    pub from: Option<i64>,
    /// Captured before, in milliseconds since the Unix epoch.
    pub to: Option<i64>,
    /// Captured from exactly this app.
    pub app: Option<String>,
    /// Has this tag (case-insensitive), from the user or the AI.
    pub tag: Option<String>,
    /// The AI put it in exactly this category (see `ai::CATEGORIES`).
    pub category: Option<String>,
}

/// The `shots_fts` columns, in index order. Mirrors `MatchField` in
/// src/library/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchField {
    /// Text OCR found in the image.
    Text,
    Tags,
    Notes,
    App,
    WindowTitle,
    /// The AI description.
    Description,
}

/// What each `shots_fts` column reports as. AI tags count as tags.
const FIELDS: [MatchField; 7] = [
    MatchField::Text,
    MatchField::Tags,
    MatchField::Notes,
    MatchField::App,
    MatchField::WindowTitle,
    MatchField::Description,
    MatchField::Tags,
];

/// A piece of a snippet; `hit` pieces matched the search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SnippetPart {
    pub text: String,
    pub hit: bool,
}

/// A shot that matched, with where and how. Mirrors `SearchHit` in
/// src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub shot: Shot,
    /// The first field the words were found in; `None` without words.
    pub field: Option<MatchField>,
    /// Text around the match in that field, empty without words.
    pub snippet: Vec<SnippetPart>,
}

/// One page of results. Mirrors `SearchPage` in src/library/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub hits: Vec<SearchHit>,
    pub offset: u32,
    /// Every shot that matches.
    pub total: u32,
}

/// The values the filter bar offers. Mirrors `FilterOptions` in
/// src/library/api.ts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterOptions {
    pub apps: Vec<String>,
    /// The user's tags.
    pub tags: Vec<String>,
    /// The AI categories some shot is in.
    pub categories: Vec<String>,
}

/// Turns typed words into an FTS5 query: every word must match, each as a
/// prefix, and FTS5 syntax is quoted away. `None` when there is nothing to
/// search for.
pub fn fts_query(text: &str) -> Option<String> {
    let terms: Vec<String> = text
        .split_whitespace()
        .map(|word| word.replace('"', ""))
        .filter(|word| word.chars().any(char::is_alphanumeric))
        .map(|word| format!("\"{word}\"*"))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

/// Splits a snippet from SQLite into plain and highlighted parts.
fn parse_snippet(raw: &str) -> Vec<SnippetPart> {
    let mut parts: Vec<SnippetPart> = Vec::new();
    let mut current = String::new();
    let mut hit = false;
    for ch in raw.chars() {
        if ch == HIT_START || ch == HIT_END {
            if !current.is_empty() {
                parts.push(SnippetPart {
                    text: std::mem::take(&mut current),
                    hit,
                });
            }
            hit = ch == HIT_START;
        } else {
            current.push(if ch == '\n' { ' ' } else { ch });
        }
    }
    if !current.is_empty() {
        parts.push(SnippetPart { text: current, hit });
    }
    parts
}

/// The WHERE clause and its parameters for the filters (not the words).
fn filter_clause(query: &SearchQuery, params: &mut Vec<Value>) -> String {
    let mut clauses = Vec::new();
    if let Some(from) = query.from {
        clauses.push("s.captured_at >= ?");
        params.push(Value::Integer(from));
    }
    if let Some(to) = query.to {
        clauses.push("s.captured_at < ?");
        params.push(Value::Integer(to));
    }
    if let Some(app) = query.app.as_ref().filter(|app| !app.is_empty()) {
        clauses.push("s.app = ?");
        params.push(Value::Text(app.clone()));
    }
    if let Some(tag) = query.tag.as_ref().filter(|tag| !tag.is_empty()) {
        clauses.push(
            "(EXISTS (SELECT 1 FROM shot_tags t WHERE t.shot_id = s.id AND t.tag = ?)
              OR EXISTS (SELECT 1 FROM shot_ai_tags a WHERE a.shot_id = s.id AND a.tag = ?))",
        );
        params.push(Value::Text(tag.clone()));
        params.push(Value::Text(tag.clone()));
    }
    if let Some(category) = query.category.as_ref().filter(|value| !value.is_empty()) {
        clauses.push("s.ai_category = ?");
        params.push(Value::Text(category.clone()));
    }
    clauses
        .iter()
        .map(|clause| format!(" AND {clause}"))
        .collect()
}

impl Library {
    /// Shots matching `query`: best matches first when there are words,
    /// otherwise newest first.
    pub fn search(
        &self,
        query: &SearchQuery,
        offset: u32,
        limit: u32,
    ) -> LibraryResult<SearchPage> {
        let limit = limit.clamp(1, MAX_PAGE);
        let conn = self.connection();
        let words = fts_query(&query.text);

        let mut params = Vec::new();
        let (from, order, snippets) = match &words {
            Some(words) => {
                params.push(Value::Text(words.clone()));
                let snippets: String = (0..FIELDS.len())
                    .map(|column| {
                        format!(
                            ", snippet(shots_fts, {column}, '{HIT_START}', '{HIT_END}', '…', {SNIPPET_TOKENS})"
                        )
                    })
                    .collect();
                (
                    "shots_fts JOIN shots s ON s.id = shots_fts.rowid WHERE shots_fts MATCH ?",
                    "shots_fts.rank, s.captured_at DESC, s.id DESC",
                    snippets,
                )
            }
            None => (
                "shots s WHERE 1",
                "s.captured_at DESC, s.id DESC",
                String::new(),
            ),
        };
        let filters = filter_clause(query, &mut params);

        let total: u32 = conn.query_row(
            &format!("SELECT COUNT(*) FROM {from}{filters}"),
            params_from_iter(params.iter()),
            |row| row.get(0),
        )?;

        params.push(Value::Integer(limit.into()));
        params.push(Value::Integer(offset.into()));
        let mut stmt = conn.prepare(&format!(
            "SELECT {SHOT_COLUMNS}{snippets} FROM {from}{filters} ORDER BY {order} LIMIT ? OFFSET ?"
        ))?;
        let with_snippets = words.is_some();
        let mut hits = stmt
            .query_map(params_from_iter(params.iter()), |row| {
                let shot = shot_from_row(row)?;
                let mut field = None;
                let mut snippet = Vec::new();
                if with_snippets {
                    for (index, candidate) in FIELDS.iter().enumerate() {
                        let raw: String = row.get(SHOT_COLUMN_COUNT + index)?;
                        if raw.contains(HIT_START) {
                            field = Some(*candidate);
                            snippet = parse_snippet(&raw);
                            break;
                        }
                    }
                }
                Ok(SearchHit {
                    shot,
                    field,
                    snippet,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for hit in &mut hits {
            self.fill_tags(&mut hit.shot)?;
        }
        Ok(SearchPage {
            hits,
            offset,
            total,
        })
    }

    /// Every app, user tag and AI category in the library, for the filter
    /// bar.
    pub fn filter_options(&self) -> LibraryResult<FilterOptions> {
        let conn = self.connection();
        let column = |sql: &str| -> LibraryResult<Vec<String>> {
            let mut stmt = conn.prepare(sql)?;
            let values = stmt
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            Ok(values)
        };
        Ok(FilterOptions {
            apps: column(
                "SELECT app FROM shots WHERE app IS NOT NULL AND app <> ''
                 GROUP BY app ORDER BY app COLLATE NOCASE",
            )?,
            tags: column(
                "SELECT tag FROM shot_tags GROUP BY tag COLLATE NOCASE ORDER BY tag COLLATE NOCASE",
            )?,
            categories: column(
                "SELECT ai_category FROM shots WHERE ai_category IS NOT NULL AND ai_category <> ''
                 GROUP BY ai_category ORDER BY ai_category",
            )?,
        })
    }
}

#[tauri::command]
pub fn library_search(
    query: SearchQuery,
    offset: u32,
    limit: u32,
    state: State<'_, LibraryState>,
) -> Result<SearchPage, String> {
    state
        .lock()
        .search(&query, offset, limit)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn library_filter_options(state: State<'_, LibraryState>) -> Result<FilterOptions, String> {
    state.lock().filter_options().map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        capture::{CaptureMode, Foreground, ORIGINALS_DIR, save_capture},
        library::AiDescription,
        ocr::tests::{FIXTURE_WORD, engine, fixture_png},
    };
    use chrono::{DateTime, Local, TimeZone};
    use image::{Rgba, RgbaImage};
    use std::{
        fs,
        path::{Path, PathBuf},
    };
    use tempfile::TempDir;

    fn day(day: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 3, day, 9, 0, 0).unwrap()
    }

    fn shoot(folder: &Path, when: DateTime<Local>, app: &str, title: &str) -> PathBuf {
        let image = RgbaImage::from_pixel(8, 8, Rgba([200, 200, 200, 255]));
        let foreground = Foreground {
            app: Some(app.into()),
            window_title: Some(title.into()),
        };
        save_capture(folder, &image, CaptureMode::Region, &foreground, None, when)
            .unwrap()
            .path
    }

    fn ids(page: &SearchPage) -> Vec<i64> {
        page.hits.iter().map(|hit| hit.shot.id).collect()
    }

    fn words(text: &str) -> SearchQuery {
        SearchQuery {
            text: text.into(),
            ..SearchQuery::default()
        }
    }

    /// Three shots: (firefox "Pricing page", day 1), (code "main.rs", day 2),
    /// (firefox "Login form", day 3).
    fn sample(dir: &Path) -> (Library, [i64; 3]) {
        let mut library = Library::open_in_memory().unwrap();
        let a = library
            .add_capture(&shoot(dir, day(1), "firefox", "Pricing page"))
            .unwrap()
            .id;
        let b = library
            .add_capture(&shoot(dir, day(2), "code", "main.rs"))
            .unwrap()
            .id;
        let c = library
            .add_capture(&shoot(dir, day(3), "firefox", "Login form"))
            .unwrap()
            .id;
        (library, [a, b, c])
    }

    #[test]
    fn typed_words_become_quoted_prefix_queries() {
        assert_eq!(fts_query("  "), None);
        assert_eq!(fts_query("- \"\" ()"), None);
        assert_eq!(fts_query("inv 2026"), Some("\"inv\"* \"2026\"*".to_owned()));
        // FTS5 syntax is just text.
        assert_eq!(
            fts_query("a\"b OR NEAR(x"),
            Some("\"ab\"* \"OR\"* \"NEAR(x\"*".to_owned())
        );
    }

    #[test]
    fn snippets_split_into_highlighted_parts() {
        let raw = format!("…order {HIT_START}pine{HIT_END}apple\ntoday");
        assert_eq!(
            parse_snippet(&raw),
            vec![
                SnippetPart {
                    text: "…order ".into(),
                    hit: false
                },
                SnippetPart {
                    text: "pine".into(),
                    hit: true
                },
                SnippetPart {
                    text: "apple today".into(),
                    hit: false
                },
            ]
        );
    }

    #[test]
    fn words_match_metadata_as_prefixes() {
        let dir = TempDir::new().unwrap();
        let (library, [a, b, c]) = sample(dir.path());

        let page = library.search(&words("fire"), 0, 10).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.hits.len(), 2);
        assert!(ids(&page).contains(&a) && ids(&page).contains(&c));
        assert_eq!(page.hits[0].field, Some(MatchField::App));

        let page = library.search(&words("LOG"), 0, 10).unwrap();
        assert_eq!(ids(&page), vec![c]);
        assert_eq!(page.hits[0].field, Some(MatchField::WindowTitle));
        assert!(
            page.hits[0]
                .snippet
                .iter()
                .any(|part| part.hit && part.text == "Login")
        );

        // Every word must match.
        assert_eq!(
            ids(&library.search(&words("firefox pric"), 0, 10).unwrap()),
            vec![a]
        );
        assert_eq!(
            library.search(&words("firefox main"), 0, 10).unwrap().total,
            0
        );
        // Mid-word text does not match.
        assert_eq!(library.search(&words("efox"), 0, 10).unwrap().total, 0);
        // Odd input is searched for, not parsed.
        assert_eq!(library.search(&words("\"main OR"), 0, 10).unwrap().total, 0);
        assert_eq!(
            ids(&library.search(&words("main.rs"), 0, 10).unwrap()),
            vec![b]
        );
    }

    #[test]
    fn no_words_lists_newest_first_without_snippets() {
        let dir = TempDir::new().unwrap();
        let (library, [a, b, c]) = sample(dir.path());
        let page = library.search(&SearchQuery::default(), 0, 10).unwrap();
        assert_eq!(ids(&page), vec![c, b, a]);
        assert!(
            page.hits
                .iter()
                .all(|hit| hit.field.is_none() && hit.snippet.is_empty())
        );

        let page = library.search(&SearchQuery::default(), 1, 1).unwrap();
        assert_eq!((ids(&page), page.offset, page.total), (vec![b], 1, 3));
    }

    #[test]
    fn filters_narrow_by_date_app_and_tag() {
        let dir = TempDir::new().unwrap();
        let (mut library, [a, b, c]) = sample(dir.path());
        library.set_tags(a, &["Receipts".into()]).unwrap();
        library
            .set_tags(b, &["receipts".into(), "work".into()])
            .unwrap();

        let by_app = SearchQuery {
            app: Some("firefox".into()),
            ..SearchQuery::default()
        };
        assert_eq!(ids(&library.search(&by_app, 0, 10).unwrap()), vec![c, a]);

        let by_date = SearchQuery {
            from: Some(day(2).timestamp_millis()),
            to: Some(day(3).timestamp_millis()),
            ..SearchQuery::default()
        };
        assert_eq!(ids(&library.search(&by_date, 0, 10).unwrap()), vec![b]);

        let by_tag = SearchQuery {
            tag: Some("RECEIPTS".into()),
            ..SearchQuery::default()
        };
        assert_eq!(ids(&library.search(&by_tag, 0, 10).unwrap()), vec![b, a]);

        let combined = SearchQuery {
            text: "pricing".into(),
            app: Some("firefox".into()),
            tag: Some("receipts".into()),
            from: Some(day(1).timestamp_millis()),
            to: None,
            category: None,
        };
        let page = library.search(&combined, 0, 10).unwrap();
        assert_eq!((ids(&page), page.total), (vec![a], 1));
        assert_eq!(page.hits[0].shot.tags, vec!["Receipts"]);

        // Empty filter values mean "any".
        let empty = SearchQuery {
            app: Some(String::new()),
            tag: Some(String::new()),
            ..SearchQuery::default()
        };
        assert_eq!(library.search(&empty, 0, 10).unwrap().total, 3);
    }

    #[test]
    fn the_index_follows_tag_note_ocr_edits_and_deletes() {
        let dir = TempDir::new().unwrap();
        let (mut library, [a, b, _]) = sample(dir.path());
        let count =
            |library: &Library, text: &str| library.search(&words(text), 0, 10).unwrap().total;

        library.set_tags(a, &["invoices".into()]).unwrap();
        assert_eq!(count(&library, "invoice"), 1);
        assert_eq!(
            library.search(&words("invoice"), 0, 10).unwrap().hits[0].field,
            Some(MatchField::Tags)
        );
        library.set_tags(a, &["design".into()]).unwrap();
        assert_eq!(count(&library, "invoice"), 0);
        assert_eq!(count(&library, "design"), 1);

        library.set_notes(b, "Staging login timeout").unwrap();
        assert_eq!(count(&library, "timeout"), 1);
        library.set_notes(b, "fixed").unwrap();
        assert_eq!(count(&library, "timeout"), 0);

        library.set_ocr_text(b, "Total due 42 EUR").unwrap();
        let page = library.search(&words("due"), 0, 10).unwrap();
        assert_eq!(ids(&page), vec![b]);
        assert_eq!(page.hits[0].field, Some(MatchField::Text));

        // Re-adding a known file keeps its OCR text, tags and notes indexed.
        let path = library.get(b).unwrap().path;
        library.add_capture(&path).unwrap();
        assert_eq!(count(&library, "due"), 1);

        library.delete(a).unwrap();
        assert_eq!(count(&library, "design"), 0);
        library.delete(b).unwrap();
        assert_eq!(count(&library, "due"), 0);
        let rows: i64 = library
            .connection()
            .query_row("SELECT COUNT(*) FROM shots_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn rescan_drops_index_rows_of_vanished_files() {
        let dir = TempDir::new().unwrap();
        let (mut library, [a, _, _]) = sample(dir.path());
        library.set_ocr_text(a, "quarterly report").unwrap();
        fs::remove_file(library.get(a).unwrap().path).unwrap();
        library.rescan(dir.path()).unwrap();
        assert_eq!(library.search(&words("quarterly"), 0, 10).unwrap().total, 0);
    }

    #[test]
    fn upgrading_an_older_library_indexes_existing_shots() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("library.db");
        let png = shoot(dir.path(), day(1), "firefox", "Pricing page");
        {
            // A library as PR 4 left it: schema 1 with one tagged shot.
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(crate::library::MIGRATIONS[0]).unwrap();
            conn.execute(
                "INSERT INTO shots (id, path, thumb_path, captured_at, app, window_title, notes)
                 VALUES (1, ?1, ?2, 0, 'firefox', 'Pricing page', 'quarterly numbers')",
                [
                    png.to_string_lossy().into_owned(),
                    png.to_string_lossy().into_owned(),
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO shot_tags (shot_id, tag) VALUES (1, 'finance')",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        let library = Library::open(&db).unwrap();
        for word in ["quarterly", "finance", "pricing", "firefox"] {
            assert_eq!(
                library.search(&words(word), 0, 10).unwrap().total,
                1,
                "{word}"
            );
        }
        assert_eq!(library.pending_ocr_count().unwrap(), 1);
    }

    #[test]
    fn upgrading_a_schema_2_library_keeps_its_index_and_queues_shots_for_ai() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join("library.db");
        let png = shoot(dir.path(), day(1), "firefox", "Pricing page");
        {
            // A library as the OCR release left it: schema 2, one shot
            // with OCR text, a tag and notes.
            let conn = rusqlite::Connection::open(&db).unwrap();
            for migration in &crate::library::MIGRATIONS[..2] {
                conn.execute_batch(migration).unwrap();
            }
            conn.execute(
                "INSERT INTO shots (id, path, thumb_path, captured_at, app, window_title, notes,
                                    ocr_text, ocr_state)
                 VALUES (1, ?1, ?2, 0, 'firefox', 'Pricing page', 'quarterly numbers',
                         'Total due 42 EUR', 1)",
                [
                    png.to_string_lossy().into_owned(),
                    png.to_string_lossy().into_owned(),
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO shot_tags (shot_id, tag) VALUES (1, 'finance')",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 2).unwrap();
        }
        let mut library = Library::open(&db).unwrap();
        assert_eq!(
            library.schema_version().unwrap(),
            crate::library::MIGRATIONS.len() as i64
        );
        for word in ["quarterly", "finance", "pricing", "firefox", "due"] {
            assert_eq!(
                library.search(&words(word), 0, 10).unwrap().total,
                1,
                "{word}"
            );
        }
        let shot = library.get(1).unwrap();
        assert_eq!(shot.tags, vec!["finance"]);
        assert_eq!(
            (shot.ai_description, shot.ai_category, shot.ai_tags.len()),
            (None, None, 0)
        );
        assert_eq!(library.ai_state(1).unwrap(), crate::library::AI_WAITING);
        assert_eq!(library.next_for_ai().unwrap().unwrap().id, 1);
        assert_eq!(
            library.next_for_ai().unwrap().unwrap().ocr_text.as_deref(),
            Some("Total due 42 EUR")
        );

        // The rebuilt triggers keep the index in step, old fields and new.
        library.set_notes(1, "monthly").unwrap();
        assert_eq!(library.search(&words("quarterly"), 0, 10).unwrap().total, 0);
        assert_eq!(library.search(&words("monthly"), 0, 10).unwrap().total, 1);
        library
            .set_ai_description(1, &described("A pricing table for Acme plans."), "m")
            .unwrap();
        assert_eq!(library.search(&words("acme"), 0, 10).unwrap().total, 1);
        let rows: i64 = library
            .connection()
            .query_row("SELECT COUNT(*) FROM shots_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    fn described(description: &str) -> AiDescription {
        AiDescription {
            description: description.into(),
            category: "browser".into(),
            tags: vec!["pricing".into(), "Saas Plans".into()],
        }
    }

    #[test]
    fn descriptions_and_ai_tags_are_searched() {
        let dir = TempDir::new().unwrap();
        let (mut library, [a, b, _]) = sample(dir.path());
        library
            .set_ai_description(
                a,
                &AiDescription {
                    description: "A checkout page showing an unpaid invoice.".into(),
                    category: "receipt".into(),
                    tags: vec!["Invoice".into(), "stripe".into()],
                },
                "qwen3-vl:4b",
            )
            .unwrap();
        library
            .set_ai_description(
                b,
                &AiDescription {
                    description: "Rust code with a borrow checker error.".into(),
                    category: "code".into(),
                    tags: vec!["rust".into(), "lifetimes".into()],
                },
                "qwen3-vl:4b",
            )
            .unwrap();

        let page = library.search(&words("unpai"), 0, 10).unwrap();
        assert_eq!(ids(&page), vec![a]);
        assert_eq!(page.hits[0].field, Some(MatchField::Description));
        assert!(
            page.hits[0]
                .snippet
                .iter()
                .any(|part| part.hit && part.text == "unpaid")
        );
        assert_eq!(page.hits[0].shot.ai_tags, vec!["Invoice", "stripe"]);
        assert_eq!(page.hits[0].shot.ai_category.as_deref(), Some("receipt"));

        // AI tags are searched, and reported as tags.
        let page = library.search(&words("lifetime"), 0, 10).unwrap();
        assert_eq!(ids(&page), vec![b]);
        assert_eq!(page.hits[0].field, Some(MatchField::Tags));

        // A new description replaces the old one in the index.
        library
            .set_ai_description(b, &described("A terminal."), "llava")
            .unwrap();
        assert_eq!(library.search(&words("borrow"), 0, 10).unwrap().total, 0);
        assert_eq!(library.search(&words("lifetimes"), 0, 10).unwrap().total, 0);
        assert_eq!(library.search(&words("saas"), 0, 10).unwrap().total, 1);

        // Clearing drops it from the index too.
        library.clear_ai(a).unwrap();
        assert_eq!(library.search(&words("unpaid"), 0, 10).unwrap().total, 0);
        assert_eq!(library.search(&words("stripe"), 0, 10).unwrap().total, 0);

        // Deleting a described shot leaves no index row behind.
        library.delete(b).unwrap();
        let rows: i64 = library
            .connection()
            .query_row("SELECT COUNT(*) FROM shots_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 2);
        let ai_tags: i64 = library
            .connection()
            .query_row("SELECT COUNT(*) FROM shot_ai_tags", [], |row| row.get(0))
            .unwrap();
        assert_eq!(ai_tags, 0);
    }

    #[test]
    fn category_and_tag_filters_cover_ai_fields() {
        let dir = TempDir::new().unwrap();
        let (mut library, [a, b, c]) = sample(dir.path());
        library
            .set_ai_description(
                a,
                &AiDescription {
                    description: "An invoice.".into(),
                    category: "receipt".into(),
                    tags: vec!["finance".into()],
                },
                "m",
            )
            .unwrap();
        library
            .set_ai_description(b, &described("Code."), "m")
            .unwrap();
        library.set_tags(c, &["Finance".into()]).unwrap();

        let by_category = |category: &str| SearchQuery {
            category: Some(category.into()),
            ..SearchQuery::default()
        };
        assert_eq!(
            ids(&library.search(&by_category("receipt"), 0, 10).unwrap()),
            vec![a]
        );
        assert_eq!(
            ids(&library.search(&by_category("browser"), 0, 10).unwrap()),
            vec![b]
        );
        // Exact: neither a prefix nor another case.
        assert_eq!(library.search(&by_category("rec"), 0, 10).unwrap().total, 0);
        assert_eq!(
            library
                .search(&by_category("Receipt"), 0, 10)
                .unwrap()
                .total,
            0
        );
        assert_eq!(library.search(&by_category(""), 0, 10).unwrap().total, 3);

        // A tag filter matches the user's tags or the AI's, in any case.
        let by_tag = |tag: &str| SearchQuery {
            tag: Some(tag.into()),
            ..SearchQuery::default()
        };
        assert_eq!(
            ids(&library.search(&by_tag("FINANCE"), 0, 10).unwrap()),
            vec![c, a]
        );
        assert_eq!(
            ids(&library.search(&by_tag("saas plans"), 0, 10).unwrap()),
            vec![b]
        );

        let combined = SearchQuery {
            text: "invoice".into(),
            category: Some("receipt".into()),
            tag: Some("finance".into()),
            ..SearchQuery::default()
        };
        assert_eq!(ids(&library.search(&combined, 0, 10).unwrap()), vec![a]);

        let options = library.filter_options().unwrap();
        assert_eq!(options.categories, vec!["browser", "receipt"]);
        // The tag list stays the user's own.
        assert_eq!(options.tags, vec!["Finance"]);
        assert_eq!(
            serde_json::to_value(&options).unwrap()["categories"],
            serde_json::json!(["browser", "receipt"])
        );
        assert_eq!(
            serde_json::to_value(MatchField::Description).unwrap(),
            serde_json::json!("description")
        );
    }

    #[test]
    fn shots_serialize_their_ai_fields_for_the_frontend() {
        let dir = TempDir::new().unwrap();
        let (mut library, [a, b, _]) = sample(dir.path());
        library
            .set_ai_description(a, &described("A pricing table."), "m")
            .unwrap();
        let json = serde_json::to_value(library.get(a).unwrap()).unwrap();
        assert_eq!(json["aiDescription"], "A pricing table.");
        assert_eq!(json["aiCategory"], "browser");
        assert_eq!(json["aiTags"], serde_json::json!(["pricing", "Saas Plans"]));
        let json = serde_json::to_value(library.get(b).unwrap()).unwrap();
        assert_eq!(json["aiDescription"], serde_json::Value::Null);
        assert_eq!(json["aiCategory"], serde_json::Value::Null);
        assert_eq!(json["aiTags"], serde_json::json!([]));
        // A query without a category, as older frontends send it, is fine.
        let query: SearchQuery = serde_json::from_str(r#"{"text": "x", "tag": "y"}"#).unwrap();
        assert_eq!(query.category, None);
        let query: SearchQuery = serde_json::from_str(r#"{"category": "code"}"#).unwrap();
        assert_eq!(query.category.as_deref(), Some("code"));
    }

    #[test]
    fn the_ai_queue_waits_for_ocr_and_runs_newest_first() {
        let dir = TempDir::new().unwrap();
        let (mut library, [a, b, c]) = sample(dir.path());
        // Nothing has been read by OCR yet.
        assert!(library.next_for_ai().unwrap().is_none());
        library.set_ocr_text(a, "older").unwrap();
        library.mark_ocr_failed(b).unwrap();
        let job = library.next_for_ai().unwrap().unwrap();
        // b is newer than a; its OCR failed, so it goes without text.
        assert_eq!((job.id, job.ocr_text), (b, None));
        assert_eq!(job.app.as_deref(), Some("code"));
        assert_eq!(job.window_title.as_deref(), Some("main.rs"));
        library.mark_ai_failed(b).unwrap();
        let job = library.next_for_ai().unwrap().unwrap();
        assert_eq!((job.id, job.ocr_text.as_deref()), (a, Some("older")));
        library.set_ocr_text(c, "").unwrap();
        assert_eq!(library.next_for_ai().unwrap().unwrap().id, c);
        let counts = library.ai_counts().unwrap();
        assert_eq!((counts.done, counts.total), (1, 3));
        assert_eq!(library.skip_waiting_ai().unwrap(), 2);
        assert!(library.next_for_ai().unwrap().is_none());
        let counts = library.ai_counts().unwrap();
        assert_eq!((counts.done, counts.total), (1, 1));
    }

    #[test]
    fn filter_options_list_apps_and_tags_once() {
        let dir = TempDir::new().unwrap();
        let (mut library, [a, b, _]) = sample(dir.path());
        library.set_tags(a, &["Work".into(), "bug".into()]).unwrap();
        library.set_tags(b, &["work".into()]).unwrap();
        let options = library.filter_options().unwrap();
        assert_eq!(options.apps, vec!["code", "firefox"]);
        assert_eq!(options.tags.len(), 2);
        assert_eq!(options.tags[0], "bug");
        assert!(options.tags[1].eq_ignore_ascii_case("work"));
    }

    #[test]
    fn the_ocr_queue_runs_newest_first_and_skips_unreadable_files() {
        let dir = TempDir::new().unwrap();
        let (mut library, [a, b, c]) = sample(dir.path());
        assert_eq!(library.pending_ocr_count().unwrap(), 3);
        assert_eq!(library.next_for_ocr().unwrap().unwrap().id, c);
        library.set_ocr_text(c, "").unwrap();
        assert_eq!(library.next_for_ocr().unwrap().unwrap().id, b);
        library.mark_ocr_failed(b).unwrap();
        assert_eq!(library.next_for_ocr().unwrap().unwrap().id, a);
        assert_eq!(library.pending_ocr_count().unwrap(), 1);
        assert_eq!(library.ocr_text(c).unwrap().as_deref(), Some(""));
        assert_eq!(library.ocr_text(a).unwrap(), None);
    }

    /// The outcome end to end: a word that appears only in the image is
    /// found by OCR and then by search, as a prefix, with a highlight.
    #[test]
    fn a_word_only_in_the_image_is_found_after_ocr() {
        let dir = TempDir::new().unwrap();
        let originals = dir.path().join(ORIGINALS_DIR);
        fs::create_dir_all(&originals).unwrap();
        let png = originals.join("Grab-it 2026-03-07 09-00-00.png");
        fs::copy(fixture_png(), &png).unwrap();

        let mut library = Library::open_in_memory().unwrap();
        let shot = library.add_capture(&png).unwrap();
        let prefix = &FIXTURE_WORD[..5];
        assert_eq!(library.search(&words(prefix), 0, 10).unwrap().total, 0);

        let job = library.next_for_ocr().unwrap().unwrap();
        assert_eq!(job.id, shot.id);
        let text = engine().read_text(&job.path).unwrap();
        library.set_ocr_text(job.id, &text).unwrap();

        let page = library.search(&words(prefix), 0, 10).unwrap();
        assert_eq!(ids(&page), vec![shot.id]);
        let hit = &page.hits[0];
        assert_eq!(hit.field, Some(MatchField::Text));
        let highlighted: String = hit
            .snippet
            .iter()
            .filter(|part| part.hit)
            .map(|part| part.text.to_lowercase())
            .collect();
        assert_eq!(highlighted, FIXTURE_WORD);
        assert!(library.next_for_ocr().unwrap().is_none());
    }
}
