import "./App.css";
import { routeFromHash, type Route } from "./routes";
import SettingsWindow from "./settings/SettingsWindow";

interface AppProps {
  route?: Route;
}

function App({ route = routeFromHash(window.location.hash) }: AppProps) {
  switch (route) {
    case "settings":
      return <SettingsWindow />;
    default:
      return (
        <main className="window">
          <h1>Grab-it</h1>
          <p className="hint">Grab-it runs in the tray. Open Settings from the tray menu.</p>
        </main>
      );
  }
}

export default App;
