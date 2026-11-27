//! Reading QR codes and barcodes in an image.
//!
//! On macOS, [`decode`] tries Apple Vision's `VNDetectBarcodesRequest` first
//! and falls back to rxing (a port of ZXing) when Vision is unavailable,
//! errors, or finds nothing (which keeps MaxiCode and light-on-dark codes
//! working). On other platforms it decodes with rxing directly. Every 1D hit
//! from rxing is checked across parallel scanline bands so prose never
//! false-triggers an accidental barcode.
//!
//! Capture text decodes the dragged area before reading its text: when it
//! holds a code, the code's value is what the user wanted. Every format
//! Vision and rxing know is tried, 2D (QR, Data Matrix, Aztec, PDF417,
//! MaxiCode) and 1D (Code 128, EAN, UPC and the rest), and an area may hold
//! several.

use std::collections::HashSet;

use image::RgbaImage;
use rxing::{
    BarcodeFormat, BinaryBitmap, DecodeHints, Luma8LuminanceSource, MultiFormatReader, RXingResult,
    Reader, common::HybridBinarizer,
};
use serde::Serialize;

/// One code found in an image. Mirrors `QuickCode` in src/quick/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Code {
    /// The code's format as people call it, such as "QR code".
    pub format: String,
    /// What the code holds.
    pub value: String,
    /// Whether `value` is an http(s) link, which the card offers to open.
    pub is_link: bool,
}

impl Code {
    /// A code of `format` holding `value`.
    pub fn new(format: impl Into<String>, value: impl Into<String>) -> Self {
        let value = value.into();
        Self {
            format: format.into(),
            is_link: is_link(&value),
            value,
        }
    }
}

/// Every code in `image`, top to bottom and then left to right; empty when
/// there is none. On macOS Vision runs first and falls back to validated rxing
/// when unavailable, on error, or empty.
pub fn decode(image: &RgbaImage) -> Vec<Code> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Vec::new();
    }
    #[cfg(target_os = "macos")]
    if let Some(Ok(codes)) = mac::decode(image)
        && !codes.is_empty()
    {
        return codes;
    }
    decode_with_rxing(image)
}

/// Decodes `image` with rxing, validating every 1D hit across parallel bands.
fn decode_with_rxing(image: &RgbaImage) -> Vec<Code> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Vec::new();
    }
    let luma = image::imageops::grayscale(image).into_raw();
    let mut hints = DecodeHints {
        // Light-on-dark codes, as dark themes draw them.
        AlsoInverted: Some(true),
        ..DecodeHints::default()
    };
    // rxing reports "nothing found" as an error.
    let Ok(results) =
        rxing::helpers::detect_multiple_in_luma_with_hints(luma.clone(), width, height, &mut hints)
    else {
        return Vec::new();
    };
    let validated: Vec<RXingResult> = results
        .into_iter()
        .filter(|result| {
            let format = result.getBarcodeFormat();
            is_2d_format(format) || validate_1d_result(&luma, width, height, result)
        })
        .collect();
    in_reading_order(validated)
}

/// Whether `format` is a 2D symbology whose finder patterns and error
/// correction already rule out accidental prose hits.
fn is_2d_format(format: &BarcodeFormat) -> bool {
    matches!(
        format,
        BarcodeFormat::QR_CODE
            | BarcodeFormat::MICRO_QR_CODE
            | BarcodeFormat::RECTANGULAR_MICRO_QR_CODE
            | BarcodeFormat::AZTEC
            | BarcodeFormat::DATA_MATRIX
            | BarcodeFormat::PDF_417
            | BarcodeFormat::MAXICODE
    )
}

