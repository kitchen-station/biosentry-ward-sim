import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./settings";
// Order matters: app.css declares the layer order (its reset under the kit), then the kit, then icons.
import "./app.css";
import "./vendor/hw-ui/src/index.css";
import "@fortawesome/fontawesome-free/css/fontawesome.min.css";
import "@fortawesome/fontawesome-free/css/solid.min.css";
import "@fortawesome/fontawesome-free/css/regular.min.css";

applyTheme();
createRoot(document.getElementById("root")!).render(<App />);
