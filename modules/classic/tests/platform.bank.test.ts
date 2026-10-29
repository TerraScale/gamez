/**
 * classic.bank (wave-C.md §2.3): the server-only bank action between the hero
 * and the account, and the vault codec. Every op, every rejection (a rejected
 * dispatch leaves sim.hash() unchanged), codec round trip and tamper
 * rejection, and determinism with a pinned hash of a scripted bank sequence.
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { BANK_ACTOR, VAULT_ITEM_DATA_MAX, type VaultItem } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { ERR } from "../src/actions.ts";
import { Dead, Equipment, Inventory, Wallet } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import {
  BANK_ACTION,
  BANK_DEFAULTS,
  BANK_EVENT,
  bankFee,
  type ClassicBankEvent,
} from "../src/platform/bank.ts";
import { classicClientDriven } from "../src/platform/policy.ts";
import {
  classicItemSummary,
  itemToVault,
  vaultToItem,
  SUMMARY_MAX_LINES,
} from "../src/platform/vault-codec.ts";
import { heroOf, RES, type AreaState, type GameState, type StashState } from "../src/resources.ts";
import type { ItemInstance } from "../src/types.ts";

const SEED = 4242;
const loaded = loadMode(mode, modules);
const registry = loaded.registry;

/** A warrior in town with its kit (one step runs classic.items.heroInit). */
function started(seed = SEED): Sim {
  const sim = createSim(loaded, { seed });
  expect(
    sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "Banker" }, "local").ok,
  ).toBe(true);
  sim.step(1);
  return sim;
}

function hero(sim: Sim): number {
  return heroOf(sim.world);
}

function gold(sim: Sim): number {
  return sim.world.get(hero(sim), Wallet)!.gold;
}

function bag(sim: Sim): ItemInstance[] {
  return sim.world.get(hero(sim), Inventory)!.items.map((e) => e.item);
}

/** Moves the equipped weapon into the bag (a plain dispatch, like a player would). */
function unequipWeapon(sim: Sim): ItemInstance {
  const weapon = sim.world.get(hero(sim), Equipment)!.weapon!;
  expect(sim.dispatch("classic.unequip", { slot: "weapon" }, "local").ok).toBe(true);
  return weapon;
}

let opCounter = 0;
function opId(): string {
  opCounter++;
  return `op_test_${String(opCounter).padStart(4, "0")}`;
}

function bank(sim: Sim, payload: unknown) {
  return sim.dispatch(BANK_ACTION, payload, BANK_ACTOR);
}

function effectOf(events: readonly GameEvent[]): ClassicBankEvent {
  const evs = events.filter((e) => e.type === BANK_EVENT);
  expect(evs).toHaveLength(1);
  return evs[0] as unknown as ClassicBankEvent;
}

function expectRejected(sim: Sim, payload: unknown, code: string): void {
  const before = sim.hash();
  const res = bank(sim, payload);
  expect(res.ok, JSON.stringify(res.error)).toBe(false);
  expect(res.error?.code).toBe(code);
  expect(sim.hash()).toBe(before);
}

/** A vault item as the account would hand it back (uid assigned by the vault). */
function asVault(sim: Sim, item: ItemInstance, uid = "v_0001"): VaultItem {
  return { uid, ...itemToVault(item, registry) };
}

describe("bankFee", () => {
  it("is 5 % with a minimum of 1, never above the amount", () => {
    expect(bankFee(1)).toBe(1);
    expect(bankFee(19)).toBe(1);
    expect(bankFee(20)).toBe(1);
    expect(bankFee(40)).toBe(2);
    expect(bankFee(1000)).toBe(50);
    expect(bankFee(1, { ...BANK_DEFAULTS, feeMin: 5 })).toBe(1);
  });

  it("the policy wires the bank action and event", () => {
    expect(classicClientDriven.platform?.bankAction).toBe(BANK_ACTION);
    expect(classicClientDriven.platform?.bankEvent).toBe(BANK_EVENT);
    expect(classicClientDriven.serverOnlyActions).toContain(BANK_ACTION);
  });
});

