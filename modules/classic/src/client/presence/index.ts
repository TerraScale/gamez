/**
 * Other players in the classic town (wave-B.md §7). OWNER: T-classic-presence.
 *
 * - While the hero is in town (AreaState.depth === 0) a PresenceConnection to
 *   world "classic-town" is open. It closes LEAVE_GRACE_MS after the hero
 *   leaves town (or on destroy); avatars disappear as soon as the hero leaves.
 * - The hero's pose is reported at most POSE_INTERVAL_MS apart, when it changed
 *   (pose.ts) or as a keepalive every POSE_KEEPALIVE_MS while unchanged.
 * - Every other avatar is drawn with renderer.upsertEntity under ids "p:<id>".
 *   Moving avatars are interpolated with walkAt(state, serverNow()) every frame;
 *   stationary ones are upserted only when the view changes.
 * - Wave C: "shopkeeper" fixtures (ChunkFixtureApi, shops:<plotId>) are drawn as
 *   translucent static ghosts. A tap on one opens its shop (openScreen "shop").
 *   A tap on another hero opens the "Trade with <name>" bubble (bubble.ts).
 *   Taps reach TownPresence through input.ts's tap interceptors, only when no
 *   sim entity is under the tap.
 * - Wave B carry-over: a remote player is not drawn until its first pose has
 *   arrived (the server sets its tag only from a pose report).
 * - Party (docs/design/party.md §11.3): a remote avatar's companions are drawn
 *   as renderer entities "p:<id>:c<i>" (kind "unit", highlight "ally", name
 *   label) at the avatar's interpolated position plus their tile offset, every
 *   frame. They go when the avatar leaves, when the list shrinks, or on leaving
 *   town. A tap on a companion opens its owner's trade bubble.
 * - The local report carries companions (the party minus the controlled hero)
 *   only while there are some, or once to clear the server's list (pose.ts).
 * - Reads the sim only; never mutates it. update() never throws.
 */
import type { FrozenRegistry, Sim } from "@gamez/kernel";
import { MAX_COMPANIONS } from "@gamez/protocol";
import type {
  ArpgRenderEntity,
  ArpgWorldRenderer,
  ClientServices,
  Facing,
  PlatformScreen,
  PresenceConnection,
  PresenceView,
  PointerInfo,
} from "@gamez/ui-host";
import { walkAt } from "@gamez/world";
import { facingOf } from "../../fixed.ts";
import { currentDepth, heroOf } from "../../resources.ts";
import { addTapInterceptor } from "../input.ts";
import { accountIdOfPresence, clearTradeBubble, showTradeBubble } from "./bubble.ts";
import { copyPose, makePose, readPose, samePose, toPoseUpdate, type PoseState } from "./pose.ts";

export const PRESENCE_WORLD = "classic-town";
/** Id prefix of shopkeeper fixtures (ChunkFixtureApi group "shops"; wave-C.md §5.4). */
export const SHOP_FIXTURE_PREFIX = "shops:";
/** Opacity of a shopkeeper ghost. */
export const GHOST_ALPHA = 0.6;
/** Cool multiply tint of a shopkeeper ghost (0xRRGGBB). */
export const GHOST_TINT = 0xbfe6ff;
/** A tap within this many tiles of an avatar's centre hits it (as the sim pick does). */
export const TAP_RADIUS = 0.8;
/** Minimum spacing between two pose reports (4 per second). */
export const POSE_INTERVAL_MS = 250;
/**
 * An unchanged pose is re-reported this often. The chunk answers it without a
 * broadcast (nothing changed), but a hero that was dropped server-side (relay
 * given up on, chunk restarted) learns "not-joined" and is rejoined, so a hero
 * standing still never stays invisible for longer than this.
 */
export const POSE_KEEPALIVE_MS = 10_000;
/** How long the connection stays open after the hero leaves town. */
export const LEAVE_GRACE_MS = 3000;
/** Wait before reconnecting after the server dropped the presence socket. */
export const RETRY_MS = 3000;
export const AVATAR_PREFIX = "p:";
/** Offset from a presence tile to the classic render position of its centre (tiles). */
export const TILE_CENTRE = 0.5;

export interface TownPresenceDeps {
  services: Pick<ClientServices, "joinPresence" | "openScreen">;
  renderer: ArpgWorldRenderer;
  registry: FrozenRegistry;
}

type Other = PresenceView["others"][number];

/** A companion of a remote avatar: its reused render object and tile offset. */
interface CompanionDraw {
  dx: number;
  dy: number;
  entity: ArpgRenderEntity;
}

