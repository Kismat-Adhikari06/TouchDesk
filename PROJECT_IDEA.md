# Cross-Platform Remote Desktop PWA

## Goal

Build a lightweight, open-source remote desktop system that allows users to view and control their Windows, macOS, or Linux computer directly from their phone using a web browser or installable PWA.

## How It Works

The system consists of three main components:

1. **Desktop Agent (Rust)** — A lightweight application installed on the computer that captures the screen using XCap and controls mouse/keyboard input using Enigo.
2. **Web/PWA Client (React + TypeScript)** — A mobile-friendly interface that displays the computer's screen and allows users to interact using touch gestures, a virtual trackpad, and their phone's keyboard.
3. **Communication Layer (WebRTC)** — Provides low-latency screen streaming and sends mouse/keyboard commands securely between devices.

## Core Features

- Live desktop screen streaming.
- Remote mouse and keyboard control.
- Touchscreen and virtual trackpad modes.
- Support for Windows, macOS, and Linux.
- Local Wi-Fi connections initially.
- Secure device pairing and authentication.
- Installable PWA for Android and iOS.
- Adjustable screen quality and frame rate.
- Lightweight desktop agent.
- Free, open-source, and self-hostable.

## Tech Stack

| Component | Technology |
|---|---|
| Desktop Agent | Rust |
| Screen Capture | XCap |
| Mouse/Keyboard | Enigo |
| Frontend | React + TypeScript |
| Styling | Tailwind CSS |
| PWA | Vite PWA |
| Streaming | WebRTC |
| Input Communication | WebRTC DataChannel |
| Signaling | WebSocket |

## Development Approach

Start with a local Wi-Fi MVP supporting screen viewing, mouse control, and keyboard input. Then introduce optimized WebRTC streaming, cross-platform improvements, and optional internet-based remote access.

## Main Vision

Create a fast, minimal, privacy-focused alternative to Chrome Remote Desktop and RustDesk, designed specifically for controlling computers from mobile devices without requiring a native mobile application.

## Project Philosophy

**Lightweight, open-source, secure, mobile-first, and easy to self-host.**
