//! Grabbing a recording's frames fast enough for 60 fps, per platform.
//!
//! - **X11**: only the recorded area is read (`Monitor::capture_region`),
//!   and the pointer is drawn in from the XFixes cursor image.
//! - **Windows**: frames come from DXGI desktop duplication
//!   (`Monitor::video_recorder`) and are cropped to the area; the pointer
//!   is drawn in with `GetCursorInfo` and `DrawIconEx`.
//! - **macOS**: Grab-it runs its own `AVCaptureScreenInput` session cropped
//!   to the area, which draws the pointer itself when asked
//!   (`capturesCursor`). xcap's recorder always captures the pointer.
//!
//! Each frame also says where the pointer was, for the `.cursor.json`
//! sidecar (see record.rs), whether or not it is drawn.

use image::RgbaImage;

use crate::{
    capture::Rect,
    pointer::{Pointer, pointer_in_frame},
    screen::MonitorInfo,
};

/// One frame of the recorded area, at its own size.
pub struct Grabbed {
    pub image: RgbaImage,
    /// Where the pointer's hot spot was, in the frame's pixels from its
    /// top-left corner. It may lie outside the frame. `None` when the
    /// platform could not say.
    pub pointer: Option<(i32, i32)>,
}

/// Grabs frames of one area of one monitor.
pub trait FrameSource {
    fn grab(&mut self) -> Result<Grabbed, String>;
}

/// Opens the fastest way this platform has to grab `rect` of `monitor`.
/// `rect` is in the pixels of the monitor's image. `fps` is the most
/// frames a second that will be asked for.
pub fn open(
    monitor: &MonitorInfo,
    rect: Rect,
    fps: u32,
    show_cursor: bool,
) -> Result<Box<dyn FrameSource>, String> {
    #[cfg(target_os = "macos")]
    match mac::ScreenInput::open(monitor, rect, fps, show_cursor) {
        Ok(source) => return Ok(Box::new(source)),
        Err(err) => eprintln!("Grab-it: recording without AVFoundation: {err}"),
    }
    #[cfg(target_os = "windows")]
    match win::Duplication::open(monitor, rect, show_cursor) {
        Ok(source) => return Ok(Box::new(source)),
        Err(err) => eprintln!("Grab-it: recording without desktop duplication: {err}"),
    }
    let _ = fps;
    Ok(Box::new(RegionSource::open(monitor, rect, show_cursor)?))
}

/// Opens a synchronous screen reader, with no cached video frames. Use after
/// hiding capture controls when the next image must reflect that hide.
/// Unlike `open`, every `grab` requests a new screen image from the OS.
pub fn open_synchronous(monitor: &MonitorInfo, rect: Rect) -> Result<Box<dyn FrameSource>, String> {
    Ok(Box::new(RegionSource::open(monitor, rect, false)?))
}

/// Copies `rect` out of an RGBA image of `width` × `height` whose rows are
/// `pitch` bytes apart, as GPU buffers often are. `None` when `rect` is
/// outside the image or `raw` is too short.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn crop_rows(
    raw: &[u8],
    width: u32,
    height: u32,
    pitch: usize,
    rect: Rect,
) -> Option<RgbaImage> {
    let rect = crate::capture::clip_rect(rect, (width, height))?;
    let row_bytes = rect.width as usize * 4;
    let mut out = Vec::with_capacity(row_bytes * rect.height as usize);
    for row in 0..rect.height as usize {
        let start = (rect.y as usize + row) * pitch + rect.x as usize * 4;
        out.extend_from_slice(raw.get(start..start + row_bytes)?);
    }
    RgbaImage::from_raw(rect.width, rect.height, out)
}

/// Grabs the area with xcap one frame at a time: X11, and elsewhere when
/// the faster way could not start.
struct RegionSource {
    monitor: xcap::Monitor,
    rect: Rect,
    origin: (i32, i32),
    scale: f64,
    show_cursor: bool,
    pointer: Option<Pointer>,
}

impl RegionSource {
    fn open(info: &MonitorInfo, rect: Rect, show_cursor: bool) -> Result<Self, String> {
        let monitors =
            xcap::Monitor::all().map_err(|err| format!("could not list monitors: {err}"))?;
        let monitor = monitors
            .into_iter()
            .nth(info.index)
            .ok_or_else(|| format!("monitor {} is no longer connected", info.index + 1))?;
        Ok(Self {
            monitor,
            rect,
            origin: (info.x, info.y),
            scale: desktop_scale(info),
            show_cursor,
            pointer: Pointer::open(),
        })
    }

