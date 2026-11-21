//! The mouse pointer: where it is and what it looks like, per platform.
//!
//! Recordings ask for it every frame (see frames.rs). Captures take one
//! [`Snapshot`] when the screen is read, and keep it beside the saved
//! image as a [`CapturedPointer`] in `meta.json`, so the editor can show,
//! move or hide it; the PNG never has it drawn in.
//!
//! - **X11**: XFixes gives the place and the image.
//! - **Windows**: `GetCursorInfo` gives the place; the image is drawn with
//!   `DrawIconEx` over black and over white to recover its transparency.
//! - **macOS**: `CGEvent` gives the place and the system's current
//!   `NSCursor` the image.
//! - **Wayland**: nothing; the portal does not hand over the pointer.

use std::io::Cursor;

use base64::{Engine, prelude::BASE64_STANDARD};
use image::{ImageFormat, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

use crate::capture::Rect;

pub use platform::Pointer;

/// Where a pointer at `position`, in the desktop coordinates monitors are
/// placed in, lies in a frame of `rect`. `scale` is the monitor image's
/// pixels per desktop unit: 1 where desktop coordinates are pixels, the
/// backing scale on macOS, where they are points.
pub fn pointer_in_frame(
    position: (f64, f64),
    origin: (i32, i32),
    scale: f64,
    rect: Rect,
) -> (i32, i32) {
    let x = ((position.0 - f64::from(origin.0)) * scale).round() as i32;
    let y = ((position.1 - f64::from(origin.1)) * scale).round() as i32;
    (x - rect.x, y - rect.y)
}

/// A pointer image: premultiplied ARGB, one `u32` a pixel, as XFixes sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorImage {
    pub width: u32,
    pub height: u32,
    /// The pixel that points, from the image's top-left corner.
    pub hot: (u32, u32),
    pub argb: Vec<u32>,
}

/// Draws `cursor` over `frame` with its hot spot at `pointer`, in frame
/// pixels, clipping whatever falls outside the frame.
pub fn draw_cursor(frame: &mut RgbaImage, cursor: &CursorImage, pointer: (i32, i32)) {
    let left = i64::from(pointer.0) - i64::from(cursor.hot.0);
    let top = i64::from(pointer.1) - i64::from(cursor.hot.1);
    for cy in 0..cursor.height {
        let y = top + i64::from(cy);
        if y < 0 || y >= i64::from(frame.height()) {
            continue;
        }
        for cx in 0..cursor.width {
            let x = left + i64::from(cx);
            if x < 0 || x >= i64::from(frame.width()) {
                continue;
            }
            let Some(&argb) = cursor.argb.get((cy * cursor.width + cx) as usize) else {
                return;
            };
            let alpha = argb >> 24;
            if alpha == 0 {
                continue;
            }
            let source = [(argb >> 16) & 0xff, (argb >> 8) & 0xff, argb & 0xff];
            let pixel = frame.get_pixel_mut(x as u32, y as u32);
            for (channel, value) in source.iter().enumerate() {
                let under = u32::from(pixel.0[channel]);
                // Premultiplied: the colour already carries its alpha.
                let blended = value + (under * (255 - alpha) + 127) / 255;
                pixel.0[channel] = blended.min(255) as u8;
            }
            pixel.0[3] = 255;
        }
    }
}

impl CursorImage {
    /// The pointer from two drawings of it, one over opaque black and one
    /// over opaque white: where they differ, the pointer lets the
    /// background through.
    #[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
    pub fn from_backgrounds(black: &RgbaImage, white: &RgbaImage, hot: (u32, u32)) -> Self {
        let (width, height) = black.dimensions();
        let mut argb = Vec::with_capacity((width * height) as usize);
        for (dark, light) in black.pixels().zip(white.pixels()) {
            let through = (0..3)
                .map(|channel| i32::from(light.0[channel]) - i32::from(dark.0[channel]))
                .max()
                .unwrap_or(0)
                .clamp(0, 255) as u32;
            let alpha = 255 - through;
            // Over black, a premultiplied colour is drawn as it is.
            let [r, g, b, _] = dark.0.map(|value| u32::from(value).min(alpha));
            argb.push(alpha << 24 | r << 16 | g << 8 | b);
        }
        Self {
            width,
            height,
            hot,
            argb,
        }
    }

