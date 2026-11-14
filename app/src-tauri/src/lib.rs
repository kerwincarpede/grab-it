mod actions;
mod ai;
mod ai_cli;
mod capture;
mod cli;
mod commands;
mod editor;
mod hotkeys;
mod hub;
mod keychain;
mod library;
mod ocr;
mod overlay;
mod permissions;
mod pin;
#[cfg(target_os = "linux")]
mod portal;
mod quick;
mod record;
mod screen;
mod search;
mod settings;
mod tidy;
mod tray;
mod update;
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
        // Registered first, as the plugin asks: a second launch hands its
        // arguments to the running Grab-it and exits, so `grab-it --open
        // region` works as a desktop shortcut or a script.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            second_launch(app, args);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(overlay::OverlayState::default())
        .manage(overlay::SpareState::default())
        .manage(overlay::LastRegionState::default())
        .manage(quick::QuickState::default())
        .manage(pin::PinState::default())
        .manage(record::RecordState::default())
        .manage(hotkeys::HotkeyState::default())
        .manage(editor::EditorState::default())
        .manage(update::UpdateState::default())
        .manage(hub::HubState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_save_folder,
            commands::set_hotkeys,
            commands::set_preferences,
            commands::get_editor_preferences,
            commands::set_editor_preferences,
            commands::set_auto_backdrop,
            commands::dismiss_ai_notice,
            commands::open_target,
            commands::get_autostart,
            commands::set_autostart,
            commands::set_show_in_dock,
            commands::set_appearance,
            hub::hub_capture,
            hub::hub_monitors,
            hub::hub_open,
            hub::hub_check_updates,
            hub::hub_quit,
            hub::hub_hide,
            quick::quick_info,
            quick::quick_thumbnail,
            quick::quick_action,
            pin::pin_info,
            pin::pin_image,
            pin::pin_zoom,
            pin::pin_copy,
            pin::pin_edit,
            pin::pin_close,
            pin::editor_pin,
            record::record_stop,
            hotkeys::pause_hotkeys,
            hotkeys::resume_hotkeys,
            overlay::overlay_info,
            overlay::overlay_image,
            overlay::overlay_ready,
            overlay::overlay_finish,
            overlay::overlay_cancel,
            editor::editor_info,
            editor::editor_image,
            editor::editor_backdrop_image,
            editor::editor_save_annotations,
            editor::editor_copy,
            editor::editor_export,
            library::library_list,
            library::library_thumbnail,
            library::library_set_tags,
            search::library_sidebar,
            library::library_remove_ai_tag,
            library::library_set_notes,
            library::library_delete,
            library::library_open,
            library::library_copy,
            library::library_text,
            library::library_copy_text,
            library::library_pin,
            library::library_reveal,
            search::library_search,
            search::library_filter_options,
            ocr::ocr_status,
            ocr::ocr_retry,
            ai::ai_status,
            ai::ai_redescribe,
            ai::ai_clear,
            ai::ai_redescribe_all,
            ai::ai_test_connection,
            ai::ai_clis,
            update::update_status,
            update::update_check,
            update::update_install,
            update::update_later
        ])
        .setup(move |app| {
            let mut store = open_settings(app)?;
            // macOS: a Dock icon that opens the Grab-it window, unless the
            // user keeps Grab-it in the menu bar only.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(if store.get().show_in_dock {
                tauri::ActivationPolicy::Regular
            } else {
                tauri::ActivationPolicy::Accessory
            });

            let hotkeys = store.get().hotkeys.clone();
            // A tray app shows nothing when it starts, so the very first
            // launch opens a short welcome with the hotkeys.
            let first_run = store.is_first_run();
            if first_run && let Err(err) = store.finish_first_run() {
                eprintln!("Grab-it: could not write the settings file: {err}");
            }
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
            // Describes captures with a vision model, once turned on. With
            // Claude Code or Codex installed, its thread first turns
            // describing on once for a user who never turned it on.
            ai::start(handle);
            // Picks up captures added while Grab-it was not running.
            library::rescan_in_background(handle, library::current_save_folder(handle));
            pin::clear_stale(handle);
            tray::create(handle)?;
            // Offers newer releases from GitHub.
            update::start(handle);
            // Has a capture overlay loaded and waiting, so the first
            // selection appears as fast as any other.
            overlay::prewarm_later(handle);
            if let Some(target) = open_target {
                windows::open(handle, target)?;
            } else if first_run {
                windows::show_welcome(handle)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Grab-it");

    app.run(|app, event| {
        // Only macOS uses the handle, for the Dock icon below.
        #[cfg(not(target_os = "macos"))]
        let _ = app;
        match event {
            // Closing the last window keeps Grab-it running in the tray.
            // Only an explicit exit (the tray's Quit) carries an exit code.
            RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            // Clicking the Dock icon with no window open shows the Grab-it window.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                if let Err(err) = windows::show_library(app) {
                    eprintln!("Grab-it: {err}");
                }
            }
            _ => {}
        }
    });
}

/// Runs what a second launch asked for in this, the running, instance.
/// Without `--open` it shows the Library, so launching Grab-it again from
/// the applications menu visibly does something.
fn second_launch(app: &tauri::AppHandle, args: Vec<String>) {
    let target = match cli::parse_open_target(args) {
        Ok(target) => target.unwrap_or(cli::OpenTarget::Library),
        Err(err) => {
            eprintln!("Grab-it: {err}");
            return;
        }
    };
    let app = app.clone();
    // Off the main thread: opening a window from this callback would
    // deadlock on Windows.
    std::thread::spawn(move || {
        if let Err(err) = windows::open(&app, target) {
            eprintln!("Grab-it: {err}");
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
