/**
 * Wave B e2e: presence in the classic town (world "classic-town", wave-B.md §7).
 * OWNER: T-presence. Two guests join the pose world; A's pose reaches B; the
 * wrong-world, bounds and unknown-world rules hold; A's leave reaches B.
 * Uses a small world-aware bot (BotClient has a fixed URL without `world`).
 */
import type { ClientMessage, EntityState, ServerMessage } from "@gamez/protocol";
// The same codec constant the browser client uses, so the e2e follows a wire-format switch.
import { codec } from "../../../apps/game/src/shared/codec.ts";
import type { Guest } from "./client.ts";
import type { E2eContext, E2eFeature } from "./features.ts";
import { check } from "./report.ts";

type Welcome = Extract<ServerMessage, { t: "welcome" }>;
type Err = Extract<ServerMessage, { t: "error" }>;

const WORLD = "classic-town";
const CHUNK = "classic-town:0:0";

/** A scripted socket for one world; `world` undefined means the default (plaza). */
class WorldBot {
  readonly log: ServerMessage[] = [];
  readonly opened: Promise<boolean>;
  readonly closed: Promise<void>;
  private readonly ws: WebSocket;
  private readonly waiters = new Set<() => void>();

  constructor(baseUrl: string, guest: Guest, world?: string) {
    const query = world === undefined ? "" : `&world=${encodeURIComponent(world)}`;
    const url = `${baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(guest.token)}${query}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.opened = new Promise((resolve) => {
      this.ws.addEventListener("open", () => resolve(true));
      this.ws.addEventListener("close", () => resolve(false));
    });
    this.ws.addEventListener("message", (ev: MessageEvent<string | ArrayBuffer>) => {
      this.log.push(codec.decodeServer(ev.data));
      for (const wake of this.waiters) wake();
    });
    this.closed = new Promise((resolve) => this.ws.addEventListener("close", () => resolve()));
  }

  send(msg: ClientMessage): void {
    this.ws.send(codec.encodeClient(msg) as string | Uint8Array<ArrayBuffer>);
  }

  /** Resolves with the first logged message that matches, or rejects after `timeoutMs`. */
  waitFor(
    label: string,
    match: (m: ServerMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const scan = (): boolean => {
        const hit = this.log.find(match);
        if (hit) {
          done();
          resolve(hit);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      const wake = (): void => void scan();
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(wake);
      };
      if (!scan()) this.waiters.add(wake);
    });
  }

  /** Closes and waits for the server's close frame (at most 3 s). */
  async close(): Promise<void> {
    this.ws.close(1000, "bye");
    await Promise.race([this.closed, new Promise((r) => setTimeout(r, 3000))]);
  }
}

const isWelcome = (m: ServerMessage): m is Welcome => m.t === "welcome";
const isError =
  (code: string) =>
  (m: ServerMessage): m is Err =>
    m.t === "error" && m.code === code;

function upsertOf(m: ServerMessage, id: string): EntityState | undefined {
  return m.t === "delta" ? m.upserts.find((e) => e.id === id) : undefined;
}

export const classicPresenceFeature: E2eFeature = {
  name: "classic-presence",
  async run(ctx: E2eContext) {
    const a = ctx.guestA;
    const b = ctx.guestB;
    const townA = `${a.accountId}:classic-town`;

    // Unknown worlds never upgrade (the route answers 404 before the socket opens).
    const probe = new WorldBot(ctx.url, a, "moon-base");
    check(!(await probe.opened), "an unknown world does not open a presence socket");
    await probe.close();

    const botA = new WorldBot(ctx.url, a, WORLD);
    check(await botA.opened, "A opens a classic-town socket");
    const welcomeA = (await botA.waitFor("A's welcome", isWelcome)) as Welcome;
    check(
      welcomeA.selfId === townA && welcomeA.chunkId === CHUNK,
      `A's welcome names ${townA} in ${CHUNK} (got ${welcomeA.selfId} in ${welcomeA.chunkId})`,
    );