    /// Straight (not premultiplied) RGBA, as a PNG stores it.
    pub fn to_rgba(&self) -> Option<RgbaImage> {
        let mut out = RgbaImage::new(self.width, self.height);
        for (pixel, &argb) in out.pixels_mut().zip(&self.argb) {
            let alpha = argb >> 24;
            if alpha == 0 {
                continue;
            }
            let straight = |shift: u32| (((argb >> shift) & 0xff) * 255 + alpha / 2) / alpha;
            *pixel = Rgba([
                straight(16).min(255) as u8,
                straight(8).min(255) as u8,
                straight(0).min(255) as u8,
                alpha as u8,
            ]);
        }
        (self.argb.len() as u64 >= u64::from(self.width) * u64::from(self.height)).then_some(out)
    }

    /// Back from straight RGBA to premultiplied ARGB.
    pub fn from_rgba(image: &RgbaImage, hot: (u32, u32)) -> Self {
        let argb = image
            .pixels()
            .map(|pixel| {
                let [r, g, b, a] = pixel.0.map(u32::from);
                let pre = |value: u32| (value * a + 127) / 255;
                a << 24 | pre(r) << 16 | pre(g) << 8 | pre(b)
            })
            .collect();
        Self {
            width: image.width(),
            height: image.height(),
            hot,
            argb,
        }
    }
}

/// The pointer at the moment a capture read the screen.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// The hot spot, in the desktop coordinates monitors are placed in.
    pub position: (f64, f64),
    pub image: CursorImage,
    /// The image's pixels per desktop unit: 1 where desktop coordinates
    /// are pixels, 1 or 2 on macOS, where they are points.
    pub density: f64,
}

/// Reads the pointer's place and image now. `None` on Wayland, when the
/// pointer is hidden, or when the platform could not say.
pub fn snapshot() -> Option<Snapshot> {
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        return None;
    }
    let mut pointer = Pointer::open()?;
    let position = pointer.position()?;
    let (image, density) = pointer.image()?;
    let usable = image.width > 0 && image.height > 0 && density.is_finite() && density > 0.0;
    usable.then_some(Snapshot {
        position,
        image,
        density,
    })
}

/// A capture's pointer as `meta.json` keeps it. Mirrors `CapturedPointer`
/// in src/editor/api.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CapturedPointer {
    /// Where the hot spot is, in the saved image's pixels.
    pub x: i32,
    pub y: i32,
    /// The pixel that points, from the pointer image's top-left corner.
    pub hot_x: u32,
    pub hot_y: u32,
    /// The pointer image's size in pixels.
    pub width: u32,
    pub height: u32,
    /// The pointer image as a base64 PNG.
    pub image: String,
}

impl Snapshot {
    /// The pointer in an image of `crop`, where `crop` is in the pixels of
    /// an image whose top-left corner is the desktop point `origin` and
    /// which has `density` pixels per desktop unit. `None` when the hot
    /// spot falls outside `crop`.
    pub fn place(&self, origin: (f64, f64), density: f64, crop: Rect) -> Option<CapturedPointer> {
        if !(density.is_finite() && density > 0.0) {
            return None;
        }
        let x = ((self.position.0 - origin.0) * density).round() as i64 - i64::from(crop.x);
        let y = ((self.position.1 - origin.1) * density).round() as i64 - i64::from(crop.y);
        let inside =
            (0..i64::from(crop.width)).contains(&x) && (0..i64::from(crop.height)).contains(&y);
        if !inside {
            return None;
        }
        let mut rgba = self.image.to_rgba()?;
        let mut hot = self.image.hot;
        // A pointer drawn at another density than the image (a 1x pointer
        // over a Retina capture) is resized to look as it did.
        let ratio = density / self.density;
        if (ratio - 1.0).abs() > 0.01 {
            let resize = |value: u32| ((f64::from(value) * ratio).round() as u32).max(1);
            rgba = image::imageops::resize(
                &rgba,
                resize(rgba.width()),
                resize(rgba.height()),
                image::imageops::FilterType::Triangle,
            );
            hot = (
                (f64::from(hot.0) * ratio).round() as u32,
                (f64::from(hot.1) * ratio).round() as u32,
            );
        }
        let mut png = Vec::new();
        rgba.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .ok()?;
        Some(CapturedPointer {
            x: x as i32,
            y: y as i32,
            hot_x: hot.0,
            hot_y: hot.1,
            width: rgba.width(),
            height: rgba.height(),
            image: BASE64_STANDARD.encode(png),
        })
    }