/// Parallel band offsets (in pixels from the hit scanline) checked to confirm
/// a 1D barcode spans consistent vertical bars rather than one row of prose.
const BAND_OFFSETS: [i32; 11] = [-20, -16, -12, -8, -4, 0, 4, 8, 12, 16, 20];
/// Height (or width, for vertical codes) of each probe strip. With a 4 px step
/// between offsets, 3 px strips never share a pixel row.
const BAND_THICKNESS: u32 = 3;
/// Minimum number of contiguous matching non-overlapping bands required to
/// accept a 1D hit (3 bands at 4 px spacing = at least 8 px of consistent bars).
const MIN_CONTIGUOUS_BANDS: usize = 3;

/// Confirms a 1D rxing hit by re-decoding non-overlapping parallel bands
/// around its scanline and requiring at least [`MIN_CONTIGUOUS_BANDS`]
/// contiguous bands to yield the same format and payload.
fn validate_1d_result(luma: &[u8], width: u32, height: u32, result: &RXingResult) -> bool {
    let text = result.getText();
    if text.trim().is_empty() {
        return false;
    }
    let points = result.getPoints();
    if points.len() < 2 {
        return false;
    }
    let (mut min_x, mut max_x) = (f32::INFINITY, f32::NEG_INFINITY);
    let (mut min_y, mut max_y) = (f32::INFINITY, f32::NEG_INFINITY);
    for point in points {
        min_x = min_x.min(point.x);
        max_x = max_x.max(point.x);
        min_y = min_y.min(point.y);
        max_y = max_y.max(point.y);
    }
    if !min_x.is_finite() || !max_x.is_finite() || !min_y.is_finite() || !max_y.is_finite() {
        return false;
    }

    let format = *result.getBarcodeFormat();
    let dx = max_x - min_x;
    let dy = max_y - min_y;
    let horizontal = dx >= dy;

    let mut run = 0usize;
    let mut best_run = 0usize;

    if horizontal {
        let span = dx.max(0.0) as u32;
        let pad = (span / 4).max(32);
        let x0 = (min_x.floor().max(0.0) as u32).saturating_sub(pad);
        let x1 = ((max_x.ceil().max(0.0) as u32).saturating_add(pad)).min(width);
        let band_w = x1.saturating_sub(x0);
        if band_w == 0 {
            return false;
        }
        let center_y = ((min_y + max_y) * 0.5).round() as i32;
        for offset in BAND_OFFSETS {
            let y = center_y + offset;
            if y < 1 || y + 1 >= height as i32 {
                run = 0;
                continue;
            }
            let band = extract_horizontal_band(luma, width, x0, x1, (y - 1) as u32);
            if decode_band_matches(band, band_w, BAND_THICKNESS, format, text) {
                run += 1;
                best_run = best_run.max(run);
                if best_run >= MIN_CONTIGUOUS_BANDS {
                    return true;
                }
            } else {
                run = 0;
            }
        }
    } else {
        let span = dy.max(0.0) as u32;
        let pad = (span / 4).max(32);
        let y0 = (min_y.floor().max(0.0) as u32).saturating_sub(pad);
        let y1 = ((max_y.ceil().max(0.0) as u32).saturating_add(pad)).min(height);
        let band_len = y1.saturating_sub(y0);
        if band_len == 0 {
            return false;
        }
        let center_x = ((min_x + max_x) * 0.5).round() as i32;
        for offset in BAND_OFFSETS {
            let x = center_x + offset;
            if x < 1 || x + 1 >= width as i32 {
                run = 0;
                continue;
            }
            // Transpose the vertical strip into a horizontal band so rxing
            // decodes along the bar axis without 90-degree rotation.
            let band = extract_vertical_band_transposed(luma, width, y0, y1, (x - 1) as u32);
            if decode_band_matches(band, band_len, BAND_THICKNESS, format, text) {
                run += 1;
                best_run = best_run.max(run);
                if best_run >= MIN_CONTIGUOUS_BANDS {
                    return true;
                }
            } else {
                run = 0;
            }
        }
    }

    false
}