    const botB = new WorldBot(ctx.url, b, WORLD);
    check(await botB.opened, "B opens a classic-town socket");
    const welcomeB = (await botB.waitFor("B's welcome", isWelcome)) as Welcome;
    check(
      welcomeB.entities.some((e) => e.id === townA),
      "B's welcome lists A in the town",
    );

    // A's pose (with a path and a tag) reaches B as a delta.
    botA.send({
      t: "pose",
      pos: { x: 36, y: 46 },
      path: [
        { x: 37, y: 46 },
        { x: 38, y: 46 },
      ],
      speed: 4,
      appearance: "unit.hero.warrior",
      tag: "Lv 3 Warrior",
    });
    const poseAtB = await botB
      .waitFor("A's pose at B", (m) => upsertOf(m, townA)?.tag === "Lv 3 Warrior")
      .catch(() => null);
    const seenA = poseAtB ? upsertOf(poseAtB, townA) : undefined;
    check(
      seenA !== undefined &&
        seenA.pos.x === 36 &&
        seenA.pos.y === 46 &&
        seenA.path.length === 2 &&
        seenA.path[1]?.x === 38 &&
        seenA.speed === 4,
      `B sees A's pose, path and tag (${seenA ? `pos ${seenA.pos.x},${seenA.pos.y} path ${seenA.path.length} tag "${seenA.tag}"` : "no delta"})`,
    );
    check(
      seenA?.appearance === "unit.hero.warrior",
      `B sees A's valid appearance (${seenA?.appearance ?? "none"})`,
    );

    // ADR 0007 R11: a tag is not free text. Anything but "Lv <n> <class word>"
    // is dropped, so B sees A's next pose without a tag.
    botA.send({
      t: "pose",
      pos: { x: 38, y: 46 },
      path: [],
      speed: 4,
      // A distinct appearance marks this pose's delta (continueWalk may keep
      // the drawn position on the earlier walk).
      appearance: "unit.hero.rogue",
      tag: "Lv 3 visit evil.example",
    });
    const freeText = await botB
      .waitFor(
        "A's free-text-tag pose at B",
        (m) => upsertOf(m, townA)?.appearance === "unit.hero.rogue",
      )
      .catch(() => null);
    const seenFree = freeText ? upsertOf(freeText, townA) : undefined;
    check(
      seenFree !== undefined && seenFree.tag === undefined,
      `a free-text pose tag is not relayed (${seenFree ? `tag ${JSON.stringify(seenFree.tag ?? null)}` : "no delta"})`,
    );

    // Pose sanitising: an out-of-bounds pose is refused and changes nothing at B.
    botA.send({ t: "pose", pos: { x: 500, y: 1 }, path: [], speed: 4 });
    const refused = await botA
      .waitFor("out-of-bounds error", isError("out-of-bounds"))
      .catch(() => null);
    check(refused !== null, "an out-of-bounds pose is refused with out-of-bounds");

    // Move intents are plaza-only; the town answers wrong-world.
    botA.send({ t: "moveTo", target: { x: 40, y: 40 } });
    const wrongMove = await botA
      .waitFor("wrong-world for moveTo", isError("wrong-world"))
      .catch(() => null);
    check(wrongMove !== null, "moveTo in classic-town is refused with wrong-world");

    // Poses are plaza-invalid: a plaza socket gets wrong-world for a pose.
    const plaza = new WorldBot(ctx.url, a);
    check(await plaza.opened, "A opens a plaza socket");
    await plaza.waitFor("plaza welcome", isWelcome).catch(() => null);
    plaza.send({ t: "pose", pos: { x: 36, y: 46 }, path: [], speed: 4 });
    const wrongPose = await plaza
      .waitFor("wrong-world for pose", isError("wrong-world"))
      .catch(() => null);
    check(wrongPose !== null, "a pose in the plaza is refused with wrong-world");
    await plaza.close();

    // A leaves: B sees the entity removed.
    await botA.close();
    const removed = await botB
      .waitFor("A's removal at B", (m) => m.t === "delta" && m.removes.includes(townA))
      .catch(() => null);
    check(removed !== null, "B sees A removed when A leaves");
    await botB.close();
  },
};