    /// The pointer in a whole image of `size` taken of `monitor`.
    pub fn place_on_monitor(
        &self,
        monitor: &crate::screen::MonitorInfo,
        size: (u32, u32),
        crop: Option<Rect>,
    ) -> Option<CapturedPointer> {
        let density = if monitor.width > 0 {
            f64::from(size.0) / f64::from(monitor.width)
        } else {
            1.0
        };
        let crop = crop.unwrap_or(Rect {
            x: 0,
            y: 0,
            width: size.0,
            height: size.1,
        });
        self.place((f64::from(monitor.x), f64::from(monitor.y)), density, crop)
    }

    /// The pointer in an image of `size` with every monitor stitched in,
    /// as [`crate::capture::stitch`] lays them out.
    pub fn place_on_desktop(
        &self,
        monitors: &[crate::screen::MonitorInfo],
        size: (u32, u32),
    ) -> Option<CapturedPointer> {
        let left = monitors.iter().map(|m| m.x).min()?;
        let top = monitors.iter().map(|m| m.y).min()?;
        let right = monitors.iter().map(|m| m.x + m.width as i32).max()?;
        let bottom = monitors.iter().map(|m| m.y + m.height as i32).max()?;
        let area = Rect {
            x: left,
            y: top,
            width: (right - left).max(0) as u32,
            height: (bottom - top).max(0) as u32,
        };
        self.place_in_area(area, size)
    }

    /// The pointer in an image of `size` showing the desktop `area`.
    pub fn place_in_area(&self, area: Rect, size: (u32, u32)) -> Option<CapturedPointer> {
        let density = if area.width > 0 {
            f64::from(size.0) / f64::from(area.width)
        } else {
            1.0
        };
        self.place(
            (f64::from(area.x), f64::from(area.y)),
            density,
            Rect {
                x: 0,
                y: 0,
                width: size.0,
                height: size.1,
            },
        )
    }
}

impl CapturedPointer {
    /// The pointer image, decoded; `None` when it is not a readable PNG.
    pub fn cursor(&self) -> Option<CursorImage> {
        let bytes = BASE64_STANDARD.decode(&self.image).ok()?;
        let image = image::load_from_memory_with_format(&bytes, ImageFormat::Png)
            .ok()?
            .to_rgba8();
        Some(CursorImage::from_rgba(&image, (self.hot_x, self.hot_y)))
    }
}

/// `image` with `pointer` drawn in, for the clipboard copy made at capture
/// time. The saved PNG never has it.
pub fn with_pointer(image: &RgbaImage, pointer: &CapturedPointer) -> RgbaImage {
    let mut out = image.clone();
    if let Some(cursor) = pointer.cursor() {
        draw_cursor(&mut out, &cursor, (pointer.x, pointer.y));
    }
    out
}

/// The pointer on X11: its place and image through XFixes.
#[cfg(target_os = "linux")]
mod platform {
    use image::RgbaImage;
    use x11rb::{
        connection::Connection as _, protocol::xfixes::ConnectionExt as _,
        rust_connection::RustConnection,
    };

    use super::{CursorImage, draw_cursor};

    pub struct Pointer {
        conn: RustConnection,
        cursor: Option<CursorImage>,
    }

    impl Pointer {
        pub fn open() -> Option<Self> {
            let (conn, _) = x11rb::connect(None).ok()?;
            conn.xfixes_query_version(4, 0).ok()?.reply().ok()?;
            conn.flush().ok()?;
            Some(Self { conn, cursor: None })
        }

