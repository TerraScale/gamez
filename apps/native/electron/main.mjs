/**
 * gamez desktop shell (docs/ship.md, "Electron and Steam"). The window loads the hosted game.
 *
 *   GAMEZ_URL       the page to load (dev: http://localhost:5173). Default: PROD_URL below.
 *   STEAM_APP_ID    when set, steamworks.js is initialised for this app id (needs the Steam client).
 *
 * Security: contextIsolation on, nodeIntegration off, sandbox on, every permission request denied,
 * navigation limited to the game origin and the OAuth providers the game uses. Everything else
 * opens in the default browser.
 */
import { app, BrowserWindow, Menu, session, shell } from "electron";
import { join } from "node:path";

/** Set this to the production URL before packaging a release. The placeholder stops the app. */
const PROD_URL = "https://REPLACE-WITH-PROD-HOST/";
const GAME_URL = process.env.GAMEZ_URL?.trim() || PROD_URL;

/** Hosts a window may stay on: the game itself and the OAuth providers it signs in with. */
const OAUTH_HOSTS = new Set([
  "accounts.google.com",
  "discord.com",
  "appleid.apple.com",
  "steamcommunity.com",
]);

let mainWindow = null;

function fail(message) {
  console.error(`gamez: ${message}`);
  app.exit(1);
}

if (GAME_URL.includes("REPLACE-WITH-PROD-HOST")) {
  // Checked on start, so a release build cannot ship with the placeholder.
  app.whenReady().then(() => fail("set PROD_URL in main.mjs or pass GAMEZ_URL"));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start);
}

function allowedInWindow(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const gameHost = new URL(GAME_URL).host;
  return parsed.host === gameHost || OAUTH_HOSTS.has(parsed.hostname);
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") shell.openExternal(url);
  } catch {
    // Not a URL: ignore.
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Game",
      submenu: [{ role: isMac ? "close" : "quit" }],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        ...(process.env.GAMEZ_URL ? [{ role: "toggleDevTools" }] : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Project homepage",
          click: () => openExternal(GAME_URL),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#10131a",
    show: false,
    title: "gamez",
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Links that open a new window go to the browser, unless they belong to the game or a provider.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedInWindow(url)) mainWindow?.loadURL(url);
    else openExternal(url);
    return { action: "deny" };
  });
  const keepInApp = (event, url) => {
    if (allowedInWindow(url)) return;
    event.preventDefault();
    openExternal(url);
  };
  mainWindow.webContents.on("will-navigate", keepInApp);
  mainWindow.webContents.on("will-redirect", keepInApp);

  mainWindow.loadURL(GAME_URL).catch((err) => {
    console.error("gamez: cannot load", GAME_URL, err?.message ?? err);
  });
}

async function initSteam() {
  const appId = process.env.STEAM_APP_ID?.trim();
  if (!appId) return null;
  try {
    // Optional dependency: a missing package or a missing Steam client is not an error for play.
    const steamworks = await import("steamworks.js");
    const client = steamworks.init(Number(appId));
    console.info(`gamez: Steam ready for app ${appId} as ${client.localplayer.getName()}`);
    return client;
  } catch (err) {
    console.warn("gamez: Steam not available, continuing without it:", err?.message ?? err);
    return null;
  }
}

async function start() {
  // Deny every permission request (camera, mic, notifications, geolocation) by default.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  buildMenu();
  await initSteam();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
