//! Command-line arguments.
//!
//! `--open <target>` opens a window directly at startup. It lets the app be
//! driven without a tray host, for example under `xvfb-run` for screenshots.

use std::{fmt, path::PathBuf};

/// A window that `--open` can show at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenTarget {
    Settings,
    /// Starts a region capture, showing the overlay.
    Region,
    /// Opens a capture in the annotation editor: `--open editor <file>`.
    Editor(PathBuf),
    /// The Library window.
    Library,
    /// Starts a text capture: drag over text to copy it.
    Text,
    /// Starts the colour picker.
    Colour,
    /// Captures the last dragged region again.
    Repeat,
    /// Starts a GIF recording, or stops the one under way.
    Record,
    /// Shows a capture on the Quick Access card: `--open quick <file>`.
    Quick(PathBuf),
    /// Pins an image above other windows: `--open pin <file>`.
    Pin(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgsError {
    MissingTarget,
    UnknownTarget(String),
    /// `--open editor`, `quick` or `pin` without the file to open.
    MissingFile(String),
}

impl fmt::Display for ArgsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingTarget => {
                write!(f, "--open needs a target, for example `--open settings`")
            }
            Self::UnknownTarget(name) => {
                write!(
                    f,
                    "unknown --open target `{name}`; expected `settings`, `library`, `region`, `repeat`, `record`, `text`, `colour`, `editor <file>`, `quick <file>` or `pin <file>`"
                )
            }
            Self::MissingFile(target) => {
                write!(
                    f,
                    "--open {target} needs a capture, for example `--open {target} shot.png`"
                )
            }
        }
    }
}

impl std::error::Error for ArgsError {}

/// Finds the `--open` target in the process arguments.
///
/// The first item is the program name and is skipped. Other arguments are
/// ignored, since platforms may add their own (macOS adds `-psn_…`).
pub fn parse_open_target<I, S>(args: I) -> Result<Option<OpenTarget>, ArgsError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut args = args.into_iter().skip(1);
    while let Some(arg) = args.next() {
        let arg = arg.as_ref();
        let name = if arg == "--open" {
            match args.next() {
                Some(value) => value.as_ref().to_owned(),
                None => return Err(ArgsError::MissingTarget),
            }
        } else if let Some(value) = arg.strip_prefix("--open=") {
            value.to_owned()
        } else {
            continue;
        };
        if name.is_empty() {
            return Err(ArgsError::MissingTarget);
        }
        return match name.as_str() {
            "settings" => Ok(Some(OpenTarget::Settings)),
            "region" => Ok(Some(OpenTarget::Region)),
            "library" => Ok(Some(OpenTarget::Library)),
            "text" => Ok(Some(OpenTarget::Text)),
            "colour" | "color" => Ok(Some(OpenTarget::Colour)),
            "repeat" => Ok(Some(OpenTarget::Repeat)),
            "record" => Ok(Some(OpenTarget::Record)),
            "editor" | "quick" | "pin" => match args.next() {
                Some(file) if !file.as_ref().is_empty() => {
                    let file = PathBuf::from(file.as_ref());
                    Ok(Some(match name.as_str() {
                        "editor" => OpenTarget::Editor(file),
                        "quick" => OpenTarget::Quick(file),
                        _ => OpenTarget::Pin(file),
                    }))
                }
                _ => Err(ArgsError::MissingFile(name)),
            },
            _ => Err(ArgsError::UnknownTarget(name)),
        };
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Option<OpenTarget>, ArgsError> {
        parse_open_target(std::iter::once("grab-it").chain(args.iter().copied()))
    }

    #[test]
    fn no_arguments_opens_nothing() {
        assert_eq!(parse(&[]), Ok(None));
    }

    #[test]
    fn open_settings_as_two_arguments() {
        assert_eq!(
            parse(&["--open", "settings"]),
            Ok(Some(OpenTarget::Settings))
        );
    }

    #[test]
    fn open_settings_with_equals() {
        assert_eq!(parse(&["--open=settings"]), Ok(Some(OpenTarget::Settings)));
    }

    #[test]
    fn open_region() {
        assert_eq!(parse(&["--open", "region"]), Ok(Some(OpenTarget::Region)));
        assert_eq!(parse(&["--open=region"]), Ok(Some(OpenTarget::Region)));
    }

    #[test]
    fn open_library() {
        assert_eq!(parse(&["--open", "library"]), Ok(Some(OpenTarget::Library)));
        assert_eq!(parse(&["--open=library"]), Ok(Some(OpenTarget::Library)));
    }

    #[test]
    fn open_editor_with_a_file() {
        assert_eq!(
            parse(&["--open", "editor", "/tmp/shot.png"]),
            Ok(Some(OpenTarget::Editor(PathBuf::from("/tmp/shot.png"))))
        );
        assert_eq!(
            parse(&["--open=editor", "shot.png"]),
            Ok(Some(OpenTarget::Editor(PathBuf::from("shot.png"))))
        );
    }

    #[test]
    fn open_editor_without_a_file_is_an_error() {
        assert_eq!(
            parse(&["--open", "editor"]),
            Err(ArgsError::MissingFile("editor".into()))
        );
        assert_eq!(
            parse(&["--open", "editor", ""]),
            Err(ArgsError::MissingFile("editor".into()))
        );
        assert_eq!(
            parse(&["--open", "pin"]),
            Err(ArgsError::MissingFile("pin".into()))
        );
    }

    #[test]
    fn open_text_and_colour() {
        assert_eq!(parse(&["--open", "text"]), Ok(Some(OpenTarget::Text)));
        assert_eq!(parse(&["--open", "colour"]), Ok(Some(OpenTarget::Colour)));
        assert_eq!(parse(&["--open=color"]), Ok(Some(OpenTarget::Colour)));
        assert_eq!(parse(&["--open", "repeat"]), Ok(Some(OpenTarget::Repeat)));
        assert_eq!(parse(&["--open", "record"]), Ok(Some(OpenTarget::Record)));
    }

    #[test]
    fn open_quick_and_pin_with_a_file() {
        assert_eq!(
            parse(&["--open", "quick", "/tmp/shot.png"]),
            Ok(Some(OpenTarget::Quick(PathBuf::from("/tmp/shot.png"))))
        );
        assert_eq!(
            parse(&["--open=pin", "shot.png"]),
            Ok(Some(OpenTarget::Pin(PathBuf::from("shot.png"))))
        );
    }

    #[test]
    fn unrelated_arguments_are_ignored() {
        assert_eq!(
            parse(&["-psn_0_12345", "--open", "settings"]),
            Ok(Some(OpenTarget::Settings))
        );
        assert_eq!(parse(&["--verbose"]), Ok(None));
    }

    #[test]
    fn program_name_is_not_parsed() {
        assert_eq!(parse_open_target(["--open"]), Ok(None));
    }

    #[test]
    fn missing_target_is_an_error() {
        assert_eq!(parse(&["--open"]), Err(ArgsError::MissingTarget));
        assert_eq!(parse(&["--open="]), Err(ArgsError::MissingTarget));
    }

    #[test]
    fn unknown_target_is_an_error() {
        assert_eq!(
            parse(&["--open", "nope"]),
            Err(ArgsError::UnknownTarget("nope".into()))
        );
    }
}
