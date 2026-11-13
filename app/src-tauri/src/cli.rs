//! Command-line arguments.
//!
//! `--open <target>` opens a window directly at startup. It lets the app be
//! driven without a tray host, for example under `xvfb-run` for screenshots.

use std::fmt;

/// A window that `--open` can show at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenTarget {
    Settings,
}

impl OpenTarget {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "settings" => Some(Self::Settings),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgsError {
    MissingTarget,
    UnknownTarget(String),
}

impl fmt::Display for ArgsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingTarget => {
                write!(f, "--open needs a target, for example `--open settings`")
            }
            Self::UnknownTarget(name) => {
                write!(f, "unknown --open target `{name}`; expected `settings`")
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
        return OpenTarget::from_name(&name)
            .map(Some)
            .ok_or(ArgsError::UnknownTarget(name));
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