        /// Where the pointer is on the desktop, keeping its image for
        /// [`Pointer::draw`].
        pub fn position(&mut self) -> Option<(f64, f64)> {
            let reply = self.conn.xfixes_get_cursor_image().ok()?.reply().ok()?;
            self.cursor = Some(CursorImage {
                width: u32::from(reply.width),
                height: u32::from(reply.height),
                hot: (u32::from(reply.xhot), u32::from(reply.yhot)),
                argb: reply.cursor_image,
            });
            Some((f64::from(reply.x), f64::from(reply.y)))
        }

        pub fn draw(&mut self, frame: &mut RgbaImage, at: (i32, i32)) {
            if let Some(cursor) = &self.cursor {
                draw_cursor(frame, cursor, at);
            }
        }

        /// The image seen by the last [`Pointer::position`], in pixels.
        pub fn image(&mut self) -> Option<(CursorImage, f64)> {
            self.cursor.clone().map(|cursor| (cursor, 1.0))
        }
    }
}

/// The pointer on Windows: `GetCursorInfo` for its place, `DrawIconEx` to
/// draw it, which gets inverting pointers such as the I-beam right.
#[cfg(target_os = "windows")]
mod platform {
    use ::windows::Win32::{
        Graphics::Gdi::{
            BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
            DIB_RGB_COLORS, DeleteDC, DeleteObject, GdiFlush, GetObjectW, HBITMAP, HGDIOBJ,
            SelectObject,
        },
        UI::WindowsAndMessaging::{
            CURSOR_SHOWING, CURSORINFO, DI_NORMAL, DrawIconEx, GetCursorInfo, GetIconInfo, HCURSOR,
            HICON, ICONINFO,
        },
    };
    use image::RgbaImage;

    use super::CursorImage;

    pub struct Pointer {
        /// The pointer last seen, if it was showing.
        current: Option<HCURSOR>,
        /// The last pointer measured, with its hot spot and size.
        shape: Option<(HCURSOR, (i32, i32), (i32, i32))>,
    }

    impl Pointer {
        pub fn open() -> Option<Self> {
            Some(Self {
                current: None,
                shape: None,
            })
        }

        pub fn position(&mut self) -> Option<(f64, f64)> {
            let mut info = CURSORINFO {
                cbSize: size_of::<CURSORINFO>() as u32,
                ..Default::default()
            };
            unsafe { GetCursorInfo(&mut info) }.ok()?;
            self.current = (info.flags.0 & CURSOR_SHOWING.0 != 0 && !info.hCursor.is_invalid())
                .then_some(info.hCursor);
            Some((f64::from(info.ptScreenPos.x), f64::from(info.ptScreenPos.y)))
        }

        /// The hot spot and size of `cursor`.
        fn shape(&mut self, cursor: HCURSOR) -> Option<((i32, i32), (i32, i32))> {
            if let Some((known, hot, size)) = self.shape
                && known == cursor
            {
                return Some((hot, size));
            }
            let mut info = ICONINFO::default();
            unsafe { GetIconInfo(HICON::from(cursor), &mut info) }.ok()?;
            let measure = |bitmap: HBITMAP| {
                let mut bits = BITMAP::default();
                let read = unsafe {
                    GetObjectW(
                        HGDIOBJ::from(bitmap),
                        size_of::<BITMAP>() as i32,
                        Some((&raw mut bits).cast()),
                    )
                };
                (read != 0).then_some((bits.bmWidth, bits.bmHeight))
            };
            let size = if info.hbmColor.is_invalid() {
                // A monochrome pointer: its mask holds the AND and XOR
                // halves one above the other.
                measure(info.hbmMask).map(|(width, height)| (width, height / 2))
            } else {
                measure(info.hbmColor)
            };
            unsafe {
                if !info.hbmColor.is_invalid() {
                    let _ = DeleteObject(info.hbmColor.into());
                }
                if !info.hbmMask.is_invalid() {
                    let _ = DeleteObject(info.hbmMask.into());
                }
            }
            let hot = (info.xHotspot as i32, info.yHotspot as i32);
            let size = size?;
            self.shape = Some((cursor, hot, size));
            Some((hot, size))
        }

