import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach } from "vitest";

// The editor's tests mount a canvas stage and can take a second or more on a
// busy CI runner; the default one-second wait made them fail by timing alone.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  clearMocks();
});
