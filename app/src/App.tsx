import "./App.css";
import { routeFromHash, type Route } from "./routes";
import RegionOverlay from "./overlay/RegionOverlay";
import SettingsWindow from "./settings/SettingsWindow";
import EditorWindow from "./editor/EditorWindow";

interface AppProps {
  route?: Route;
}

function App({ route = routeFromHash(window.location.hash) }: AppProps) {
  switch (route) {
    case "settings":
      return <SettingsWindow />;
    case "overlay":
      return <RegionOverlay />;
    case "editor":
      return <EditorWindow />;
    default:
      return (
        <main className="window">
          <h1>Grab-it</h1>
          <p className="hint">Grab-it runs in the tray. Capture and open Settings from the tray menu.</p>
        </main>
      );
  }
}

export default App;
