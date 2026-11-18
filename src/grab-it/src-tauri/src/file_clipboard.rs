//! Copies images and files. File copies put files on the system clipboard as files, so pasting into a file
//! manager, a chat or a mail app attaches them rather than their pixels.
//!
//! - macOS: file URLs written to the general pasteboard (`NSPasteboard`).
//! - Windows: a `CF_HDROP` file list, as Explorer's Copy makes.
//! - Linux: a GTK clipboard offering `text/uri-list` and GNOME's
//!   `x-special/gnome-copied-files`, set on the main thread, which owns GTK.

use std::path::PathBuf;

use image::RgbaImage;
use tauri::AppHandle;

#[cfg(any(target_os = "macos", test))]
fn png_bytes(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|err| format!("could not encode the clipboard image: {err}"))?;
    Ok(bytes.into_inner())
}

/// Copies pixels to the clipboard. Call from a worker thread because macOS
/// waits for the main thread to publish the pasteboard item.
pub fn copy_image(app: &AppHandle, image: &RgbaImage) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let png = png_bytes(image)?;
        let tiff = mac::tiff_bytes(&png);
        on_main_thread(app, move || mac::write_image(png, tiff))
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let clip = tauri::image::Image::new(image.as_raw(), image.width(), image.height());
        app.clipboard()
            .write_image(&clip)
            .map_err(|err| format!("could not copy to the clipboard: {err}"))
    }
}

/// Puts `paths` on the clipboard as files.
pub fn copy_files(app: &AppHandle, paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("Nothing to copy.".into());
    }
    let paths = paths.to_vec();
    #[cfg(target_os = "linux")]
    {
        on_main_thread(app, move || linux::write(&paths))
    }
    #[cfg(target_os = "macos")]
    {
        on_main_thread(app, move || mac::write(&paths))
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        win::write(&paths)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, paths);
        Err("Copying files is not available on this system.".into())
    }
}

/// Runs `job` on the main thread and waits for what it returns. Called from
/// the command thread pool, never the main thread, so waiting cannot
/// deadlock.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn on_main_thread(
    app: &AppHandle,
    job: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (send, receive) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(job());
    })
    .map_err(|err| format!("could not copy the file: {err}"))?;
    receive
        .recv()
        .map_err(|_| "could not copy the file".to_owned())?
}

