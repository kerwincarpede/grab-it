//! Reading a capture: OCR, face detection and code detection, each on a
//! screen-sized capture generated at the start.

use std::hint::black_box;

use criterion::{Criterion, criterion_group, criterion_main};
use grab_it_lib::bench::{Faces, Ocr, decode_codes, face_models_dir, fixture, ocr_models_dir};
use image::{DynamicImage, Rgba, RgbaImage, imageops};
use rxing::{BarcodeFormat, MultiFormatWriter, Writer};

/// A 1280×800 display, a common laptop size.
const SCREEN: (u32, u32) = (1280, 800);

fn blank_screen() -> RgbaImage {
    RgbaImage::from_pixel(SCREEN.0, SCREEN.1, Rgba([255, 255, 255, 255]))
}

/// A screen holding four lines of text: the OCR fixture's line, repeated.
fn text_capture() -> RgbaImage {
    let line = image::open(fixture("ocr-pineapple.png"))
        .expect("open the OCR fixture")
        .into_rgba8();
    let mut capture = blank_screen();
    for row in 0..4 {
        imageops::overlay(&mut capture, &line, 320, 40 + row * 180);
    }
    capture
}

/// A screen holding the face fixture in its middle.
fn face_capture() -> RgbaImage {
    let portrait = image::open(fixture("face-portrait.jpg"))
        .expect("open the face fixture")
        .into_rgba8();
    let mut capture = blank_screen();
    imageops::overlay(&mut capture, &portrait, 480, 200);
    capture
}

/// A screen holding one QR code.
fn code_capture() -> RgbaImage {
    let matrix = MultiFormatWriter
        .encode(
            "https://example.com/benchmarks?page=1",
            &BarcodeFormat::QR_CODE,
            240,
            240,
        )
        .expect("draw the QR code");
    let code = RgbaImage::from_fn(matrix.width(), matrix.height(), |x, y| {
        if matrix.get(x, y) {
            Rgba([0, 0, 0, 255])
        } else {
            Rgba([255, 255, 255, 255])
        }
    });
    let mut capture = blank_screen();
    imageops::overlay(&mut capture, &code, 520, 280);
    capture
}

fn detect(c: &mut Criterion) {
    let ocr = Ocr::load(&ocr_models_dir()).expect("load the OCR models");
    let faces = Faces::load(&face_models_dir()).expect("load the face model");
    let text = text_capture();
    let text_rgb = DynamicImage::ImageRgba8(text.clone()).into_rgb8();
    let face = face_capture();
    let code = code_capture();

    let mut group = c.benchmark_group("detect");
    // Each OCR read takes a large part of a second.
    group.sample_size(10);
    group.bench_function("ocr", |b| {
        b.iter(|| ocr.read_image(black_box(&text_rgb)).expect("read the text"))
    });
    group.bench_function("faces", |b| {
        b.iter(|| faces.detect(black_box(&face)).expect("detect the faces"))
    });
    group.bench_function("codes_qr", |b| b.iter(|| decode_codes(black_box(&code))));
    // The usual case: a capture with no code in it.
    group.bench_function("codes_none", |b| b.iter(|| decode_codes(black_box(&text))));
    group.finish();
}

criterion_group!(benches, detect);
criterion_main!(benches);
