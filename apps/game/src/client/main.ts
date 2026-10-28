import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { registerPwa } from "./pwa/index.ts";

// main.ts stays JSX-free: the React tree is created with createElement.
const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(createElement(App));
// Production builds only (docs/ship.md "PWA"); never blocks or throws.
void registerPwa();
