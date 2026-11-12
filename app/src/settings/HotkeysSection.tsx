import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { acceleratorFromEvent, isMacPlatform } from "./accelerator";
import { pauseHotkeys, resumeHotkeys, type Hotkeys, type HotkeysUpdate } from "./api";

const FIELDS: { key: keyof Hotkeys; label: string }[] = [
  { key: "region", label: "Region" },
  { key: "window", label: "Window" },
  { key: "screen", label: "Screen" },
];

interface HotkeysSectionProps {
  saved: Hotkeys;
  disabled: boolean;
  onSave: (hotkeys: Hotkeys) => Promise<HotkeysUpdate | null>;
}

/**
 * The capture hotkeys. Focus a field and press the new key combination;
 * Tab moves on as usual. Nothing changes until Save.
 *
 * While a field has focus the global hotkeys are paused, so pressing a
 * current hotkey records it rather than taking a capture. PrintScreen is
 * also recorded on key up, since Windows webviews send no key down for it,
 * but only when no key down was seen: elsewhere the modifier may already be
 * released by key up, which would overwrite Alt+PrintScreen with PrintScreen.
 */
function HotkeysSection({ saved, disabled, onSave }: HotkeysSectionProps) {
  const [draft, setDraft] = useState<Hotkeys | null>(null);
  const [busy, setBusy] = useState(false);
  const current = draft ?? saved;
  const changed = FIELDS.some(({ key }) => current[key] !== saved[key]);
  const paused = useRef(false);
  // The field whose PrintScreen key down was seen and whose key up is pending.
  const printScreenDown = useRef<keyof Hotkeys | null>(null);

  useEffect(
    () => () => {
      if (paused.current) {
        paused.current = false;
        void resumeHotkeys().catch(() => undefined);
      }
    },
    [],
  );

  function pause() {
    if (paused.current) return;
    paused.current = true;
    // Best effort: if this fails the hotkey may still start a capture.
    void pauseHotkeys().catch(() => undefined);
  }

  function resume(event: FocusEvent<HTMLInputElement>) {
    // Moving between hotkey fields keeps the hotkeys paused.
    const next = event.relatedTarget;
    if (next instanceof HTMLElement && next.dataset.hotkeyField !== undefined) return;
    if (!paused.current) return;
    paused.current = false;
    void resumeHotkeys().catch(() => undefined);
  }

  function clearPrintScreenDown() {
    printScreenDown.current = null;
  }

  function apply(field: keyof Hotkeys, event: KeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const accelerator = acceleratorFromEvent(event, isMacPlatform());
    if (accelerator) setDraft({ ...current, [field]: accelerator });
  }

  function record(field: keyof Hotkeys) {
    return (event: KeyboardEvent<HTMLInputElement>) => {
      const plainTab =
        event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey;
      if (plainTab) return;
      if (event.code === "PrintScreen") printScreenDown.current = field;
      apply(field, event);
    };
  }

  function recordPrintScreen(field: keyof Hotkeys) {
    return (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.code !== "PrintScreen") return;
      const sawKeyDown = printScreenDown.current === field;
      printScreenDown.current = null;
      // Key down already recorded it, with the modifiers held at that time.
      if (sawKeyDown) {
        event.preventDefault();
        return;
      }
      apply(field, event);
    };
  }

  async function save() {
    setBusy(true);
    try {
      const update = await onSave(current);
      if (update) setDraft(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="field hotkeys" aria-labelledby="hotkeys-heading">
      <span id="hotkeys-heading" className="field-heading">
        Hotkeys
      </span>
      {FIELDS.map(({ key, label }) => (
        <div className="hotkey-row" key={key}>
          <label htmlFor={`hotkey-${key}`}>{label}</label>
          <input
            id={`hotkey-${key}`}
            type="text"
            readOnly
            value={current[key]}
            data-hotkey-field=""
            onKeyDown={record(key)}
            onKeyUp={recordPrintScreen(key)}
            onFocus={pause}
            onBlur={(event) => {
              clearPrintScreenDown();
              resume(event);
            }}
            disabled={disabled}
            aria-describedby="hotkeys-hint"
          />
        </div>
      ))}
      <p className="hint" id="hotkeys-hint">
        Click a field and press the new keys.
      </p>
      <div className="hotkey-actions">
        <button type="button" onClick={save} disabled={disabled || busy || !changed}>
          Save hotkeys
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => setDraft(null)}
          disabled={busy || !changed}
        >
          Revert
        </button>
      </div>
    </section>
  );
}

export default HotkeysSection;
