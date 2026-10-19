# Connect To Desktop

A lightweight, open-source, cross-platform remote desktop system that lets you view and control your Windows, macOS, or Linux computer directly from a phone — through a web browser or an installable PWA. No native mobile app required.

**Philosophy:** lightweight, open-source, secure, mobile-first, and easy to self-host.

> **Status: Phase 2 (screen streaming).** The agent captures the desktop (PipeWire/XDG portal), encodes H.264, and streams it over WebRTC to the PWA dashboard on the local network. Remote input control, pairing, and internet access arrive in later phases. See `PROJECT_IDEA.md` for the full product vision.

## Structure

```
apps/
  desktop-agent/   # Rust agent — WebRTC screen streaming server
    vendor/xcap/   # vendored xcap (portal-session lifetime fix, see Troubleshooting)
  web/             # React + TypeScript + Vite PWA dashboard
docs/              # Design specs
scripts/           # generate-icons.mjs (zero-dep PWA icon generator)
```

## Requirements

- **Linux** (developed and verified on Ubuntu with GNOME/Wayland, x86_64)
- **Rust** via [rustup](https://rustup.rs) (stable toolchain: cargo, rustc, clippy, rustfmt)
- **Node.js ≥ 20** with npm
- **System libraries** for the agent (PipeWire/wayland build deps, a C++ compiler for OpenH264)

## Linux setup

```bash
# 1. Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. System build libraries for the desktop agent
sudo apt install -y pkg-config clang g++ \
  libpipewire-0.3-dev libspa-0.2-dev libegl-dev libgbm-dev \
  libwayland-dev libdrm-dev libx11-dev libxcb1-dev

# 3. Desktop agent
cd apps/desktop-agent
cargo build --release

# 4. Web app
cd ../web
npm install
```

## Running

```bash
# 1. Start the agent (release build — debug builds encode ~10x slower)
cd apps/desktop-agent
cargo run --release

# 2. Start the dashboard (dev server)
cd apps/web
npm run dev
```

The agent prints the address and a random 6-digit PIN:

```
Desktop Agent v0.1.0
Operating system: linux (x86_64)
Remote Desktop Agent Ready
Listening on 0.0.0.0:8080
PIN: 123456
Enter 192.168.18.249:8080 in the dashboard to connect
```

Open the dashboard, enter the printed address and PIN, and press **Connect Device**. On Wayland, a portal dialog ("Share screen") appears on the computer for every stream — click **Allow**; the video starts within a second or two of approval. Press **Disconnect** when done; the PIN changes on every agent restart.

Agent options:

| Flag | Default | Meaning |
|---|---|---|
| `--bind <ip:port>` | `0.0.0.0:8080` | Listen address |
| `--pin <digits>` | random | Fixed PIN instead of a random one |
| `--fps <1-60>` | `30` | Target frame rate |
| `--max-width <px>` | `1280` | Downscale the capture to this width (height keeps aspect) |
| `--bitrate <kbps>` | `2500` | Encoder bitrate |

## Development commands

| Task | Command |
|---|---|
| Run the desktop agent | `cd apps/desktop-agent && cargo run --release` |
| Unit-test the agent | `cd apps/desktop-agent && cargo test` |
| Live capture test (opens the portal dialog) | `cd apps/desktop-agent && cargo test streams_and_encodes_live_frames -- --ignored --nocapture` |
| Lint the agent | `cd apps/desktop-agent && cargo clippy --all-targets -- -D warnings` |
| Format-check the agent | `cd apps/desktop-agent && cargo fmt -- --check` |
| Start the web dev server | `cd apps/web && npm run dev` |
| Production build of the web app | `cd apps/web && npm run build` |
| Serve the production build | `cd apps/web && npm run preview` |
| Lint the web app | `cd apps/web && npm run lint` |
| Regenerate PWA icons | `node scripts/generate-icons.mjs` |

The web app is a PWA: production builds ship a web app manifest and service worker, so the dashboard is installable on Android and iOS browsers.

## Limitations (current phase)

- **Local network only.** Both devices must be on the same LAN; there is no relay/TURN server yet.
- **One viewer at a time.** A second connection receives "Another viewer is already connected."
- **Mouse/keyboard control (Phase 3).** Trackpad-style gestures and an on-screen keyboard let you control the desktop remotely. Enable "Mouse" or "Keys" on the viewer (control is only active while in those modes). Held keys/buttons are released automatically when the session ends. The cursor is embedded into the captured stream where the compositor supports it.
- **Wayland re-approval.** Each stream opens the portal dialog again; approvals are not remembered.
- **Idle screens may freeze.** GNOME delivers screencast frames on demand — a completely static desktop may emit no new frames (the video holds the last frame). Any change resumes the stream.
- **PWA install needs HTTPS.** The dashboard works over plain `http://` on the LAN, but service-worker install requires a secure context — serve `apps/web/dist` behind HTTPS (e.g. Caddy/nginx) to install it on a phone. WebRTC itself does not require HTTPS.
- **H.264 decode support** is required in the browser (Chrome, Edge, Safari and iOS are fine; Firefox relies on platform codecs).

## Troubleshooting

- **Agent build fails on `pkg-config` / PipeWire / EGL / GBM:** install the apt packages listed in *Linux setup* step 2.
- **No sudo access:** extract the same `-dev` packages into a local prefix and point cargo at it via `apps/desktop-agent/.cargo/config.toml` (this machine uses that approach; the file is machine-local and gitignored).
- **No video, "Timed out while connecting":** make sure nothing blocks UDP between the devices (VPN, client isolation/"AP isolation" on the router, or a firewall). Opening the firewall for the agent port helps: `sudo ufw allow 8080/tcp`.
- **"Wrong PIN" repeatedly:** after 10 failed attempts the agent locks out for 60 seconds; restart it for a fresh PIN.
- **Portal dialog never appears / capture fails instantly:** xcap 0.9.8 from crates.io drops the D-Bus connection that owns the ScreenCast session, which kills the stream before the first frame. This repo vendors the crate at `apps/desktop-agent/vendor/xcap` and patches the lifetime (wired up via `[patch.crates-io]` in the agent's `Cargo.toml`) — build from the repo root as-is; do not delete the vendor directory.
- **Encoder warnings about `AdaptiveQuant` / `BackgroundDetection`:** harmless OpenH264 notices for screen-content mode.

## Roadmap

1. **Phase 1 — Foundation:** monorepo, runnable Rust agent, installable PWA dashboard. ✅
2. **Phase 2 — Streaming:** WebRTC screen capture streaming over local Wi-Fi. ✅
3. **Phase 3 — Control:** remote mouse/keyboard input via WebRTC DataChannel with trackpad-style gestures and on-screen keyboard, cursor embedding, and safe cleanup on disconnect.
4. **Phase 4 — Pairing & access:** secure device pairing, authentication, optional internet access.
