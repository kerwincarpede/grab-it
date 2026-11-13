mod cli;
mod commands;
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
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_save_folder
        ])
        .setup(move |app| {
            // A tray app: no Dock icon on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let store = open_settings(app)?;
            app.manage(Mutex::new(store));

            let handle = app.handle();
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

fn open_settings(app: &App) -> tauri::Result<SettingsStore> {
    let paths = app.path();
    let pictures = paths
        .picture_dir()
        .or_else(|_| paths.home_dir().map(|home| home.join("Pictures")))
        .unwrap_or_else(|_| PathBuf::from("Pictures"));
    let file = paths.app_data_dir()?.join(SETTINGS_FILE);
    Ok(SettingsStore::open(file, Settings::defaults(&pictures)))
}