        pub fn draw(&mut self, frame: &mut RgbaImage, at: (i32, i32)) {
            let Some(cursor) = self.current else {
                return;
            };
            let Some((hot, (width, height))) = self.shape(cursor) else {
                return;
            };
            if width <= 0 || height <= 0 {
                return;
            }
            let (left, top) = (at.0 - hot.0, at.1 - hot.1);
            unsafe { draw_icon(frame, HICON::from(cursor), (left, top), (width, height)) };
        }

        /// The pointer last seen by [`Pointer::position`], drawn once over
        /// black and once over white to recover its transparency. In
        /// pixels, as the desktop is.
        pub fn image(&mut self) -> Option<(CursorImage, f64)> {
            let cursor = self.current?;
            let (hot, (width, height)) = self.shape(cursor)?;
            if width <= 0 || height <= 0 || hot.0 < 0 || hot.1 < 0 {
                return None;
            }
            let size = (width as u32, height as u32);
            let mut black = RgbaImage::from_pixel(size.0, size.1, image::Rgba([0, 0, 0, 255]));
            let mut white =
                RgbaImage::from_pixel(size.0, size.1, image::Rgba([255, 255, 255, 255]));
            unsafe {
                draw_icon(&mut black, HICON::from(cursor), (0, 0), (width, height));
                draw_icon(&mut white, HICON::from(cursor), (0, 0), (width, height));
            }
            Some((
                CursorImage::from_backgrounds(&black, &white, (hot.0 as u32, hot.1 as u32)),
                1.0,
            ))
        }
    }

    /// Draws `icon` with its top-left corner at `corner` in `frame`: the
    /// pixels under it are copied into a bitmap, the icon is drawn over
    /// them there, and the result is copied back.
    unsafe fn draw_icon(frame: &mut RgbaImage, icon: HICON, corner: (i32, i32), size: (i32, i32)) {
        let (frame_width, frame_height) = (frame.width() as i32, frame.height() as i32);
        let (width, height) = size;
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return;
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    // Negative: rows run top to bottom.
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let Ok(bitmap) = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
            else {
                let _ = DeleteDC(dc);
                return;
            };
            let previous = SelectObject(dc, bitmap.into());
            let patch =
                std::slice::from_raw_parts_mut(bits.cast::<u8>(), (width * height * 4) as usize);
            let inside = |x: i32, y: i32| x >= 0 && y >= 0 && x < frame_width && y < frame_height;
            for y in 0..height {
                for x in 0..width {
                    let (fx, fy) = (corner.0 + x, corner.1 + y);
                    if inside(fx, fy) {
                        let [r, g, b, _] = frame.get_pixel(fx as u32, fy as u32).0;
                        let at = ((y * width + x) * 4) as usize;
                        patch[at..at + 4].copy_from_slice(&[b, g, r, 255]);
                    }
                }
            }
            if DrawIconEx(dc, 0, 0, icon, width, height, 0, None, DI_NORMAL).is_ok() {
                let _ = GdiFlush();
                for y in 0..height {
                    for x in 0..width {
                        let (fx, fy) = (corner.0 + x, corner.1 + y);
                        if inside(fx, fy) {
                            let at = ((y * width + x) * 4) as usize;
                            let (b, g, r) = (patch[at], patch[at + 1], patch[at + 2]);
                            frame.put_pixel(fx as u32, fy as u32, image::Rgba([r, g, b, 255]));
                        }
                    }
                }
            }
            SelectObject(dc, previous);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(dc);
        }
    }
}

