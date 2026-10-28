/**
 * Dev harness for the classic client: mounts classicView full-page with
 * minimal fake ClientServices. The renderer comes from the game app's Pixi
 * module and the art from apps/game/public/art/kenney (see vite.config.ts).
 * Run from the repo root: node_modules/.bin/vp dev --config modules/classic/dev/vite.config.ts
 */
import type { AssetManifest } from "@gamez/assets";
import type { ClientServices } from "@gamez/ui-host";
import { createWorldRenderer } from "../../../apps/game/src/client/render/pixi-renderer.ts";
import { classicView } from "@gamez/mode-classic/client";

const host = document.getElementById("host");
if (!host) throw new Error("missing #host element");

const manifestUrl = "/art/kenney/manifest.json";
const manifest = (await (await fetch(manifestUrl)).json()) as AssetManifest;

const services: ClientServices = {
  session: { token: "dev", accountId: "dev", name: "Dev" },
  manifest,
  assetBaseUrl: "/art/kenney/",
  modes: [],
  createWorldRenderer,
  connectInstance() {
    throw new Error("the classic dev harness has no instance connections");
  },
  exit() {
    host.textContent = "Exit requested (dev harness).";
  },
};

await classicView.mount(host, services);
