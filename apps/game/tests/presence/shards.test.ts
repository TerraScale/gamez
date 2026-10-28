import { describe, expect, it } from "vite-plus/test";
import { RelayFanout } from "../../src/server/presence/fanout.ts";
import { placement } from "../../src/server/presence/world.ts";
import {
  PRESENCE_WORLDS,
  relayName,
  relayShard,
  stableHash,
  type PresenceWorldSpec,
} from "../../src/shared/worlds.ts";

const plaza = PRESENCE_WORLDS.plaza!;
const town = PRESENCE_WORLDS["classic-town"]!;

describe("relay shard routing", () => {
  it("stableHash is 32-bit FNV-1a (pinned, so routing never changes across deploys)", () => {
    expect(stableHash("")).toBe(0x811c9dc5);
    expect(stableHash("a")).toBe(0xe40c292c);
    expect(stableHash("foobar")).toBe(0xbf9cf968);
  });

  it("plaza keeps exactly one relay with its legacy name", () => {
    expect(plaza.relayShards).toBe(1);
    for (const id of ["a", "b", "acc-1", crypto.randomUUID()]) {
      expect(relayShard(id, plaza)).toBe(0);
      expect(placement("EU", id, plaza).relay).toBe("relay:EU:0");
    }
    // A shard argument never changes the plaza's name.
    expect(relayName("EU", plaza, 3)).toBe("relay:EU:0");
  });

  it("classic-town spreads accounts over 4 relays named by shard", () => {
    expect(town.relayShards).toBe(4);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) {
      const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      const shard = relayShard(id, town);
      expect(Number.isInteger(shard) && shard >= 0 && shard < 4).toBe(true);
      counts[shard]!++;
      expect(placement("NA", id, town).relay).toBe(`relay:NA:classic-town:${shard}`);
    }
    // Roughly even: every shard gets 25 % +- 5 % of the accounts.
    for (const c of counts) expect(Math.abs(c - 1000)).toBeLessThan(200);
  });

  it("is stable per account, so all sockets of one account meet on one relay", () => {
    const id = crypto.randomUUID();
    const first = placement("EU", id, town).relay;
    for (let i = 0; i < 10; i++) expect(placement("EU", id, town).relay).toBe(first);
    expect(relayShard("acc-1", town)).toBe(stableHash("acc-1") % 4);
  });

  it("shard 0 keeps the wave B relay name, and a bad shard count means one shard", () => {
    expect(relayName("EU", town)).toBe("relay:EU:classic-town:0");
    expect(relayName("EU", town, 0)).toBe("relay:EU:classic-town:0");
    const broken: PresenceWorldSpec = { ...town, relayShards: 0 };
    expect(relayShard("anything", broken)).toBe(0);
  });
});

describe("chunk fan-out over sharded relays", () => {
  const delta = { seq: 7, upserts: ["a"], removes: [] as string[] };

  it("delivers each delta once to every relay, however many players are behind it", async () => {
    const relays = [0, 1, 2, 3].map((s) => relayName("EU", town, s));
    const fanout = new RelayFanout();
    for (const r of relays) expect(fanout.add(r)).toBe(true);
    expect(fanout.add(relays[0]!)).toBe(false);
    const got: [string, typeof delta][] = [];
    const res = await fanout.deliver(async (r) => {
      got.push([r, delta]);
    });
    expect(got.map(([r]) => r)).toEqual(relays);
    expect(res.delivered).toEqual(relays);
    expect(res.dropped).toEqual([]);
  });

  it("delivers to the other relays when one fails, and drops it after 3 failures in a row", async () => {
    const fanout = new RelayFanout(["r0", "r1", "r2"]);
    const seen: string[] = [];
    const send = async (r: string): Promise<void> => {
      if (r === "r1") throw new Error("down");
      seen.push(r);
    };
    let res = await fanout.deliver(send);
    expect(res.failed.map((f) => [f.relay, f.failures])).toEqual([["r1", 1]]);
    expect(res.dropped).toEqual([]);
    res = await fanout.deliver(send);
    expect(res.dropped).toEqual([]);
    res = await fanout.deliver(send);
    expect(res.dropped).toEqual(["r1"]);
    expect(fanout.names()).toEqual(["r0", "r2"]);
    expect(seen).toEqual(["r0", "r2", "r0", "r2", "r0", "r2"]);
  });

  it("a success resets the failure count", async () => {
    const fanout = new RelayFanout(["r0"]);
    let fail = true;
    const send = async (): Promise<void> => {
      if (fail) throw new Error("flaky");
    };
    await fanout.deliver(send);
    await fanout.deliver(send);
    fail = false;
    await fanout.deliver(send);
    fail = true;
    const res = await fanout.deliver(send);
    expect(res.failed[0]?.failures).toBe(1);
    expect(fanout.has("r0")).toBe(true);
  });

  it("counts a hung delivery as a failure instead of stalling the others", async () => {
    const fanout = new RelayFanout(["r0", "r1"], 3, 20);
    const res = await fanout.deliver((r) =>
      r === "r1" ? new Promise<void>(() => {}) : Promise.resolve(),
    );
    expect(res.delivered).toEqual(["r0"]);
    expect(res.failed.map((f) => [f.relay, String(f.reason)])).toEqual([
      ["r1", "Error: deliver timed out"],
    ]);
  });

  it("ignores the result for a relay that unsubscribed while its delivery was in flight", async () => {
    const fanout = new RelayFanout(["r0", "r1"]);
    const res = await fanout.deliver(async (r) => {
      if (r === "r1") {
        fanout.remove("r1");
        throw new Error("gone");
      }
    });
    expect(res.delivered).toEqual(["r0"]);
    expect(res.failed).toEqual([]);
    expect(fanout.names()).toEqual(["r0"]);
  });
});
