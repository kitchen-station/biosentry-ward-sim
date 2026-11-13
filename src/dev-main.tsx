import { createRoot } from "react-dom/client";
import Analytics from "./analytics/Analytics";
import "./app.css";
import "./analytics/analytics.css";

// The developer build's only entry. The customer app never imports this file.
createRoot(document.getElementById("root")!).render(<Analytics />);
