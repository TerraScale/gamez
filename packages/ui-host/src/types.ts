/**
 * Client-side platform contracts shared by the app shell and every mode's
 * client package. Mode packages depend on this, never on apps/game.
 */
import type { AssetManifest } from "@gamez/assets";
import type { DispatchResult, GameEvent, LoadedMode, SimSnapshot, World } from "@gamez/kernel";
import type { ModeInfo } from "@gamez/protocol";
import type { WorldRenderer } from "./render.ts";

export interface Session {
  token: string;
  accountId: string;
  name: string;
}

/** Live view of an instance as seen by a mode's UI. */
export interface InstanceView {
  status: "connecting" | "online" | "offline";
  /** Authoritative snapshot (or the locally predicted one while an action is in flight). */
  snapshot: SimSnapshot | null;
  /** World restored from `snapshot` for read-only queries by the UI. Do not mutate. */
  world: World | null;
  /** Events from the latest resolved action, oldest first. */
  events: GameEvent[];
  /** Last rejected action, cleared by the next successful one. */
  error: { code: string; message: string } | null;
  pingMs: number | null;
}

/** Connection to the player's InstanceDO for one mode (/ws/instance). */
export interface InstanceConnection {
  readonly mode: string;
  /** Loaded mode (same modules as the server) — gives access to the frozen registry. */
  readonly loaded: LoadedMode;
  getView(): InstanceView;
  subscribe(cb: (view: InstanceView) => void): () => void;
  /**
   * Sends an action. The client predicts it immediately with its local sim
   * (same kernel + modules), then reconciles with the server result.
   */
  act(name: string, payload: unknown): Promise<DispatchResult>;
  /** Discards the instance and starts fresh (new run / new battle). */
  restart(): void;
  close(): void;
}

export interface ClientServices {
  session: Session;
  manifest: AssetManifest;
  /** Base URL that manifest atlas URLs are relative to. */
  assetBaseUrl: string;
  modes: ModeInfo[];
  /** Creates an isometric world renderer (Pixi) — call init() with the manifest above. */
  createWorldRenderer(): WorldRenderer;
  /** Opens (or reuses) the instance connection for an instance-based mode. */
  connectInstance(mode: string): InstanceConnection;
  /** Returns to the mode picker. */
  exit(): void;
}

/** A mode's client entry: mounts its UI into `host`, returns an unmount function. */
export interface ClientModeView {
  modeId: string;
  /**
   * True when the mode renders its own control that calls services.exit() (the
   * "Modes" button). The app shell then skips its floating back button, which
   * would otherwise overlap the mode's HUD. Default false.
   */
  ownsExitControl?: boolean;
  mount(host: HTMLElement, services: ClientServices): Promise<() => void> | (() => void);
}