    #[cfg(not(target_os = "macos"))]
    fn grab_image(&self) -> Result<RgbaImage, String> {
        let rect = self.rect;
        if rect.x < 0 || rect.y < 0 {
            return Err("the recorded area is off screen".to_owned());
        }
        self.monitor
            .capture_region(rect.x as u32, rect.y as u32, rect.width, rect.height)
            .map_err(|err| format!("could not capture the recorded area: {err}"))
    }

    /// xcap's macOS regions are in points; the whole monitor is grabbed
    /// and cropped instead.
    #[cfg(target_os = "macos")]
    fn grab_image(&self) -> Result<RgbaImage, String> {
        let image = self
            .monitor
            .capture_image()
            .map_err(|err| format!("could not capture the monitor: {err}"))?;
        crate::capture::crop(&image, self.rect)
            .ok_or_else(|| "the recorded area is off screen".to_owned())
    }
}

impl FrameSource for RegionSource {
    fn grab(&mut self) -> Result<Grabbed, String> {
        let mut image = self.grab_image()?;
        let (origin, scale, rect, show) = (self.origin, self.scale, self.rect, self.show_cursor);
        let pointer = self.pointer.as_mut().and_then(|pointer| {
            let at = pointer_in_frame(pointer.position()?, origin, scale, rect);
            if show {
                pointer.draw(&mut image, at);
            }
            Some(at)
        });
        Ok(Grabbed { image, pointer })
    }
}

/// Image pixels per desktop unit.
fn desktop_scale(info: &MonitorInfo) -> f64 {
    if cfg!(target_os = "macos") && info.scale_factor.is_finite() && info.scale_factor > 0.0 {
        info.scale_factor
    } else {
        1.0
    }
}

