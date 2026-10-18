use crate::capture::{self, StreamConfig};
use crate::encode::EncodedFrame;
use anyhow::Context;
use bytes::Bytes;
use rtc::media::Sample;
use rtc::peer_connection::configuration::media_engine::MIME_TYPE_H264;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
    RtpCodecKind,
};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, channel};
use tokio::sync::watch;
use webrtc::media_stream::MediaStreamTrack;
use webrtc::media_stream::Track;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::peer_connection::{
    MediaEngine, PeerConnection as PeerConnectionTrait, PeerConnectionBuilder,
    PeerConnectionEventHandler, RTCIceCandidateInit, RTCPeerConnectionIceEvent,
    RTCPeerConnectionState, RTCSessionDescription, Registry, register_default_interceptors,
};
use webrtc::rtp_transceiver::RtpSender;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const H264_FMTP: &str = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";
const H264_PAYLOAD_TYPE: u8 = 102;

/// Prevents two viewers from streaming at once. Claimed before a session is
/// built and released when the supervisor task finishes (or earlier, if setup
/// fails before the supervisor starts).
pub struct SessionGuard {
    busy: Arc<AtomicBool>,
}

impl SessionGuard {
    pub fn claim(busy: &Arc<AtomicBool>) -> Option<Self> {
        // Ok = the swap succeeded, i.e. nobody held the session.
        busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
            .then(|| Self {
                busy: Arc::clone(busy),
            })
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::SeqCst);
    }
}

pub enum SessionCommand {
    Answer(Box<RTCSessionDescription>),
    Ice(RTCIceCandidateInit),
    Stop,
}

pub struct StreamSession {
    pub pc: Arc<dyn PeerConnectionTrait>,
    pub track: Arc<TrackLocalStaticSample>,
    sender: Arc<dyn RtpSender>,
}

struct SignalingEvents {
    out: UnboundedSender<Value>,
    state_tx: watch::Sender<RTCPeerConnectionState>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for SignalingEvents {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        match event.candidate.to_json() {
            Ok(candidate) => {
                let _ = self
                    .out
                    .send(json!({"type": "ice", "candidate": candidate}));
            }
            Err(err) => eprintln!("[webrtc] could not serialize ICE candidate: {err}"),
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let _ = self.state_tx.send(state);
    }
}

/// Builds a peer connection with one send-only H.264 video track, ready for
/// offer/answer negotiation. Local ICE candidates are forwarded to `out`.
pub async fn create_session(
    out: UnboundedSender<Value>,
) -> anyhow::Result<(StreamSession, watch::Receiver<RTCPeerConnectionState>)> {
    let (state_tx, state_rx) = watch::channel(RTCPeerConnectionState::New);

    let mut media_engine = MediaEngine::default();
    let video_codec = RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: 90000,
            channels: 0,
            sdp_fmtp_line: H264_FMTP.to_owned(),
            rtcp_feedback: vec![],
        },
        payload_type: H264_PAYLOAD_TYPE,
    };
    media_engine.register_codec(video_codec.clone(), RtpCodecKind::Video)?;
    let registry = register_default_interceptors(Registry::new(), &mut media_engine)?;

    let handler = Arc::new(SignalingEvents { out, state_tx });

    let pc: Arc<dyn PeerConnectionTrait> = Arc::new(
        PeerConnectionBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_handler(handler)
            .with_udp_addrs(vec!["0.0.0.0:0"])
            .build()
            .await?,
    );

    let ssrc = rand::random::<u32>();
    let track = Arc::new(TrackLocalStaticSample::new(
        Instant::now(),
        MediaStreamTrack::new(
            "connect-to-desktop".to_owned(),
            format!("screen-{ssrc}"),
            "Screen".to_owned(),
            RtpCodecKind::Video,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc),
                    ..Default::default()
                },
                codec: video_codec.rtp_codec.clone(),
                ..Default::default()
            }],
        ),
    )?);
    let sender = pc
        .add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
        .await?;

    Ok((StreamSession { pc, track, sender }, state_rx))
}

async fn negotiated_payload_type(sender: &Arc<dyn RtpSender>) -> anyhow::Result<u8> {
    let parameters = sender.get_parameters().await?;
    parameters
        .rtp_parameters
        .codecs
        .first()
        .map(|codec| codec.payload_type)
        .context("negotiated session has no video codec")
}

fn is_terminal(state: RTCPeerConnectionState) -> bool {
    matches!(
        state,
        RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
    )
}

fn state_name(state: RTCPeerConnectionState) -> &'static str {
    match state {
        RTCPeerConnectionState::New => "new",
        RTCPeerConnectionState::Connecting => "connecting",
        RTCPeerConnectionState::Connected => "connected",
        RTCPeerConnectionState::Disconnected => "disconnected",
        RTCPeerConnectionState::Failed => "failed",
        RTCPeerConnectionState::Closed => "closed",
        _ => "unknown",
    }
}

