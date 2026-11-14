//! What the computer plays on macOS 13 and later: an audio-only
//! ScreenCaptureKit stream of the main display.
//!
//! ScreenCaptureKit sends the mix of everything playing, as 48 kHz float
//! samples, one plane a channel. The stream also captures the display, so
//! it is asked for the smallest picture at one frame a second, and those
//! frames are thrown away. It needs the Screen Recording permission, which
//! recording has already checked.
//!
//! ScreenCaptureKit is linked weakly (see build.rs), so Grab-it still starts
//! on macOS before 12.3, where it does not exist; [`available`] keeps it
//! from being used before 13, where it cannot capture sound.

use std::{
    path::Path,
    ptr::{self, NonNull},
    slice,
    sync::mpsc,
    time::{Duration, Instant},
};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchQueueAttr, DispatchRetained};
use objc2::{
    AllocAnyThread, DefinedClass, define_class, msg_send, rc::Retained, runtime::ProtocolObject,
};
use objc2_core_audio_types::{AudioBuffer, AudioBufferList};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{
    CMBlockBuffer, CMSampleBuffer, CMTime,
    kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
};
use objc2_foundation::{
    NSArray, NSError, NSObject, NSObjectProtocol, NSOperatingSystemVersion, NSProcessInfo,
};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamOutput, SCStreamOutputType, SCWindow,
};

use super::{START_TIMEOUT, SharedSink, Sink, interleave_planes, lock};

/// The sound ScreenCaptureKit is asked for.
const RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
/// How long stopping the stream may take.
const STOP_TIMEOUT: Duration = Duration::from_secs(2);

/// Whether this macOS can record what it plays: 13 or later.
pub fn available() -> bool {
    NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion {
        majorVersion: 13,
        minorVersion: 0,
        patchVersion: 0,
    })
}

/// An Objective-C object handed from the queue a completion handler runs
/// on to the thread waiting for it.
struct Handed<T>(T);

// SAFETY: only the retain count of the object is shared; the waiting
// thread is the only one that uses it once it is handed over.
unsafe impl<T> Send for Handed<T> {}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "GrabItSystemSoundOutput"]
    #[ivars = SharedSink]
    struct SoundOutput;

    unsafe impl NSObjectProtocol for SoundOutput {}

    unsafe impl SCStreamOutput for SoundOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn stream_did_output_sample_buffer_of_type(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            kind: SCStreamOutputType,
        ) {
            // The display's frames are only there because the stream
            // needs them.
            if kind != SCStreamOutputType::Audio {
                return;
            }
            let at = Instant::now();
            if let Some(samples) = unsafe { samples_of(sample_buffer) } {
                lock(self.ivars()).push(&samples, at);
            }
        }
    }
);

impl SoundOutput {
    fn new(sink: SharedSink) -> Retained<Self> {
        let this = Self::alloc().set_ivars(sink);
        unsafe { msg_send![super(this), init] }
    }
}

/// The sound in `sample_buffer` as interleaved 16-bit stereo.
unsafe fn samples_of(sample_buffer: &CMSampleBuffer) -> Option<Vec<i16>> {
    let mut needed = 0usize;
    // SAFETY: asks only for the size of the list; every out pointer but
    // that one is null.
    let status = unsafe {
        sample_buffer.audio_buffer_list_with_retained_block_buffer(
            &mut needed,
            ptr::null_mut(),
            0,
            None,
            None,
            0,
            ptr::null_mut(),
        )
    };
    if status != 0 || needed < size_of::<AudioBufferList>() {
        return None;
    }
    // u64s keep the list's pointers aligned.
    let mut storage = vec![0u64; needed.div_ceil(size_of::<u64>())];
    let list = storage.as_mut_ptr().cast::<AudioBufferList>();
    let mut block: *mut CMBlockBuffer = ptr::null_mut();
    // SAFETY: `list` has the room the call above asked for.
    let status = unsafe {
        sample_buffer.audio_buffer_list_with_retained_block_buffer(
            ptr::null_mut(),
            list,
            needed,
            None,
            None,
            kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            &mut block,
        )
    };
    // The samples point into the block, which is released when this returns.
    // SAFETY: the call hands back a retained block buffer, or null.
    let _block = NonNull::new(block).map(|block| unsafe { CFRetained::from_raw(block) });
    if status != 0 {
        return None;
    }
    // SAFETY: the call filled in the list, whose buffers run on past the
    // one its type declares, up to `mNumberBuffers`.
    let buffers: &[AudioBuffer] = unsafe {
        let count = (*list).mNumberBuffers as usize;
        slice::from_raw_parts((&raw const (*list).mBuffers).cast::<AudioBuffer>(), count)
    };
    let planes: Vec<(&[f32], usize)> = buffers
        .iter()
        .map(|buffer| {
            let samples: &[f32] = if buffer.mData.is_null() {
                &[]
            } else {
                // SAFETY: ScreenCaptureKit's sound is 32-bit float, and the
                // buffer holds `mDataByteSize` bytes of it.
                unsafe {
                    slice::from_raw_parts(
                        buffer.mData.cast::<f32>(),
                        buffer.mDataByteSize as usize / size_of::<f32>(),
                    )
                }
            };
            (samples, buffer.mNumberChannels.max(1) as usize)
        })
        .collect();
    Some(interleave_planes(&planes, usize::from(CHANNELS)))
}