/// Copies [`BAND_THICKNESS`] consecutive rows `[y_start..y_start + BAND_THICKNESS)`
/// across columns `[x0..x1)` from `luma`.
fn extract_horizontal_band(luma: &[u8], width: u32, x0: u32, x1: u32, y_start: u32) -> Vec<u8> {
    let band_w = (x1 - x0) as usize;
    let stride = width as usize;
    let mut band = Vec::with_capacity(band_w * BAND_THICKNESS as usize);
    for row in 0..BAND_THICKNESS {
        let row_start = (y_start + row) as usize * stride + x0 as usize;
        band.extend_from_slice(&luma[row_start..row_start + band_w]);
    }
    band
}

/// Copies [`BAND_THICKNESS`] consecutive columns `[x_start..x_start + BAND_THICKNESS)`
/// across rows `[y0..y1)` from `luma`, transposed into horizontal rows.
fn extract_vertical_band_transposed(
    luma: &[u8],
    width: u32,
    y0: u32,
    y1: u32,
    x_start: u32,
) -> Vec<u8> {
    let band_len = (y1 - y0) as usize;
    let stride = width as usize;
    let mut band = Vec::with_capacity(band_len * BAND_THICKNESS as usize);
    for col in 0..BAND_THICKNESS {
        let x = (x_start + col) as usize;
        for y in y0..y1 {
            band.push(luma[y as usize * stride + x]);
        }
    }
    band
}

/// Returns true when `band` decodes as `format` with payload `expected_text`.
fn decode_band_matches(
    band: Vec<u8>,
    width: u32,
    height: u32,
    format: BarcodeFormat,
    expected_text: &str,
) -> bool {
    let Ok(source) = Luma8LuminanceSource::new(band, width, height) else {
        return false;
    };
    let mut bitmap = BinaryBitmap::new(HybridBinarizer::new(source));
    let mut hints = DecodeHints {
        PossibleFormats: Some(HashSet::from([format])),
        AlsoInverted: Some(true),
        TryHarder: Some(false),
        ..DecodeHints::default()
    };
    let mut reader = MultiFormatReader::default();
    reader
        .decode_with_hints(&mut bitmap, &mut hints)
        .is_ok_and(|res| res.getBarcodeFormat() == &format && res.getText() == expected_text)
}

/// The codes in `results` in reading order, without empty values or
/// repeats (rxing can find one code twice while it searches around it).
fn in_reading_order(results: Vec<RXingResult>) -> Vec<Code> {
    let found = results
        .iter()
        .filter(|result| !result.getText().trim().is_empty())
        .map(|result| {
            let code = Code::new(format_name(result.getBarcodeFormat()), result.getText());
            (top_left(result), code)
        })
        .collect();
    sort_and_dedup(found)
}

/// Sorts `(top_left, Code)` pairs top to bottom then left to right, dropping
/// duplicates.
fn sort_and_dedup(mut found: Vec<((i64, i64), Code)>) -> Vec<Code> {
    // Rows a few pixels apart still count as one row, so codes side by
    // side read left to right.
    found.sort_by_key(|((x, y), _)| (y / 32, *x));
    let mut codes: Vec<Code> = Vec::with_capacity(found.len());
    for (_, code) in found {
        if !codes.contains(&code) {
            codes.push(code);
        }
    }
    codes
}

/// The top-left corner of the points rxing located a code by.
fn top_left(result: &RXingResult) -> (i64, i64) {
    let points = result.getPoints();
    let min = |pick: fn(&rxing::Point) -> f32| {
        points
            .iter()
            .map(pick)
            .fold(f32::INFINITY, f32::min)
            .clamp(0.0, i64::MAX as f32) as i64
    };
    if points.is_empty() {
        return (0, 0);
    }
    (min(|point| point.x), min(|point| point.y))
}

