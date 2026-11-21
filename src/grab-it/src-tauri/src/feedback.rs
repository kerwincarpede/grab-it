//! Send feedback: opens a GitHub issue form in the browser, filled in with
//! the Grab-it version and system, for the user to finish and submit.
//! Nothing is sent until they submit the form themselves.

use crate::rt::AppHandle;
use tauri::Url;
use tauri_plugin_opener::OpenerExt;

const NEW_ISSUE_URL: &str = "https://github.com/kerwincarpede/grab-it/issues/new";

/// Which issue form to open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    /// Report a problem: `.github/ISSUE_TEMPLATE/bug_report.yml`.
    Problem,
    /// Suggest an idea: `.github/ISSUE_TEMPLATE/feature_request.yml`.
    Idea,
}

impl Form {
    fn template(self) -> &'static str {
        match self {
            Form::Problem => "bug_report.yml",
            Form::Idea => "feature_request.yml",
        }
    }
}

/// The issue form's address with `version` and `os` filled in. The query
/// keys are the forms' field ids, so a renamed field must change here too.
pub fn form_url(form: Form, version: &str, os: &str) -> Url {
    Url::parse_with_params(
        NEW_ISSUE_URL,
        [
            ("template", form.template()),
            ("version", version),
            ("os", os),
        ],
    )
    .expect("the new-issue address is valid")
}

/// The system as the forms show it, such as `Linux x86_64 (Wayland)`.
fn system() -> String {
    let os = match std::env::consts::OS {
        "linux" => "Linux",
        "macos" => "macOS",
        "windows" => "Windows",
        other => other,
    };
    let arch = std::env::consts::ARCH;
    format!("{os} {arch}{}", session())
}

/// On Linux, whether the session is X11 or Wayland, which changes how
/// capture works there.
#[cfg(target_os = "linux")]
fn session() -> &'static str {
    if crate::portal::is_wayland() {
        " (Wayland)"
    } else {
        " (X11)"
    }
}

#[cfg(not(target_os = "linux"))]
fn session() -> &'static str {
    ""
}

/// Opens `form` in the user's browser, filled in from the running app.
pub fn open(app: &AppHandle, form: Form) {
    let version = app.package_info().version.to_string();
    let url = form_url(form, &version, &system());
    if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("Grab-it: could not open the feedback form: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn problem_opens_the_bug_form() {
        let url = form_url(Form::Problem, "1.2.3", "Windows x86_64");
        assert_eq!(
            url.as_str(),
            "https://github.com/kerwincarpede/grab-it/issues/new\
             ?template=bug_report.yml&version=1.2.3&os=Windows+x86_64"
        );
    }

    #[test]
    fn idea_opens_the_feature_form() {
        let url = form_url(Form::Idea, "1.2.3", "macOS aarch64");
        assert_eq!(
            url.as_str(),
            "https://github.com/kerwincarpede/grab-it/issues/new\
             ?template=feature_request.yml&version=1.2.3&os=macOS+aarch64"
        );
    }

    #[test]
    fn os_is_escaped_and_reads_back_unchanged() {
        let os = "Linux x86_64 (Wayland) & more=#?";
        let url = form_url(Form::Problem, "1.2.3-beta.1", os);
        assert_eq!(
            url.query(),
            Some(
                "template=bug_report.yml&version=1.2.3-beta.1\
                 &os=Linux+x86_64+%28Wayland%29+%26+more%3D%23%3F"
            )
        );
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert_eq!(
            pairs,
            [
                ("template".into(), "bug_report.yml".into()),
                ("version".into(), "1.2.3-beta.1".into()),
                ("os".into(), os.into()),
            ]
        );
        assert_eq!(url.fragment(), None);
    }

    #[test]
    fn system_names_the_os_and_architecture() {
        let system = system();
        assert!(system.contains(std::env::consts::ARCH));
        #[cfg(target_os = "linux")]
        assert!(system.ends_with("(Wayland)") || system.ends_with("(X11)"));
    }
}