/// The error a completion handler was given, as text, or None for none.
fn error_text(error: *mut NSError) -> Option<String> {
    // SAFETY: the handler is given a valid NSError or null.
    unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string())
}

/// The audio-only stream, stopped when dropped.
pub struct Stream {
    stream: Retained<SCStream>,
    _output: Retained<SoundOutput>,
    _queue: DispatchRetained<DispatchQueue>,
}

impl Stream {
    /// Starts recording what the computer plays into a WAV at `wav`.
    pub fn start(wav: &Path) -> Result<(Self, SharedSink), String> {
        if !available() {
            return Err("recording the system sound needs macOS 13 or later".to_owned());
        }
        let display = main_display()?;
        let sink = Sink::create(wav, CHANNELS, RATE, true)?;
        // SAFETY: plain ScreenCaptureKit calls on objects made here, with
        // the arguments they document.
        unsafe {
            let filter = SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &NSArray::<SCWindow>::new(),
            );
            let config = SCStreamConfiguration::new();
            config.setCapturesAudio(true);
            config.setSampleRate(RATE as isize);
            config.setChannelCount(isize::from(CHANNELS));
            config.setExcludesCurrentProcessAudio(true);
            // The picture is thrown away: as little of it as there can be.
            config.setWidth(2);
            config.setHeight(2);
            config.setMinimumFrameInterval(CMTime::new(1, 1));
            config.setQueueDepth(3);
            let stream = SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                None,
            );
            let output = SoundOutput::new(SharedSink::clone(&sink));
            let queue = DispatchQueue::new("grab-it-system-sound", DispatchQueueAttr::SERIAL);
            let protocol = ProtocolObject::<dyn SCStreamOutput>::from_ref(&*output);
            for kind in [SCStreamOutputType::Audio, SCStreamOutputType::Screen] {
                stream
                    .addStreamOutput_type_sampleHandlerQueue_error(protocol, kind, Some(&*queue))
                    .map_err(|err| {
                        format!(
                            "could not record the system sound: {}",
                            err.localizedDescription()
                        )
                    })?;
            }

            let (started_tx, started_rx) = mpsc::channel::<Option<String>>();
            let handler = RcBlock::new(move |error: *mut NSError| {
                let _ = started_tx.send(error_text(error));
            });
            stream.startCaptureWithCompletionHandler(Some(&*handler));
            let started = Self {
                stream,
                _output: output,
                _queue: queue,
            };
            match started_rx.recv_timeout(START_TIMEOUT) {
                Ok(None) => Ok((started, sink)),
                Ok(Some(err)) => Err(format!("could not record the system sound: {err}")),
                Err(_) => Err("the system sound did not start".to_owned()),
            }
        }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        let (stopped_tx, stopped_rx) = mpsc::channel::<()>();
        let handler = RcBlock::new(move |_error: *mut NSError| {
            let _ = stopped_tx.send(());
        });
        // SAFETY: stopping a stream that was started; one that failed to
        // start answers with an error, which is ignored.
        unsafe {
            self.stream
                .stopCaptureWithCompletionHandler(Some(&*handler))
        };
        let _ = stopped_rx.recv_timeout(STOP_TIMEOUT);
    }
}

/// The main display, which the stream needs although only its sound is
/// kept.
fn main_display() -> Result<Retained<SCDisplay>, String> {
    let (content_tx, content_rx) =
        mpsc::channel::<Result<Handed<Retained<SCShareableContent>>, String>>();
    let handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            // SAFETY: the handler is given a valid SCShareableContent or null.
            let content = unsafe { Retained::retain(content) };
            let _ = content_tx.send(match content {
                Some(content) => Ok(Handed(content)),
                None => {
                    Err(error_text(error).unwrap_or_else(|| "no screens to capture".to_owned()))
                }
            });
        },
    );
    // SAFETY: the handler only sends what it is given on a channel.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    let content = match content_rx.recv_timeout(START_TIMEOUT) {
        Ok(Ok(Handed(content))) => content,
        Ok(Err(err)) => return Err(format!("could not record the system sound: {err}")),
        Err(_) => return Err("the system sound did not start".to_owned()),
    };
    // SAFETY: a property of the content handed back.
    let displays = unsafe { content.displays() };
    displays
        .firstObject()
        .ok_or_else(|| "could not record the system sound: there is no display".to_owned())
}
