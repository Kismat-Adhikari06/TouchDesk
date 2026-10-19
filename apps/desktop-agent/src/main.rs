mod capture;
mod encode;
mod input;
mod peer;
mod signaling;

use anyhow::Context;
use capture::StreamConfig;
use signaling::{AgentSettings, app};
use std::net::{TcpListener, UdpSocket};

struct Args {
    bind: String,
    fps: u32,
    max_width: u32,
    bitrate: u32,
    pin: Option<String>,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            bind: "0.0.0.0:8080".to_owned(),
            fps: 30,
            max_width: 1280,
            bitrate: 2_000_000,
            pin: None,
        }
    }
}

fn usage() -> &'static str {
    "\
Usage: desktop-agent [options]

Options:
  --bind <addr:port>    listen address (default 0.0.0.0:8080)
  --fps <n>             stream frame rate (default 30)
  --max-width <n>       max stream width in pixels (default 1280)
  --bitrate <bps>       video bitrate in bits per second (default 2000000)
  --pin <pin>           fixed PIN (default: random each run)
  --help                show this help"
}

fn parse_args() -> anyhow::Result<Args> {
    let mut args = Args::default();
    let mut iter = std::env::args().skip(1);
    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--bind" => args.bind = iter.next().with_context(|| "--bind requires a value")?,
            "--fps" => {
                args.fps = iter
                    .next()
                    .with_context(|| "--fps requires a value")?
                    .parse()
                    .context("--fps must be a number")?
            }
            "--max-width" => {
                args.max_width = iter
                    .next()
                    .with_context(|| "--max-width requires a value")?
                    .parse()
                    .context("--max-width must be a number")?
            }
            "--bitrate" => {
                args.bitrate = iter
                    .next()
                    .with_context(|| "--bitrate requires a value")?
                    .parse()
                    .context("--bitrate must be a number")?
            }
            "--pin" => args.pin = Some(iter.next().with_context(|| "--pin requires a value")?),
            "--help" | "-h" => {
                println!("{}", usage());
                std::process::exit(0);
            }
            other => anyhow::bail!("unknown option {other}\n\n{}", usage()),
        }
    }
    if args.fps == 0 || args.fps > 120 {
        anyhow::bail!("--fps must be between 1 and 120");
    }
    if args.max_width < 160 {
        anyhow::bail!("--max-width must be at least 160");
    }
    if args.bitrate < 100_000 {
        anyhow::bail!("--bitrate must be at least 100000");
    }
    Ok(args)
}

/// Best-effort LAN IP: connect a UDP socket to a documentation address (no
/// packet is ever sent) and read which source address the routing table picks.
fn lan_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    let address = socket.local_addr().ok()?;
    if address.ip().is_unspecified() {
        None
    } else {
        Some(address.ip().to_string())
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    println!("Desktop Agent v{}", env!("CARGO_PKG_VERSION"));
    println!(
        "Operating system: {} ({})",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!("Remote Desktop Agent Ready");

    let args = match parse_args() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("{err:#}");
            std::process::exit(2);
        }
    };
    let pin = args
        .pin
        .unwrap_or_else(|| format!("{:06}", rand::random::<u32>() % 1_000_000));

    let listener =
        TcpListener::bind(&args.bind).with_context(|| format!("binding {}", args.bind))?;
    let listener = tokio::net::TcpListener::from_std(listener).context("preparing listener")?;
    let local = listener.local_addr().context("reading listen address")?;
    let host = if local.ip().is_unspecified() {
        lan_ip().unwrap_or_else(|| "127.0.0.1".to_owned())
    } else {
        local.ip().to_string()
    };

    let input_info = input::init();
    println!("{}", input_info.status);
    if input_info.handle.available {
        println!("Remote control is available from the viewer.");
    } else {
        println!("Remote control is unavailable on this setup; the viewer stays read-only.");
    }

    let state = signaling::AppState::new(
        AgentSettings {
            pin: pin.clone(),
            stream: StreamConfig {
                fps: args.fps,
                max_width: args.max_width,
                bitrate: args.bitrate,
            },
        },
        input_info.handle,
    );

    println!("Listening on {}", listener.local_addr().unwrap_or(local));
    println!("PIN: {pin}");
    println!(
        "Enter {host}:{port} in the dashboard to connect",
        port = local.port()
    );

    axum::serve(listener, app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .context("server error")
}
