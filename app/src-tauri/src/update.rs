//! Updates: Grab-it checks the latest GitHub release shortly after it
//! starts and then every few hours, and asks before installing a newer
//! version. The tray's "Check for updates…" checks on demand.
//!
//! The release workflow publishes `latest.json` next to the installers,
//! each package signed with the key whose public half is in
//! `tauri.conf.json`; the updater refuses anything else. Its `changes` list
//! what each recent version brought, so the prompt can show everything an
//! update brings, however many versions behind this copy is.

use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use semver::Version;
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::quick;

/// How long after launch the first check waits, so it never competes with
/// starting up or with a capture taken right away.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(30);
/// How often a long-running Grab-it checks again.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// The most changes the prompt lists; the rest are summed up in a line.
const MAX_CHANGES: usize = 12;
/// Longer change descriptions are cut short, to keep the prompt readable.
const MAX_CHANGE_CHARS: usize = 100;

#[derive(Default)]
pub struct UpdateState {
    /// A check, prompt or install is under way.
    busy: AtomicBool,
    /// The version the user chose "Later" for. Automatic checks do not ask
    /// about it again until Grab-it restarts; "Check for updates…" does.
    declined: Mutex<Option<String>>,
}

/// Who asked for a check. Only a check the user asked for reports that
/// there is nothing new, or that the check failed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    Automatic,
    User,
}

/// Checks in the background now and then. Development builds only check
/// from the tray, since their version is rarely the released one.
pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_AFTER);
        loop {
            check(&app, Trigger::Automatic);
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

/// Checks from the tray, off the main thread: the prompts block.
pub fn check_from_tray(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || check(&app, Trigger::User));
}

/// Looks for a newer release and, if there is one, asks to install it.
/// Blocks, so it must not run on the main thread.
fn check(app: &AppHandle, trigger: Trigger) {
    let state = app.state::<UpdateState>();
    if state.busy.swap(true, Ordering::SeqCst) {
        if trigger == Trigger::User {
            notice(app, "Checking for updates", "Grab-it is already on it.");
        }
        return;
    }
    let found = tauri::async_runtime::block_on(async {
        app.updater()
            .map_err(|err| err.to_string())?
            .check()
            .await
            .map_err(|err| err.to_string())
    });
    match found {
        Ok(Some(update)) => offer(app, &state, update, trigger),
        Ok(None) => {
            if trigger == Trigger::User {
                notice(
                    app,
                    "Grab-it is up to date",
                    &format!(
                        "You have the latest version, {}.",
                        app.package_info().version
                    ),
                );
            }
        }
        Err(err) => {
            eprintln!("Grab-it: could not check for updates: {err}");
            if trigger == Trigger::User {
                message(
                    app,
                    "Could not check for updates",
                    &format!("{err}\n\nCheck your connection and try again."),
                    MessageDialogKind::Error,
                );
            }
        }
    }
    state.busy.store(false, Ordering::SeqCst);
}

fn offer(app: &AppHandle, state: &UpdateState, update: Update, trigger: Trigger) {
    let mut declined = state.declined.lock().unwrap_or_else(|e| e.into_inner());
    if !should_ask(trigger, declined.as_deref(), &update.version) {
        return;
    }
    let install = app
        .dialog()
        .message(prompt_text(
            &update.current_version,
            &update.version,
            &changes_since(&update),
        ))
        .title("Update Grab-it")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and Restart".into(),
            "Later".into(),
        ))
        .blocking_show();
    if !install {
        *declined = Some(update.version.clone());
        return;
    }
    drop(declined);
    install_and_restart(app, &update);
}

/// Whether to ask about `version`: always when the user asked, otherwise
/// only if they have not already said "Later" to it.
fn should_ask(trigger: Trigger, declined: Option<&str>, version: &str) -> bool {
    trigger == Trigger::User || declined != Some(version)
}

/// What one version brought, as `latest.json` lists it.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
struct Changes {
    version: String,
    #[serde(default)]
    items: Vec<String>,
}

