use crate::capture::StreamConfig;
use crate::peer::{SessionCommand, SessionGuard, create_session, spawn_supervisor};
use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::routing::get;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use webrtc::peer_connection::{RTCIceCandidateInit, RTCSessionDescription};

const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_AUTH_FAILURES: u32 = 10;
const LOCKOUT_MS: u64 = 60_000;
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

pub struct AgentSettings {
    pub pin: String,
    pub stream: StreamConfig,
}

pub struct AppState {
    pub settings: AgentSettings,
    pub busy: Arc<AtomicBool>,
    auth_failures: AtomicU32,
    locked_until_ms: AtomicU64,
}

impl AppState {
    pub fn new(settings: AgentSettings) -> Arc<Self> {
        Arc::new(Self {
            settings,
            busy: Arc::new(AtomicBool::new(false)),
            auth_failures: AtomicU32::new(0),
            locked_until_ms: AtomicU64::new(0),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Auth {
        pin: String,
    },
    Start,
    Answer {
        sdp: String,
    },
    Ice {
        candidate: Option<RTCIceCandidateInit>,
    },
    Stop,
}

pub fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_upgrade))
        .with_state(state)
}

async fn health(State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    axum::Json(json!({
        "status": "ok",
        "busy": state.busy.load(Ordering::SeqCst),
    }))
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    ws.on_upgrade(move |socket| session_loop(socket, state))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn authenticate(state: &AppState, pin: &str, out: &UnboundedSender<Value>) -> bool {
    let now = now_ms();
    let locked_until = state.locked_until_ms.load(Ordering::SeqCst);
    if locked_until > now {
        let seconds = (locked_until - now).div_ceil(1000);
        let _ = out.send(json!({
            "type": "auth_error",
            "message": format!("Too many failed attempts. Try again in {seconds}s.")
        }));
        return false;
    }
    if pin == state.settings.pin {
        state.auth_failures.store(0, Ordering::SeqCst);
        let _ = out.send(json!({"type": "auth_ok"}));
        return true;
    }
    let failures = state.auth_failures.fetch_add(1, Ordering::SeqCst) + 1;
    if failures >= MAX_AUTH_FAILURES {
        state.auth_failures.store(0, Ordering::SeqCst);
        state
            .locked_until_ms
            .store(now + LOCKOUT_MS, Ordering::SeqCst);
        let _ = out.send(json!({
            "type": "auth_error",
            "message": "Too many failed attempts. Locked for 60 seconds."
        }));
    } else {
        let _ = out.send(json!({"type": "auth_error", "message": "Wrong PIN."}));
    }
    false
}

async fn start_stream(
    state: &AppState,
    out: UnboundedSender<Value>,
) -> Result<(JoinHandle<()>, UnboundedSender<SessionCommand>), String> {
    let guard = SessionGuard::claim(&state.busy)
        .ok_or_else(|| "Another viewer is already connected.".to_owned())?;

    let (session, state_rx) = create_session(out.clone())
        .await
        .map_err(|err| format!("Could not start the stream: {err:#}"))?;

    let offer = session
        .pc
        .create_offer(None)
        .await
        .map_err(|err| format!("Could not create the stream offer: {err:#}"))?;
    // Enqueue the offer before set_local so it always precedes any ICE
    // candidates the peer connection may emit afterwards.
    let _ = out.send(serde_json::to_value(&offer).unwrap_or(json!(null)));
    session
        .pc
        .set_local_description(offer)
        .await
        .map_err(|err| format!("Could not configure the stream: {err:#}"))?;

    let (command_tx, command_rx) = unbounded_channel::<SessionCommand>();
    let handle = spawn_supervisor(
        session,
        state_rx,
        state.settings.stream,
        guard,
        out,
        command_rx,
    );
    Ok((handle, command_tx))
}

async fn session_loop(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = unbounded_channel::<Value>();

    let writer = tokio::spawn(async move {
        while let Some(value) = out_rx.recv().await {
            if ws_tx
                .send(Message::Text(value.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let authenticated = match timeout(AUTH_TIMEOUT, ws_rx.next()).await {
        Err(_) => {
            let _ = out_tx.send(json!({
                "type": "auth_error",
                "message": "Authentication timed out."
            }));
            false
        }
        Ok(None) | Ok(Some(Err(_))) => false,
        Ok(Some(Ok(message))) => match message {
            Message::Text(text) => match serde_json::from_str::<ClientMessage>(&text) {
                Ok(ClientMessage::Auth { pin }) => authenticate(&state, &pin, &out_tx),
                _ => {
                    let _ = out_tx.send(json!({
                        "type": "auth_error",
                        "message": "First message must be an auth message."
                    }));
                    false
                }
            },
            _ => {
                let _ = out_tx.send(json!({
                    "type": "auth_error",
                    "message": "First message must be an auth message."
                }));
                false
            }
        },
    };
    if !authenticated {
        drop(out_tx);
        let _ = timeout(Duration::from_secs(2), writer).await;
        return;
    }

    let mut supervisor: Option<(JoinHandle<()>, UnboundedSender<SessionCommand>)> = None;

    while let Some(message) = ws_rx.next().await {
        let text = match message {
            Ok(Message::Text(text)) => text,
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        let message: ClientMessage = match serde_json::from_str(&text) {
            Ok(message) => message,
            Err(_) => {
                let _ = out_tx.send(json!({
                    "type": "error",
                    "message": "Unrecognized message."
                }));
                continue;
            }
        };

        match message {
            ClientMessage::Auth { .. } => {
                let _ = out_tx.send(json!({
                    "type": "error",
                    "message": "Already authenticated."
                }));
            }
            ClientMessage::Start => {
                if supervisor.is_some() {
                    let _ = out_tx.send(json!({
                        "type": "error",
                        "message": "A stream is already running."
                    }));
                    continue;
                }
                match start_stream(&state, out_tx.clone()).await {
                    Ok(handle) => supervisor = Some(handle),
                    Err(message) => {
                        let _ = out_tx.send(json!({"type": "error", "message": message}));
                    }
                }
            }
            ClientMessage::Answer { sdp } => {
                let description = match RTCSessionDescription::answer(sdp) {
                    Ok(description) => description,
                    Err(err) => {
                        let _ = out_tx.send(json!({
                            "type": "error",
                            "message": format!("Invalid answer SDP: {err}")
                        }));
                        continue;
                    }
                };
                match &supervisor {
                    Some((_, commands)) => {
                        if commands
                            .send(SessionCommand::Answer(Box::new(description)))
                            .is_err()
                        {
                            let _ = out_tx.send(json!({
                                "type": "error",
                                "message": "The stream has already ended."
                            }));
                        }
                    }
                    None => {
                        let _ = out_tx.send(json!({
                            "type": "error",
                            "message": "No stream is active."
                        }));
                    }
                }
            }
            ClientMessage::Ice {
                candidate: Some(candidate),
            } => {
                if let Some((_, commands)) = &supervisor {
                    let _ = commands.send(SessionCommand::Ice(candidate));
                }
            }
            ClientMessage::Ice { candidate: None } => {}
            ClientMessage::Stop => {
                if let Some((handle, commands)) = supervisor.take() {
                    let _ = commands.send(SessionCommand::Stop);
                    let _ = timeout(STOP_TIMEOUT, handle).await;
                }
            }
        }
    }

    if let Some((handle, commands)) = supervisor.take() {
        let _ = commands.send(SessionCommand::Stop);
        let _ = timeout(STOP_TIMEOUT, handle).await;
    }
    drop(out_tx);
    let _ = timeout(Duration::from_secs(2), writer).await;
}
