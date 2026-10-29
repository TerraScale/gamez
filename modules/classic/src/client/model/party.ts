/**
 * Party HUD model (docs/design/party.md §10.1): PartyView for the party frames,
 * the party panel and the death banner. Pure: reads the world and the frozen
 * registry, never mutates them. buildHud() shares its structure with the
 * previous snapshot, so unchanged frames keep their identity.
 *
 * Returns null before a hero exists. A party of one has one member; the
 * party resource (RES.party) may be absent, which is the solo game.
 */
import type { Entity, FrozenRegistry, World } from "@gamez/kernel";
import {
  AutoState,
  Dead,
  Hero,
  Level,
  Life,
  Mana,
  Reviving,
  Statuses,
  Talents,
} from "../../components.ts";
import {
  actingLeaderOf,
  founderOf,
  partyGold,
  partyMembers,
  roleOf,
  slotsOf,
} from "../../party/shared.ts";
import {
  DEFAULT_PARTY_CONFIG,
  RES,
  partyStateOf,
  type AreaState,
  type ControlState,
  type DungeonState,
  type GameState,
} from "../../resources.ts";
import { nextSlotPrice, partyProtoOf, recruitFee, recruitLevel, xpAtLevel } from "../../rules.ts";
import {
  BALANCE_ID,
  KIND,
  type BalanceProto,
  type ClassProto,
  type StatusProto,
} from "../../types.ts";
import type { PartyMemberView, PartyView, StatusView } from "../contract.ts";

/** Statuses shown on a frame (the rest are only in the hero panel). */
const FRAME_STATUS_LIMIT = 4;

/** Party HUD view of the world at `tick`, or null before a hero exists. */
export function buildPartyView(world: World, registry: FrozenRegistry, tick = 0): PartyView | null {
  const bal = registry.get<BalanceProto>(KIND.balance, BALANCE_ID);
  const members = partyMembers(world);
  if (!bal || members.length === 0) return null;
  const proto = partyProtoOf(registry);
  const game = world.getResource<GameState>(RES.game);
  const controlled = game?.hero ?? 0;
  const leader = actingLeaderOf(world);
  const founder = founderOf(world);

  const views: PartyMemberView[] = [];
  for (const e of members) {
    const v = memberView(world, registry, bal, e, views.length, {
      tick,
      controlled,
      leader,
      founder,
      members,
    });
    if (v) views.push(v);
  }
  if (views.length === 0) return null;

  const slots = slotsOf(world, registry);
  const bosses = world.getResource<DungeonState>(RES.dungeon)?.bossesKilled ?? [];
  const nextBoss =
    slots >= proto.maxMembers
      ? null
      : (proto.unlockBossDepths.find((d) => !bosses.includes(d)) ?? null);
  let highest = 1;
  for (const v of views) highest = Math.max(highest, v.level);
  const level = recruitLevel(proto, highest);
  const fee = recruitFee(proto, level);
  const gold = partyGold(world);
  const area = world.getResource<AreaState>(RES.area);
  const inTown = area !== undefined && area.depth === 0;
  const blocked: PartyView["recruit"]["blocked"] = !inTown
    ? "town"
    : views.length >= slots
      ? "slots"
      : gold < fee
        ? "gold"
        : null;
  const control = world.getResource<ControlState>(RES.control);
  const party = partyStateOf(world);

  return {
    members: views,
    slots,
    maxMembers: proto.maxMembers,
    nextSlotPrice: nextSlotPrice(proto, slots),
    nextSlotBossDepth: nextBoss,
    recruit: { level, fee, blocked },
    config: party ? { ...party.config } : { ...DEFAULT_PARTY_CONFIG },
    gold,
    inTown,
    partyAuto: (control?.mode ?? "manual") !== "manual",
  };
}

interface MemberContext {
  tick: number;
  controlled: Entity;
  leader: Entity;
  founder: Entity;
  members: readonly Entity[];
}

function memberView(
  world: World,
  registry: FrozenRegistry,
  bal: BalanceProto,
  e: Entity,
  slot: number,
  c: MemberContext,
): PartyMemberView | null {
  const hero = world.get(e, Hero);
  const lvl = world.get(e, Level);
  const life = world.get(e, Life);
  const mana = world.get(e, Mana);
  if (!hero || !lvl || !life || !mana) return null;
  const cls = registry.get<ClassProto>(KIND.class, hero.classId);
  const xpStart = xpAtLevel(bal, lvl.level);
  const span = lvl.level >= bal.maxLevel ? 0 : xpAtLevel(bal, lvl.level + 1) - xpStart;
  let xpPermille = 0;
  if (lvl.level >= bal.maxLevel) xpPermille = 1000;
  else if (span > 0) xpPermille = clamp(Math.floor(((lvl.xp - xpStart) * 1000) / span), 0, 1000);
  let reviving: PartyMemberView["reviving"] = null;
  if (world.has(e, Dead)) {
    for (const r of c.members) {
      const rv = world.get(r, Reviving);
      if (rv && rv.target === e) {
        const total = rv.until - rv.startedAt;
        const pct =
          total > 0 ? clamp(Math.round(((c.tick - rv.startedAt) * 100) / total), 0, 100) : 0;
        reviving = { by: r, pct };
        break;
      }
    }
  }
  const talents = world.get(e, Talents);
  const auto = world.get(e, AutoState);
  return {
    entity: e,
    slot,
    key: `F${slot + 1}`,
    name: hero.name,
    classId: hero.classId,
    className: cls?.name ?? hero.classId,
    appearance: cls?.appearance ?? "",
    tint: cls?.tint ?? 0xffffff,
    level: lvl.level,
    xpPermille,
    life: life.hp,
    lifeMax: life.max,
    mana: mana.mp,
    manaMax: mana.max,
    role: roleOf(world, registry, e),
    dead: world.has(e, Dead),
    reviving,
    controlled: e === c.controlled,
    leader: e === c.leader,
    founder: e === c.founder,
    plan: auto?.plan ?? "none",
    unspent: lvl.statPoints + lvl.skillPoints + (talents?.points ?? 0),
    statuses: memberStatuses(world, registry, e, c.tick),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** A member's active statuses for its frame: soonest to expire first, at most FRAME_STATUS_LIMIT. */
function memberStatuses(
  world: World,
  registry: FrozenRegistry,
  e: Entity,
  tick: number,
): StatusView[] {
  const list = world.get(e, Statuses)?.list ?? [];
  const out: StatusView[] = [];
  for (const s of list) {
    if (s.until <= tick) continue;
    const proto = registry.get<StatusProto>(KIND.status, s.id);
    out.push({
      id: s.id,
      name: proto?.name ?? s.id,
      kind: proto?.kind ?? "buff",
      secondsLeft: Math.ceil((s.until - tick) / 20),
      tint: proto?.tint ?? 0xffffff,
    });
  }
  out.sort((a, b) => a.secondsLeft - b.secondsLeft || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.slice(0, FRAME_STATUS_LIMIT);
}