/** Plot id of a shopkeeper fixture id ("shops:p1" -> "p1"). */
export function plotIdOf(fixtureId: string): string {
  return fixtureId.startsWith(SHOP_FIXTURE_PREFIX)
    ? fixtureId.slice(SHOP_FIXTURE_PREFIX.length)
    : fixtureId;
}

/**
 * True once an entity may be drawn. Shopkeepers are fixtures (always). A remote
 * player is hidden until its first pose: the server sets `tag` only from a pose
 * report, and the join state has no tag yet (wave B carry-over).
 */
export function poseReady(o: Other): boolean {
  return o.kind === "shopkeeper" || o.tag !== undefined;
}

interface Avatar {
  other: Other;
  /** Kind of the entity when it was first drawn (shopkeepers are static ghosts). */
  kind: Other["kind"];
  /** Generation of the last view that contained this avatar. */
  gen: number;
  /** True while the last draw showed the avatar walking. */
  moving: boolean;
  facing: Facing;
  /** Reused render object (never re-allocated after creation). */
  entity: ArpgRenderEntity;
  /** Party companions, in report order (party.md §11.3). */
  companions: CompanionDraw[];
}

/** Facing a stationary avatar shows: the last segment of its path, or south. */
function restFacing(o: Other): Facing {
  const p = o.path;
  const last = p[p.length - 1];
  if (!last) return "s";
  const prev = (p.length > 1 ? p[p.length - 2] : undefined) ?? o.pos;
  return facingOf(last.x - prev.x, last.y - prev.y, "s");
}

export class TownPresence {
  private conn: PresenceConnection | null = null;
  private unsub: (() => void) | null = null;
  private view: PresenceView | null = null;
  private viewDirty = false;
  /** Epoch ms the hero left town while the connection was still open. */
  private leftAt: number | null = null;
  private retryAt = Number.NEGATIVE_INFINITY;
  private readonly shown = new Map<string, Avatar>();
  private gen = 0;
  private readonly cur: PoseState = makePose();
  private readonly sent: PoseState = makePose();
  private sentValid = false;
  private lastSendMs = Number.NEGATIVE_INFINITY;
  private destroyed = false;
  private error: string | null = null;
  private debugGetter: (() => TownPresence) | null = null;
  private debugTried = false;
  private unhookTaps: (() => void) | null = null;

  constructor(readonly deps: TownPresenceDeps) {}

  /**
   * A left tap no sim entity took. Shopkeeper: opens its shop. Other hero: opens
   * the trade bubble. Anything else clears an open bubble and walks (returns false).
   * Only while connected; the page's own taps otherwise behave as before.
   */
  private readonly onTap = (p: PointerInfo): boolean => {
    if (!this.conn) return false;
    let best: Avatar | null = null;
    let bestD = TAP_RADIUS * TAP_RADIUS;
    for (const a of this.shown.values()) {
      // A companion counts as its owner (its tap opens the owner's bubble).
      for (let i = -1; i < a.companions.length; i++) {
        const e = i < 0 ? a.entity : a.companions[i]!.entity;
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        const d = dx * dx + dy * dy;
        if (d <= bestD) {
          best = a;
          bestD = d;
        }
      }
    }
    const open = this.deps.services.openScreen;
    if (best === null || !open) {
      clearTradeBubble();
      return false;
    }
    if (best.kind === "shopkeeper") {
      clearTradeBubble();
      const screen: PlatformScreen = {
        id: "shop",
        world: PRESENCE_WORLD,
        plotId: plotIdOf(best.other.id),
      };
      open(screen);
      return true;
    }
    showTradeBubble({
      accountId: accountIdOfPresence(best.other.id, PRESENCE_WORLD),
      displayName: best.other.name,
    });
    return true;
  };

  /** Per frame: open/close by area, report pose, draw others. Never throws. */
  update(sim: Sim, nowMs: number): void {
    if (this.destroyed) return;
    try {
      if (!this.debugTried) this.publishDebug();
      this.tick(sim, nowMs);
    } catch (err) {
      this.error = String(err);
    }
  }

  /** Number of other players drawn (HUD / QA). */
  get othersShown(): number {
    return this.shown.size;
  }

  /** True while the presence connection is open (QA / tests). */
  get connected(): boolean {
    return this.conn !== null;
  }

  /**
   * The drawn avatars as plain objects (QA hook window.__gamez.presence).
   * Allocates on every call: debug/QA reads only, never per frame.
   */
  get avatars(): {
    id: string;
    name: string;
    tag: string | null;
    x: number;
    y: number;
    moving: boolean;
  }[] {
    const out: {
      id: string;
      name: string;
      tag: string | null;
      x: number;
      y: number;
      moving: boolean;
    }[] = [];
    for (const a of this.shown.values()) {
      const e = a.entity;
      out.push({
        id: e.id,
        name: e.name ?? "",
        tag: e.subtitle ?? null,
        x: e.x,
        y: e.y,
        moving: a.moving,
      });
    }
    return out;
  }

