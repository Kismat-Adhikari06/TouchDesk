use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Deserialize;
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::time::Duration;

/// Bound on queued input commands. Mouse moves and scrolls are dropped when
/// the queue is full so a stalled consumer can never build up a backlog of
/// stale pointer positions.
const INPUT_QUEUE: usize = 128;
/// Sanity clamp for a single move/scroll delta.
const MAX_DELTA: i32 = 500;
/// Longest text string accepted in one message.
const MAX_TEXT_CHARS: usize = 256;

/// Wire format of control messages sent from the phone over the WebRTC data
/// channel. Values are validated before they touch the desktop.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlMessage {
    Control {
        enabled: bool,
    },
    Move {
        dx: i32,
        dy: i32,
    },
    Button {
        button: String,
        state: String,
    },
    Click {
        button: String,
        #[serde(default)]
        double: bool,
    },
    Scroll {
        dx: i32,
        dy: i32,
    },
    Text {
        text: String,
    },
    Key {
        key: String,
        state: String,
    },
}

pub enum InputCommand {
    Message(ControlMessage),
    /// Releases every held button and key and disables control. Sent when a
    /// session ends or the data channel closes.
    ReleaseAll,
}

/// Cloneable handle used by the session code to feed the input thread.
#[derive(Clone)]
pub struct InputHandle {
    tx: Option<SyncSender<InputCommand>>,
    pub width: u32,
    pub height: u32,
    pub available: bool,
}