/// The changes between this copy and the update, newest first.
fn changes_since(update: &Update) -> Vec<Changes> {
    let listed = update
        .raw_json
        .get("changes")
        .cloned()
        .and_then(|changes| serde_json::from_value(changes).ok())
        .unwrap_or_default();
    pick_changes(
        listed,
        &update.current_version,
        &update.version,
        update.body.as_deref(),
    )
}

/// Keeps the versions after `current`, up to and including `available`.
/// Without a changelog, the update's notes (a Markdown list) stand in.
fn pick_changes(
    listed: Vec<Changes>,
    current: &str,
    available: &str,
    notes: Option<&str>,
) -> Vec<Changes> {
    let (Ok(current), Ok(newest)) = (Version::parse(current), Version::parse(available)) else {
        return Vec::new();
    };
    let mut picked: Vec<(Version, Changes)> = listed
        .into_iter()
        .filter_map(|changes| {
            let version = Version::parse(&changes.version).ok()?;
            (version > current && version <= newest).then_some((version, changes))
        })
        .collect();
    picked.sort_by(|a, b| b.0.cmp(&a.0));
    if picked.is_empty()
        && let Some(notes) = notes
    {
        let items: Vec<String> = notes
            .lines()
            .filter_map(|line| line.trim().strip_prefix("- "))
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect();
        if !items.is_empty() {
            return vec![Changes {
                version: available.to_string(),
                items,
            }];
        }
    }
    picked.into_iter().map(|(_, changes)| changes).collect()
}

fn prompt_text(current: &str, available: &str, changes: &[Changes]) -> String {
    let mut text = format!("Grab-it {available} is available. You have {current}.\n\n");
    text.push_str(&changes_text(changes));
    text.push_str("\n\nInstall it now? Grab-it restarts when the update is in.");
    text
}

/// The changes as a bulleted list, headed by version when there are
/// several, and cut off after [`MAX_CHANGES`].
fn changes_text(changes: &[Changes]) -> String {
    let with_items: Vec<&Changes> = changes.iter().filter(|c| !c.items.is_empty()).collect();
    if with_items.is_empty() {
        return "This update brings fixes and small improvements.".to_string();
    }
    let total: usize = with_items.iter().map(|c| c.items.len()).sum();
    let mut lines = Vec::new();
    let mut shown = 0;
    for changes in &with_items {
        if shown == MAX_CHANGES {
            break;
        }
        if with_items.len() > 1 {
            if !lines.is_empty() {
                lines.push(String::new());
            }
            lines.push(format!("New in {}:", changes.version));
        } else {
            lines.push("What's new:".to_string());
        }
        for item in changes.items.iter().take(MAX_CHANGES - shown) {
            lines.push(format!("• {}", shorten(item)));
            shown += 1;
        }
    }
    if total > shown {
        let more = total - shown;
        let changes = if more == 1 { "change" } else { "changes" };
        lines.push(format!("…and {more} more {changes}."));
    }
    lines.join("\n")
}

fn shorten(item: &str) -> String {
    if item.chars().count() <= MAX_CHANGE_CHARS {
        return item.to_string();
    }
    let cut: String = item.chars().take(MAX_CHANGE_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

fn install_and_restart(app: &AppHandle, update: &Update) {
    notice(
        app,
        &format!("Updating to Grab-it {}", update.version),
        "Downloading the update. Grab-it restarts when it is done.",
    );
    // A recording in progress is finished first, so its GIF is complete.
    crate::record::stop_and_wait(app);
    let installed = tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {}));
    match installed {
        // On Windows the installer has already closed Grab-it by now.
        Ok(()) => app.restart(),
        Err(err) => {
            eprintln!("Grab-it: could not install the update: {err}");
            message(
                app,
                "Could not update Grab-it",
                &format!(
                    "{err}\n\nYou can download Grab-it {} from its GitHub releases page instead.",
                    update.version
                ),
                MessageDialogKind::Error,
            );
        }
    }
}

