use crate::encode::{EncodedFrame, H264Encoder};
use anyhow::Context;
use std::borrow::Cow;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::{Sender, UnboundedSender};

#[derive(Clone, Copy)]
pub struct StreamConfig {
    pub fps: u32,
    pub max_width: u32,
    pub bitrate: u32,
}

/// Lifecycle events from the capture thread.
pub enum CaptureEvent {
    /// The screen-share portal was approved and frames are flowing.
    Ready,
    /// Terminal capture failure; the thread exits right after sending this.
    Error(String),
}

pub fn primary_monitor() -> anyhow::Result<xcap::Monitor> {
    let monitors = xcap::Monitor::all().context("listing monitors")?;
    let mut fallback = None;
    for monitor in monitors {
        if monitor.is_primary().unwrap_or(false) {
            return Ok(monitor);
        }
        fallback = Some(monitor);
    }
    fallback.ok_or_else(|| anyhow::anyhow!("no monitors detected"))
}

/// Spawns the capture + encode thread. Frames go to `frame_tx`; lifecycle
/// events go to `event_tx` (`Ready` once the portal stream is running, then at
/// most one `Error` before the thread exits).
pub fn spawn_capture(
    config: StreamConfig,
    stop: Arc<AtomicBool>,
    frame_tx: Sender<EncodedFrame>,
    event_tx: UnboundedSender<CaptureEvent>,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("capture-encode".into())
        .spawn(move || {
            if let Err(err) = capture_loop(&config, &stop, &frame_tx, &event_tx) {
                let msg = format!("{err:#}");
                let _ = event_tx.send(CaptureEvent::Error(msg.clone()));
                eprintln!("[capture] {msg}");
            }
        })
        .expect("spawn capture thread")
}

fn capture_loop(
    config: &StreamConfig,
    stop: &AtomicBool,
    frame_tx: &Sender<EncodedFrame>,
    event_tx: &UnboundedSender<CaptureEvent>,
) -> anyhow::Result<()> {
    let monitor = primary_monitor().context("locating screen to capture")?;

    // On Wayland this opens the xdg-desktop-portal ScreenCast dialog once;
    // frames then arrive continuously over PipeWire. (monitor.capture_image()
    // is unusable here: it re-runs the portal round-trip every call, ~750ms.)
    let (recorder, frame_rx) = monitor
        .video_recorder()
        .context("opening the screen-share portal")?;
    recorder.start().context("starting the screen stream")?;
    let _ = event_tx.send(CaptureEvent::Ready);

    let result = encode_frames(config, stop, frame_tx, &frame_rx);
    let _ = recorder.stop();
    result
}

fn encode_frames(
    config: &StreamConfig,
    stop: &AtomicBool,
    frame_tx: &Sender<EncodedFrame>,
    frame_rx: &std::sync::mpsc::Receiver<xcap::Frame>,
) -> anyhow::Result<()> {
    let mut encoder = H264Encoder::new(config.bitrate, config.fps)?;
    let frame_interval = Duration::from_micros(1_000_000 / config.fps.max(1) as u64);
    let mut next_encode_at = Instant::now();
    let mut scratch: Vec<u8> = Vec::new();
    let mut force_keyframe = false;
    let mut consecutive_errors = 0u32;

    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }

        // An idle timeout is normal (static screens produce no new frames);
        // only a dropped channel means the portal stream is gone.
        let frame = match frame_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(frame) => frame,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(anyhow::anyhow!("screen capture stream ended unexpectedly"));
            }
        };
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }

        // Frame pacing: drain PipeWire unconditionally, but only encode at the
        // configured rate (drops frames when the source is faster than fps).
        let now = Instant::now();
        if now < next_encode_at {
            continue;
        }
        next_encode_at = now + frame_interval;

        if frame.raw.len() < (frame.width as usize) * (frame.height as usize) * 4 {
            consecutive_errors += 1;
            if consecutive_errors >= 10 {
                return Err(anyhow::anyhow!(
                    "capture produced undersized frames ({} bytes for {}x{})",
                    frame.raw.len(),
                    frame.width,
                    frame.height
                ));
            }
            continue;
        }
        consecutive_errors = 0;

        let (width, height, rgba) = scale_frame(
            &frame.raw,
            frame.width,
            frame.height,
            config.max_width,
            &mut scratch,
        );

        if force_keyframe {
            encoder.force_keyframe();
            force_keyframe = false;
        }

        match encoder.encode_rgba(&rgba, width as usize, height as usize) {
            Err(err) => return Err(anyhow::anyhow!("H.264 encoding failed: {err}")),
            Ok(Some(frame)) => match frame_tx.try_send(frame) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => {
                    force_keyframe = true;
                }
                Err(TrySendError::Closed(_)) => return Ok(()),
            },
            Ok(None) => {}
        }
    }
}

