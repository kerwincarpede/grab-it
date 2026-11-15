import { describe, expect, it } from "vitest";
import { DEFAULT_RECORDING } from "../settings/api";
import { audioWith, microphoneLabel, nextCountdown, withMicrophone, withSystemSound } from "./recordOptions";

describe("the recording options", () => {
  it("combines the microphone and the system sound", () => {
    expect(audioWith(false, false)).toBe("none");
    expect(audioWith(true, false)).toBe("microphone");
    expect(audioWith(false, true)).toBe("system");
    expect(audioWith(true, true)).toBe("both");
  });

  it("picks a microphone, keeping the system sound", () => {
    const both = { ...DEFAULT_RECORDING, audio: "both" as const, microphone: "usb" };
    expect(withMicrophone(both, { kind: "none" })).toMatchObject({ audio: "system", microphone: "usb" });
    expect(withMicrophone(DEFAULT_RECORDING, { kind: "default" })).toMatchObject({ audio: "microphone", microphone: null });
    expect(withMicrophone(DEFAULT_RECORDING, { kind: "device", id: "usb" })).toMatchObject({ audio: "microphone", microphone: "usb" });
  });

  it("turns the system sound on and off, keeping the microphone", () => {
    const mic = { ...DEFAULT_RECORDING, audio: "microphone" as const };
    expect(withSystemSound(mic, true).audio).toBe("both");
    expect(withSystemSound({ ...mic, audio: "both" }, false).audio).toBe("microphone");
    expect(withSystemSound(DEFAULT_RECORDING, true).audio).toBe("system");
  });

  it("steps through the countdowns and back to none", () => {
    expect([0, 3, 5, 10].map(nextCountdown)).toEqual([3, 5, 10, 0]);
    expect(nextCountdown(7)).toBe(0);
  });

  it("names the microphone chosen", () => {
    const mics = [{ id: "usb", name: "USB Microphone", isDefault: false }];
    expect(microphoneLabel(DEFAULT_RECORDING, mics)).toBe("No microphone");
    expect(microphoneLabel({ ...DEFAULT_RECORDING, audio: "microphone" }, mics)).toBe("Default microphone");
    expect(microphoneLabel({ ...DEFAULT_RECORDING, audio: "both", microphone: "usb" }, mics)).toBe("USB Microphone");
    expect(microphoneLabel({ ...DEFAULT_RECORDING, audio: "microphone", microphone: "gone" }, mics)).toBe("Saved microphone");
  });
});
