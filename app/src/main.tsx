import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isInstantOverlay } from "./overlay/api";

// Before the first paint: a see-through capture overlay must never flash
// the app's background.
if (isInstantOverlay()) document.documentElement.classList.add("overlay-clear");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