  /** Last swallowed error, or null (QA / tests). */
  get lastError(): string | null {
    return this.error;
  }

  destroy(): void {
    this.destroyed = true;
    this.close();
    this.unpublishDebug();
  }

  /**
   * QA hook: when the page runs with `?debug=1` (window.__gamez already exists,
   * created by the renderer and debug.ts), publishes `window.__gamez.presence`
   * as a live getter for this instance. Tried once; nothing happens without debug.
   */
  private publishDebug(): void {
    this.debugTried = true;
    try {
      const root = (globalThis as { __gamez?: unknown }).__gamez;
      if (!root || typeof root !== "object") return;
      const get = (): TownPresence => this;
      Object.defineProperty(root, "presence", { get, enumerable: true, configurable: true });
      this.debugGetter = get;
    } catch (err) {
      this.error = String(err);
    }
  }

  private unpublishDebug(): void {
    const get = this.debugGetter;
    if (!get) return;
    this.debugGetter = null;
    try {
      const root = (globalThis as { __gamez?: Record<string, unknown> }).__gamez;
      if (root && Object.getOwnPropertyDescriptor(root, "presence")?.get === get) {
        delete root.presence;
      }
    } catch (err) {
      this.error = String(err);
    }
  }

  private tick(sim: Sim, nowMs: number): void {
    const world = sim.world;
    const hero = heroOf(world);
    const inTown = hero !== 0 && currentDepth(world) === 0;

    if (inTown) {
      this.leftAt = null;
    } else {
      if (this.conn && this.leftAt === null) this.leftAt = nowMs;
      // Avatars leave the scene at once; the connection lingers for the grace period.
      this.clearAvatars();
      if (this.conn && this.leftAt !== null && nowMs - this.leftAt >= LEAVE_GRACE_MS) this.close();
      return;
    }

    if (!this.conn) {
      this.open(nowMs);
      if (!this.conn) return;
    }
    if (this.view?.status === "offline") {
      this.close();
      this.retryAt = nowMs + RETRY_MS;
      return;
    }

    if (this.viewDirty && this.view) {
      this.viewDirty = false;
      this.reconcile();
    }
    this.reportPose(world, hero, nowMs);
    this.drawMoving();
  }

  private open(nowMs: number): void {
    const join = this.deps.services.joinPresence;
    if (!join || nowMs < this.retryAt) return;
    try {
      const conn = join(PRESENCE_WORLD);
      this.unhookTaps?.();
      this.unhookTaps = addTapInterceptor(this.onTap);
      const unsub = conn.subscribe((v) => {
        this.view = v;
        this.viewDirty = true;
      });
      this.view = conn.getView();
      this.viewDirty = true;
      this.conn = conn;
      this.unsub = unsub;
      this.sentValid = false;
    } catch (err) {
      this.error = String(err);
      this.retryAt = nowMs + RETRY_MS;
    }
  }

  private close(): void {
    const conn = this.conn;
    const unsub = this.unsub;
    this.unhookTaps?.();
    this.unhookTaps = null;
    this.conn = null;
    this.unsub = null;
    this.view = null;
    this.viewDirty = false;
    this.leftAt = null;
    this.sentValid = false;
    this.clearAvatars();
    try {
      unsub?.();
      conn?.close();
    } catch (err) {
      this.error = String(err);
    }
  }

  private reportPose(world: Sim["world"], hero: number, nowMs: number): void {
    const conn = this.conn;
    if (!conn) return;
    if (!readPose(world, hero, this.deps.registry, this.cur)) return;
    if (
      this.sentValid &&
      samePose(this.cur, this.sent) &&
      nowMs - this.lastSendMs < POSE_KEEPALIVE_MS
    )
      return;
    if (nowMs - this.lastSendMs < POSE_INTERVAL_MS) return;
    // Companions travel only while there are some; the server's list is cleared once.
    conn.setPose(toPoseUpdate(this.cur, this.cur.cn > 0 || this.sent.cn > 0));
    copyPose(this.cur, this.sent);
    this.sentValid = true;
    this.lastSendMs = nowMs;
  }

