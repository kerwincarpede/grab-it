import { useState, type KeyboardEvent } from "react";
import { acceleratorFromEvent, isMacPlatform } from "./accelerator";
import type { Hotkeys, HotkeysUpdate } from "./api";

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
 */
function HotkeysSection({ saved, disabled, onSave }: HotkeysSectionProps) {
  const [draft, setDraft] = useState<Hotkeys | null>(null);
  const [busy, setBusy] = useState(false);
  const current = draft ?? saved;
  const changed = FIELDS.some(({ key }) => current[key] !== saved[key]);

  function record(field: keyof Hotkeys) {
    return (event: KeyboardEvent<HTMLInputElement>) => {
      const plainTab =
        event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey;
      if (plainTab) return;
      event.preventDefault();
      const accelerator = acceleratorFromEvent(event, isMacPlatform());
      if (accelerator) setDraft({ ...current, [field]: accelerator });
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
            onKeyDown={record(key)}
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
