/**
 * Builds the ClientServices a mode receives. Everything a mode can reach from
 * the platform goes through here, so this is the one place to change how the
 * app provides it.
 */
import type { AssetManifest } from "@gamez/assets";
import type { ModeInfo } from "@gamez/protocol";
import type { ClientServices, PlatformServices, Session } from "@gamez/ui-host";
import { MODES } from "../../shared/catalog.ts";
import { instanceConnector } from "../instance/index.ts";
import { verifiedConnector } from "../instance/verified.ts";
import { createPlatform } from "../platform/index.ts";
import { presenceConnector } from "../presence/index.ts";
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
  /** The app-wide platform (absent = offline). Modes get the same instance as the picker. */
  platform?: PlatformServices;
}

/** Services for one mode run. `exit` returns the app to the mode picker. */
export function createServices(boot: BootData, exit: () => void): ClientServices {
  const session = () => boot.session;
  const services: ClientServices = {
    session: boot.session,
    manifest: boot.manifest,
    assetBaseUrl: ART_BASE,
    modes: modeInfos(),
    createWorldRenderer,
    // Instance-based modes (duel, steps): one InstanceClient per mode, see ../instance/.
    connectInstance: instanceConnector(boot.session),
    exit,
  };
  // Wave B (docs/design/wave-B.md §8): each is absent until its implementation lands.
  const verified = verifiedConnector(session);
  if (verified) services.connectVerified = verified;
  const presence = presenceConnector(session);
  if (presence) services.joinPresence = presence;
  const platform = boot.platform ?? createPlatform(session);
  if (platform) services.platform = platform;
  return services;
}
