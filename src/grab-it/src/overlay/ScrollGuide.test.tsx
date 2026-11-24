import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ScrollGuide from "./ScrollGuide";
import { useAccessibility } from "./useAccessibility";
import { mockCommands } from "../test/mockCommands";

function guide(props: Partial<Parameters<typeof ScrollGuide>[0]> = {}) {
  const onByHand = vi.fn();
  render(
    <ScrollGuide stage="choose" byHand={false} onByHand={onByHand} accessibility={true} edge="bottom" top={0} {...props} />,
  );
  return onByHand;
}

describe("ScrollGuide", () => {
  it("marks the step the setup is on", () => {
    guide();
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveAttribute("aria-current", "step");
    expect(steps[0]).toHaveTextContent("Choose a window, or drag an area");
  });

  it("moves on to adjusting once an area is held", () => {
    guide({ stage: "adjust" });
    const steps = screen.getAllByRole("listitem");
    expect(steps[0]).toHaveAttribute("data-state", "done");
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    expect(steps[2]).toHaveAttribute("data-state", "current");
  });

  it("says Grab-it scrolls and asks to leave the mouse alone", () => {
    guide();
    expect(screen.getByRole("status")).toHaveTextContent(/scrolls for you/);
    expect(screen.getByRole("status")).toHaveTextContent(/Leave the mouse and trackpad alone/);
    expect(screen.getByRole("radio", { name: "Scroll for me" })).toBeChecked();
  });

  it("lets the user choose to scroll by hand", async () => {
    const onByHand = guide();
    await userEvent.click(screen.getByRole("radio", { name: "I’ll scroll myself" }));
    expect(onByHand).toHaveBeenCalledWith(true);
  });

  it("explains scrolling by hand when chosen", () => {
    guide({ byHand: true });
    expect(screen.getByRole("status")).toHaveTextContent(/Scroll the page yourself/);
    expect(screen.getByRole("radio", { name: "I’ll scroll myself" })).toBeChecked();
  });

  it("offers Open Settings when Accessibility is off, and runs by hand", async () => {
    const calls = mockCommands({ accessibility_open_settings: () => null });
    guide({ accessibility: false });
    expect(screen.getByRole("radio", { name: "Scroll for me" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "I’ll scroll myself" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(calls.map(({ cmd }) => cmd)).toContain("accessibility_open_settings");
  });

  it("asks for Accessibility without prompting, only in Scroll", async () => {
    const calls = mockCommands({ accessibility_status: () => false });
    const { result, rerender } = renderHook(({ on }) => useAccessibility(on), { initialProps: { on: false } });
    expect(result.current).toBeNull();
    expect(calls).toHaveLength(0);
    rerender({ on: true });
    await waitFor(() => expect(result.current).toBe(false));
    expect(calls.map(({ cmd }) => cmd)).toEqual(["accessibility_status"]);
  });
});