/// What people call `format`.
fn format_name(format: &BarcodeFormat) -> String {
    match format {
        BarcodeFormat::QR_CODE => "QR code",
        BarcodeFormat::MICRO_QR_CODE => "Micro QR code",
        BarcodeFormat::RECTANGULAR_MICRO_QR_CODE => "rMQR code",
        BarcodeFormat::AZTEC => "Aztec",
        BarcodeFormat::DATA_MATRIX => "Data Matrix",
        BarcodeFormat::PDF_417 => "PDF417",
        BarcodeFormat::MAXICODE => "MaxiCode",
        BarcodeFormat::CODABAR => "Codabar",
        BarcodeFormat::CODE_39 => "Code 39",
        BarcodeFormat::CODE_93 => "Code 93",
        BarcodeFormat::CODE_128 => "Code 128",
        BarcodeFormat::EAN_8 => "EAN-8",
        BarcodeFormat::EAN_13 => "EAN-13",
        BarcodeFormat::ITF => "ITF",
        BarcodeFormat::RSS_14 => "GS1 DataBar",
        BarcodeFormat::RSS_EXPANDED => "GS1 DataBar Expanded",
        BarcodeFormat::TELEPEN => "Telepen",
        BarcodeFormat::UPC_A => "UPC-A",
        BarcodeFormat::UPC_E => "UPC-E",
        BarcodeFormat::UPC_EAN_EXTENSION => "UPC/EAN extension",
        BarcodeFormat::DXFilmEdge => "DX film edge",
        _ => "Barcode",
    }
    .to_owned()
}

/// Maps a Vision `VNBarcodeSymbology` identifier to Grab-it's human-readable
/// format name. Matching by string avoids strong links to symbols introduced
/// in newer macOS versions (such as Codabar or MicroQR on macOS 12).
#[cfg(any(target_os = "macos", test))]
fn vision_format_name(symbology: &str) -> String {
    match symbology {
        "VNBarcodeSymbologyQR" => "QR code",
        "VNBarcodeSymbologyMicroQR" => "Micro QR code",
        "VNBarcodeSymbologyAztec" => "Aztec",
        "VNBarcodeSymbologyDataMatrix" => "Data Matrix",
        "VNBarcodeSymbologyPDF417" | "VNBarcodeSymbologyMicroPDF417" => "PDF417",
        "VNBarcodeSymbologyCodabar" => "Codabar",
        "VNBarcodeSymbologyCode39"
        | "VNBarcodeSymbologyCode39Checksum"
        | "VNBarcodeSymbologyCode39FullASCII"
        | "VNBarcodeSymbologyCode39FullASCIIChecksum" => "Code 39",
        "VNBarcodeSymbologyCode93" | "VNBarcodeSymbologyCode93i" => "Code 93",
        "VNBarcodeSymbologyCode128" => "Code 128",
        "VNBarcodeSymbologyEAN8" => "EAN-8",
        "VNBarcodeSymbologyEAN13" => "EAN-13",
        "VNBarcodeSymbologyI2of5"
        | "VNBarcodeSymbologyI2of5Checksum"
        | "VNBarcodeSymbologyITF14" => "ITF",
        "VNBarcodeSymbologyGS1DataBar" | "VNBarcodeSymbologyGS1DataBarLimited" => "GS1 DataBar",
        "VNBarcodeSymbologyGS1DataBarExpanded" => "GS1 DataBar Expanded",
        "VNBarcodeSymbologyUPCE" => "UPC-E",
        _ => "Barcode",
    }
    .to_owned()
}

#[cfg(target_os = "macos")]
mod mac {
    use image::RgbaImage;
    use objc2::{AnyThread, rc::autoreleasepool, runtime::AnyClass};
    use objc2_core_foundation::CFData;
    use objc2_core_graphics::{
        CGBitmapInfo, CGColorRenderingIntent, CGColorSpace, CGDataProvider, CGImage,
        CGImageAlphaInfo,
    };
    use objc2_foundation::{NSArray, NSDictionary};
    use objc2_vision::{VNDetectBarcodesRequest, VNImageRequestHandler, VNRequest};

    use super::{Code, sort_and_dedup, vision_format_name};

    /// Decodes barcodes in `image` with Vision, or returns `None` when
    /// `VNDetectBarcodesRequest` is absent on this macOS version.
    pub fn decode(image: &RgbaImage) -> Option<Result<Vec<Code>, String>> {
        AnyClass::get(c"VNDetectBarcodesRequest")?;
        Some(autoreleasepool(|_| detect(image)))
    }

