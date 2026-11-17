import { createRoot } from "react-dom/client";
import Analytics from "./analytics/Analytics";
// Order matters: app.css declares the layer order (its reset under the kit), then the kit, then icons.
import "./app.css";
import "./vendor/hw-ui/src/index.css";
import "@fortawesome/fontawesome-free/css/fontawesome.min.css";
import "@fortawesome/fontawesome-free/css/solid.min.css";
import "@fortawesome/fontawesome-free/css/regular.min.css";
import "./analytics/analytics.css";

// The developer build's only entry. The customer app never imports this file.
createRoot(document.getElementById("root")!).render(<Analytics />);
