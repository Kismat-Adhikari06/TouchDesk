fn main() {
    println!("Desktop Agent v{}", env!("CARGO_PKG_VERSION"));
    println!(
        "Operating system: {} ({})",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!("Remote Desktop Agent Ready");
}
