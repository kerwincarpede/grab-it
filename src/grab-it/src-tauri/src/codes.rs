//! Reading QR codes and barcodes in an image, with rxing (a port of ZXing).
//!
//! Capture text decodes the dragged area before reading its text: when it
//! holds a code, the code's value is what the user wanted. Every format
//! rxing knows is tried, 2D (QR, Data Matrix, Aztec, PDF417, MaxiCode) and
//! 1D (Code 128, EAN, UPC and the rest), and an area may hold several.

use image::RgbaImage;
use rxing::{BarcodeFormat, DecodeHints, RXingResult};
use serde::Serialize;

/// One code found in an image. Mirrors `QuickCode` in src/quick/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
/// there is none. Slow on a large image, as rxing tries hard to find codes.
pub fn decode(image: &RgbaImage) -> Vec<Code> {
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
        rxing::helpers::detect_multiple_in_luma_with_hints(luma, width, height, &mut hints)
    else {
        return Vec::new();
    };
    in_reading_order(results)
}

/// The codes in `results` in reading order, without empty values or
/// repeats (rxing can find one code twice while it searches around it).
fn in_reading_order(results: Vec<RXingResult>) -> Vec<Code> {
    let mut found: Vec<((i64, i64), Code)> = results
        .iter()
        .filter(|result| !result.getText().trim().is_empty())
        .map(|result| {
            let code = Code::new(format_name(result.getBarcodeFormat()), result.getText());
            (top_left(result), code)
        })
        .collect();
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
}