impl InputHandle {
    pub fn send(&self, command: InputCommand) {
        let Some(tx) = &self.tx else { return };
        let reliable = !matches!(
            command,
            InputCommand::Message(ControlMessage::Move { .. })
                | InputCommand::Message(ControlMessage::Scroll { .. })
        );
        if !reliable {
            // Pointer traffic is droppable; the next message carries fresher
            // positions anyway.
            let _ = tx.try_send(command);
            return;
        }
        // Clicks, keys and text must not be lost, but a wedged consumer must
        // not block the caller forever either: retry for up to ~100ms.
        let mut command = command;
        for attempt in 0..10 {
            match tx.try_send(command) {
                Ok(()) => return,
                Err(TrySendError::Full(returned)) => command = returned,
                Err(TrySendError::Disconnected(_)) => return,
            }
            if attempt < 9 {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        eprintln!("[input] command dropped: input queue full");
    }

    pub fn release_all(&self) {
        self.send(InputCommand::ReleaseAll);
    }
}

pub struct InputInfo {
    pub handle: InputHandle,
    pub status: String,
}

/// Probes whether simulated input works here and starts the dedicated input
/// thread. The thread owns the enigo connection so the async runtime never
/// blocks on desktop round-trips.
pub fn init() -> InputInfo {
    let (width, height) = primary_screen_size();
    match Enigo::new(&Settings::default()) {
        Ok(probe) => {
            drop(probe);
            let (tx, rx) = sync_channel::<InputCommand>(INPUT_QUEUE);
            let spawned = std::thread::Builder::new()
                .name("remote-input".to_owned())
                .spawn(move || input_worker(rx));
            if let Err(err) = spawned {
                return InputInfo {
                    handle: InputHandle {
                        tx: None,
                        width,
                        height,
                        available: false,
                    },
                    status: format!("remote input unavailable: could not start thread ({err})"),
                };
            }
            let backend = if std::env::var("WAYLAND_DISPLAY").is_ok() {
                "wayland"
            } else {
                "x11"
            };
            InputInfo {
                handle: InputHandle {
                    tx: Some(tx),
                    width,
                    height,
                    available: true,
                },
                status: format!("remote input ready ({backend}, screen {width}x{height})"),
            }
        }
        Err(err) => InputInfo {
            handle: InputHandle {
                tx: None,
                width,
                height,
                available: false,
            },
            status: format!("remote input unavailable ({err})"),
        },
    }
}

fn primary_screen_size() -> (u32, u32) {
    match xcap::Monitor::all() {
        Ok(monitors) => match monitors.into_iter().next() {
            Some(monitor) => match (monitor.width(), monitor.height()) {
                (Ok(w), Ok(h)) if w > 0 && h > 0 => (w, h),
                _ => (0, 0),
            },
            None => (0, 0),
        },
        Err(_) => (0, 0),
    }
}

fn input_worker(rx: Receiver<InputCommand>) {
    let mut engine = match Enigo::new(&Settings::default()) {
        Ok(enigo) => Engine {
            enigo,
            control_enabled: false,
            held_buttons: Vec::new(),
            held_keys: Vec::new(),
        },
        Err(err) => {
            eprintln!("[input] engine start failed: {err}");
            return;
        }
    };
    while let Ok(command) = rx.recv() {
        match command {
            InputCommand::ReleaseAll => engine.release_all(),
            InputCommand::Message(message) => engine.apply(message),
        }
    }
    // Channel closed: the process is shutting down.
    engine.release_all();
}

struct Engine {
    enigo: Enigo,
    control_enabled: bool,
    held_buttons: Vec<Button>,
    held_keys: Vec<Key>,
}

impl Engine {
    fn apply(&mut self, message: ControlMessage) {
        match message {
            ControlMessage::Control { enabled } => {
                if enabled == self.control_enabled {
                    return;
                }
                self.control_enabled = enabled;
                if enabled {
                    eprintln!(
                        "[input] remote control ACTIVE — the viewer can move the mouse and type"
                    );
                } else {
                    eprintln!("[input] remote control ended");
                    self.release_held();
                }
            }
            ControlMessage::Move { dx, dy } => {
                if !self.accepting() {
                    return;
                }
                let dx = dx.clamp(-MAX_DELTA, MAX_DELTA);
                let dy = dy.clamp(-MAX_DELTA, MAX_DELTA);
                if dx == 0 && dy == 0 {
                    return;
                }
                if let Err(err) = self.enigo.move_mouse(dx, dy, Coordinate::Rel) {
                    eprintln!("[input] move failed: {err}");
                }
            }
            ControlMessage::Button { button, state } => {
                if !self.accepting() {
                    return;
                }
                let Some(button) = parse_button(&button) else {
                    eprintln!("[input] ignored unknown button {button:?}");
                    return;
                };
                match state.as_str() {
                    "down" => {
                        if let Err(err) = self.enigo.button(button, Direction::Press) {
                            eprintln!("[input] button press failed: {err}");
                        } else if !self.held_buttons.contains(&button) {
                            self.held_buttons.push(button);
                        }
                    }
                    "up" => {
                        if let Err(err) = self.enigo.button(button, Direction::Release) {
                            eprintln!("[input] button release failed: {err}");
                        }
                        self.held_buttons.retain(|held| *held != button);
                    }
                    other => eprintln!("[input] ignored unknown button state {other:?}"),
                }
            }
            ControlMessage::Click { button, double } => {
                if !self.accepting() {
                    return;
                }
                let Some(button) = parse_button(&button) else {
                    eprintln!("[input] ignored unknown button {button:?}");
                    return;
                };
                let times = if double { 2 } else { 1 };
                for _ in 0..times {
                    if let Err(err) = self.enigo.button(button, Direction::Press) {
                        eprintln!("[input] click failed: {err}");
                        return;
                    }
                    if let Err(err) = self.enigo.button(button, Direction::Release) {
                        eprintln!("[input] click failed: {err}");
                        return;
                    }
                }
            }
            ControlMessage::Scroll { dx, dy } => {
                if !self.accepting() {
                    return;
                }
                let dy = dy.clamp(-MAX_DELTA, MAX_DELTA);
                let dx = dx.clamp(-MAX_DELTA, MAX_DELTA);
                if dy != 0
                    && let Err(err) = self.enigo.scroll(-dy, Axis::Vertical)
                {
                    eprintln!("[input] scroll failed: {err}");
                }
                if dx != 0
                    && let Err(err) = self.enigo.scroll(-dx, Axis::Horizontal)
                {
                    eprintln!("[input] scroll failed: {err}");
                }
            }
            ControlMessage::Text { text } => {
                if !self.accepting() {
                    return;
                }
                let clipped: String = text.chars().take(MAX_TEXT_CHARS).collect();
                if clipped.is_empty() {
                    return;
                }
                if let Err(err) = self.enigo.text(&clipped) {
                    eprintln!("[input] text failed: {err}");
                }
            }
            ControlMessage::Key { key, state } => {
                if !self.accepting() {
                    return;
                }
                let Some(parsed) = parse_key(&key) else {
                    eprintln!("[input] ignored unknown key {key:?}");
                    return;
                };
                match state.as_str() {
                    "down" => {
                        if let Err(err) = self.enigo.key(parsed, Direction::Press) {
                            eprintln!("[input] key press failed: {err}");
                        } else if !self.held_keys.contains(&parsed) {
                            self.held_keys.push(parsed);
                        }
                    }
                    "up" => {
                        if let Err(err) = self.enigo.key(parsed, Direction::Release) {
                            eprintln!("[input] key release failed: {err}");
                        }
                        self.held_keys.retain(|held| *held != parsed);
                    }
                    other => eprintln!("[input] ignored unknown key state {other:?}"),
                }
            }
        }
    }

    fn accepting(&self) -> bool {
        if self.control_enabled {
            return true;
        }
        eprintln!("[input] ignored input while remote control is disabled");
        false
    }

    fn release_all(&mut self) {
        if self.control_enabled {
            eprintln!("[input] remote control ended");
        }
        self.control_enabled = false;
        self.release_held();
    }

    fn release_held(&mut self) {
        for button in self.held_buttons.drain(..) {
            if let Err(err) = self.enigo.button(button, Direction::Release) {
                eprintln!("[input] releasing held button failed: {err}");
            }
        }
        for key in self.held_keys.drain(..) {
            if let Err(err) = self.enigo.key(key, Direction::Release) {
                eprintln!("[input] releasing held key failed: {err}");
            }
        }
    }
}

fn parse_button(name: &str) -> Option<Button> {
    match name {
        "left" => Some(Button::Left),
        "middle" => Some(Button::Middle),
        "right" => Some(Button::Right),
        _ => None,
    }
}

/// Maps DOM `KeyboardEvent.code` values to enigo keys. Printable characters
/// use `Key::Unicode`; named keys use the platform enum.
fn parse_key(code: &str) -> Option<Key> {
    let key = match code {
        "Backspace" => Key::Backspace,
        "Enter" | "NumpadEnter" => Key::Return,
        "Tab" => Key::Tab,
        "Escape" => Key::Escape,
        "Delete" => Key::Delete,
        "Insert" => Key::Insert,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ShiftLeft" | "ShiftRight" => Key::Shift,
        "ControlLeft" | "ControlRight" => Key::Control,
        "AltLeft" | "AltRight" => Key::Alt,
        "MetaLeft" | "MetaRight" => Key::Meta,
        "CapsLock" => Key::CapsLock,
        "Space" => Key::Space,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        "IntlBackslash" => Key::Unicode('\\'),
        "Backquote" => Key::Unicode('`'),
        "Minus" => Key::Unicode('-'),
        "Equal" => Key::Unicode('='),
        "BracketLeft" => Key::Unicode('['),
        "BracketRight" => Key::Unicode(']'),
        "Backslash" => Key::Unicode('\\'),
        "Semicolon" => Key::Unicode(';'),
        "Quote" => Key::Unicode('\''),
        "Comma" => Key::Unicode(','),
        "Period" => Key::Unicode('.'),
        "Slash" => Key::Unicode('/'),
        _ => {
            if let Some(rest) = code.strip_prefix("Key") {
                if rest.len() == 1
                    && let Some(letter) = rest.chars().next().filter(|c| c.is_ascii_alphabetic())
                {
                    return Some(Key::Unicode(letter.to_ascii_lowercase()));
                }
                return None;
            }
            if let Some(rest) = code.strip_prefix("Digit") {
                if rest.len() == 1
                    && let Some(digit) = rest.chars().next().filter(|c| c.is_ascii_digit())
                {
                    return Some(Key::Unicode(digit));
                }
                return None;
            }
            return None;
        }
    };
    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_letter_digit_and_special_keys() {
        assert!(matches!(parse_key("KeyA"), Some(Key::Unicode('a'))));
        assert!(matches!(parse_key("KeyZ"), Some(Key::Unicode('z'))));
        assert!(matches!(parse_key("Digit5"), Some(Key::Unicode('5'))));
        assert!(matches!(parse_key("Slash"), Some(Key::Unicode('/'))));
        assert!(matches!(parse_key("Escape"), Some(Key::Escape)));
        assert!(matches!(parse_key("Enter"), Some(Key::Return)));
        assert!(matches!(parse_key("ArrowLeft"), Some(Key::LeftArrow)));
        assert!(matches!(parse_key("ControlLeft"), Some(Key::Control)));
        assert!(matches!(parse_key("MetaRight"), Some(Key::Meta)));
        assert!(matches!(parse_key("F5"), Some(Key::F5)));
    }

    #[test]
    fn rejects_unknown_keys() {
        assert!(parse_key("NotAKey").is_none());
        assert!(parse_key("KeyAB").is_none());
        assert!(parse_key("Digit12").is_none());
    }

    #[test]
    fn parses_buttons() {
        assert!(matches!(parse_button("left"), Some(Button::Left)));
        assert!(matches!(parse_button("right"), Some(Button::Right)));
        assert!(matches!(parse_button("middle"), Some(Button::Middle)));
        assert!(parse_button("jump").is_none());
    }

    #[test]
    fn parses_control_messages_from_json() {
        let move_msg: ControlMessage =
            serde_json::from_str(r#"{"type":"move","dx":3,"dy":-7}"#).unwrap();
        assert!(matches!(move_msg, ControlMessage::Move { dx: 3, dy: -7 }));

        let click: ControlMessage =
            serde_json::from_str(r#"{"type":"click","button":"left","double":true}"#).unwrap();
        assert!(matches!(click, ControlMessage::Click { double: true, .. }));

        let click_minimal: ControlMessage =
            serde_json::from_str(r#"{"type":"click","button":"right"}"#).unwrap();
        assert!(matches!(
            click_minimal,
            ControlMessage::Click { double: false, .. }
        ));

        let control: ControlMessage =
            serde_json::from_str(r#"{"type":"control","enabled":true}"#).unwrap();
        assert!(matches!(control, ControlMessage::Control { enabled: true }));

        let key: ControlMessage =
            serde_json::from_str(r#"{"type":"key","key":"Backspace","state":"down"}"#).unwrap();
        assert!(matches!(
            key,
            ControlMessage::Key { ref key, ref state } if key == "Backspace" && state == "down"
        ));

        assert!(serde_json::from_str::<ControlMessage>(r#"{"type":"nope"}"#).is_err());
    }
}
