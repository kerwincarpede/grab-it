import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Loupe from "./Loupe";

describe("Loupe", () => {
  it("shows the image pixel under the cursor at the scale given", () => {
    render(<Loupe image={null} pointer={{ x: 100, y: 50 }} scale={2} viewport={{ width: 1000, height: 800 }} />);
    expect(screen.getByTestId("overlay-position")).toHaveTextContent("200, 100");
  });

  it("shows the pixel it is given instead, when the caller maps the cursor itself", () => {
    render(<Loupe image={null} pointer={{ x: 100, y: 50 }} scale={2} viewport={{ width: 1000, height: 800 }} pixel={{ x: 12, y: 34 }} />);
    expect(screen.getByTestId("overlay-position")).toHaveTextContent("12, 34");
  });
});