/// Runs one streaming session: waits for the WebRTC connection, then
/// captures/encodes/sends until something ends it, then releases everything.
/// The `guard` is dropped (freeing the busy flag) when this returns.
pub fn spawn_supervisor(
    session: StreamSession,
    mut state_rx: watch::Receiver<RTCPeerConnectionState>,
    config: StreamConfig,
    guard: SessionGuard,
    out: UnboundedSender<Value>,
    mut commands: UnboundedReceiver<SessionCommand>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let pc = session.pc.clone();

        // Negotiation phase: the client's answer and ICE candidates arrive
        // while we wait for the connection, so commands are handled here too.
        let mut failure: Option<String> = None;
        let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
        loop {
            let state = *state_rx.borrow();
            if matches!(state, RTCPeerConnectionState::Connected) {
                break;
            }
            if is_terminal(state) {
                failure = Some(
                    "The connection failed. Check that both devices are on the same network."
                        .to_owned(),
                );
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                failure = Some(
                    "Timed out while connecting. Check that both devices are on the same network."
                        .to_owned(),
                );
                break;
            }
            tokio::select! {
                changed = state_rx.changed() => {
                    if changed.is_err() {
                        failure = Some("The connection ended unexpectedly.".to_owned());
                        break;
                    }
                }
                command = commands.recv() => match command {
                    Some(SessionCommand::Answer(description)) => {
                        if let Err(err) = pc.set_remote_description(*description).await {
                            failure = Some(format!("Could not apply the connection answer: {err}"));
                            break;
                        }
                    }
                    Some(SessionCommand::Ice(candidate)) => {
                        if let Err(err) = pc.add_ice_candidate(candidate).await {
                            eprintln!("[webrtc] ICE candidate rejected: {err}");
                        }
                    }
                    Some(SessionCommand::Stop) | None => {
                        let _ = pc.close().await;
                        let _ = out.send(json!({"type": "stopped"}));
                        drop(guard);
                        return;
                    }
                },
            }
        }
        if let Some(message) = failure {
            let _ = out.send(json!({"type": "error", "message": message}));
            let _ = pc.close().await;
            drop(guard);
            return;
        }
        let _ = out.send(json!({"type": "state", "state": "connected"}));

        let ssrc = match session.track.ssrcs().await.first().copied() {
            Some(ssrc) => ssrc,
            None => {
                let _ =
                    out.send(json!({"type": "error", "message": "Stream setup failed: no SSRC."}));
                let _ = pc.close().await;
                drop(guard);
                return;
            }
        };
        let payload_type = match negotiated_payload_type(&session.sender).await {
            Ok(payload_type) => payload_type,
            Err(err) => {
                let _ = out.send(
                    json!({"type": "error", "message": format!("Stream setup failed: {err:#}")}),
                );
                let _ = pc.close().await;
                drop(guard);
                return;
            }
        };

        let frame_interval = Duration::from_micros(1_000_000 / config.fps.max(1) as u64);
        let (frame_tx, mut frame_rx) = channel::<EncodedFrame>(4);
        let (event_tx, mut capture_events) =
            tokio::sync::mpsc::unbounded_channel::<capture::CaptureEvent>();
        let stop = Arc::new(AtomicBool::new(false));

        let track = session.track.clone();
        let mut writer = tokio::spawn(async move {
            while let Some(frame) = frame_rx.recv().await {
                let sample = Sample {
                    data: Bytes::from(frame.data),
                    duration: frame_interval,
                    ..Sample::new(Instant::now())
                };
                if track
                    .write_sample(ssrc, payload_type, &sample, &[])
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });

        let capture = capture::spawn_capture(config, Arc::clone(&stop), frame_tx, event_tx);

        loop {
            if is_terminal(*state_rx.borrow()) {
                let _ = out.send(json!({"type": "state", "state": state_name(*state_rx.borrow())}));
                break;
            }
            tokio::select! {
                changed = state_rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let state = *state_rx.borrow();
                    let _ = out.send(json!({"type": "state", "state": state_name(state)}));
                    if is_terminal(state) {
                        break;
                    }
                }
                event = capture_events.recv() => {
                    match event {
                        Some(capture::CaptureEvent::Ready) => {
                            let _ = out.send(json!({"type": "state", "state": "capturing"}));
                        }
                        Some(capture::CaptureEvent::Error(message)) => {
                            let _ = out.send(json!({"type": "error", "message": format!("Screen capture stopped: {message}")}));
                            break;
                        }
                        None => {
                            let _ = out.send(json!({"type": "error", "message": "Screen capture ended unexpectedly."}));
                            break;
                        }
                    }
                }
                command = commands.recv() => {
                    match command {
                        Some(SessionCommand::Answer(description)) => {
                            if let Err(err) = pc.set_remote_description(*description).await {
                                let _ = out.send(json!({"type": "error", "message": format!("Connection error: {err}")}));
                                break;
                            }
                        }
                        Some(SessionCommand::Ice(candidate)) => {
                            if let Err(err) = pc.add_ice_candidate(candidate).await {
                                eprintln!("[webrtc] ICE candidate rejected: {err}");
                            }
                        }
                        Some(SessionCommand::Stop) | None => break,
                    }
                }
            }
        }

        stop.store(true, Ordering::Relaxed);
        let joined = tokio::time::timeout(
            Duration::from_secs(3),
            tokio::task::spawn_blocking(move || {
                let _ = capture.join();
            }),
        )
        .await;
        if joined.is_err() {
            eprintln!("[capture] join timed out");
        }
        if tokio::time::timeout(Duration::from_secs(2), &mut writer)
            .await
            .is_err()
        {
            writer.abort();
        }
        let _ = pc.close().await;
        let _ = out.send(json!({"type": "stopped"}));
        drop(guard);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_claims_once_and_releases_on_drop() {
        let busy = Arc::new(AtomicBool::new(false));
        let first = SessionGuard::claim(&busy);
        assert!(first.is_some());
        assert!(busy.load(Ordering::SeqCst));
        assert!(SessionGuard::claim(&busy).is_none());
        drop(first);
        assert!(!busy.load(Ordering::SeqCst));
        assert!(SessionGuard::claim(&busy).is_some());
    }
}