/// Windows: DXGI desktop duplication through xcap's recorder.
#[cfg(target_os = "windows")]
mod win {
    use std::{
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
            mpsc::{self, RecvTimeoutError, Sender},
        },
        time::Duration,
    };

    use xcap::{Frame, Monitor};

    use super::{FrameSource, Grabbed, RegionSource, crop_rows};
    use crate::pointer::pointer_in_frame;
    use crate::{capture::Rect, screen::MonitorInfo};

    /// How long the duplication thread waits for a frame before it looks
    /// for a Start or Stop.
    const POLL: Duration = Duration::from_millis(100);
    /// How long opening a monitor's duplication may take.
    const OPEN_TIMEOUT: Duration = Duration::from_secs(5);

    /// One monitor's desktop duplication, opened once and kept for the
    /// life of the app: xcap's duplication thread never ends, so opening
    /// one per recording would leave a live duplication behind each time,
    /// until DXGI refused to open more. Recordings start and stop it.
    struct Duplicator {
        monitor: u32,
        commands: Mutex<Sender<bool>>,
        /// The newest frame of the whole monitor while started.
        latest: Arc<Mutex<Option<Frame>>>,
        /// False once xcap's thread has ended (the duplication was lost,
        /// say to a mode change), so the next recording opens a new one.
        alive: Arc<AtomicBool>,
    }

    /// The duplications opened so far, one a monitor.
    static DUPLICATORS: Mutex<Vec<Arc<Duplicator>>> = Mutex::new(Vec::new());

    impl Duplicator {
        /// The monitor's duplication, opened the first time it is asked
        /// for or after the last one was lost.
        fn get(monitor: u32) -> Result<Arc<Self>, String> {
            let mut all = DUPLICATORS.lock().unwrap_or_else(|p| p.into_inner());
            all.retain(|known| known.alive.load(Ordering::SeqCst));
            if let Some(known) = all.iter().find(|known| known.monitor == monitor) {
                return Ok(Arc::clone(known));
            }
            let opened = Arc::new(Self::open(monitor)?);
            all.push(Arc::clone(&opened));
            Ok(opened)
        }

        /// Opens the duplication on a thread of its own, which keeps xcap's
        /// recorder (not `Send`) and copies its frames into `latest`.
        fn open(monitor: u32) -> Result<Self, String> {
            let (commands, received) = mpsc::channel::<bool>();
            let (ready, opened) = mpsc::channel::<Result<(), String>>();
            let latest = Arc::new(Mutex::new(None));
            let alive = Arc::new(AtomicBool::new(true));
            let (slot, living) = (Arc::clone(&latest), Arc::clone(&alive));
            std::thread::Builder::new()
                .name("grab-it-duplication".into())
                .spawn(move || {
                    let recorder = Monitor::all()
                        .map_err(|err| err.to_string())
                        .and_then(|monitors| {
                            monitors
                                .into_iter()
                                .find(|candidate| candidate.id().ok() == Some(monitor))
                                .ok_or_else(|| "the monitor is no longer connected".to_owned())
                        })
                        .and_then(|found| found.video_recorder().map_err(|err| err.to_string()));
                    let (recorder, frames) = match recorder {
                        Ok(opened) => opened,
                        Err(err) => {
                            living.store(false, Ordering::SeqCst);
                            let _ = ready.send(Err(err));
                            return;
                        }
                    };
                    let _ = ready.send(Ok(()));
                    // Frames that arrive while stopped were captured for
                    // the last recording (or none) and are thrown away.
                    let mut started = false;
                    loop {
                        while let Ok(start) = received.try_recv() {
                            started = start;
                            // Each recording waits for a fresh frame rather
                            // than take one left from the last.
                            *slot.lock().unwrap_or_else(|p| p.into_inner()) = None;
                            let changed = if start {
                                recorder.start()
                            } else {
                                recorder.stop()
                            };
                            if let Err(err) = changed {
                                eprintln!("Grab-it: desktop duplication: {err}");
                            }
                        }
                        match frames.recv_timeout(POLL) {
                            Ok(frame) if started => {
                                *slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(frame);
                            }
                            Ok(_) => {}
                            Err(RecvTimeoutError::Timeout) => {}
                            // xcap's thread ended: the duplication is gone.
                            Err(RecvTimeoutError::Disconnected) => break,
                        }
                    }
                    living.store(false, Ordering::SeqCst);
                    *slot.lock().unwrap_or_else(|p| p.into_inner()) = None;
                })
                .map_err(|err| err.to_string())?;
            opened
                .recv_timeout(OPEN_TIMEOUT)
                .map_err(|_| "desktop duplication did not open".to_owned())??;
            Ok(Self {
                monitor,
                commands: Mutex::new(commands),
                latest,
                alive,
            })
        }

        fn send(&self, start: bool) {
            let _ = self
                .commands
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .send(start);
        }
    }

    pub struct Duplication {
        duplicator: Arc<Duplicator>,
        /// Grabs frames until duplication has sent one, and places the
        /// pointer.
        fallback: RegionSource,
    }

    impl Duplication {
        pub fn open(info: &MonitorInfo, rect: Rect, show_cursor: bool) -> Result<Self, String> {
            let fallback = RegionSource::open(info, rect, show_cursor)?;
            let monitor = fallback.monitor.id().map_err(|err| err.to_string())?;
            let duplicator = Duplicator::get(monitor)?;
            // Grabs fall back to GDI until a frame of this recording comes:
            // the thread may not see Start for up to a poll.
            *duplicator.latest.lock().unwrap_or_else(|p| p.into_inner()) = None;
            duplicator.send(true);
            Ok(Self {
                duplicator,
                fallback,
            })
        }
    }

    impl FrameSource for Duplication {
        fn grab(&mut self) -> Result<Grabbed, String> {
            // A lost duplication (a full-screen app, a UAC prompt, the lock
            // screen) sends nothing more: GDI takes over for the rest.
            if !self.duplicator.alive.load(Ordering::SeqCst) {
                return self.fallback.grab();
            }
            let cropped = {
                let latest = self
                    .duplicator
                    .latest
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                latest.as_ref().and_then(|frame| {
                    let pitch = frame.raw.len() / frame.height.max(1) as usize;
                    crop_rows(
                        &frame.raw,
                        frame.width,
                        frame.height,
                        pitch,
                        self.fallback.rect,
                    )
                })
            };
            let Some(mut image) = cropped else {
                return self.fallback.grab();
            };
            let source = &mut self.fallback;
            let (origin, scale, rect, show) =
                (source.origin, source.scale, source.rect, source.show_cursor);
            let pointer = source.pointer.as_mut().and_then(|pointer| {
                let at = pointer_in_frame(pointer.position()?, origin, scale, rect);
                if show {
                    pointer.draw(&mut image, at);
                }
                Some(at)
            });
            Ok(Grabbed { image, pointer })
        }
    }

    impl Drop for Duplication {
        fn drop(&mut self) {
            self.duplicator.send(false);
        }
    }
}

