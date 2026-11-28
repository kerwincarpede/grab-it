import { render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ScrollGuide, { SCROLL_DOCS_URL } from "./ScrollGuide";
import { useAccessibility } from "./useAccessibility";
import { mockCommands } from "../test/mockCommands";

type Props = Parameters<typeof ScrollGuide>[0];

function props(overrides: Partial<Props> = {}): Props {
  return {
    stage: "choose",
    byHand: false,
    onByHand: vi.fn(),
    accessibility: true,
    edge: "bottom",
    top: 0,
    onStart: vi.fn(),
    onDocs: vi.fn(),
    ...overrides,
  };
}

function guide(overrides: Partial<Props> = {}): Props {
  const given = props(overrides);
  render(<ScrollGuide {...given} />);
  return given;
}

function steps() {
  const list = screen.getByRole("complementary", { name: "Scrolling capture" }).querySelector("ol");
  return within(list as HTMLElement).getAllByRole("listitem");
}

function points() {
  return within(screen.getByRole("status"))
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

describe("ScrollGuide", () => {
  it("has a header that says Esc cancels", () => {
    guide();
    expect(screen.getByRole("heading", { name: "Scrolling capture" })).toBeInTheDocument();
    expect(screen.getByText("Esc")).toBeInTheDocument();
    expect(screen.getByText(/to cancel/)).toBeInTheDocument();
  });

  it("shows only the first step as current, with what to do", () => {
    guide();
    const list = steps();
    expect(list).toHaveLength(3);
    expect(list.filter((step) => step.getAttribute("aria-current") === "step")).toEqual([list[0]]);
    expect(list[0]).toHaveTextContent("Click a window or drag over an area");
    expect(list[0]).toHaveTextContent("Pick the part of the screen that scrolls.");
    // Only the current step explains itself.
    expect(list[1]).not.toHaveTextContent("Fixed headers and sidebars are fine.");
    expect(list[1]).toHaveAttribute("data-state", "next");
    expect(list[2]).toHaveAttribute("data-state", "next");
  });

  it("ticks the first step once an area is held, and makes trimming current", () => {
    guide({ stage: "adjust" });
    const list = steps();
    expect(list[0]).toHaveAttribute("data-state", "done");
    expect(within(list[0]).getByRole("img", { name: "Done" })).toBeInTheDocument();
    expect(list[1]).toHaveAttribute("aria-current", "step");
    expect(list[1]).toHaveTextContent("Trim the edges");
    expect(list[1]).toHaveTextContent("Fixed headers and sidebars are fine. They appear once, at the top.");
    expect(list[2]).toHaveAttribute("data-state", "next");
    expect(list[2]).not.toHaveAttribute("aria-current");
  });

  it("tags trimming as optional", () => {
    guide();
    expect(within(steps()[1]).getByText("optional")).toBeInTheDocument();
    expect(within(steps()[0]).queryByText("optional")).not.toBeInTheDocument();
  });

  it("offers Grab-it and Me as cards that say when to pick each", () => {
    guide();
    const group = screen.getByRole("radiogroup", { name: "Who scrolls?" });
    const auto = within(group).getByRole("radio", { name: "Grab-it" });
    const me = within(group).getByRole("radio", { name: "Me" });
    expect(auto).toBeChecked();
    expect(me).not.toBeChecked();
    expect(auto).toHaveAccessibleDescription("Hands-free. Best for most pages.");
    expect(me).toHaveAccessibleDescription("For pages that load more as you scroll, or apps Grab-it can't scroll.");
  });

  it("lets the user choose to scroll", async () => {
    const { onByHand } = guide();
    await userEvent.click(screen.getByRole("radio", { name: "Me" }));
    expect(onByHand).toHaveBeenCalledWith(true);
  });

  it("lists what happens when Grab-it scrolls", () => {
    guide();
    expect(screen.getByRole("region", { name: "What happens" })).toBeInTheDocument();
    expect(points()).toEqual([
      "Starts from what's on screen now and scrolls down. Not at the top? Press Esc, scroll up, and start again.",
      "Hands off the mouse and trackpad. Moving them hands scrolling to you.",
      "Stops at the end and saves on its own.",
    ]);
  });

  it("lists what happens when the user scrolls", () => {
    guide({ byHand: true });
    expect(screen.getByRole("radio", { name: "Me" })).toBeChecked();
    expect(points()).toEqual([
      "Starts from what's on screen now.",
      "Scroll at a steady pace. If the bar says you went too fast, scroll back a little.",
      "Choose Finish on the bar at the top of the screen when you reach the end.",
    ]);
  });

  it("keeps room for either list, so the cards do not move", () => {
    const { rerender } = render(<ScrollGuide {...props({ stage: "adjust" })} />);
    const cell = screen.getByRole("status").parentElement as HTMLElement;
    const shown = () => Array.from(cell.querySelectorAll("li"), (item) => item.textContent).sort();
    const automatic = shown();
    rerender(<ScrollGuide {...props({ stage: "adjust", byHand: true })} />);
    // The same six points fill the cell either way; only which three show changes.
    expect(shown()).toEqual(automatic);
    expect(automatic).toHaveLength(6);
    expect(automatic).toContain("Starts from what's on screen now.");
    expect(automatic).toContain("Stops at the end and saves on its own.");
    expect(cell.querySelector(".scroll-guide-spacer")).toHaveAttribute("aria-hidden", "true");
  });

  it("links to the docs page through the overlay, which cancels first", async () => {
    const { onDocs } = guide();
    const link = screen.getByRole("link", { name: "How scrolling capture works" });
    expect(link).toHaveAttribute("href", SCROLL_DOCS_URL);
    expect(SCROLL_DOCS_URL).toBe("https://kerwincarpede.github.io/grab-it/capture/scrolling/");
    await userEvent.click(link);
    expect(onDocs).toHaveBeenCalledTimes(1);
  });

  it("starts scrolling only once an area is held", async () => {
    const waiting = guide();
    const start = screen.getByRole("button", { name: /Start scrolling/ });
    expect(start).toBeDisabled();
    expect(within(start).getByText("Enter")).toBeInTheDocument();
    await userEvent.click(start);
    expect(waiting.onStart).not.toHaveBeenCalled();
  });

  it("starts the held area from Start scrolling", async () => {
    const { onStart } = guide({ stage: "adjust" });
    await userEvent.click(screen.getByRole("button", { name: /Start scrolling/ }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("shows a banner with Open Settings when Accessibility is off, and the user scrolls", async () => {
    const calls = mockCommands({ accessibility_open_settings: () => null });
    guide({ accessibility: false });
    const auto = screen.getByRole("radio", { name: "Grab-it" });
    expect(auto).toBeDisabled();
    expect(auto).toHaveAccessibleDescription("Needs Accessibility permission.");
    expect(screen.getByRole("radio", { name: "Me" })).toBeChecked();
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(
      "Grab-it needs Accessibility permission to scroll for you. Until you allow it, you scroll.",
    );
    // The banner is the panel's last part, below the footer.
    expect(banner.parentElement?.lastElementChild).toBe(banner);
    await userEvent.click(within(banner).getByRole("button", { name: "Open Settings" }));
    expect(calls.map(({ cmd }) => cmd)).toContain("accessibility_open_settings");
  });

  it("has no banner while Accessibility is allowed", () => {
    guide();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Settings" })).not.toBeInTheDocument();
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