/// `path` as a `file://` URI: every byte but unreserved characters and `/`
/// percent-encoded, as file managers expect.
#[cfg(any(target_os = "linux", test))]
fn file_uri(path: &std::path::Path) -> String {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    };
    #[cfg(not(unix))]
    let bytes = path.to_string_lossy().replace('\\', "/").into_bytes();
    let mut uri = String::from("file://");
    if !bytes.starts_with(b"/") {
        uri.push('/');
    }
    for byte in bytes {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

/// The `text/uri-list` body for `uris` (RFC 2483): one per line, CRLF ended.
#[cfg(any(target_os = "linux", test))]
fn uri_list(uris: &[String]) -> String {
    uris.iter().map(|uri| format!("{uri}\r\n")).collect()
}

/// The `x-special/gnome-copied-files` body for `uris`: "copy", then one URI
/// a line, as Nautilus and its forks read a Copy.
#[cfg(any(target_os = "linux", test))]
fn gnome_copied_files(uris: &[String]) -> String {
    let mut body = String::from("copy");
    for uri in uris {
        body.push('\n');
        body.push_str(uri);
    }
    body
}

/// The bytes of a `CF_HDROP` clipboard entry: a `DROPFILES` header (20
/// bytes: the list's offset, a point and two flags, `fWide` set), then each
/// name in UTF-16 with its own NUL, and a NUL ending the list.
#[cfg(any(target_os = "windows", test))]
fn drop_files(names: &[Vec<u16>]) -> Vec<u8> {
    const HEADER: u32 = 20;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&HEADER.to_le_bytes()); // pFiles
    bytes.extend_from_slice(&0i32.to_le_bytes()); // pt.x
    bytes.extend_from_slice(&0i32.to_le_bytes()); // pt.y
    bytes.extend_from_slice(&0i32.to_le_bytes()); // fNC
    bytes.extend_from_slice(&1i32.to_le_bytes()); // fWide
    for name in names {
        for unit in name.iter().chain(std::iter::once(&0)) {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
    }
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes
}

#[cfg(target_os = "linux")]
mod linux {
    use std::path::PathBuf;

    use gtk::{Clipboard, TargetEntry, TargetFlags, gdk};

    const GNOME: u32 = 0;
    const URI_LIST: u32 = 1;
    const TEXT: u32 = 2;

    /// Takes the clipboard with the files' URIs. Runs on the main thread.
    pub fn write(paths: &[PathBuf]) -> Result<(), String> {
        let uris: Vec<String> = paths.iter().map(|path| super::file_uri(path)).collect();
        let gnome = super::gnome_copied_files(&uris);
        let list = super::uri_list(&uris);
        let text = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("\n");
        let targets = [
            TargetEntry::new("x-special/gnome-copied-files", TargetFlags::empty(), GNOME),
            TargetEntry::new("text/uri-list", TargetFlags::empty(), URI_LIST),
            TargetEntry::new("UTF8_STRING", TargetFlags::empty(), TEXT),
            TargetEntry::new("text/plain;charset=utf-8", TargetFlags::empty(), TEXT),
            TargetEntry::new("text/plain", TargetFlags::empty(), TEXT),
        ];
        let clipboard = Clipboard::get(&gdk::SELECTION_CLIPBOARD);
        let taken = clipboard.set_with_data(&targets, move |_, selection, info| {
            let body = match info {
                GNOME => &gnome,
                URI_LIST => &list,
                _ => &text,
            };
            selection.set(&selection.target(), 8, body.as_bytes());
        });
        if !taken {
            return Err("could not copy the file to the clipboard".into());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::path::PathBuf;

    use objc2::{AnyThread, rc::autoreleasepool, runtime::ProtocolObject};
    use objc2_app_kit::{
        NSImage, NSPasteboard, NSPasteboardItem, NSPasteboardTypePNG, NSPasteboardTypeTIFF,
        NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSData, NSString, NSURL};

    /// Converts on the calling worker, keeping the NSImage local to that thread.
    pub fn tiff_bytes(png: &[u8]) -> Option<Vec<u8>> {
        autoreleasepool(|_| {
            let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png))?;
            Some(image.TIFFRepresentation()?.to_vec())
        })
    }

    /// Publishes both formats as one image, in paste preference order.
    pub fn write_image(png: Vec<u8>, tiff: Option<Vec<u8>>) -> Result<(), String> {
        let item = NSPasteboardItem::new();
        // SAFETY: AppKit provides these immutable pasteboard type constants.
        if !item.setData_forType(&NSData::from_vec(png), unsafe { NSPasteboardTypePNG }) {
            return Err("could not put the PNG on the clipboard".into());
        }
        if let Some(tiff) = tiff {
            item.setData_forType(&NSData::from_vec(tiff), unsafe { NSPasteboardTypeTIFF });
        }
        let objects = NSArray::from_slice(&[ProtocolObject::from_ref(&*item)]);
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        if pasteboard.writeObjects(&objects) {
            Ok(())
        } else {
            Err("could not copy the image to the clipboard".into())
        }
    }

    /// Writes the files' URLs to the general pasteboard. Runs on the main
    /// thread.
    pub fn write(paths: &[PathBuf]) -> Result<(), String> {
        let urls: Vec<_> = paths
            .iter()
            .map(|path| NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy())))
            .collect();
        let writers: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = urls
            .iter()
            .map(|url| ProtocolObject::from_ref(&**url))
            .collect();
        let objects = NSArray::from_slice(&writers);
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        let written = pasteboard.writeObjects(&objects);
        if written {
            Ok(())
        } else {
            Err("could not copy the file to the clipboard".into())
        }
    }
}

