# Saved data standards

Grab-it updates itself, so every release opens files that older releases wrote, and sometimes the other way round. A change that can't read yesterday's data loses someone's captures. Where files live and what's in them is in "Captures on disk" and "Settings" in [development.md](../development.md).

## Originals

- A capture's PNG in `<save folder>/originals/` and a recording in `recordings/` are never modified. Edits live beside them, and crop and backdrop are applied only on copy or export.

## `settings.json`

- Every new field has `#[serde(default)]` (or `skip_serializing_if` for optional ones), so an older file still loads.
- To rename a value or field, keep the old name loading with `#[serde(alias = "...")]`. `webcamShape: "rounded"` still loads as `squircle`.
- Secrets such as endpoint API keys go in the system keychain (`keychain.rs`), not in `settings.json`.
- Settings that the operating system keeps, such as starting at sign-in, stay with the operating system.

## Library database

- Migrations live in `library::MIGRATIONS` and are tracked by `PRAGMA user_version`. **Append new ones. Never edit, reorder or remove old ones.**
- A new column is nullable or has a default. Rows written before it existed must still read correctly, so treat `NULL` as "not known yet".
- Add a test that starts from the previous schema version and migrates up. `library.rs` already has examples.

## Sidecars

- `<name>.meta.json`, `<name>.annotations.json` and `<name>.edits.json` are formats with versions.
- A version this build can't read throws, so the file is never overwritten. Keep it that way. Within a version it knows, a reader skips entries it doesn't recognise (such as an unknown annotation shape) instead of failing.
- Adding an optional field doesn't need a new version. Changing what an existing field means does.
- `<name>.transcript.json` is written by **Transcribe** in the video editor and kept beside its recording, moved, renamed and deleted with it (`library::extra_files`, and the mp4 and gif siblings `SaveDestination::reserve` keeps free). Version 1:

  ```json
  {
    "version": 1,
    "model": "whisper-base",
    "language": "en",
    "segments": [
      { "startMs": 0, "endMs": 2400, "text": "Click Save.", "words": [{ "text": "Click", "startMs": 0, "endMs": 600 }, { "text": "Save.", "startMs": 650, "endMs": 1300 }] }
    ]
  }
  ```

  Times are in the recording. Editing captions never rewrites it; only transcribing again does.
- `<name>.edits.json` is at version 5 when it holds `captions` (`{burnIn, style?, cues: [{id, source?, startMs, endMs, text}]}`), so builds that read only versions 1 to 4 refuse to open the recording ("unsupported edits version 5") and never overwrite the sidecar: nothing is lost, and a build that reads version 5 opens it again. A sidecar without captions keeps the oldest version its other edits need. A cue's `source` works as a zoom's: absent for the sidecar's own recording.
