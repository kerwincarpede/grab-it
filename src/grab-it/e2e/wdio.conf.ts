// Smoke tests: WebdriverIO drives the e2e build of Grab-it through
// tauri-driver. `npm run e2e` builds that binary first; see "Smoke tests" in
// docs/development.md.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createSandbox, SANDBOX_VAR } from "./support/sandbox";

const e2eDir = import.meta.dirname;
const projectDir = path.resolve(e2eDir, "..");
const application = path.join(
  projectDir,
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "grab-it.exe" : "grab-it",
);
const fixture = path.join(e2eDir, "fixtures", "screen.png");
const DRIVER_PORT = 4444;

// One folder per run, kept afterwards for its logs and captures. Set before
// the workers start, so they all inherit it.
process.env.GRAB_IT_E2E_RUN ??= fs.mkdtempSync(path.join(os.tmpdir(), "grab-it-e2e-"));
const runDir = process.env.GRAB_IT_E2E_RUN;
fs.mkdirSync(runDir, { recursive: true });

let xvfb: ChildProcess | undefined;
let tauriDriver: ChildProcess | undefined;

/** The full path of `command` on PATH, if it is there. */
function onPath(command: string): string | undefined {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      if (dir && fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** tauri-driver from TAURI_DRIVER, PATH or cargo's bin folder. */
function tauriDriverPath(): string {
  const cargoBin = path.join(os.homedir(), ".cargo", "bin", process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver");
  const found = process.env.TAURI_DRIVER ?? onPath("tauri-driver") ?? (fs.existsSync(cargoBin) ? cargoBin : undefined);
  if (!found) throw new Error("tauri-driver not found: install it with `cargo install tauri-driver --locked`");
  return found;
}

/**
 * Linux: a private 1920×1080 X server, so the windows never open on the
 * developer's desktop and the screen is the same size on every machine.
 * GRAB_IT_E2E_DISPLAY=inherit uses the current DISPLAY instead, to watch.
 */
async function startXvfb(): Promise<void> {
  if (process.platform !== "linux" || process.env.GRAB_IT_E2E_DISPLAY === "inherit") return;
  const binary = onPath("Xvfb");
  if (!binary) {
    if (!process.env.DISPLAY) throw new Error("No DISPLAY and no Xvfb: install xvfb, or run under xvfb-run");
    console.warn(`Xvfb not found; using DISPLAY ${process.env.DISPLAY}`);
    return;
  }
  const server = spawn(binary, ["-displayfd", "3", "-screen", "0", "1920x1080x24", "-nolisten", "tcp", "-ac"], {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  xvfb = server;
  const display = await new Promise<string>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("Xvfb did not start within 10 seconds")), 10_000);
    server.stdio[3]?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) {
        clearTimeout(timer);
        resolve(text.trim());
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Xvfb exited with ${code}`));
    });
  });
  // Inherited by the workers, tauri-driver, the app and xdotool.
  process.env.DISPLAY = `:${display}`;
}

/** Whether something listens on `port`. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Resolves once `port` is listened on (`open`) or free again. */
async function waitForPort(port: number, open: boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await listening(port)) !== open) {
    if (Date.now() > deadline) {
      throw new Error(open ? `tauri-driver did not listen on port ${port}` : `port ${port} is still in use`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The app's environment: the sandbox's home and data, the fixture, and X11 only. */
function appEnvironment(sandboxRoot: string): NodeJS.ProcessEnv {
  const sandbox = createSandbox(sandboxRoot);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [SANDBOX_VAR]: sandbox.root,
    GRAB_IT_E2E_CAPTURE: fixture,
  };
  if (process.platform === "win32") {
    // Windows keeps app data under APPDATA, which this does not redirect.
    return env;
  }
  Object.assign(env, {
    HOME: sandbox.home,
    XDG_DATA_HOME: sandbox.dataHome,
    XDG_CONFIG_HOME: sandbox.configHome,
    XDG_CACHE_HOME: sandbox.cacheHome,
  });
  if (process.platform === "linux") {
    // X11 first: Wayland would send captures through the desktop portal.
    delete env.WAYLAND_DISPLAY;
    env.XDG_SESSION_TYPE = "x11";
    env.GDK_BACKEND = "x11";
    // Software rendering: Xvfb has no GPU.
    env.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
    env.WEBKIT_DISABLE_COMPOSITING_MODE = "1";
    env.LIBGL_ALWAYS_SOFTWARE = "1";
  }
  return env;
}

export const config: WebdriverIO.Config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: DRIVER_PORT,
  specs: [path.join(e2eDir, "specs", "*.ts")],
  // One app at a time: they share tauri-driver's port and the display.
  maxInstances: 1,
  capabilities: [
    {
      // tauri-driver speaks WebDriver classic, not BiDi.
      "wdio:enforceWebDriverClassic": true,
      "tauri:options": {
        application,
        // Grab-it starts in the tray with no window; open the Grab-it window.
        args: ["--open", "library"],
      },
    },
  ],
  // WebdriverIO writes each worker's commands and replies to a log file in
  // outputDir, for working out a failure after the run.
  logLevel: "info",
  outputDir: path.join(runDir, "logs"),
  bail: 0,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 180_000,
  },

  onPrepare: async () => {
    if (!fs.existsSync(application)) {
      throw new Error(`No e2e build at ${application}: run \`npm run e2e\`, which builds it with --features e2e`);
    }
    await startXvfb();
    console.log(`Smoke test data and logs: ${runDir}`);
  },

  // Each spec file gets a fresh app with its own sandbox, behind its own
  // tauri-driver. Restarts within a spec (reloadSession) keep both.
  beforeSession: async (_config, _capabilities, _specs, cid) => {
    // The previous spec's tauri-driver may still be letting go of the port.
    await waitForPort(DRIVER_PORT, false, 15_000);
    const sandboxRoot = path.join(runDir, `session-${cid}`);
    const env = appEnvironment(sandboxRoot);
    // The specs read the sandbox from here.
    process.env[SANDBOX_VAR] = sandboxRoot;
    const log = fs.openSync(path.join(sandboxRoot, "tauri-driver.log"), "a");
    const driver = tauriDriverPath();
    // Linux: a private session bus, so the single-instance check never hands
    // the arguments to a Grab-it already running on the developer's bus.
    const dbus = process.platform === "linux" ? onPath("dbus-run-session") : undefined;
    if (process.platform === "linux" && !dbus) {
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(sandboxRoot, "no-session-bus")}`;
    }
    const [command, args] = dbus ? [dbus, ["--", driver]] : [driver, []];
    tauriDriver = spawn(command, args, {
      env,
      stdio: ["ignore", log, log],
      // Its own process group, so the app and the bus go with it.
      detached: process.platform !== "win32",
    });
    await waitForPort(DRIVER_PORT, true, 30_000);
  },

  afterSession: () => {
    const driver = tauriDriver;
    tauriDriver = undefined;
    if (!driver?.pid) return;
    try {
      if (process.platform === "win32") driver.kill();
      else process.kill(-driver.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  },

  onComplete: () => {
    xvfb?.kill();
    console.log(`Smoke test data and logs kept in ${runDir}`);
  },
};
