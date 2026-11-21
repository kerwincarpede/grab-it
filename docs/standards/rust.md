# Rust backend standards

These apply to `src/grab-it/src-tauri/`. Each feature has its own module in `src/` (`pin.rs`, `library.rs`, `record.rs` and so on). `lib.rs` wires them into the app.

## Commands

- A `#[tauri::command]` lives in the module it belongs to. It is only reachable once it is listed in `tauri::generate_handler![...]` in `invoke_handler` in `lib.rs`, which the app and the IPC tests share.
- Name handles through the `crate::rt` aliases (`AppHandle`, `WebviewWindow`, `MenuItem` and so on), never a concrete `tauri::AppHandle` or `tauri::Wry`. They are Wry in the app and Tauri's mock runtime in tests, so the IPC tests can build the real commands.
- Commands return `Result<T, String>`, so the frontend gets a message it can show. Inside a module, use a typed error (for example `LibraryResult`) and turn it into a `String` at the command.
- Send bytes as `tauri::ipc::Response`, not as a JSON array.
- Check arguments from the page before using them, for example that `factor.is_finite() && factor > 0.0` in `pin_zoom`. The page is not trusted to send sane values.
- If a struct crosses the bridge, its TypeScript twin in an `api.ts` must change in the same PR (see [frontend.md](frontend.md)).

## Windows and capabilities

- A new window label has to match a pattern in `capabilities/*.json`, or the window's page can't call anything.
- Add a permission to a capability only when a window needs it, and only to that window's capability.

## Platforms

- Put platform-specific code behind `#[cfg(target_os = "...")]`, and give the other platforms a `#[cfg(not(...))]` fallback so all three still compile. CI builds Windows, macOS and Linux.
- Wayland is a runtime case (`WAYLAND_DISPLAY`), not a compile-time one. Capture goes through the portals there. Features that can't work on Wayland must say so rather than fail quietly.
- Never block the main thread with encoding, file I/O or OCR. The capture overlay has to appear at once. See "Captures on disk" in [development.md](../development.md).

## Style

- `cargo fmt` and `cargo clippy --all-targets -- -D warnings` must be clean. Warnings fail CI.
- Give public items a `///` comment that says what they do and why, not how.
- Tests go in a `#[cfg(test)] mod tests` at the bottom of the module they test. They must run without a network or display. OCR tests use the bundled models in `ocr-models/`. The one exception is `src/ipc_tests.rs`, the crate-level module that calls commands through Tauri's IPC on the mock runtime.
- Debug switches are `GRAB_IT_*` environment variables (for example `GRAB_IT_TRACE_OVERLAY`). Document a new one in `development.md`.