/// A Quick Access card: for news that needs no answer.
fn notice(app: &AppHandle, title: &str, message: &str) {
    quick::show(
        app,
        quick::QuickItem::Notice {
            title: title.into(),
            message: message.into(),
        },
    );
}

fn message(app: &AppHandle, title: &str, text: &str, kind: MessageDialogKind) {
    app.dialog()
        .message(text)
        .title(title)
        .kind(kind)
        .blocking_show();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn later_silences_automatic_checks_for_that_version_only() {
        assert!(should_ask(Trigger::Automatic, None, "0.4.0"));
        assert!(!should_ask(Trigger::Automatic, Some("0.4.0"), "0.4.0"));
        assert!(should_ask(Trigger::Automatic, Some("0.4.0"), "0.5.0"));
        assert!(should_ask(Trigger::User, Some("0.4.0"), "0.4.0"));
    }

    fn changes(version: &str, items: &[&str]) -> Changes {
        Changes {
            version: version.into(),
            items: items.iter().map(|item| item.to_string()).collect(),
        }
    }

    #[test]
    fn the_prompt_names_both_versions_and_the_changes() {
        let text = prompt_text(
            "0.3.0",
            "0.4.0",
            &[changes("0.4.0", &["Check for updates"])],
        );
        assert_eq!(
            text,
            "Grab-it 0.4.0 is available. You have 0.3.0.\n\n\
             What's new:\n\
             • Check for updates\n\n\
             Install it now? Grab-it restarts when the update is in."
        );
    }

    #[test]
    fn only_versions_since_this_one_count_newest_first() {
        let listed = vec![
            changes("0.3.0", &["Three"]),
            changes("0.5.0", &["Five"]),
            changes("0.10.0", &["Ten"]),
            changes("0.4.0", &["Four"]),
            changes("0.6.0", &["Six"]),
            changes("not a version", &["?"]),
        ];
        let picked = pick_changes(listed, "0.3.0", "0.5.0", None);
        assert_eq!(
            picked,
            vec![changes("0.5.0", &["Five"]), changes("0.4.0", &["Four"])]
        );
    }

    #[test]
    fn without_a_changelog_the_notes_stand_in() {
        let picked = pick_changes(Vec::new(), "0.3.0", "0.4.0", Some("- One\n- Two\n\nmore"));
        assert_eq!(picked, vec![changes("0.4.0", &["One", "Two"])]);
        assert!(pick_changes(Vec::new(), "0.3.0", "0.4.0", Some("prose")).is_empty());
        assert!(pick_changes(Vec::new(), "0.3.0", "0.4.0", None).is_empty());
    }

    #[test]
    fn several_versions_are_headed_by_version() {
        let text = changes_text(&[
            changes("0.5.0", &["Five"]),
            changes("0.4.1", &[]),
            changes("0.4.0", &["Four"]),
        ]);
        assert_eq!(text, "New in 0.5.0:\n• Five\n\nNew in 0.4.0:\n• Four");
    }

    #[test]
    fn long_lists_are_cut_off_with_a_count() {
        let many: Vec<String> = (1..=15).map(|n| format!("Change {n}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        let text = changes_text(&[changes("0.5.0", &many[..10]), changes("0.4.0", &many[10..])]);
        assert_eq!(text.matches('•').count(), MAX_CHANGES);
        assert!(text.contains("New in 0.4.0:\n• Change 11\n• Change 12\n…and 3 more changes."));
    }

    #[test]
    fn no_listed_changes_still_says_something() {
        assert_eq!(
            changes_text(&[changes("0.4.0", &[])]),
            "This update brings fixes and small improvements."
        );
    }

    #[test]
    fn long_changes_are_shortened() {
        let long = "x".repeat(150);
        let short = shorten(&long);
        assert_eq!(short.chars().count(), MAX_CHANGE_CHARS);
        assert!(short.ends_with('…'));
        assert_eq!(shorten("Short"), "Short");
    }
}
