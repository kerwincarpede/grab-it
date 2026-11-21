// Smoke tests: WebdriverIO drives the e2e build of Grab-it through
// tauri-driver. `npm run e2e` builds that binary first; see "Smoke tests" in
// docs/development.md.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { checkWindowsAppData, createSandbox, SANDBOX_VAR } from "./support/sandbox";

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
/** Replaced in beforeSession by a free port of the worker's own. */
const PLACEHOLDER_PORT = 4444;

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
 * Windows: msedgedriver, which tauri-driver drives, from MSEDGEDRIVER or
 * PATH. Its version has to match the installed WebView2 runtime's; CI
 * downloads the matching one (ci.yml).
 */
function msedgedriverPath(): string {
  const found = process.env.MSEDGEDRIVER ?? onPath("msedgedriver");
  if (!found) {
    throw new Error("msedgedriver not found: download the one matching your WebView2 version, and set MSEDGEDRIVER or put it on PATH");
  }
  return found;
}

/** Windows: whether a grab-it.exe is still running. */
function appRunning(): boolean {
  try {
    const listed = execFileSync("tasklist", ["/FI", "IMAGENAME eq grab-it.exe", "/NH"], { encoding: "utf8" });
    return listed.toLowerCase().includes("grab-it.exe");
  } catch {
    return false;
  }
}

/**
 * Windows: ends any Grab-it still running, by name, and waits until none
 * runs. A Grab-it left in the tray would take the next session's launch
 * (single instance) and hold the app data the next session empties.
 */