/// The pointer on macOS: its place from `CGEvent`, and for captures its
/// image from the system's current `NSCursor`. Recordings leave the
/// drawing to AVFoundation.
#[cfg(target_os = "macos")]
mod platform {
    use image::{ImageFormat, RgbaImage};
    use objc2::{rc::Retained, runtime::AnyObject};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSCursor,
    };
    use objc2_core_graphics::CGEvent;
    use objc2_foundation::NSDictionary;

    use super::CursorImage;

    pub struct Pointer;

    impl Pointer {
        pub fn open() -> Option<Self> {
            Some(Self)
        }

        /// In global points from the top-left of the main display, as
        /// monitors are placed.
        pub fn position(&mut self) -> Option<(f64, f64)> {
            let event = CGEvent::new(None)?;
            let point = CGEvent::location(Some(&*event));
            Some((point.x, point.y))
        }

        pub fn draw(&mut self, _frame: &mut RgbaImage, _at: (i32, i32)) {}

        /// The pointer showing now, with its pixels per point.
        pub fn image(&mut self) -> Option<(CursorImage, f64)> {
            // Deprecated for capturing the screen, which is what this is:
            // `currentCursor` would only give Grab-it's own pointer.
            #[allow(deprecated)]
            let cursor = NSCursor::currentSystemCursor()?;
            let picture = cursor.image();
            let points = picture.size();
            let tiff = picture.TIFFRepresentation()?;
            let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
            let properties: Retained<NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>> =
                NSDictionary::new();
            // SAFETY: an empty dictionary is a valid set of properties.
            let png = unsafe {
                bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
            }?;
            let rgba = image::load_from_memory_with_format(&png.to_vec(), ImageFormat::Png)
                .ok()?
                .to_rgba8();
            let density = if points.width > 0.0 {
                f64::from(rgba.width()) / points.width
            } else {
                1.0
            };
            let spot = cursor.hotSpot();
            let hot = (
                (spot.x * density).round().max(0.0) as u32,
                (spot.y * density).round().max(0.0) as u32,
            );
            Some((CursorImage::from_rgba(&rgba, hot), density))
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
mod platform {
    use image::RgbaImage;

    pub struct Pointer;

    impl Pointer {
        pub fn open() -> Option<Self> {
            None
        }

        pub fn position(&mut self) -> Option<(f64, f64)> {
            None
        }

        pub fn draw(&mut self, _frame: &mut RgbaImage, _at: (i32, i32)) {}

        pub fn image(&mut self) -> Option<(super::CursorImage, f64)> {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(position: (f64, f64)) -> Snapshot {
        Snapshot {
            position,
            image: CursorImage {
                width: 2,
                height: 2,
                hot: (1, 1),
                argb: vec![0xffff0000, 0x00000000, 0x80808080, 0xff00ff00],
            },
            density: 1.0,
        }
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn the_snapshot_is_placed_in_the_saved_image_and_dropped_outside() {
        let shot = snapshot((2120.0, 80.0));
        // A region of a second monitor to the right of a 1920 px one.
        let placed = shot
            .place((1920.0, 0.0), 1.0, rect(100, 50, 400, 300))
            .unwrap();
        assert_eq!((placed.x, placed.y), (100, 30));
        assert_eq!((placed.hot_x, placed.hot_y), (1, 1));
        assert_eq!((placed.width, placed.height), (2, 2));
        // The same pointer is outside a region further down.
        assert!(
            shot.place((1920.0, 0.0), 1.0, rect(100, 100, 400, 300))
                .is_none()
        );
        // macOS: points at twice the pixels.
        let retina = snapshot((75.5, 40.0));
        let placed = retina
            .place((0.0, 0.0), 2.0, rect(100, 50, 400, 300))
            .unwrap();
        assert_eq!((placed.x, placed.y), (51, 30));
        // A 1x pointer over a 2x capture is drawn twice the size.
        assert_eq!((placed.width, placed.height), (4, 4));
        assert_eq!((placed.hot_x, placed.hot_y), (2, 2));
        // A window's own image: the area's size against the image's.
        let placed = retina
            .place_in_area(rect(50, 20, 100, 100), (200, 200))
            .unwrap();
        assert_eq!((placed.x, placed.y), (51, 40));
        // The right edge is outside.
        assert!(
            snapshot((150.0, 20.0))
                .place_in_area(rect(50, 20, 100, 100), (100, 100))
                .is_none()
        );
    }

    #[test]
    fn the_pointer_image_survives_the_round_trip_through_png() {
        let shot = snapshot((1.0, 1.0));
        let placed = shot.place((0.0, 0.0), 1.0, rect(0, 0, 4, 4)).unwrap();
        let cursor = placed.cursor().unwrap();
        assert_eq!(cursor.hot, (1, 1));
        assert_eq!((cursor.width, cursor.height), (2, 2));
        assert_eq!(cursor.argb[0], 0xffff0000);
        assert_eq!(cursor.argb[1] >> 24, 0);
        assert_eq!(cursor.argb[3], 0xff00ff00);
        // Half transparent: the colour comes back within rounding.
        let half = cursor.argb[2];
        assert_eq!(half >> 24, 0x80);
        assert!(((half >> 16) & 0xff).abs_diff(0x80) <= 1);
    }

    #[test]
    fn the_clipboard_copy_has_the_pointer_and_the_original_does_not() {
        let original = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 255, 255]));
        let placed = snapshot((2.0, 2.0))
            .place((0.0, 0.0), 1.0, rect(0, 0, 4, 4))
            .unwrap();
        let copy = with_pointer(&original, &placed);
        assert_eq!(copy.get_pixel(1, 1), &Rgba([255, 0, 0, 255]));
        assert_eq!(copy.get_pixel(2, 2), &Rgba([0, 255, 0, 255]));
        assert_eq!(copy.get_pixel(0, 0), &Rgba([0, 0, 255, 255]));
        assert_eq!(original.get_pixel(1, 1), &Rgba([0, 0, 255, 255]));
    }

    #[test]
    fn a_pointer_drawn_over_black_and_white_keeps_its_transparency() {
        let mut black = RgbaImage::from_pixel(3, 1, Rgba([0, 0, 0, 255]));
        let mut white = RgbaImage::from_pixel(3, 1, Rgba([255, 255, 255, 255]));
        // Opaque red; nothing; half-transparent black.
        black.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        white.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        white.put_pixel(2, 0, Rgba([128, 128, 128, 255]));
        let cursor = CursorImage::from_backgrounds(&black, &white, (0, 0));
        assert_eq!(cursor.argb, vec![0xffff0000, 0x00000000, 0x7f000000]);
    }

    #[test]
    fn the_pointer_is_placed_relative_to_the_recorded_area() {
        let rect = Rect {
            x: 100,
            y: 50,
            width: 400,
            height: 300,
        };
        // A second monitor to the right of a 1920 px one.
        assert_eq!(
            pointer_in_frame((2120.0, 80.0), (1920, 0), 1.0, rect),
            (100, 30)
        );
        // Left of and above the area: outside the frame.
        assert_eq!(
            pointer_in_frame((1950.0, 10.0), (1920, 0), 1.0, rect),
            (-70, -40)
        );
        // macOS: points at twice the pixels.
        assert_eq!(pointer_in_frame((75.5, 40.0), (0, 0), 2.0, rect), (51, 30));
    }

    #[test]
    fn the_cursor_is_drawn_at_its_hot_spot_and_clipped() {
        let mut frame = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 255, 255]));
        // 2×2: opaque red, transparent, half-transparent white, opaque green.
        let cursor = CursorImage {
            width: 2,
            height: 2,
            hot: (1, 1),
            argb: vec![0xffff0000, 0x00000000, 0x80808080, 0xff00ff00],
        };
        draw_cursor(&mut frame, &cursor, (2, 2));
        assert_eq!(frame.get_pixel(1, 1), &Rgba([255, 0, 0, 255]));
        assert_eq!(frame.get_pixel(2, 1), &Rgba([0, 0, 255, 255]));
        // 0x80 white premultiplied over blue.
        assert_eq!(frame.get_pixel(1, 2), &Rgba([128, 128, 255, 255]));
        assert_eq!(frame.get_pixel(2, 2), &Rgba([0, 255, 0, 255]));
        assert_eq!(frame.get_pixel(0, 0), &Rgba([0, 0, 255, 255]));

        // Hanging off the top-left corner: only the part inside is drawn.
        let mut frame = RgbaImage::from_pixel(2, 2, Rgba([0, 0, 0, 255]));
        draw_cursor(&mut frame, &cursor, (0, 0));
        assert_eq!(frame.get_pixel(0, 0), &Rgba([0, 255, 0, 255]));
        assert_eq!(frame.get_pixel(1, 1), &Rgba([0, 0, 0, 255]));
    }
}