/// macOS: Grab-it's own AVCaptureScreenInput session, cropped to the area.
#[cfg(target_os = "macos")]
mod mac {
    use std::{
        slice,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    use dispatch2::{DispatchQueue, DispatchQueueAttr};
    use image::RgbaImage;
    use objc2::{
        AllocAnyThread, DefinedClass, define_class, msg_send, rc::Retained, runtime::ProtocolObject,
    };
    use objc2_av_foundation::{
        AVCaptureConnection, AVCaptureOutput, AVCaptureScreenInput, AVCaptureSession,
        AVCaptureVideoDataOutput, AVCaptureVideoDataOutputSampleBufferDelegate,
    };
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_media::{CMSampleBuffer, CMTime};
    use objc2_core_video::{
        CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
        CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth,
        CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
        kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_32BGRA,
    };
    use objc2_foundation::{NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSString};

    use super::{FrameSource, Grabbed, crop_rows};
    use crate::pointer::{Pointer, pointer_in_frame};
    use crate::{capture::Rect, screen::MonitorInfo};

    /// How long the session gets to send its first frame.
    const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(2);

    type Latest = Arc<Mutex<Option<RgbaImage>>>;

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "GrabItRecordingFrameDelegate"]
        #[ivars = Latest]
        struct FrameDelegate;

        unsafe impl NSObjectProtocol for FrameDelegate {}

