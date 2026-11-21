//! The Library over 10,000 items: searching it, and rescanning a save
//! folder of that many captures. Everything is generated in a temporary
//! folder at the start.

use std::{hint::black_box, path::Path};

use chrono::{Local, TimeDelta, TimeZone};
use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use grab_it_lib::bench::{
    CaptureMode, Foreground, Library, PreparedShot, SearchQuery, ShotKind, rescan, save_capture,
    thumb_path,
};
use image::{Rgba, RgbaImage};
use tempfile::TempDir;

/// How many items the Library holds.
const ITEMS: u32 = 10_000;

/// One results page, as the Library window asks for.
const PAGE: u32 = 100;

/// Words the generated OCR text is made of.
const WORDS: [&str; 32] = [
    "order", "account", "settings", "profile", "search", "results", "update", "download",
    "project", "report", "summary", "invoice", "payment", "total", "customer", "shipping",
    "meeting", "notes", "agenda", "calendar", "message", "reply", "draft", "folder", "build",
    "error", "warning", "deploy", "branch", "commit", "review", "release",
];

const APPS: [&str; 4] = ["firefox", "code", "terminal", "slack"];

/// A fixed sequence of word indexes, so every run searches the same text.
struct Words(u64);

impl Iterator for Words {
    type Item = &'static str;

    fn next(&mut self) -> Option<Self::Item> {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        Some(WORDS[(self.0 >> 59) as usize])
    }
}

/// A Library of [`ITEMS`] captures, each with about 30 words of OCR text.
/// Its rows point at files that do not exist, which searching never reads.
fn searchable_library(folder: &Path) -> Library {
    let mut library = Library::open_in_memory().expect("open a library");
    let mut words = Words(7);
    for n in 0..ITEMS {
        let path = folder.join(format!("capture-{n:05}.png"));
        let shot = library
            .insert(&PreparedShot {
                kind: ShotKind::Image,
                thumb_path: thumb_path(&path),
                path,
                captured_at: 1_772_870_400_000 + i64::from(n) * 60_000,
                mode: Some("region".into()),
                app: Some(APPS[n as usize % APPS.len()].into()),
                window_title: Some(format!("Window {}", n % 50)),
                width: 1280,
                height: 800,
                duration_ms: None,
                bytes: Some(120_000),
            })
            .expect("add a capture");
        let text = words.by_ref().take(30).collect::<Vec<_>>().join(" ");
        library
            .set_ocr_text(shot.id, &text)
            .expect("store the OCR text");
    }
    library
}

/// A save folder holding [`ITEMS`] small captures with their sidecars.
fn save_folder() -> TempDir {
    let dir = TempDir::new().expect("make a temporary folder");
    let image = RgbaImage::from_pixel(16, 10, Rgba([10, 20, 30, 255]));
    let foreground = Foreground {
        app: Some("firefox".into()),
        window_title: Some("Benchmarks".into()),
    };
    let start = Local
        .with_ymd_and_hms(2026, 3, 7, 9, 0, 0)
        .single()
        .expect("a valid local time");
    for n in 0..ITEMS {
        save_capture(
            dir.path(),
            &image,
            CaptureMode::Region,
            &foreground,
            None,
            start + TimeDelta::seconds(i64::from(n)),
        )
        .expect("save a capture");
    }
    dir
}

fn search(c: &mut Criterion) {
    let dir = TempDir::new().expect("make a temporary folder");
    let library = searchable_library(dir.path());
    let queries = [
        (
            "words",
            SearchQuery {
                text: "invoice payment".into(),
                ..SearchQuery::default()
            },
        ),
        (
            "prefix",
            SearchQuery {
                text: "rev".into(),
                ..SearchQuery::default()
            },
        ),
        (
            "app",
            SearchQuery {
                app: Some("code".into()),
                ..SearchQuery::default()
            },
        ),
        ("newest", SearchQuery::default()),
    ];

    let mut group = c.benchmark_group("library_search");
    for (name, query) in &queries {
        group.bench_function(*name, |b| {
            b.iter(|| {
                library
                    .search(black_box(query), 0, PAGE)
                    .expect("search the library")
            })
        });
    }
    group.finish();
}

fn rescan_folder(c: &mut Criterion) {
    let folder = save_folder();
    let mut library = Library::open_in_memory().expect("open a library");
    // Adds every capture and writes its thumbnail, as a first rescan does.
    let first = rescan(&mut library, folder.path()).expect("rescan the folder");
    assert_eq!(first.added, ITEMS as usize);

    let mut group = c.benchmark_group("library_rescan");
    // Each rescan stats tens of thousands of files.
    group.sample_size(10);
    group.bench_function("unchanged", |b| {
        b.iter(|| rescan(&mut library, black_box(folder.path())).expect("rescan the folder"))
    });
    // Thumbnails exist, so this times reading the sidecars and adding rows.
    // The filled library is returned, so dropping it is not timed.
    group.bench_function("new", |b| {
        b.iter_batched(
            || Library::open_in_memory().expect("open a library"),
            |mut library| {
                rescan(&mut library, black_box(folder.path())).expect("rescan the folder");
                library
            },
            BatchSize::PerIteration,
        )
    });
    group.finish();
}

criterion_group!(benches, search, rescan_folder);
criterion_main!(benches);
