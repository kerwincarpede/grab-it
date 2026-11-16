import { useEffect, useState, type ReactNode } from "react";
import { RegionIcon, ScreenIcon, WindowIcon } from "../app/icons";
import {
  DEFAULT_RECORDING,
  getSettings,
  knownCameras,
  listCameras,
  listMicrophones,
  rememberListing,
  setRecording,
  systemSoundAvailable,
  type Camera,
  type Microphone,
  type RecordingSettings,
  type RecordingSource,
} from "../settings/api";

/** The setup toolbar's sources, in the order of their number keys. */
export const SOURCES: { source: RecordingSource; label: string; icon: ReactNode }[] = [
  { source: "region", label: "Region", icon: <RegionIcon size={16} /> },
  { source: "window", label: "Window", icon: <WindowIcon size={16} /> },
  { source: "screen", label: "Screen", icon: <ScreenIcon size={16} /> },
];

/** The recording settings, loaded once `enabled`, and how to change them. */
export interface RecordingOptions {
  recording: RecordingSettings | null;
  microphones: Microphone[];
  /** The cameras last listed with their names; reading them never turns a camera on. */
  cameras: Camera[];
  /** The cameras are being listed again. */
  refreshingCameras: boolean;
  /**
   * Lists the cameras again, opening one for a moment to read their names,
   * and shows and remembers them when every one was named.
   */
  refreshCameras: () => void;
  /** System sound can be recorded here. */
  system: boolean;
  error: string | null;
  /** Shows `next` at once and saves it to Settings → Recording. */
  save: (next: RecordingSettings) => void;
}

/**
 * Settings → Recording for the setup toolbar, read when it is first
 * needed. Each change is saved as it is made, so Settings and the next
 * recording follow it.
 */
export function useRecordingOptions(enabled: boolean): RecordingOptions {
  const [recording, setLocal] = useState<RecordingSettings | null>(null);
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [refreshingCameras, setRefreshingCameras] = useState(false);
  const [system, setSystem] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (!cancelled) setLocal({ ...DEFAULT_RECORDING, ...settings.recording });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    listMicrophones()
      .then((listed) => {
        if (!cancelled) setMicrophones(listed);
      })
      .catch(() => {
        // The default microphone is still offered.
      });
    knownCameras()
      .then((known) => {
        if (!cancelled) setCameras(known);
      })
      .catch(() => {
        // The default camera is still offered.
      });
    systemSoundAvailable()
      .then((available) => {
        if (!cancelled) setSystem(available);
      })
      .catch(() => {
        // Then system sound is not offered.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  function save(next: RecordingSettings) {
    const before = recording;
    setLocal(next);
    setError(null);
    setRecording(next).catch((err: unknown) => {
      setLocal(before);
      setError(String(err));
    });
  }

  function refreshCameras() {
    setRefreshingCameras(true);
    listCameras(true)
      .then(async (listing) => {
        // A listing with a hidden name keeps the names known.
        if (!listing.named) return;
        setCameras(listing.cameras);
        await rememberListing(listing);
      })
      .catch(() => {
        // The list stays as it was.
      })
      .finally(() => setRefreshingCameras(false));
  }

  return { recording, microphones, cameras, refreshingCameras, refreshCameras, system, error, save };
}
