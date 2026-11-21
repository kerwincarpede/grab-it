import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockCommands } from "../test/mockCommands";
import { describe, expect, it } from "vitest";
import StepsBar from "./StepsBar";
import { routeFromHash } from "../routes";

function backend(fail = false) {
  return mockCommands(
    {
      steps_bar_stop: () => {
        if (fail) throw new Error("no step capture");
      },
    },
    { otherwise: () => null },
  );
}

describe("StepsBar", () => {
  it("says a step capture is on", () => {
    backend();
    render(<StepsBar />);
    expect(screen.getByText("Step capture")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("stops the step capture once", async () => {
    const calls = backend();
    render(<StepsBar />);
    const stop = screen.getByRole("button", { name: "Stop" });
    await userEvent.click(stop);
    expect(stop).toBeDisabled();
    await userEvent.click(stop);
    expect(calls.filter((call) => call.cmd === "steps_bar_stop")).toHaveLength(1);
  });

  it("can be pressed again when stopping failed", async () => {
    backend(true);
    const error = console.error;
    console.error = () => {};
    try {
      render(<StepsBar />);
      await userEvent.click(screen.getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled());
    } finally {
      console.error = error;
    }
  });

  it("is the stepsbar route", () => {
    expect(routeFromHash("#/stepsbar")).toBe("stepsbar");
  });
});
