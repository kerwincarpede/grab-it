//! Paths shared by screenshots and recordings.

use std::{
    ffi::OsStr,
    fs::{self, File},
    io,
    path::PathBuf,
    sync::Mutex,
};

use chrono::{DateTime, Local};
use tauri::Manager;

use crate::{
    commands::{SettingsState, lock},
    rt::AppHandle,
    settings::{SaveLayout, Settings},
};

/// A snapshot of the save folder and both options for a new file.
pub(crate) struct SaveDestination {
    pub(crate) folder: PathBuf,
    pub(crate) layout: SaveLayout,
}

impl SaveDestination {
    pub(crate) fn current(app: &AppHandle) -> Self {
        Self::from_settings(lock(&app.state::<SettingsState>()).get())
    }

    pub(crate) fn from_settings(settings: &Settings) -> Self {
        Self {
            folder: settings.save_folder.clone(),
            layout: settings.save_layout,
        }
    }

    #[cfg(any(test, feature = "bench"))]
    pub(crate) fn flat(folder: &std::path::Path) -> Self {
        Self {
            folder: folder.to_owned(),
            layout: SaveLayout::default(),
        }
    }

    /// Chooses and creates a free media file without overwriting an existing
    /// file, sidecar or thumbnail shared by two recording formats.
    pub(crate) fn reserve(
        &self,
        media: &str,
        time: &DateTime<Local>,
        app_name: Option<&str>,
        extension: &str,
    ) -> io::Result<(PathBuf, File)> {
        let root = self.folder.join(media);
        let dir = if self.layout.by_month {
            let month = time.format("%Y-%m").to_string();
            let dir = root.join(&month);
            fs::create_dir_all(&dir)?;
            if !fs::symlink_metadata(&dir)?.is_dir()
                || fs::canonicalize(&dir)? != fs::canonicalize(&root)?.join(month)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "{} must be a month folder inside {}",
                        dir.display(),
                        root.display()
                    ),
                ));
            }
            dir
        } else {
            fs::create_dir_all(&root)?;
            root
        };
        let app_label = if self.layout.include_app_name {
            app_name.and_then(safe_app_label)
        } else {
            None
        };
        let sibling_extensions: &[&str] = match extension {
            "png" => &["meta.json", "annotations.json", "assets"],
            "mp4" => &["gif", "edits.json", "cursor.json", "sound.m4a"],
            "gif" => &["mp4", "edits.json", "cursor.json", "sound.m4a"],
            _ => &[],
        };
        // MP4s and GIFs with the same stem would share a thumbnail. Check
        // sibling extensions and claim the path under one lock.
        static RESERVING: Mutex<()> = Mutex::new(());
        let _reservation = RESERVING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for counter in 1..=u32::MAX {
            let stem = media_stem(time, app_label.as_deref(), counter);
            let mut occupied = false;
            for sibling in sibling_extensions {
                match fs::symlink_metadata(dir.join(format!("{stem}.{sibling}"))) {
                    Ok(_) => {
                        occupied = true;
                        break;
                    }
                    Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                    Err(err) => return Err(err),
                }
            }
            if occupied {
                continue;
            }
            let path = dir.join(format!("{stem}.{extension}"));
            match File::options().write(true).create_new(true).open(&path) {
                Ok(file) => return Ok((path, file)),
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
                Err(err) => return Err(err),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "no unused name for the media file",
        ))
    }
}

fn media_stem(time: &DateTime<Local>, app_label: Option<&str>, counter: u32) -> String {
    let mut stem = time.format("%Y-%m-%d %H-%M-%S").to_string();
    if let Some(app_label) = app_label {
        stem.push_str(" – ");
        stem.push_str(app_label);
    }
    if counter > 1 {
        stem.push_str(&format!(" ({counter})"));
    }
    stem
}

/// Keeps app names portable and leaves room for extensions, sidecars and
/// thumbnail temp names. The timestamp prefix also avoids device names.
fn safe_app_label(app_name: &str) -> Option<String> {
    const MAX_BYTES: usize = 80;
    let mut label = String::new();
    for word in app_name
        .split(|ch: char| ch.is_whitespace() || ch.is_control() || "<>:\"/\\|?*".contains(ch))
        .filter(|word| !word.is_empty())
    {
        if !label.is_empty() {
            label.push(' ');
        }
        label.push_str(word);
        if label.len() >= MAX_BYTES {
            label.truncate(label.floor_char_boundary(MAX_BYTES));
            break;
        }
    }
    let label = label.trim_matches([' ', '.']);
    (!label.is_empty()).then(|| label.to_owned())
}