  /** Brings the avatars in line with the latest view (new, changed, removed). */
  private reconcile(): void {
    const view = this.view;
    const conn = this.conn;
    if (!view || !conn) return;
    this.gen++;
    const now = conn.serverNow();
    for (const o of view.others) {
      if (o.id === view.selfId) continue;
      // Not drawn until its first pose (a joined hero still shows its saved tile).
      if (!poseReady(o)) continue;
      const key = o.id;
      let a = this.shown.get(key);
      if (!a) {
        const ghost = o.kind === "shopkeeper";
        a = {
          other: o,
          kind: o.kind,
          gen: this.gen,
          moving: false,
          facing: restFacing(o),
          companions: [],
          entity: {
            id: AVATAR_PREFIX + key,
            name: o.name,
            appearance: o.appearance,
            fallbackAppearance: "unit.hero",
            kind: "unit",
            x: o.pos.x,
            y: o.pos.y,
            facing: "s",
            moving: false,
            isSelf: false,
            showLabel: true,
            // Other players get the soft green identity outline; shop ghosts none.
            highlight: o.kind === "player" ? "ally" : null,
            ...(ghost ? { alpha: GHOST_ALPHA, tint: GHOST_TINT } : {}),
          },
        };
        a.entity.facing = a.facing;
        this.shown.set(key, a);
      }
      a.gen = this.gen;
      a.other = o;
      const e = a.entity;
      if (e.name !== o.name) e.name = o.name;
      if (e.appearance !== o.appearance) e.appearance = o.appearance;
      if (o.tag !== undefined) e.subtitle = o.tag;
      else delete e.subtitle;
      this.syncCompanions(a, o.companions ?? []);
      this.draw(a, now);
    }
    for (const [key, a] of this.shown) {
      if (a.gen === this.gen) continue;
      this.dropAvatar(a);
      this.shown.delete(key);
    }
  }

  /**
   * Makes the avatar's companion render objects match the reported list: reuses
   * the object in each slot (its name and look follow the report), creates the
   * missing slots, and removes the ones past the end of the list.
   */
  private syncCompanions(a: Avatar, list: NonNullable<Other["companions"]>): void {
    const n = Math.min(list.length, MAX_COMPANIONS);
    while (a.companions.length > n) {
      const c = a.companions.pop()!;
      this.deps.renderer.removeEntity(c.entity.id);
    }
    for (let i = 0; i < n; i++) {
      const src = list[i]!;
      let c = a.companions[i];
      if (!c) {
        c = {
          dx: src.dx,
          dy: src.dy,
          entity: {
            id: `${AVATAR_PREFIX}${a.other.id}:c${i}`,
            name: src.name,
            appearance: src.appearance,
            fallbackAppearance: "unit.hero",
            kind: "unit",
            x: a.entity.x,
            y: a.entity.y,
            facing: a.facing,
            moving: a.moving,
            isSelf: false,
            showLabel: true,
            highlight: "ally",
          },
        };
        a.companions.push(c);
      }
      c.dx = src.dx;
      c.dy = src.dy;
      const ce = c.entity;
      if (ce.name !== src.name) ce.name = src.name;
      if (ce.appearance !== src.appearance) ce.appearance = src.appearance;
    }
  }

  /** Removes an avatar's render objects, its companions included. */
  private dropAvatar(a: Avatar): void {
    this.deps.renderer.removeEntity(a.entity.id);
    for (const c of a.companions) this.deps.renderer.removeEntity(c.entity.id);
    a.companions.length = 0;
  }

  /** Per-frame interpolation of avatars that are still walking. */
  private drawMoving(): void {
    if (this.shown.size === 0 || !this.conn) return;
    let now: number | null = null;
    for (const a of this.shown.values()) {
      if (!a.moving) continue;
      if (now === null) now = this.conn.serverNow();
      this.draw(a, now);
    }
  }

  private draw(a: Avatar, now: number): void {
    const w = walkAt(a.other, now);
    const e = a.entity;
    // Presence tiles are integers; classic draws units at pos / SUB, where a tile's centre is t + 0.5.
    e.x = w.x + TILE_CENTRE;
    e.y = w.y + TILE_CENTRE;
    if (w.next) {
      a.facing = facingOf(w.next.x - w.from.x, w.next.y - w.from.y, a.facing);
      a.moving = true;
    } else {
      a.moving = false;
    }
    e.facing = a.facing;
    e.moving = a.moving;
    this.deps.renderer.upsertEntity(e);
    // Companions follow the avatar's interpolated tile plus their offset.
    for (const c of a.companions) {
      const ce = c.entity;
      ce.x = e.x + c.dx;
      ce.y = e.y + c.dy;
      ce.facing = a.facing;
      ce.moving = a.moving;
      this.deps.renderer.upsertEntity(ce);
    }
  }

  private clearAvatars(): void {
    clearTradeBubble();
    if (this.shown.size === 0) return;
    for (const a of this.shown.values()) this.dropAvatar(a);
    this.shown.clear();
  }
}
