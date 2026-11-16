import { describe, expect, it } from "vitest";
import { DEFAULT_RECORDING } from "../settings/api";
import {
  audioWith,
  cameraLabel,
  microphoneLabel,
  nextCountdown,
  withCamera,
  withMicrophone,
  withSystemSound,
} from "./recordOptions";

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

  it("picks a camera, turning the webcam on with it", () => {
    const usb = { ...DEFAULT_RECORDING, showWebcam: true, camera: "usb" };
    expect(withCamera(usb, { kind: "none" })).toMatchObject({ showWebcam: false, camera: "usb" });
    expect(withCamera(DEFAULT_RECORDING, { kind: "default" })).toMatchObject({ showWebcam: true, camera: null });
    expect(withCamera(usb, { kind: "default" })).toMatchObject({ showWebcam: true, camera: null });
    expect(withCamera(DEFAULT_RECORDING, { kind: "device", id: "usb" })).toMatchObject({ showWebcam: true, camera: "usb" });
  });

  it("names the camera chosen", () => {
    const cameras = [{ id: "usb", name: "Logitech C920" }];
    expect(cameraLabel(DEFAULT_RECORDING, cameras)).toBe("No webcam");
    expect(cameraLabel({ ...DEFAULT_RECORDING, showWebcam: false, camera: "usb" }, cameras)).toBe("No webcam");
    expect(cameraLabel({ ...DEFAULT_RECORDING, showWebcam: true }, cameras)).toBe("Default camera");
    expect(cameraLabel({ ...DEFAULT_RECORDING, showWebcam: true, camera: "usb" }, cameras)).toBe("Logitech C920");
    expect(cameraLabel({ ...DEFAULT_RECORDING, showWebcam: true, camera: "gone" }, cameras)).toBe("Saved camera");
  });
});