describe("classic.bank ops", () => {
  it("depositGold removes gold and credits gold minus the fee", () => {
    const sim = started();
    expect(gold(sim)).toBe(50);
    const id = opId();
    const res = bank(sim, { opId: id, op: { kind: "depositGold", gold: 40 } });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(gold(sim)).toBe(10);
    const ev = effectOf(res.events);
    expect(ev).toEqual({ type: BANK_EVENT, opId: id, credit: { coin: 38 }, item: null, gold: 40 });
  });

  it("withdrawCoin adds gold", () => {
    const sim = started();
    const res = bank(sim, { opId: opId(), op: { kind: "withdrawCoin", coin: 125 } });
    expect(res.ok).toBe(true);
    expect(gold(sim)).toBe(175);
    const ev = effectOf(res.events);
    expect(ev.credit).toBeNull();
    expect(ev.item).toBeNull();
    expect(ev.gold).toBe(-125);
  });

  it("depositItem takes a bag item and emits its vault form", () => {
    const sim = started();
    const weapon = unequipWeapon(sim);
    expect(bag(sim).map((i) => i.uid)).toContain(weapon.uid);
    const res = bank(sim, { opId: opId(), op: { kind: "depositItem", ref: weapon.uid } });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(bag(sim).map((i) => i.uid)).not.toContain(weapon.uid);
    const ev = effectOf(res.events);
    expect(ev.credit).toBeNull();
    expect(ev.gold).toBe(0);
    expect(ev.item).toMatchObject({
      itemId: weapon.base,
      count: 1,
      origin: "classic",
      universal: false,
      tradable: true,
    });
    expect(ev.item!.summary.category).toBe("weapon");
    expect(ev.item!.summary.slot).toBe("weapon");
    expect(ev.item!.summary.icon).not.toMatch(/\.png$/);
  });

  it("depositItem also takes stash items (any tab)", () => {
    const sim = started();
    const weapon = unequipWeapon(sim);
    // Put it in stash tab 1 directly (reach rules are not under test here).
    const h = hero(sim);
    const inv = sim.world.get(h, Inventory)!;
    sim.world.update(h, Inventory, { items: inv.items.filter((e) => e.item.uid !== weapon.uid) });
    const stash = sim.world.getResource<StashState>(RES.stash)!;
    sim.world.setResource(RES.stash, { ...stash, items: [...stash.items, { ...weapon, tab: 1 }] });
    const res = bank(sim, { opId: opId(), op: { kind: "depositItem", ref: weapon.uid } });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(sim.world.getResource<StashState>(RES.stash)!.items).toHaveLength(stash.items.length);
    const data = JSON.parse(effectOf(res.events).item!.data!) as Record<string, unknown>;
    expect(data.uid).toBeUndefined();
    expect(data.tab).toBeUndefined();
  });

  it("withdrawItem recreates the item with a fresh uid in the first free bag spot", () => {
    const sim = started();
    const weapon = unequipWeapon(sim);
    const dep = bank(sim, { opId: opId(), op: { kind: "depositItem", ref: weapon.uid } });
    const vault: VaultItem = { uid: "v_abc", ...effectOf(dep.events).item! };
    const nextUid = sim.world.getResource<GameState>(RES.game)!.nextUid;
    const res = bank(sim, {
      opId: opId(),
      op: { kind: "withdrawItem", uid: "v_abc" },
      item: vault,
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const back = bag(sim).find((i) => i.uid === nextUid);
    expect(back).toBeDefined();
    const { uid: _a, ...restBack } = back!;
    const { uid: _b, ...restWeapon } = weapon;
    expect(restBack).toEqual(restWeapon);
    expect(sim.world.getResource<GameState>(RES.game)!.nextUid).toBe(nextUid + 1);
    const ev = effectOf(res.events);
    expect(ev).toMatchObject({ credit: null, item: null, gold: 0 });
  });
});

describe("classic.bank rejections", () => {
  it("rejects malformed payloads", () => {
    const sim = started();
    expectRejected(sim, null, ERR.badPayload);
    expectRejected(sim, { opId: "short", op: { kind: "depositGold", gold: 5 } }, ERR.badPayload);
    expectRejected(sim, { opId: opId(), op: { kind: "steal", gold: 5 } }, ERR.badPayload);
    expectRejected(sim, { opId: opId(), op: { kind: "depositGold", gold: 0 } }, ERR.badPayload);
    expectRejected(sim, { opId: opId(), op: { kind: "depositGold", gold: 1.5 } }, ERR.badPayload);
    expectRejected(sim, { opId: opId(), op: { kind: "withdrawCoin", coin: -3 } }, ERR.badPayload);
    expectRejected(
      sim,
      { opId: opId(), op: { kind: "withdrawCoin", coin: BANK_DEFAULTS.maxAmount + 1 } },
      ERR.badPayload,
    );
    expectRejected(sim, { opId: opId(), op: { kind: "withdrawItem", uid: "x1" } }, ERR.badPayload);
    expectRejected(
      sim,
      { opId: opId(), op: { kind: "depositGold", gold: 5 }, item: { uid: "x" } },
      ERR.badPayload,
    );
  });

  it("needs a hero", () => {
    const sim = createSim(loaded, { seed: SEED });
    expectRejected(sim, { opId: opId(), op: { kind: "withdrawCoin", coin: 5 } }, ERR.noHero);
  });

  it("needs a living hero", () => {
    const sim = started();
    sim.world.add(hero(sim), Dead, { at: sim.tick, killer: 0 });
    expectRejected(sim, { opId: opId(), op: { kind: "withdrawCoin", coin: 5 } }, ERR.dead);
  });

  it("works in town only", () => {
    const sim = started();
    const area = sim.world.getResource<AreaState>(RES.area)!;
    sim.world.setResource(RES.area, { ...area, depth: 2 });
    expectRejected(sim, { opId: opId(), op: { kind: "depositGold", gold: 10 } }, ERR.notInTown);
  });

  it("depositGold: more than the wallet, or not covering the fee", () => {
    const sim = started();
    expectRejected(sim, { opId: opId(), op: { kind: "depositGold", gold: 51 } }, ERR.noGold);
    expectRejected(sim, { opId: opId(), op: { kind: "depositGold", gold: 1 } }, ERR.empty);
  });

  it("depositItem: unknown or equipped items", () => {
    const sim = started();
    const weapon = sim.world.get(hero(sim), Equipment)!.weapon!;
    expectRejected(
      sim,
      { opId: opId(), op: { kind: "depositItem", ref: weapon.uid } },
      ERR.unknownId,
    );
    expectRejected(sim, { opId: opId(), op: { kind: "depositItem", ref: 99999 } }, ERR.unknownId);
  });

  it("withdrawItem: bag full", () => {
    const sim = started();
    const weapon = unequipWeapon(sim);
    const vault = asVault(sim, weapon);
    const h = hero(sim);
    const inv = sim.world.get(h, Inventory)!;
    // Fill every cell with 1x1 copies of a potion-sized item.
    const filler = (uid: number, x: number, y: number) => ({
      item: { ...weapon, uid, base: "classic.item.potion_life_1" },
      x,
      y,
    });
    const items = [];
    let uid = 50_000;
    for (let y = 0; y < inv.rows; y++)
      for (let x = 0; x < inv.cols; x++) items.push(filler(uid++, x, y));
    sim.world.update(h, Inventory, { items });
    expectRejected(
      sim,
      { opId: opId(), op: { kind: "withdrawItem", uid: vault.uid }, item: vault },
      ERR.bagFull,
    );
  });

  it("withdrawItem: tampered or foreign vault items", () => {
    const sim = started();
    const weapon = unequipWeapon(sim);
    const good = asVault(sim, weapon, "v_t1");
    const op = { kind: "withdrawItem", uid: "v_t1" };
    const tamper = (patch: Partial<VaultItem>) =>
      expectRejected(sim, { opId: opId(), op, item: { ...good, ...patch } }, ERR.badPayload);
    tamper({ origin: "steps" });
    tamper({ data: "{not json" });
    tamper({ data: null });
    tamper({ itemId: "classic.item.other" });
    tamper({ uid: "v_other" });
  });
});

describe("vault codec", () => {
  const sim = started();
  const weapon = unequipWeapon(sim);

  it("round-trips an item exactly (except the uid)", () => {
    const v = itemToVault(weapon, registry);
    expect(v.data!.length).toBeLessThanOrEqual(VAULT_ITEM_DATA_MAX);
    const back = vaultToItem(v, registry, 777);
    expect(back).toEqual({ ...weapon, uid: 777 });
  });

  it("round-trips the wave A optional fields and drops the stash tab", () => {
    const fancy: ItemInstance = {
      ...weapon,
      rarity: "magic",
      mods: [{ stat: "str", value: 5 }],
      sockets: ["classic.item.gem_ruby_1", null],
      dur: { cur: 3, max: 40 },
      upgrade: 2,
      rerolls: 1,
      tab: 2,
    };
    const back = vaultToItem(itemToVault(fancy, registry), registry, 9)!;
    const { tab: _t, ...expected } = fancy;
    expect(back).toEqual({ ...expected, uid: 9 });
  });

  it("summary: name, rarity, level, category, slot, icon and at most 8 lines", () => {
    const s = classicItemSummary(weapon, registry);
    expect(s).toMatchObject({ name: weapon.name, rarity: weapon.rarity, level: weapon.ilvl });
    expect(s.lines.length).toBeLessThanOrEqual(SUMMARY_MAX_LINES);
    for (const line of s.lines) expect(line.length).toBeLessThanOrEqual(60);
    const many: ItemInstance = {
      ...weapon,
      mods: Array.from({ length: 12 }, (_, i) => ({ stat: "life" as const, value: i + 1 })),
    };
    expect(classicItemSummary(many, registry).lines).toHaveLength(SUMMARY_MAX_LINES);
  });

  it("rejects tampered data strictly", () => {
    const v = itemToVault(weapon, registry);
    const data = JSON.parse(v.data!) as Record<string, unknown>;
    const withData = (d: Record<string, unknown>) => ({ ...v, data: JSON.stringify(d) });
    const bad: Record<string, unknown>[] = [
      { ...data, base: "classic.item.nope" },
      { ...data, rarity: "legendary" },
      { ...data, ilvl: 0 },
      { ...data, ilvl: 2.5 },
      { ...data, name: "" },
      { ...data, value: -1 },
      { ...data, mods: [{ stat: "godMode", value: 1 }] },
      { ...data, mods: [{ stat: "life", value: 1.5 }] },
      { ...data, mods: [{ stat: "life", value: 1, extra: true }] },
      { ...data, affixes: ["classic.affix.nope"] },
      { ...data, unique: "classic.unique.nope", rarity: "unique" },
      { ...data, rarity: "unique" },
      { ...data, sockets: ["classic.item.short_sword"] },
      { ...data, dur: { cur: 5, max: 4 } },
      { ...data, upgrade: -1 },
      { ...data, uid: 5 },
      { ...data, tab: 1 },
      { ...data, hacked: true },
    ];
    for (const d of bad)
      expect(vaultToItem(withData(d), registry, 1), JSON.stringify(d)).toBeNull();
    expect(
      vaultToItem({ ...v, data: "x".repeat(VAULT_ITEM_DATA_MAX + 1) }, registry, 1),
    ).toBeNull();
    expect(vaultToItem({ ...v, count: 2 }, registry, 1)).toBeNull();
    expect(vaultToItem({ ...v, origin: "duel" }, registry, 1)).toBeNull();
    expect(vaultToItem(v, registry, 0)).toBeNull();
  });
});

/** A fixed script: deposit gold, withdraw coin, deposit the weapon, withdraw it back, play on. */
function script(seed: number): Sim {
  const sim = started(seed);
  const ids = ["op_script_0001", "op_script_0002", "op_script_0003", "op_script_0004"];
  expect(bank(sim, { opId: ids[0], op: { kind: "depositGold", gold: 30 } }).ok).toBe(true);
  sim.step(20);
  expect(bank(sim, { opId: ids[1], op: { kind: "withdrawCoin", coin: 7 } }).ok).toBe(true);
  const weapon = unequipWeapon(sim);
  const dep = bank(sim, { opId: ids[2], op: { kind: "depositItem", ref: weapon.uid } });
  expect(dep.ok).toBe(true);
  sim.step(20);
  const item: VaultItem = { uid: "v_script", ...effectOf(dep.events).item! };
  expect(bank(sim, { opId: ids[3], op: { kind: "withdrawItem", uid: "v_script" }, item }).ok).toBe(
    true,
  );
  sim.step(40);
  return sim;
}

describe("determinism", () => {
  it("same seed and script give the same hash", () => {
    expect(script(SEED).hash()).toBe(script(SEED).hash());
  });

  it("pins the hash of a scripted bank sequence", () => {
    const sim = script(SEED);
    expect(gold(sim)).toBe(27);
    expect(sim.hash()).toMatchInlineSnapshot(`"aa8872de5c7239cf"`);
  });
});
