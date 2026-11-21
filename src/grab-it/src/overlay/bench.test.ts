import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { benchEnabled, benchSwitch, parseSwitches, setupBench } from "./bench";

/** Fakes the backend, with `config` as `GRAB_IT_OVERLAY_BENCH`; returns the commands called. */
function mockBench(config: string | null): string[] {
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    if (cmd === "overlay_bench_config") return config;
    throw new Error(`unexpected command ${cmd}`);
  });
  return calls;
}

const benchStyle = () => document.getElementById("overlay-bench-style");

afterEach(() => {
  benchStyle()?.remove();
});

describe("benchEnabled", () => {
  it("is on only for an overlay the backend opened for the bench", () => {
    expect(benchEnabled("#/overlay")).toBe(false);
    expect(benchEnabled("#/overlay?instant")).toBe(false);
    expect(benchEnabled("#/overlay?bench")).toBe(true);
    expect(benchEnabled("#/overlay?instant&bench")).toBe(true);
  });
});

describe("parseSwitches", () => {
  it("reads comma-separated switches, ignoring spaces and empty ones", () => {
    expect([...parseSwitches("")]).toEqual([]);
    expect([...parseSwitches("noloupe, probe,,raw ")]).toEqual(["noloupe", "probe", "raw"]);
  });
});

describe("setupBench", () => {
  it("turns on the switches the backend was started with", async () => {
    const calls = mockBench("noloupe, probe,nodim");

    await expect(setupBench("#/overlay?instant&bench")).resolves.toBe(true);

    expect(calls).toEqual(["overlay_bench_config"]);
    expect(benchSwitch("noloupe")).toBe(true);
    expect(benchSwitch("probe")).toBe(true);
    expect(benchSwitch("lazy")).toBe(false);
    // Switches that are styles hide what they name.
    expect(benchStyle()?.textContent).toContain(".overlay-dim{display:none!important}");
  });

  it("runs with no switches when the variable is empty", async () => {
    mockBench("");

    await expect(setupBench("#/overlay?bench")).resolves.toBe(true);

    expect(benchSwitch("noloupe")).toBe(false);
    expect(benchStyle()).toBeNull();
  });

  it("stays off, asking the backend nothing, without the bench flag", async () => {
    mockBench("noloupe");
    await setupBench("#/overlay?bench");
    const calls = mockBench("noloupe");

    await expect(setupBench("#/overlay?instant")).resolves.toBe(false);

    expect(calls).toEqual([]);
    expect(benchSwitch("noloupe")).toBe(false);
  });

  it("stays off when the backend has no bench configured", async () => {
    mockBench(null);

    await expect(setupBench("#/overlay?bench")).resolves.toBe(false);

    expect(benchSwitch("noloupe")).toBe(false);
  });
});
