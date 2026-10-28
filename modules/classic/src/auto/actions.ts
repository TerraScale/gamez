/**
 * Control actions of classic.auto (§15.1): classic.setControl,
 * classic.setSpeed and classic.setAutoConfig. They are settings, so they
 * work without a hero and while the hero is dead.
 */
import { ActionError, type ActionDef, type World } from "@gamez/kernel";
import { ACTION, ERR } from "../actions.ts";
import { AutoState, Intent } from "../components.ts";
import { emit } from "../events.ts";
import {
  DEFAULT_AUTO_CONFIG,
  heroOf,
  RES,
  type AutoConfig,
  type ControlMode,
  type ControlState,
  type SimSpeed,
} from "../resources.ts";
import { ITEM_RARITIES, type ItemRarity } from "../types.ts";

const MODES: readonly ControlMode[] = ["manual", "auto", "idle"];
const SPEEDS: readonly SimSpeed[] = [1, 2, 4, 8];

function bad(message: string): never {
  throw new ActionError(ERR.badPayload, message);
}

function record(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    bad("expected an object");
  return payload as Record<string, unknown>;
}

export function defaultControl(): ControlState {
  // Auto by default: a new hero plays itself until the player takes over (or picks Manual).
  return { mode: "auto", speed: 1, overrideUntil: 0, config: { ...DEFAULT_AUTO_CONFIG } };
}

/** The ControlState resource (created when missing). */
export function controlState(world: World): ControlState {
  let c = world.getResource<ControlState>(RES.control);
  if (!c) {
    world.setResource(RES.control, defaultControl());
    c = world.getResource<ControlState>(RES.control)!;
  }
  return c;
}

type FieldKind = "pct" | "bool" | "rarity" | "depth";
const CONFIG_FIELDS: Record<keyof AutoConfig, FieldKind> = {
  lifePotionPct: "pct",
  manaPotionPct: "pct",
  retreatPct: "pct",
  pickupRarity: "rarity",
  pickupGold: "bool",
  pickupPotions: "bool",
  keepRarity: "rarity",
  autoEquip: "bool",
  autoAllocate: "bool",
  autoDescend: "bool",
  explorePct: "pct",
  maxDepth: "depth",
  buyPotions: "bool",
  manaReservePct: "pct",
  autoRepair: "bool",
  autoCraft: "bool",
  autoGamble: "bool",
  autoRift: "bool",
};
/** Highest maxDepth accepted (0 = no limit). */
export const MAX_DEPTH_LIMIT = 999;

/** Validates a partial AutoConfig strictly (known keys, types and ranges). */
export function parseConfig(raw: unknown): Partial<AutoConfig> {
  const obj = record(raw);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_FIELDS, key))
      bad(`unknown config field "${key}"`);
    const kind = CONFIG_FIELDS[key as keyof AutoConfig];
    const v = obj[key];
    switch (kind) {
      case "pct":
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100)
          bad(`${key} must be an integer 0..100`);
        break;
      case "depth":
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_DEPTH_LIMIT)
          bad(`${key} must be an integer 0..${MAX_DEPTH_LIMIT}`);
        break;
      case "bool":
        if (typeof v !== "boolean") bad(`${key} must be a boolean`);
        break;
      case "rarity":
        if (typeof v !== "string" || !ITEM_RARITIES.includes(v as ItemRarity))
          bad(`${key} must be an item rarity`);
        break;
    }
    out[key] = v;
  }
  return out as Partial<AutoConfig>;
}

export const setControlAction: ActionDef<{ mode: ControlMode }> = {
  name: ACTION.setControl,
  parse(_world, payload) {
    const mode = record(payload).mode;
    if (typeof mode !== "string" || !MODES.includes(mode as ControlMode))
      bad('mode must be "manual", "auto" or "idle"');
    return { mode: mode as ControlMode };
  },
  apply(world, p, ctx) {
    const c = controlState(world);
    c.mode = p.mode;
    if (p.mode !== "idle") c.speed = 1;
    c.overrideUntil = 0;
    const hero = heroOf(world);
    if (hero !== 0 && p.mode === "manual") {
      // Hand the hero back: stop whatever the controller ordered.
      const intent = world.get(hero, Intent);
      if (intent && intent.source === "auto" && intent.kind !== "idle")
        world.add(hero, Intent, { kind: "idle", source: "auto", at: ctx.tick });
      const st = world.get(hero, AutoState);
      if (st && st.plan !== "none") {
        st.plan = "none";
        emit(ctx, { type: "classic.auto.plan", plan: "none", note: "manual" });
      }
    }
    if (hero !== 0 && p.mode !== "manual") {
      // Re-plan right away.
      const st = world.get(hero, AutoState);
      if (st) st.thinkAt = ctx.tick;
    }
    emit(ctx, { type: "classic.control", mode: c.mode, speed: c.speed });
  },
};

export const setSpeedAction: ActionDef<{ speed: SimSpeed }> = {
  name: ACTION.setSpeed,
  parse(_world, payload) {
    const speed = record(payload).speed;
    if (typeof speed !== "number" || !SPEEDS.includes(speed as SimSpeed))
      bad("speed must be 1, 2, 4 or 8");
    return { speed: speed as SimSpeed };
  },
  apply(world, p, ctx) {
    const c = controlState(world);
    if (c.mode !== "idle") throw new ActionError(ERR.modeNotIdle, "speed needs Full Idle mode");
    c.speed = p.speed;
    emit(ctx, { type: "classic.control", mode: c.mode, speed: c.speed });
  },
};

export const setAutoConfigAction: ActionDef<{ config: Partial<AutoConfig> }> = {
  name: ACTION.setAutoConfig,
  parse(_world, payload) {
    const obj = record(payload);
    if (!("config" in obj)) bad("expected { config }");
    return { config: parseConfig(obj.config) };
  },
  apply(world, p) {
    const c = controlState(world);
    c.config = { ...c.config, ...p.config };
  },
};