        unsafe impl AVCaptureVideoDataOutputSampleBufferDelegate for FrameDelegate {
            #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
            unsafe fn capture_output_did_output_sample_buffer_from_connection(
                &self,
                _output: &AVCaptureOutput,
                sample_buffer: &CMSampleBuffer,
                _connection: &AVCaptureConnection,
            ) {
                if let Some(image) = unsafe { to_image(sample_buffer) } {
                    *self.ivars().lock().unwrap_or_else(|p| p.into_inner()) = Some(image);
                }
            }
        }
    );

    impl FrameDelegate {
        fn new(latest: Latest) -> Retained<Self> {
            let this = Self::alloc().set_ivars(latest);
            unsafe { msg_send![super(this), init] }
        }
    }

    /// The sample's BGRA pixels as an RGBA image.
    unsafe fn to_image(sample_buffer: &CMSampleBuffer) -> Option<RgbaImage> {
        let pixels = unsafe { sample_buffer.image_buffer() }?;
        unsafe { CVPixelBufferLockBaseAddress(&pixels, CVPixelBufferLockFlags::ReadOnly) };
        let image = unsafe { locked_to_image(&pixels) };
        unsafe { CVPixelBufferUnlockBaseAddress(&pixels, CVPixelBufferLockFlags::ReadOnly) };
        image
    }

    /// Copies a pixel buffer whose base address is locked.
    unsafe fn locked_to_image(pixels: &CVPixelBuffer) -> Option<RgbaImage> {
        if CVPixelBufferGetPixelFormatType(pixels) != kCVPixelFormatType_32BGRA {
            return None;
        }
        let width = CVPixelBufferGetWidth(pixels);
        let height = CVPixelBufferGetHeight(pixels);
        let pitch = CVPixelBufferGetBytesPerRow(pixels);
        let base = CVPixelBufferGetBaseAddress(pixels);
        if base.is_null() || width == 0 || height == 0 {
            return None;
        }
        let data = unsafe { slice::from_raw_parts(base.cast::<u8>(), pitch * height) };
        let whole = Rect {
            x: 0,
            y: 0,
            width: width as u32,
            height: height as u32,
        };
        let mut image = crop_rows(data, width as u32, height as u32, pitch, whole)?;
        for pixel in image.pixels_mut() {
            pixel.0.swap(0, 2);
        }
        Some(image)
    }

    pub struct ScreenInput {
        session: Retained<AVCaptureSession>,
        _input: Retained<AVCaptureScreenInput>,
        _output: Retained<AVCaptureVideoDataOutput>,
        _delegate: Retained<FrameDelegate>,
        latest: Latest,
        pointer: Pointer,
        origin: (i32, i32),
        scale: f64,
        rect: Rect,
    }

    impl ScreenInput {
        pub fn open(
            info: &MonitorInfo,
            rect: Rect,
            fps: u32,
            show_cursor: bool,
        ) -> Result<Self, String> {
            let monitors =
                xcap::Monitor::all().map_err(|err| format!("could not list monitors: {err}"))?;
            let display = monitors
                .get(info.index)
                .ok_or_else(|| format!("monitor {} is no longer connected", info.index + 1))?
                .id()
                .map_err(|err| err.to_string())?;
            let scale = super::desktop_scale(info);
            // In points, from the display's bottom-left corner.
            let crop = CGRect {
                origin: CGPoint {
                    x: f64::from(rect.x) / scale,
                    y: f64::from(info.height)
                        - (f64::from(rect.y) + f64::from(rect.height)) / scale,
                },
                size: CGSize {
                    width: f64::from(rect.width) / scale,
                    height: f64::from(rect.height) / scale,
                },
            };
            let latest: Latest = Arc::new(Mutex::new(None));
            unsafe {
                let session = AVCaptureSession::new();
                let input =
                    AVCaptureScreenInput::initWithDisplayID(AVCaptureScreenInput::alloc(), display)
                        .ok_or("could not open the display for recording")?;
                input.setCropRect(crop);
                input.setCapturesCursor(show_cursor);
                input.setCapturesMouseClicks(false);
                input.setMinFrameDuration(CMTime::new(1, fps.max(1) as i32));
                if !session.canAddInput(&input) {
                    return Err("the recording session refused the display".to_owned());
                }
                session.addInput(&input);

                let output = AVCaptureVideoDataOutput::new();
                output.setAlwaysDiscardsLateVideoFrames(true);
                let key = NSString::from_str(&kCVPixelBufferPixelFormatTypeKey.to_string());
                let format = NSNumber::new_u32(kCVPixelFormatType_32BGRA);
                let settings: Retained<NSDictionary<NSString>> =
                    NSDictionary::from_slices::<NSString>(&[key.as_ref()], &[format.as_ref()]);
                output.setVideoSettings(Some(&settings));
                if !session.canAddOutput(&output) {
                    return Err("the recording session refused its output".to_owned());
                }
                session.addOutput(&output);

                let delegate = FrameDelegate::new(Arc::clone(&latest));
                let protocol =
                    ProtocolObject::<dyn AVCaptureVideoDataOutputSampleBufferDelegate>::from_ref(
                        &*delegate,
                    );
                let queue = DispatchQueue::new("grab-it-recording", DispatchQueueAttr::SERIAL);
                let queue: &DispatchQueue = queue.as_ref();
                let _: () = msg_send![&output, setSampleBufferDelegate: protocol, queue: queue];
                session.startRunning();

                let source = Self {
                    session,
                    _input: input,
                    _output: output,
                    _delegate: delegate,
                    latest,
                    pointer: Pointer,
                    origin: (info.x, info.y),
                    scale,
                    rect,
                };
                let deadline = Instant::now() + FIRST_FRAME_TIMEOUT;
                while source.frame().is_none() {
                    if Instant::now() >= deadline {
                        return Err("the display sent no frames".to_owned());
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(source)
            }
        }

        fn frame(&self) -> Option<RgbaImage> {
            self.latest
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
        }
    }

    impl FrameSource for ScreenInput {
        fn grab(&mut self) -> Result<Grabbed, String> {
            let image = self
                .frame()
                .ok_or_else(|| "the display stopped sending frames".to_owned())?;
            // The session picks the frames' size; the pointer follows it.
            let ratio = f64::from(image.width()) / f64::from(self.rect.width.max(1));
            let pointer = self.pointer.position().map(|position| {
                let (x, y) = pointer_in_frame(position, self.origin, self.scale, self.rect);
                (
                    (f64::from(x) * ratio).round() as i32,
                    (f64::from(y) * ratio).round() as i32,
                )
            });
            Ok(Grabbed { image, pointer })
        }
    }

    impl Drop for ScreenInput {
        fn drop(&mut self) {
            unsafe { self.session.stopRunning() };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn rows_with_padding_are_cropped_to_the_area() {
        // 3×2 pixels, each row padded to 16 bytes as a GPU might.
        let pitch = 16;
        let mut raw = vec![0u8; pitch * 2];
        for y in 0..2 {
            for x in 0..3 {
                let at = y * pitch + x * 4;
                raw[at..at + 4].copy_from_slice(&[x as u8, y as u8, 7, 255]);
            }
        }
        let rect = Rect {
            x: 1,
            y: 0,
            width: 2,
            height: 2,
        };
        let image = crop_rows(&raw, 3, 2, pitch, rect).unwrap();
        assert_eq!(image.dimensions(), (2, 2));
        assert_eq!(image.get_pixel(0, 0), &Rgba([1, 0, 7, 255]));
        assert_eq!(image.get_pixel(1, 1), &Rgba([2, 1, 7, 255]));
        // Clipped to the image; nothing at all left is None.
        let wide = Rect {
            x: 2,
            y: 1,
            width: 10,
            height: 10,
        };
        assert_eq!(
            crop_rows(&raw, 3, 2, pitch, wide).unwrap().dimensions(),
            (1, 1)
        );
        let off = Rect {
            x: 5,
            y: 0,
            width: 1,
            height: 1,
        };
        assert!(crop_rows(&raw, 3, 2, pitch, off).is_none());
        // A short buffer is refused rather than read past.
        assert!(crop_rows(&raw[..20], 3, 2, pitch, rect).is_none());
    }
}
