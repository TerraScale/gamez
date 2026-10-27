import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";

// main.ts stays JSX-free: the React tree is created with createElement.
const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(createElement(App));
