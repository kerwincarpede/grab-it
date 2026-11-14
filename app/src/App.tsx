import "./App.css";
import { lazy, Suspense } from "react";
import { routeFromHash, type Route } from "./routes";
import RegionOverlay from "./overlay/RegionOverlay";
import SettingsWindow from "./settings/SettingsWindow";
import LibraryWindow from "./library/LibraryWindow";
import QuickAccess from "./quick/QuickAccess";
import PinWindow from "./pin/PinWindow";
import WelcomeWindow from "./welcome/WelcomeWindow";
import AppWindow from "./app/AppWindow";
import Hub from "./hub/Hub";
import { viewFromHash } from "./app/api";

// The editor brings Konva, most of the bundle, so it loads only in the
// editor window; the overlay and the other windows open without it.
const EditorWindow = lazy(() => import("./editor/EditorWindow"));
const RecordingEditor = lazy(() => import("./recording/RecordingEditor"));

interface AppProps {
  route?: Route;
}

function App({ route = routeFromHash(window.location.hash) }: AppProps) {
  switch (route) {
    case "app":
      return <AppWindow initialView={viewFromHash(window.location.hash)} />;
    case "hub":
      return <Hub />;
    case "settings":
      return <SettingsWindow />;
    case "overlay":
      return <RegionOverlay />;
    case "editor":
      return (
        <Suspense fallback={null}>
          <EditorWindow />
        </Suspense>
      );
    case "recording":
      return (
        <Suspense fallback={null}>
          <RecordingEditor />
        </Suspense>
      );
    case "library":
      return <LibraryWindow />;
    case "quick":
      return <QuickAccess />;
    case "pin":
      return <PinWindow />;
    case "welcome":
      return <WelcomeWindow />;
    default:
      return (
        <main className="window home">
          <h1>Grab-it</h1>
          <p className="hint">Grab-it runs in the menu bar. Click its icon to capture or open the Grab-it window.</p>
        </main>
      );
  }
}

export default App;