    fn cg_image(image: &RgbaImage) -> Result<objc2_core_foundation::CFRetained<CGImage>, String> {
        let (width, height) = image.dimensions();
        let (w, h) = (width as usize, height as usize);
        let mut rgb = Vec::with_capacity(w * h * 3);
        for pixel in image.pixels() {
            rgb.extend_from_slice(&pixel.0[..3]);
        }
        let data = CFData::from_bytes(&rgb);
        let provider = CGDataProvider::with_cf_data(Some(&data))
            .ok_or("could not hand the image to Vision")?;
        let space = CGColorSpace::new_device_rgb().ok_or("no RGB colour space")?;
        // SAFETY: the provider holds w * h packed 8-bit RGB pixels, three
        // bytes each, and `decode` may be null.
        unsafe {
            CGImage::new(
                w,
                h,
                8,
                24,
                w * 3,
                Some(&space),
                CGBitmapInfo(CGImageAlphaInfo::None.0),
                Some(&provider),
                std::ptr::null(),
                false,
                CGColorRenderingIntent::RenderingIntentDefault,
            )
        }
        .ok_or_else(|| "could not make an image for Vision".to_owned())
    }

    fn detect(image: &RgbaImage) -> Result<Vec<Code>, String> {
        let (w, h) = image.dimensions();
        let (wf, hf) = (f64::from(w), f64::from(h));
        let cg_image = cg_image(image)?;

        // SAFETY: class existence was verified via `AnyClass::get`.
        let request = unsafe { VNDetectBarcodesRequest::new() };
        // SAFETY: fresh handler over a valid CGImage with empty options.
        let handler = unsafe {
            VNImageRequestHandler::initWithCGImage_options(
                VNImageRequestHandler::alloc(),
                &cg_image,
                &NSDictionary::new(),
            )
        };
        let requests: &VNRequest = &request;
        handler
            .performRequests_error(&NSArray::from_slice(&[requests]))
            .map_err(|err| err.localizedDescription().to_string())?;

        // SAFETY: plain property read on a finished request.
        let Some(observations) = (unsafe { request.results() }) else {
            return Ok(Vec::new());
        };
        let mut found: Vec<((i64, i64), Code)> = Vec::new();
        for observation in observations.iter() {
            // SAFETY: plain property reads on a finished observation.
            let Some(payload) = (unsafe { observation.payloadStringValue() }) else {
                continue;
            };
            let value = payload.to_string();
            if value.trim().is_empty() {
                continue;
            }
            let symbology = unsafe { observation.symbology() }.to_string();
            let bbox = unsafe { observation.boundingBox() };
            let x = (bbox.origin.x * wf).floor().clamp(0.0, wf) as i64;
            let y = ((1.0 - (bbox.origin.y + bbox.size.height)) * hf)
                .floor()
                .clamp(0.0, hf) as i64;
            found.push(((x, y), Code::new(vision_format_name(&symbology), value)));
        }
        Ok(sort_and_dedup(found))
    }
}

/// Whether `value` is an http:// or https:// link and nothing else. Only
/// these are offered to open: a code could hold any other scheme.
pub fn is_link(value: &str) -> bool {
    let value = value.trim();
    let lower = value.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    match rest {
        Some(rest) => !rest.is_empty() && !value.chars().any(char::is_whitespace),
        None => false,
    }
}

