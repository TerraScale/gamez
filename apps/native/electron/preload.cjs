/**
 * Preload for the gamez desktop window. Runs with contextIsolation and sandbox on, so the page
 * never sees Node or Electron APIs. It exposes one frozen, read-only object: `window.gamezNative`.
 *
 * CommonJS on purpose: a sandboxed preload cannot load ES modules (the sandbox loader is CJS).
 * main.mjs is ESM and is loaded by Electron as a module.
 */
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld(
  "gamezNative",
  Object.freeze({
    shell: "electron",
    platform: process.platform,
  }),
);