/// Whether a single folder name matches the supported YYYY-MM layout.
pub(crate) fn is_month_folder(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let bytes = name.as_bytes();
    bytes.len() == 7
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && matches!(&bytes[5..], [b'0', b'1'..=b'9'] | [b'1', b'0'..=b'2'])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{capture::ORIGINALS_DIR, record::RECORDINGS_DIR};
    use chrono::TimeZone;

    #[test]
    fn date_first_names_and_months_share_the_local_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let destination = SaveDestination {
            folder: dir.path().to_owned(),
            layout: SaveLayout {
                by_month: true,
                include_app_name: true,
            },
        };
        let march = Local.with_ymd_and_hms(2026, 3, 31, 23, 59, 59).unwrap();
        let april = Local.with_ymd_and_hms(2026, 4, 1, 0, 0, 0).unwrap();
        let (earlier, _) = destination
            .reserve(ORIGINALS_DIR, &march, Some("Firefox"), "png")
            .unwrap();
        let (later, _) = destination
            .reserve(ORIGINALS_DIR, &april, Some("Notes"), "png")
            .unwrap();
        assert!(earlier.file_name() < later.file_name());
        assert!(earlier.ends_with("originals/2026-03/2026-03-31 23-59-59 – Firefox.png"));
        assert!(later.ends_with("originals/2026-04/2026-04-01 00-00-00 – Notes.png"));
        let (no_app, _) = destination
            .reserve(RECORDINGS_DIR, &april, None, "mp4")
            .unwrap();
        assert!(no_app.ends_with("recordings/2026-04/2026-04-01 00-00-00.mp4"));
        let (unusable_app, _) = destination
            .reserve(RECORDINGS_DIR, &april, Some(" ./\\:* "), "gif")
            .unwrap();
        assert!(unusable_app.ends_with("recordings/2026-04/2026-04-01 00-00-00 (2).gif"));
    }

    #[test]
    fn repeated_reservations_keep_the_first_file_and_orphaned_sidecars() {
        use io::Write;
        let dir = tempfile::tempdir().unwrap();
        let destination = SaveDestination::flat(dir.path());
        let time = Local.with_ymd_and_hms(2026, 3, 7, 9, 5, 1).unwrap();
        let (first, mut file) = destination
            .reserve(RECORDINGS_DIR, &time, Some("Firefox"), "mp4")
            .unwrap();
        file.write_all(b"first clip").unwrap();
        drop(file);
        let sidecar = first.with_file_name("2026-03-07 09-05-01 (2).edits.json");
        fs::write(&sidecar, b"an existing edit").unwrap();
        let (third, _) = destination
            .reserve(RECORDINGS_DIR, &time, None, "mp4")
            .unwrap();
        let (fourth, _) = destination
            .reserve(RECORDINGS_DIR, &time, None, "gif")
            .unwrap();
        assert!(first.ends_with("recordings/2026-03-07 09-05-01.mp4"));
        assert!(third.ends_with("recordings/2026-03-07 09-05-01 (3).mp4"));
        assert!(fourth.ends_with("recordings/2026-03-07 09-05-01 (4).gif"));
        assert_eq!(fs::read(first).unwrap(), b"first clip");
        assert_eq!(fs::read(sidecar).unwrap(), b"an existing edit");
    }

    #[test]
    fn app_labels_have_no_filename_separators_and_are_bounded_at_utf8_characters() {
        assert_eq!(
            safe_app_label(" \t.foo \\Obsidian:/My<Notes>?*\"|. "),
            Some("foo Obsidian My Notes".into())
        );
        assert_eq!(safe_app_label(".."), None);
        assert_eq!(safe_app_label(&"界".repeat(40)).unwrap(), "界".repeat(26));
    }

    #[cfg(unix)]
    #[test]
    fn a_month_folder_symlink_cannot_redirect_a_save() {
        let dir = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let destination = SaveDestination {
            folder: dir.path().to_owned(),
            layout: SaveLayout {
                by_month: true,
                include_app_name: false,
            },
        };
        let recordings = dir.path().join(RECORDINGS_DIR);
        fs::create_dir(&recordings).unwrap();
        std::os::unix::fs::symlink(external.path(), recordings.join("2026-03")).unwrap();
        let time = Local.with_ymd_and_hms(2026, 3, 7, 9, 5, 1).unwrap();
        let err = destination
            .reserve(RECORDINGS_DIR, &time, None, "mp4")
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(fs::read_dir(external.path()).unwrap().count(), 0);
    }
}
