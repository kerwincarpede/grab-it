import fs from "node:fs";
import path from "node:path";

/** Names the folder that holds one session's throwaway home and data. Set per worker by wdio.conf.ts. */
export const SANDBOX_VAR = "GRAB_IT_E2E_SANDBOX";

/** Grab-it's identifier in tauri.conf.json: the name of its app data folder. */
const IDENTIFIER = "com.kerwincarpede.grabit";

/**
 * Windows: the app data folders Tauri uses (app_data_dir, and
 * app_local_data_dir for the webview's own data). Tauri asks Windows for
 * the known folders, which ignore APPDATA and LOCALAPPDATA, so a run cannot
 * redirect them as it does HOME and XDG_DATA_HOME on Linux: it empties
 * these real folders instead, which is why it runs on CI runners only
 * (wdio.conf.ts).
 */
export function windowsAppDataFolders(): { roaming: string; local: string } {
  const roaming = process.env.APPDATA;
  const local = process.env.LOCALAPPDATA;
  if (!roaming || !local) throw new Error("APPDATA and LOCALAPPDATA must be set on Windows");
  return { roaming: path.join(roaming, IDENTIFIER), local: path.join(local, IDENTIFIER) };
}

/** Where one app session keeps everything, so a run never touches the real home or settings. */
export interface Sandbox {
  root: string;
  /** HOME for the app. */
  home: string;
  /** XDG_DATA_HOME, which holds the app data folder. */
  dataHome: string;
  /** XDG_CONFIG_HOME. */
  configHome: string;
  /** XDG_CACHE_HOME. */
  cacheHome: string;
  /** The app data folder: settings.json, the Library database, control.sock. On Windows the real one. */
  appData: string;
  settingsFile: string;
  /** The save folder the seeded settings point at. */
  saveFolder: string;
  /** Where captures are saved, as PNG plus sidecars. */
  originals: string;
  /** Where the editor export spec writes. */
  exports: string;
}

export function sandboxAt(root: string): Sandbox {
  const dataHome = path.join(root, "data");
  const appData = process.platform === "win32" ? windowsAppDataFolders().roaming : path.join(dataHome, IDENTIFIER);
  const saveFolder = path.join(root, "captures");
  return {
    root,
    home: path.join(root, "home"),
    dataHome,
    configHome: path.join(root, "config"),
    cacheHome: path.join(root, "cache"),
    appData,
    settingsFile: path.join(appData, "settings.json"),
    saveFolder,
    originals: path.join(saveFolder, "originals"),
    exports: path.join(root, "exports"),
  };
}

/**
 * Makes the folders and seeds settings.json: the save folder inside the
 * sandbox, AI descriptions never turned on by themselves (a provider is
 * set), GIF recordings so no ffmpeg is downloaded, a Quick Access card
 * that stays until it is closed, and text at 100%.
 *
 * Text size zooms the webviews, and its default is 110%. Under that zoom
 * WebKitWebDriver lands element clicks at the element's centre divided by
 * 1.1, on whatever is there instead, so the specs run at 100%.
 */
export function createSandbox(root: string): Sandbox {
  const sandbox = sandboxAt(root);
  if (process.platform === "win32") {
    // A fresh app on Windows: empty the real app data, which the previous
    // session's app has let go of by now (wdio.conf.ts stops it first).
    const { roaming, local } = windowsAppDataFolders();
    for (const dir of [roaming, local]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  }
  for (const dir of [sandbox.home, sandbox.configHome, sandbox.cacheHome, sandbox.appData, sandbox.exports]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const settings = {
    saveFolder: sandbox.saveFolder,
    ai: { enabled: false, provider: "endpoint" },
    recording: { format: "gif" },
    appearance: { popupSeconds: 0, textScale: 100, hubScale: 100 },
  };
  fs.writeFileSync(sandbox.settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return sandbox;
}

/** The sandbox of the session this spec runs in. */
export function currentSandbox(): Sandbox {
  const root = process.env[SANDBOX_VAR];
  if (!root) throw new Error(`${SANDBOX_VAR} is not set; run the specs through e2e/wdio.conf.ts`);
  return sandboxAt(root);
}
