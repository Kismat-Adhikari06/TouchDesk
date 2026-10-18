# Connect To Desktop

A lightweight, open-source, cross-platform remote desktop system that lets you view and control your Windows, macOS, or Linux computer directly from a phone — through a web browser or an installable PWA. No native mobile app required.

**Philosophy:** lightweight, open-source, secure, mobile-first, and easy to self-host.

> **Status: Phase 1 (foundation).** The monorepo, Rust agent, and PWA dashboard build and run. Screen streaming, mouse/keyboard control, pairing, and networking arrive in later phases. See `PROJECT_IDEA.md` for the full product vision.

## Structure

```
apps/
  desktop-agent/   # Rust agent — prints version/OS, ready line (Phase 1)
  web/             # React + TypeScript + Vite PWA dashboard
docs/              # Design specs
scripts/           # generate-icons.mjs (zero-dep PWA icon generator)
```

## Requirements

- **Linux** (developed and verified on Ubuntu, x86_64)
- **Rust** via [rustup](https://rustup.rs) (stable toolchain: cargo, rustc, clippy, rustfmt)
- **Node.js ≥ 20** with npm
- **System libraries** for the agent (XCap/Enigo compile-time dependencies)

## Linux setup

```bash
# 1. Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. System build libraries for the desktop agent
sudo apt install -y pkg-config clang \
  libpipewire-0.3-dev libspa-0.2-dev libegl-dev libgbm-dev \
  libwayland-dev libdrm-dev libx11-dev libxcb1-dev

# 3. Desktop agent
cd apps/desktop-agent
cargo build

# 4. Web app
cd ../web
npm install
```

## Development commands

| Task | Command |
|---|---|
| Run the desktop agent | `cd apps/desktop-agent && cargo run` |
| Lint the agent | `cd apps/desktop-agent && cargo clippy -- -D warnings` |
| Format-check the agent | `cd apps/desktop-agent && cargo fmt -- --check` |
| Start the web dev server | `cd apps/web && npm run dev` |
| Production build of the web app | `cd apps/web && npm run build` |
| Serve the production build | `cd apps/web && npm run preview` |
| Lint the web app | `cd apps/web && npm run lint` |
| Regenerate PWA icons | `node scripts/generate-icons.mjs` |

Expected agent output:

```
Desktop Agent v0.1.0
Operating system: linux (x86_64)
Remote Desktop Agent Ready
```

The web app is a PWA: production builds ship a web app manifest and service worker, so the dashboard is installable on Android and iOS browsers.

## Troubleshooting

- **Agent build fails on `pkg-config` / PipeWire / EGL / GBM:** install the apt packages listed in *Linux setup* step 2.
- **No sudo access:** extract the same `-dev` packages into a local prefix and point cargo at it via `apps/desktop-agent/.cargo/config.toml` (this machine uses that approach; the file is machine-local and gitignored).

## Roadmap

1. **Phase 1 — Foundation:** monorepo, runnable Rust agent, installable PWA dashboard. ✅
2. **Phase 2 — Streaming:** WebRTC screen capture streaming over local Wi-Fi.
3. **Phase 3 — Control:** remote mouse/keyboard input via WebRTC DataChannel.
4. **Phase 4 — Pairing & access:** secure device pairing, authentication, optional internet access.
