fn main() {
    // ScreenCaptureKit records the system sound on macOS 13+ (see
    // src/audio/system_mac.rs), but does not exist before 12.3: linked
    // weakly, Grab-it still starts there and only offers no system sound.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
    }

    // tauri-build embeds the Common Controls v6 manifest in the app binary
    // only, so the test executables load the system's v5 comctl32 and exit
    // at startup with STATUS_ENTRYPOINT_NOT_FOUND (TaskDialogIndirect).
    // Embedding the same manifest through the linker gives it to every
    // binary, tests included.
    let mut windows = tauri_build::WindowsAttributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }

    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("{error:#}");
    }
}
