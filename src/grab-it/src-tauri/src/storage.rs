//! What the library takes up on disk: each kind's count and size, from the
//! `bytes` the library records for every item, and the free and total space
//! on the save folder's disk. The Library's storage pill and its Storage
//! popover show them.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::library::{Library, LibraryResult, LibraryState, ShotKind, current_save_folder};

/// How many items of one kind the library holds and their total size.
/// Mirrors `KindUsage` in src/library/api.ts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
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

/// The library's size by kind and the save folder's disk.
#[tauri::command(async)]
pub fn library_storage(
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<LibraryStorage, String> {
    let usage = usage(&state.lock()).map_err(|err| err.to_string())?;
    let disk = disk_space(&current_save_folder(&app));
    Ok(LibraryStorage {
        image: usage.image,
        gif: usage.gif,
        video: usage.video,
        disk,
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
        };
        assert_eq!(
            serde_json::to_value(storage).unwrap(),
            serde_json::json!({
                "image": { "count": 2, "bytes": 30 },
                "gif": { "count": 0, "bytes": 0 },
                "video": { "count": 0, "bytes": 0 },
                "disk": { "free": 5, "total": 100 },
            })
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