async function stopWindowsApp(): Promise<void> {
  // It also ends a Grab-it the developer has running.
  checkWindowsAppData();
  const deadline = Date.now() + 15_000;
  while (appRunning()) {
    if (Date.now() > deadline) throw new Error("grab-it.exe is still running 15 seconds after its session ended");
    spawnSync("taskkill", ["/im", "grab-it.exe", "/t", "/f"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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

/**
 * Free ports on 127.0.0.1, one per name. Each spec file's tauri-driver and
 * native driver get their own, so a driver an earlier worker left running
 * can never answer the next worker's session.
 */
async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<net.Server>((resolve, reject) => {
          const server = net.createServer();
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
  );
  const ports = servers.map((server) => (server.address() as net.AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

/**
 * Resolves once tauri-driver passes a request through to the native
 * WebDriver. tauri-driver listens before WebKitWebDriver (or msedgedriver)
 * does, and a session asked for in between fails with a dropped socket.
 * Any HTTP reply to `/status` proves both are up.
 */
async function waitForDriver(driver: ChildProcess, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (driver.exitCode !== null || driver.signalCode !== null) {
      throw new Error(`tauri-driver exited (${driver.exitCode ?? driver.signalCode}) before it was ready`);
    }
    try {
      await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      // Not listening yet, or the native driver is not.
    }
    if (Date.now() > deadline) {
      throw new Error(`tauri-driver on port ${port} did not reach its native driver within ${timeoutMs / 1000} seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Where a session's tauri-driver records its process ID, for onWorkerEnd. */
function driverPidFile(sandboxRoot: string): string {
  return path.join(sandboxRoot, "tauri-driver.pid");
}

/** Stops tauri-driver with what it started: the native driver, the app and the bus. */
function stopProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    else process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/** Stops this worker's tauri-driver, if it still runs. Synchronous, for process exit. */
function stopTauriDriver(): void {
  const driver = tauriDriver;
  tauriDriver = undefined;
  if (driver?.pid) stopProcessTree(driver.pid);
  const sandboxRoot = process.env[SANDBOX_VAR];
  if (sandboxRoot) fs.rmSync(driverPidFile(sandboxRoot), { force: true });
}

/** Starts tauri-driver for one spec file and waits until it can create a session. */
async function startTauriDriver(sandboxRoot: string, port: number, nativePort: number): Promise<void> {
  const env = appEnvironment(sandboxRoot);
  const log = fs.openSync(path.join(sandboxRoot, "tauri-driver.log"), "a");
  const driverArgs = [tauriDriverPath(), "--port", String(port), "--native-port", String(nativePort)];
  // Windows: tauri-driver drives msedgedriver.
  if (process.platform === "win32") driverArgs.push("--native-driver", msedgedriverPath());
  // Linux: a private session bus, so the single-instance check never hands
  // the arguments to a Grab-it already running on the developer's bus.
  const dbus = process.platform === "linux" ? onPath("dbus-run-session") : undefined;
  if (process.platform === "linux" && !dbus) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(sandboxRoot, "no-session-bus")}`;
  }
  const [command, args] = dbus ? [dbus, ["--", ...driverArgs]] : [driverArgs[0], driverArgs.slice(1)];
  const driver = spawn(command, args, {
    env,
    stdio: ["ignore", log, log],
    // Its own process group, so the app and the bus go with it.
    detached: process.platform !== "win32",
  });
  tauriDriver = driver;
  if (driver.pid) fs.writeFileSync(driverPidFile(sandboxRoot), `${driver.pid}\n`);
  await waitForDriver(driver, port, 30_000);
}

/**
 * Saves a screenshot of the window the session is driving to
 * `screenshots/` in the run folder, named after the spec's session and the
 * failed test or hook.
 */
async function saveFailureScreenshot(parent: string | undefined, title: string): Promise<void> {
  const name = `${parent ?? ""} ${title}`.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  const dir = path.join(runDir, "screenshots");
  try {
    fs.mkdirSync(dir, { recursive: true });
    await browser.saveScreenshot(path.join(dir, `${process.env[SANDBOX_VAR] ? path.basename(process.env[SANDBOX_VAR]) : "session"}-${name}.png`));
  } catch (err) {
    // The window may have closed with the failure, or no session was made.
    console.warn(`No screenshot for "${title}": ${String(err)}`);
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
    // Tauri asks Windows for the app data folders, so HOME and XDG_* would
    // change nothing; createSandbox emptied the real ones instead.
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
  port: PLACEHOLDER_PORT,
  specs: [path.join(e2eDir, "specs", "*.ts")],
  // One app at a time: they share the display.
  maxInstances: 1,
  capabilities: [
    {
      // tauri-driver speaks WebDriver classic, not BiDi.
      "wdio:enforceWebDriverClassic": true,
      "tauri:options": {
        application,
        // Grab-it starts in the tray with no window; open the Grab-it window.
        // One argument: msedgedriver passes the app Chromium-style switches
        // and does not keep a separate value after `--open`.
        args: ["--open=library"],
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
  // Windows: msedgedriver already waits a minute for the app's WebView2
  // before it gives up, and a retry only repeats that wait.
  connectionRetryCount: process.platform === "win32" ? 0 : 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 180_000,
  },

  // A failed test leaves a picture of the window it was driving.
  afterTest: async (test, _context, { passed }) => {
    if (!passed) await saveFailureScreenshot(test.parent, test.title);
  },

  // So does a failed hook, such as a spec's `before` that captures: Mocha
  // then skips its tests, and afterTest never runs.
  afterHook: async (test, _context, { passed }) => {
    if (!passed) await saveFailureScreenshot(test.parent, test.title);
  },

  onPrepare: async () => {
    if (!fs.existsSync(application)) {
      throw new Error(`No e2e build at ${application}: run \`npm run e2e\`, which builds it with --features e2e`);
    }
    // Reported early here, but WebdriverIO carries on after a hook's
    // error, so stopWindowsApp and createSandbox check again before they
    // end or delete anything.
    checkWindowsAppData();
    if (process.platform === "win32") msedgedriverPath();
    await startXvfb();
    console.log(`Smoke test data and logs: ${runDir}`);
  },

  // Each spec file gets a fresh app with its own sandbox, behind its own
  // tauri-driver on its own ports. Restarts within a spec (reloadSession)
  // keep both.
  beforeSession: async (config, _capabilities, specs, cid) => {
    const sandboxRoot = path.join(runDir, `session-${cid}`);
    // The specs read the sandbox from here. Set first, so the specs load
    // even when the driver fails, and the worker fails on its own session.
    process.env[SANDBOX_VAR] = sandboxRoot;
    const [port, nativePort] = await freePorts(2);
    // The runner creates the session from this same config object.
    config.port = port;
    // Kills the driver however the worker ends, even when no session was made.
    process.once("exit", stopTauriDriver);
    // Windows: no Grab-it may hold the app data createSandbox empties.
    if (process.platform === "win32") await stopWindowsApp();
    try {
      await startTauriDriver(sandboxRoot, port, nativePort);
    } catch (err) {
      // Nothing listens on the port now, so creating the session fails
      // too: the app never starts in another session's data.
      stopTauriDriver();
      console.error(`[${cid}] tauri-driver did not start, so ${path.basename(specs[0] ?? "this spec")} fails: ${String(err)}`);
      throw err;
    }
  },

  afterSession: async () => {
    const started = tauriDriver !== undefined;
    stopTauriDriver();
    // Windows: taskkill ends the tree under tauri-driver, but a Grab-it left
    // in the tray would still take the next launch.
    if (process.platform === "win32" && started) await stopWindowsApp();
  },

  // The launcher's backstop: a worker that crashed may have left its
  // tauri-driver running.
  onWorkerEnd: (cid) => {
    const pidFile = driverPidFile(path.join(runDir, `session-${cid}`));
    if (!fs.existsSync(pidFile)) return;
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (pid > 0) stopProcessTree(pid);
    fs.rmSync(pidFile, { force: true });
  },

  onComplete: () => {
    xvfb?.kill();
    console.log(`Smoke test data and logs kept in ${runDir}`);
  },
};
