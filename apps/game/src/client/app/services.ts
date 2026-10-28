/**
 * Builds the ClientServices a mode receives. Everything a mode can reach from
 * the platform goes through here, so this is the one place to change how the
 * app provides it.
 */
import type { AssetManifest } from "@gamez/assets";
import type { ModeInfo } from "@gamez/protocol";
import type { ClientServices, Session } from "@gamez/ui-host";
import { MODES } from "../../shared/catalog.ts";
import { instanceConnector } from "../instance/index.ts";
import { classicInfo } from "../modes/index.ts";
import { createWorldRenderer } from "../render/pixi-renderer.ts";

export const ART_BASE = "/art/kenney/";

const EMPTY_MANIFEST: AssetManifest = {
  version: "0",
  pack: "none",
  atlases: [],
  sprites: {},
  animations: {},
  licenses: [],
};

/** The asset manifest, or an empty one (placeholder sprites) when it is missing. */
export async function loadManifest(): Promise<AssetManifest> {
  try {
    const res = await fetch(`${ART_BASE}manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Missing files fall through to the SPA's index.html, so a parse error means "no manifest".
    return (await res.json()) as AssetManifest;
  } catch (err) {
    console.warn("asset manifest unavailable, using placeholders", err);
    return EMPTY_MANIFEST;
  }
}

/** Picker entries: every catalog mode (classic first), then the multiplayer plaza demo. */
export function modeInfos(): ModeInfo[] {
  const catalog = MODES.filter((m) => m.id !== classicInfo.id).map((m): ModeInfo => ({
    id: m.id,
    name: m.name,
    description: m.description,
    world: m.world,
  }));
  catalog.sort((a, b) => (a.id === "classic" ? -1 : b.id === "classic" ? 1 : 0));
  return [...catalog, classicInfo];
}

export interface BootData {
  session: Session;
  manifest: AssetManifest;
}

/** Services for one mode run. `exit` returns the app to the mode picker. */
export function createServices(boot: BootData, exit: () => void): ClientServices {
  return {
    session: boot.session,
    manifest: boot.manifest,
    assetBaseUrl: ART_BASE,
    modes: modeInfos(),
    createWorldRenderer,
    // Instance-based modes (duel, steps): one InstanceClient per mode, see ../instance/.
    connectInstance: instanceConnector(boot.session),
    exit,
  };
}
