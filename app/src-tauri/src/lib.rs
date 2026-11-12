mod actions;
mod capture;
mod cli;
mod commands;
mod editor;
mod hotkeys;
mod library;
mod ocr;
mod overlay;
mod permissions;
#[cfg(target_os = "linux")]
mod portal;
mod screen;
mod search;
mod settings;
mod tray;
mod windows;

use std::{path::PathBuf, sync::Mutex};

use tauri::{App, Manager, RunEvent};

use settings::{SETTINGS_FILE, Settings, SettingsStore};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let open_target = cli::parse_open_target(std::env::args()).unwrap_or_else(|err| {
        eprintln!("Grab-it: {err}");
        None
    });

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(overlay::OverlayState::default())
        .manage(hotkeys::HotkeyState::default())
        .manage(editor::EditorState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_save_folder,
            commands::set_hotkeys,
            hotkeys::pause_hotkeys,
            hotkeys::resume_hotkeys,
            overlay::overlay_info,
            overlay::overlay_image,
            overlay::overlay_finish,
            overlay::overlay_cancel,
            editor::editor_info,
            editor::editor_image,
            editor::editor_save_annotations,
            editor::editor_copy,
            editor::editor_export,
            library::library_list,
            library::library_thumbnail,
            library::library_set_tags,
            library::library_set_notes,
            library::library_delete,
            library::library_open,
            search::library_search,
            search::library_filter_options,
            ocr::ocr_status,
            ocr::ocr_retry
        ])
        .setup(move |app| {
            // A tray app: no Dock icon on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let store = open_settings(app)?;
            let hotkeys = store.get().hotkeys.clone();
            app.manage(Mutex::new(store));
            let data_dir = app.path().app_data_dir()?;
            app.manage(library::open_for_app(&data_dir));

            let handle = app.handle();
            if uses_hotkey_plugin() {
                handle.plugin(hotkeys::plugin())?;
            }
            hotkeys::start(handle, &hotkeys);
            // Reads captures waiting for OCR, downloading the models first.
            ocr::start(handle, ocr::models_dir(&data_dir));
            // Picks up captures added while Grab-it was not running.
            library::rescan_in_background(handle, library::current_save_folder(handle));
            tray::create(handle)?;
            if let Some(target) = open_target {
                windows::open(handle, target)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Grab-it");

    app.run(|_app, event| {
        // Closing the last window keeps Grab-it running in the tray.
        // Only an explicit exit (the tray's Quit) carries an exit code.
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}

/// Wayland binds hotkeys through the GlobalShortcuts portal instead of the
/// global-shortcut plugin, which only works on X11, Windows and macOS.
fn uses_hotkey_plugin() -> bool {
    #[cfg(target_os = "linux")]
    {
        !portal::is_wayland()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

fn open_settings(app: &App) -> tauri::Result<SettingsStore> {
    let paths = app.path();
    let pictures = paths
        .picture_dir()
        .or_else(|_| paths.home_dir().map(|home| home.join("Pictures")))
        .unwrap_or_else(|_| PathBuf::from("Pictures"));
    let file = paths.app_data_dir()?.join(SETTINGS_FILE);
    Ok(SettingsStore::open(file, Settings::defaults(&pictures)))
}