/// The values of `codes`, one per line, as Capture text copies them.
pub fn values(codes: &[Code]) -> String {
    codes
        .iter()
        .map(|code| code.value.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use image::{Rgba, imageops};
    use rxing::{MultiFormatWriter, Writer};

    /// `value` drawn as a black-on-white `format` code of about
    /// `width` x `height` pixels, quiet zone included.
    pub fn draw(value: &str, format: BarcodeFormat, width: u32, height: u32) -> RgbaImage {
        let matrix = MultiFormatWriter
            .encode(value, &format, width as i32, height as i32)
            .expect("rxing could not draw the code");
        RgbaImage::from_fn(matrix.width(), matrix.height(), |x, y| {
            if matrix.get(x, y) {
                Rgba([0, 0, 0, 255])
            } else {
                Rgba([255, 255, 255, 255])
            }
        })
    }

    /// A white canvas of `width` x `height`.
    pub fn canvas(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]))
    }

    #[test]
    fn reads_a_qr_code() {
        let image = draw(
            "https://example.com/a?b=1",
            BarcodeFormat::QR_CODE,
            240,
            240,
        );
        assert_eq!(
            decode(&image),
            vec![Code {
                format: "QR code".into(),
                value: "https://example.com/a?b=1".into(),
                is_link: true,
            }]
        );
    }

    #[test]
    fn reads_a_code_128_barcode() {
        let image = draw("GRAB-IT 0043", BarcodeFormat::CODE_128, 480, 120);
        assert_eq!(
            decode(&image),
            vec![Code {
                format: "Code 128".into(),
                value: "GRAB-IT 0043".into(),
                is_link: false,
            }]
        );
    }

    #[test]
    fn reads_a_code_drawn_light_on_dark() {
        let mut image = draw("inverted", BarcodeFormat::QR_CODE, 240, 240);
        imageops::invert(&mut image);
        let values: Vec<_> = decode(&image).into_iter().map(|code| code.value).collect();
        assert_eq!(values, ["inverted"]);
    }

    #[test]
    fn reads_several_codes_in_reading_order() {
        let mut image = canvas(1100, 420);
        let qr = draw("first", BarcodeFormat::QR_CODE, 260, 260);
        let bar = draw("second", BarcodeFormat::CODE_128, 440, 140);
        imageops::overlay(&mut image, &qr, 40, 60);
        imageops::overlay(&mut image, &bar, 600, 120);
        let codes = decode(&image);
        let found: Vec<_> = codes
            .iter()
            .map(|code| (code.format.as_str(), code.value.as_str()))
            .collect();
        assert_eq!(found, [("QR code", "first"), ("Code 128", "second")]);
        assert_eq!(values(&codes), "first\nsecond");
    }

    #[test]
    fn an_image_without_codes_has_none() {
        assert!(decode(&canvas(300, 200)).is_empty());
        // A soft gradient with a solid block on it, like a button.
        let mut shapes = RgbaImage::from_fn(300, 200, |x, _| {
            let shade = 120 + (x * 120 / 300) as u8;
            Rgba([shade, shade, shade, 255])
        });
        imageops::overlay(
            &mut shapes,
            &RgbaImage::from_pixel(120, 60, Rgba([20, 20, 20, 255])),
            90,
            70,
        );
        assert!(decode(&shapes).is_empty());
        assert!(decode(&RgbaImage::new(0, 0)).is_empty());
    }

    #[test]
    fn only_http_and_https_values_are_links() {
        assert!(is_link("https://example.com"));
        assert!(is_link("HTTP://EXAMPLE.COM/path"));
        assert!(is_link(" https://example.com/x \n"));
        assert!(!is_link("https://"));
        assert!(!is_link("https://example.com and more"));
        assert!(!is_link("javascript:alert(1)"));
        assert!(!is_link("file:///etc/passwd"));
        assert!(!is_link("mailto:a@example.com"));
        assert!(!is_link("WIFI:S:home;T:WPA;P:secret;;"));
        assert!(!is_link("example.com"));
        assert!(Code::new("QR code", "https://a.example").is_link);
        assert!(!Code::new("QR code", "hello").is_link);
    }

    #[test]
    fn prose_fixture_does_not_false_trigger_a_barcode() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("ocr-two-paragraphs.png");
        let image = image::open(fixture).unwrap().into_rgba8();
        assert_eq!(decode_with_rxing(&image), vec![]);
        assert_eq!(decode(&image), vec![]);
    }

    #[test]
    fn rxing_keeps_real_1d_inverted_and_2d_codes() {
        let code128 = draw("GRAB-IT 0043", BarcodeFormat::CODE_128, 480, 120);
        assert_eq!(
            decode_with_rxing(&code128),
            vec![Code::new("Code 128", "GRAB-IT 0043")]
        );

        let mut inverted_1d = draw("DARK-1D-42", BarcodeFormat::CODE_128, 480, 120);
        imageops::invert(&mut inverted_1d);
        assert_eq!(
            decode_with_rxing(&inverted_1d),
            vec![Code::new("Code 128", "DARK-1D-42")]
        );

        let ean8 = draw("96385074", BarcodeFormat::EAN_8, 320, 120);
        assert_eq!(
            decode_with_rxing(&ean8),
            vec![Code::new("EAN-8", "96385074")]
        );

        let qr = draw("https://example.com/2d", BarcodeFormat::QR_CODE, 240, 240);
        assert_eq!(
            decode_with_rxing(&qr),
            vec![Code::new("QR code", "https://example.com/2d")]
        );

        let dm = draw("dm-payload", BarcodeFormat::DATA_MATRIX, 200, 200);
        assert_eq!(
            decode_with_rxing(&dm),
            vec![Code::new("Data Matrix", "dm-payload")]
        );
    }

    #[test]
    fn single_scanline_1d_impostor_is_rejected() {
        // Paste only a 3 px tall sliver of a real Code 128 barcode onto a
        // white canvas: one scanline decodes, but parallel bands 4 px away do
        // not, so validation rejects it just as it rejects prose hits.
        let full = draw("FAKE-ROW-1", BarcodeFormat::CODE_128, 480, 120);
        let sliver = imageops::crop_imm(&full, 0, 58, full.width(), 3).to_image();
        let mut page = canvas(full.width(), 120);
        imageops::overlay(&mut page, &sliver, 0, 58);
        assert_eq!(decode_with_rxing(&page), vec![]);
    }

    #[test]
    fn vision_symbologies_map_to_human_format_names() {
        assert_eq!(vision_format_name("VNBarcodeSymbologyQR"), "QR code");
        assert_eq!(
            vision_format_name("VNBarcodeSymbologyMicroQR"),
            "Micro QR code"
        );
        assert_eq!(vision_format_name("VNBarcodeSymbologyAztec"), "Aztec");
        assert_eq!(
            vision_format_name("VNBarcodeSymbologyDataMatrix"),
            "Data Matrix"
        );
        assert_eq!(vision_format_name("VNBarcodeSymbologyPDF417"), "PDF417");
        assert_eq!(vision_format_name("VNBarcodeSymbologyCode128"), "Code 128");
        assert_eq!(vision_format_name("VNBarcodeSymbologyCode39"), "Code 39");
        assert_eq!(vision_format_name("VNBarcodeSymbologyCode93"), "Code 93");
        assert_eq!(vision_format_name("VNBarcodeSymbologyEAN8"), "EAN-8");
        assert_eq!(vision_format_name("VNBarcodeSymbologyEAN13"), "EAN-13");
        assert_eq!(vision_format_name("VNBarcodeSymbologyUPCE"), "UPC-E");
        assert_eq!(vision_format_name("VNBarcodeSymbologyI2of5"), "ITF");
        assert_eq!(vision_format_name("VNBarcodeSymbologyITF14"), "ITF");
        assert_eq!(vision_format_name("VNBarcodeSymbologyCodabar"), "Codabar");
        assert_eq!(
            vision_format_name("VNBarcodeSymbologyGS1DataBar"),
            "GS1 DataBar"
        );
        assert_eq!(
            vision_format_name("VNBarcodeSymbologyGS1DataBarExpanded"),
            "GS1 DataBar Expanded"
        );
        assert_eq!(vision_format_name("VNBarcodeSymbologyUnknown"), "Barcode");
    }
}