#[cfg(target_os = "windows")]
mod win {
    use std::{os::windows::ffi::OsStrExt, path::PathBuf, thread, time::Duration};

    use ::windows::Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock},
            Ole::CF_HDROP,
        },
    };

    /// How often, and how far apart, opening a clipboard another app holds
    /// is tried.
    const OPEN_TRIES: u32 = 10;
    const OPEN_WAIT: Duration = Duration::from_millis(20);

    /// Puts a `CF_HDROP` list of the files on the clipboard.
    pub fn write(paths: &[PathBuf]) -> Result<(), String> {
        let names: Vec<Vec<u16>> = paths
            .iter()
            .map(|path| path.as_os_str().encode_wide().collect())
            .collect();
        let bytes = super::drop_files(&names);
        let fail = |err: ::windows::core::Error| {
            format!("could not copy the file to the clipboard: {err}")
        };
        // SAFETY: the memory is sized for `bytes`, written only while
        // locked, and handed to the clipboard (which then owns it) or freed.
        unsafe {
            let memory: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(fail)?;
            let target = GlobalLock(memory) as *mut u8;
            if target.is_null() {
                let _ = GlobalFree(Some(memory));
                return Err("could not copy the file to the clipboard".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
            let _ = GlobalUnlock(memory);

            let mut opened = OpenClipboard(None);
            for _ in 1..OPEN_TRIES {
                if opened.is_ok() {
                    break;
                }
                thread::sleep(OPEN_WAIT);
                opened = OpenClipboard(None);
            }
            if let Err(err) = opened {
                let _ = GlobalFree(Some(memory));
                return Err(fail(err));
            }
            let set = EmptyClipboard()
                .and_then(|()| SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(memory.0))));
            let _ = CloseClipboard();
            if let Err(err) = set {
                let _ = GlobalFree(Some(memory));
                return Err(fail(err));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn clipboard_png_preserves_the_pixels() {
        let image = RgbaImage::from_raw(2, 1, vec![20, 30, 40, 0, 90, 80, 70, 128]).unwrap();
        let png = png_bytes(&image).unwrap();
        let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png).unwrap();
        assert_eq!(decoded.into_rgba8(), image);
    }

    #[test]
    fn file_uris_escape_spaces_and_non_ascii_names() {
        assert_eq!(
            file_uri(Path::new("/home/me/Grab-it/originals/Login bug #2.png")),
            "file:///home/me/Grab-it/originals/Login%20bug%20%232.png"
        );
        assert_eq!(
            file_uri(Path::new("/tmp/café.mp4")),
            "file:///tmp/caf%C3%A9.mp4"
        );
    }

    #[test]
    fn linux_targets_list_each_uri() {
        let uris = vec!["file:///a.png".to_owned(), "file:///b%20c.mp4".to_owned()];
        assert_eq!(uri_list(&uris), "file:///a.png\r\nfile:///b%20c.mp4\r\n");
        assert_eq!(
            gnome_copied_files(&uris),
            "copy\nfile:///a.png\nfile:///b%20c.mp4"
        );
    }

    #[test]
    fn drop_files_is_a_wide_header_then_nul_separated_names() {
        let names: Vec<Vec<u16>> = ["C:\\a.png", "C:\\b.mp4"]
            .iter()
            .map(|name| name.encode_utf16().collect())
            .collect();
        let bytes = drop_files(&names);

        assert_eq!(
            &bytes[0..4],
            &20u32.to_le_bytes(),
            "the list starts after the header"
        );
        assert_eq!(&bytes[16..20], &1i32.to_le_bytes(), "the names are wide");
        let units: Vec<u16> = bytes[20..]
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let expected: Vec<u16> = "C:\\a.png\0C:\\b.mp4\0\0".encode_utf16().collect();
        assert_eq!(units, expected);
    }
}
