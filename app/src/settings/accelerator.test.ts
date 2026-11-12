import { describe, expect, it } from "vitest";
import { acceleratorFromEvent, type KeyPress } from "./accelerator";

function press(code: string, key: string, mods: Partial<KeyPress> = {}): KeyPress {
  return { code, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

describe("acceleratorFromEvent", () => {
  it("names PrintScreen with modifiers", () => {
    expect(acceleratorFromEvent(press("PrintScreen", "PrintScreen"))).toBe("PrintScreen");
    expect(acceleratorFromEvent(press("PrintScreen", "PrintScreen", { altKey: true }))).toBe(
      "Alt+PrintScreen",
    );
    expect(acceleratorFromEvent(press("PrintScreen", "PrintScreen", { ctrlKey: true }))).toBe(
      "Ctrl+PrintScreen",
    );
  });

  it("uses the physical key, not the shifted character", () => {
    expect(
      acceleratorFromEvent(press("Digit2", "@", { shiftKey: true, metaKey: true }), true),
    ).toBe("Shift+Cmd+2");
    expect(acceleratorFromEvent(press("KeyS", "S", { ctrlKey: true, shiftKey: true }))).toBe(
      "Ctrl+Shift+S",
    );
  });

  it("waits while only modifiers are held", () => {
    expect(acceleratorFromEvent(press("ShiftLeft", "Shift", { shiftKey: true }))).toBeNull();
    expect(acceleratorFromEvent(press("ControlLeft", "Control", { ctrlKey: true }))).toBeNull();
  });

  it("ignores keys that cannot be hotkeys", () => {
    expect(acceleratorFromEvent(press("IntlRo", "ろ"))).toBeNull();
  });

  it("supports function keys and arrows", () => {
    expect(acceleratorFromEvent(press("F12", "F12", { altKey: true }))).toBe("Alt+F12");
    expect(acceleratorFromEvent(press("ArrowUp", "ArrowUp", { ctrlKey: true }))).toBe("Ctrl+Up");
  });
});
