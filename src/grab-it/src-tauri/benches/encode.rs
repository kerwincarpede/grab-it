//! Writing a capture's thumbnail, and exporting it to PNG, JPG and WebP,
//! from a 1920×1080 capture generated in a temporary folder at the start.

use std::{fs, hint::black_box};

use chrono::{Local, TimeZone};
use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use grab_it_lib::bench::{
    CaptureMode, Foreground, Library, ensure_thumbnail, export_shot, prepare_capture, save_capture,
    thumb_path,
};
use image::{Rgba, RgbaImage};
use tempfile::TempDir;

/// A screen-like 1920×1080 image: a gradient behind bands of "text", so it
/// compresses about as well as a real capture rather than to nothing.
fn screen_image() -> RgbaImage {
    RgbaImage::from_fn(1920, 1080, |x, y| {
        let line = (y / 24) % 3 != 2 && (x / 8 + y / 24) % 11 < 7 && y % 24 < 14;
        if line && (x * 7 + y * 13) % 5 < 3 {
            Rgba([30, 30, 40, 255])
        } else {
            Rgba([
                (200 + x * 40 / 1920) as u8,
                (210 + y * 30 / 1080) as u8,
                235,
                255,
            ])
        }
    })
}

fn encode(c: &mut Criterion) {
    let dir = TempDir::new().expect("make a temporary folder");
    let foreground = Foreground {
        app: Some("firefox".into()),
        window_title: Some("Benchmarks".into()),
    };
    let time = Local
        .with_ymd_and_hms(2026, 3, 7, 9, 5, 0)
        .single()
        .expect("a valid local time");
    let png = save_capture(
        dir.path(),
        &screen_image(),
        CaptureMode::Region,
        &foreground,
        None,
        time,
    )
    .expect("save the capture")
    .path;
    let mut library = Library::open_in_memory().expect("open a library");
    let shot = library
        .insert(&prepare_capture(&png).expect("read the capture"))
        .expect("add the capture");
    let thumb = thumb_path(&shot.path);
    let exports = dir.path().join("exports");
    fs::create_dir_all(&exports).expect("make the export folder");

    let mut group = c.benchmark_group("encode");
    group.bench_function("thumbnail", |b| {
        b.iter_batched(
            || {
                let _ = fs::remove_file(&thumb);
            },
            |()| ensure_thumbnail(black_box(&shot.path), &thumb).expect("write the thumbnail"),
            BatchSize::PerIteration,
        )
    });
    // A PNG export of a PNG capture copies the original's bytes; JPG and
    // WebP encode it.
    for extension in ["png", "jpg", "webp"] {
        let target = exports.join(format!("export.{extension}"));
        group.bench_function(format!("export_{extension}"), |b| {
            b.iter(|| export_shot(black_box(&shot), &target).expect("export the capture"))
        });
    }
    group.finish();
}

criterion_group!(benches, encode);
criterion_main!(benches);
