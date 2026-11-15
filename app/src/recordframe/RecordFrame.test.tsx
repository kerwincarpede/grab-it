import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RecordFrame from "./RecordFrame";
import { frameOptions, type FrameOptions } from "./api";
import type { BarStatus } from "../recordbar/api";

const RECORDING: BarStatus = {
  phase: "recording",
  countdownEndsAt: null,
  startedAt: Date.now() - 5_000,
  pausedMs: 0,
  pausedAt: null,
  maxSeconds: null,
  format: "mp4",
  microphone: null,
  system: null,
  webcam: false,
};

const countdown = (endsIn = 2_500): BarStatus => ({
  ...RECORDING,
  phase: "countdown",
  startedAt: null,
  countdownEndsAt: Date.now() + endsIn,
});

const options = (shape: FrameOptions["shape"], isProtected = false): FrameOptions => ({
  shape,
  margin: shape === "screen" ? 0 : 6,
  protected: isProtected,
});

describe("frameOptions", () => {
  it("reads the shape, the margin and the protection from the hash", () => {
    expect(frameOptions("#/recordframe?shape=window&margin=7.5&protected=1")).toEqual({
      shape: "window",
      margin: 7.5,
      protected: true,
    });
    expect(frameOptions("#/recordframe?shape=screen&margin=0&protected=0")).toEqual({
      shape: "screen",
      margin: 0,
      protected: false,
    });
  });

  it("is a region with no margin when the hash says nothing it knows", () => {
    expect(frameOptions("#/recordframe")).toEqual({ shape: "region", margin: 0, protected: false });
    expect(frameOptions("#/recordframe?shape=star&margin=-4")).toEqual({ shape: "region", margin: 0, protected: false });
  });
});

describe("RecordFrame", () => {
  it("draws a dashed edge and four brackets around a region", () => {
    render(<RecordFrame options={options("region")} status={RECORDING} />);
    const frame = screen.getByTestId("recordframe");
    expect(frame).toHaveAttribute("data-shape", "region");
    expect(frame.style.getPropertyValue("--rf-margin")).toBe("6px");
    expect(frame.style.getPropertyValue("--rf-bracket-at")).toBe("3px");
    expect(screen.getByTestId("recordframe-edge")).toBeInTheDocument();
    expect(screen.getAllByTestId("recordframe-corner")).toHaveLength(4);
    expect(screen.queryByTestId("recordframe-count")).not.toBeInTheDocument();
  });

  it("rounds a window's outline", () => {
    render(<RecordFrame options={options("window")} status={RECORDING} />);
    expect(screen.getByTestId("recordframe")).toHaveAttribute("data-shape", "window");
    expect(screen.getByTestId("recordframe-edge")).toBeInTheDocument();
  });

  it("marks a whole display with brackets in its corners only", () => {
    render(<RecordFrame options={options("screen", true)} status={RECORDING} />);
    expect(screen.queryByTestId("recordframe-edge")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("recordframe-corner")).toHaveLength(4);
    expect(screen.getByTestId("recordframe").style.getPropertyValue("--rf-bracket-at")).toBe("0px");
  });

  it("keeps a display's brackets out of a recording that would show them", () => {
    const { rerender } = render(<RecordFrame options={options("screen")} status={countdown()} />);
    expect(screen.getAllByTestId("recordframe-corner")).toHaveLength(4);
    rerender(<RecordFrame options={options("screen")} status={RECORDING} />);
    expect(screen.queryByTestId("recordframe-corner")).not.toBeInTheDocument();
  });

  it("shows the countdown's big number in the middle", () => {
    render(<RecordFrame options={options("region")} status={countdown()} />);
    expect(screen.getByTestId("recordframe-count")).toHaveTextContent("3");
  });

  it("drops the number once the countdown has run out", () => {
    render(<RecordFrame options={options("region")} status={countdown(-100)} />);
    expect(screen.queryByTestId("recordframe-count")).not.toBeInTheDocument();
  });
});
