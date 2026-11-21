//! The Tauri runtime Grab-it is built on, named once for the whole crate.
//!
//! The app runs on Wry. The IPC tests (`ipc_tests.rs`) build the same
//! commands on Tauri's mock runtime, so every module names its handles
//! through these aliases rather than `tauri::AppHandle` or `tauri::Wry`.

/// The runtime the app runs on: Wry, or Tauri's mock runtime in tests.
#[cfg(not(test))]
pub type Rt = tauri::Wry;
/// The runtime the app runs on: Wry, or Tauri's mock runtime in tests.
#[cfg(test)]
pub type Rt = tauri::test::MockRuntime;

/// A handle to the running app.
pub type AppHandle = tauri::AppHandle<Rt>;
/// A window with its webview.
pub type WebviewWindow = tauri::WebviewWindow<Rt>;
/// A native window, as a webview's events and the IPC hand it over.
#[allow(dead_code)]
pub type Window = tauri::Window<Rt>;
/// An item in the tray menu.
pub type MenuItem = tauri::menu::MenuItem<Rt>;
/// A submenu of the tray menu.
pub type Submenu = tauri::menu::Submenu<Rt>;
/// A plugin registered with the app.
pub type TauriPlugin = tauri::plugin::TauriPlugin<Rt>;
