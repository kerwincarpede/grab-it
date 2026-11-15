import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/geist-mono";
import App from "./App";
import { isInstantOverlay } from "./overlay/api";
import { routeFromHash } from "./routes";

// Before the first paint: a see-through capture overlay must never flash
// the app's background.
if (isInstantOverlay()) document.documentElement.classList.add("overlay-clear");
// A pin window is see-through too, so a faded pin shows what is behind it.
if (routeFromHash(window.location.hash) === "pin") document.documentElement.classList.add("pin-clear");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
