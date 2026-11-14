fn main() {
    // ScreenCaptureKit records the system sound on macOS 13+ (see
    // src/audio/system_mac.rs), but does not exist before 12.3: linked
    // weakly, Grab-it still starts there and only offers no system sound.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
    }
    tauri_build::build()
}
