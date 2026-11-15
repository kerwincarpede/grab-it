import { useCallback, useEffect, useRef } from "react";
import { getEditorPreferences, setEditorPreferences, type EditorPreferences } from "../settings/api";
import { fromPreferences, PREFERENCES_DELAY_MS, toPreferences, type EditorChoices } from "./preferences";

/**
 * Restores the editor's remembered colour, tool, widths and options when it
 * opens, then saves `choices` to settings.json as they change (debounced).
 * `restore` should be stable (it is called once, after loading).
 *
 * The editor starts on today's defaults and stays usable whatever happens
 * here: when loading fails (or there is no Tauri, as in tests) nothing is
 * restored and nothing is saved, so preferences that could not be read are
 * never overwritten with defaults.
 */
export function useEditorPreferences(choices: EditorChoices, restore: (choices: EditorChoices) => void) {
  const key = JSON.stringify(toPreferences(choices));
  /** Null until loaded; then the preferences as last saved (or restored). */
  const saved = useRef<string | null>(null);
  /** A change not yet written. */
  const pending = useRef<string | null>(null);

  const flush = useCallback(() => {
    const next = pending.current;
    if (next === null) return;
    pending.current = null;
    saved.current = next;
    try {
      setEditorPreferences(JSON.parse(next) as EditorPreferences).catch(() => undefined);
    } catch {
      // No Tauri: nothing to save to.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loading: Promise<EditorPreferences>;
    try {
      loading = getEditorPreferences();
    } catch (err) {
      loading = Promise.reject(err);
    }
    loading
      .then((stored) => {
        if (cancelled) return;
        const next = fromPreferences(stored);
        saved.current = JSON.stringify(toPreferences(next));
        restore(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [restore]);

  useEffect(() => {
    // Nothing is saved before loading, or when the file already holds it.
    if (saved.current === null || key === saved.current) {
      pending.current = null;
      return;
    }
    pending.current = key;
    const timer = window.setTimeout(flush, PREFERENCES_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [key, flush]);

  // A change still waiting is written when the window goes away.
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
}