/// Nearest-neighbor downscale so the encoded width never exceeds `max_width`;
/// output dimensions are always even (H.264 4:2:0 requirement). Returns the
/// frame as either the original slice (already within limits) or `scratch`.
fn scale_frame<'a>(
    src: &'a [u8],
    src_width: u32,
    src_height: u32,
    max_width: u32,
    scratch: &'a mut Vec<u8>,
) -> (u32, u32, Cow<'a, [u8]>) {
    let scale = if src_width > max_width {
        max_width as f64 / src_width as f64
    } else {
        1.0
    };
    let mut target_width = (((src_width as f64 * scale) as u32) & !1).max(2);
    let mut target_height = (((src_height as f64 * scale) as u32) & !1).max(2);
    target_width = target_width.min(src_width & !1).max(2);
    target_height = target_height.min(src_height & !1).max(2);

    let src_len = (src_width as usize) * (src_height as usize) * 4;
    if target_width == src_width
        && target_height == src_height
        && src.len() >= src_len
        && src_width.is_multiple_of(2)
        && src_height.is_multiple_of(2)
    {
        return (target_width, target_height, Cow::Borrowed(src));
    }

    scratch.resize(target_width as usize * target_height as usize * 4, 0);
    for y in 0..target_height as usize {
        let src_y = (y as u64 * src_height as u64) / target_height as u64;
        for x in 0..target_width as usize {
            let src_x = (x as u64 * src_width as u64) / target_width as u64;
            let src_i = ((src_y * src_width as u64 + src_x) * 4) as usize;
            let dst_i = (y * target_width as usize + x) * 4;
            if src_i + 4 <= src.len() && dst_i + 4 <= scratch.len() {
                scratch[dst_i..dst_i + 4].copy_from_slice(&src[src_i..src_i + 4]);
            }
        }
    }
    (
        target_width,
        target_height,
        Cow::Borrowed(scratch.as_slice()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_frame_caps_width_and_keeps_even_dimensions() {
        let (width, height, max_width) = (1920u32, 1080u32, 1280u32);
        let src = vec![7u8; (width * height * 4) as usize];
        let mut scratch = Vec::new();
        let (tw, th, rgba) = scale_frame(&src, width, height, max_width, &mut scratch);
        assert_eq!(tw, 1280);
        assert_eq!(th, 720);
        assert_eq!(tw % 2, 0);
        assert_eq!(th % 2, 0);
        assert_eq!(rgba.len(), (tw * th * 4) as usize);
    }

    #[test]
    fn scale_frame_keeps_small_even_frames_untouched() {
        let (width, height) = (1280u32, 720u32);
        let src = vec![9u8; (width * height * 4) as usize];
        let mut scratch = Vec::new();
        let (tw, th, rgba) = scale_frame(&src, width, height, 1280, &mut scratch);
        assert_eq!((tw, th), (width, height));
        assert!(std::ptr::eq(rgba.as_ptr(), src.as_ptr()));
    }

    #[test]
    fn scale_frame_handles_odd_dimensions() {
        let (width, height, max_width) = (1919u32, 1079u32, 1280u32);
        let src = vec![3u8; (width * height * 4) as usize];
        let mut scratch = Vec::new();
        let (tw, th, rgba) = scale_frame(&src, width, height, max_width, &mut scratch);
        assert_eq!(tw % 2, 0);
        assert_eq!(th % 2, 0);
        assert!(tw <= 1280);
        assert_eq!(rgba.len(), (tw * th * 4) as usize);
    }

    #[test]
    #[ignore = "needs a real display; on Wayland the portal may ask for screen-share permission"]
    fn streams_and_encodes_live_frames() {
        let _ = env_logger::try_init();
        let monitor = primary_monitor().expect("locate a monitor");
        let open_start = Instant::now();
        let (recorder, frame_rx) = monitor.video_recorder().expect("open portal stream");
        recorder.start().expect("start stream");
        eprintln!("portal stream opened in {:?}", open_start.elapsed());

        let mut frames: Vec<xcap::Frame> = Vec::new();
        let start = Instant::now();
        let mut first_frame_at = None;
        while start.elapsed() < Duration::from_secs(5) {
            match frame_rx.recv_timeout(Duration::from_millis(500)) {
                Ok(frame) => {
                    if first_frame_at.is_none() {
                        first_frame_at = Some(start.elapsed());
                    }
                    frames.push(frame);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(err) => panic!("stream ended: {err}"),
            }
        }
        recorder.stop().expect("stop stream");

        let elapsed = start.elapsed().as_secs_f64();
        let first = first_frame_at.expect("at least one frame within 5s");
        eprintln!(
            "received {} frames in {elapsed:.1}s ({:.1} fps); first frame after {first:?}",
            frames.len(),
            frames.len() as f64 / elapsed
        );

        let last = frames.last().expect("frame to encode");
        let mut encoder = H264Encoder::new(2_000_000, 30).expect("encoder");
        let mut scratch = Vec::new();
        for frame in frames.iter().take(5) {
            let (width, height, rgba) =
                scale_frame(&frame.raw, frame.width, frame.height, 1280, &mut scratch);
            let frame_start = Instant::now();
            let encoded = encoder
                .encode_rgba(&rgba, width as usize, height as usize)
                .expect("encode");
            match encoded {
                Some(encoded) => eprintln!(
                    "encoded {}x{} ({} bytes) in {:?}",
                    width,
                    height,
                    encoded.data.len(),
                    frame_start.elapsed()
                ),
                None => eprintln!(
                    "frame skipped by rate control in {:?}",
                    frame_start.elapsed()
                ),
            }
        }
        assert!(last.width > 0 && last.height > 0);
        assert!(!last.raw.is_empty());
    }
}
