import { useCallback, useEffect, useRef, useState } from "react";
import { getEditorPreferences, setBackdropPresets } from "../settings/api";
import { parseBackdropPresets, type SavedBackdrop } from "../editor/preferences";
import { parseBackdrop } from "../editor/sidecar";
import type { Backdrop } from "../editor/model";

/**
 * The backdrop presets saved from the capture editor, shared with it
 * through settings.json, and the last backdrop it picked (what a new
 * backdrop starts from). `presets` is null until they are read, or when
 * they cannot be, which hides them. Changes are made on the stored list,
 * one at a time, so one made in an editor window meanwhile is never lost.
 */
export function useBackdropPresets(onError: (message: string) => void) {
  const [presets, setPresets] = useState<SavedBackdrop[] | null>(null);
  const [lastBackdrop, setLastBackdrop] = useState<Backdrop | null>(null);
  const presetsRef = useRef<SavedBackdrop[] | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const show = useCallback((next: SavedBackdrop[]) => {
    presetsRef.current = next;
    setPresets(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loading: ReturnType<typeof getEditorPreferences>;
    try {
      loading = getEditorPreferences();
    } catch (err) {
      loading = Promise.reject(err);
    }
    loading
      .then((prefs) => {
        if (cancelled) return;
        show(parseBackdropPresets(prefs.backdropPresets));
        setLastBackdrop(parseBackdrop(prefs.backdrop));
      })
      // No presets on show, and none written over.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [show]);

  const stored = async () => parseBackdropPresets((await getEditorPreferences()).backdropPresets);

  const enqueue = (step: () => Promise<void>) => {
    queue.current = queue.current.then(step).catch((err: unknown) => onError(`Could not save presets: ${String(err instanceof Error ? err.message : err)}`));
  };

  /** Shows the presets as settings.json holds them now. */
  const refresh = () => {
    if (!presetsRef.current) return;
    enqueue(async () => show(await stored()));
  };

  /** Changes the presets with `update`, on show at once and then on the stored list. */
  const change = (update: (presets: SavedBackdrop[]) => SavedBackdrop[]) => {
    if (!presetsRef.current) return;
    show(update(presetsRef.current));
    enqueue(async () => {
      const next = update(await stored());
      show(await setBackdropPresets(next).then(parseBackdropPresets));
    });
  };

  return { presets, presetsRef, lastBackdrop, refresh, change };
}
