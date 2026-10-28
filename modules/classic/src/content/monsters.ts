/**
 * Monsters and bosses (design §8.1). Stats are at monster level 1 and are
 * scaled by rules.scaleMonster. Speeds are sub per tick, ranges are in tiles
 * through tiles(). Bosses have themes [] and a `boss` block; `sentry` is the
 * hero summon used by Spark Sentry (never placed by population). Wave A:
 * bosses fight in phases with telegraphed skills (content/boss.ts) and the
 * two rift guardians (guardian: true, no `boss` block) are spawned only by
 * classic.rift.
 */
import { tiles } from "../fixed.ts";
import type { MonsterProto } from "../types.ts";

type Body = Omit<MonsterProto, "appearance" | "fallbackAppearance">;

/**
 * Fallback art for a monster or NPC whose own clips are missing. It must not
 * be a real art id (the player's "unit.hero" art would then stand in for the
 * monster): `unit.unknown` is not in the art manifest, so the renderer falls
 * through to its placeholder.
 */
export const UNKNOWN_ART = "unit.unknown";

function monster(key: string, p: Body): MonsterProto {
  return { appearance: `unit.monster.${key}`, fallbackAppearance: UNKNOWN_ART, ...p };
}

const CRYPT = "classic.theme.crypt";
const CAVES = "classic.theme.caves";
const FORGE = "classic.theme.forge";
const ABYSS = "classic.theme.abyss";

const REGULAR: Record<string, MonsterProto> = {
  "classic.monster.husk": monster("husk", {
    name: "Shambling Husk",
    family: "undead",
    description: "A dead farmhand that still walks the furrows of the crypt.",
    tint: 0x9fb58a,
    scale: 100,
    behaviour: "rusher",
    life: 18,
    armor: 6,
    toHit: 25,
    dmgMin: 2,
    dmgMax: 5,
    element: "phys",
    resist: { fire: 0, cold: 20, lightning: 0, poison: 50 },
    xp: 9,
    moveSpeed: 30,
    radius: 80,
    skills: ["classic.mskill.claw"],
    aggroRange: tiles(8),
    keepDistance: 0,
    packSize: [3, 6],
    themes: [CRYPT, CAVES],
    minDepth: 1,
    weight: 10,
  }),
  "classic.monster.gnawling": monster("gnawling", {
    name: "Gnawling",
    family: "vermin",
    description: "A starved, rat-like thing that comes in squealing swarms.",
    tint: 0xb08a5c,
    scale: 70,
    behaviour: "swarm",
    life: 7,
    armor: 2,
    toHit: 30,
    dmgMin: 1,
    dmgMax: 3,
    element: "phys",
    resist: { fire: 0, cold: 0, lightning: 0, poison: 20 },
    xp: 4,
    moveSpeed: 62,
    radius: 60,
    skills: ["classic.mskill.bite"],
    aggroRange: tiles(8),
    keepDistance: 0,
    packSize: [6, 10],
    themes: [CRYPT, CAVES],
    minDepth: 1,
    weight: 10,
  }),
  "classic.monster.bonefletcher": monster("bonefletcher", {
    name: "Bonefletcher",
    family: "undead",
    description: "A skeletal archer that keeps its distance and shoots bone arrows.",
    tint: 0xe8e0c8,
    scale: 100,
    behaviour: "archer",
    life: 12,
    armor: 4,
    toHit: 30,
    dmgMin: 2,
    dmgMax: 4,
    element: "phys",
    resist: { fire: 0, cold: 30, lightning: 0, poison: 40 },
    xp: 10,
    moveSpeed: 40,
    radius: 70,
    skills: ["classic.mskill.arrow"],
    aggroRange: tiles(10),
    keepDistance: tiles(5),
    packSize: [2, 4],
    themes: [CRYPT, FORGE],
    minDepth: 1,
    weight: 10,
  }),
  "classic.monster.ash_seer": monster("ash_seer", {
    name: "Ash Seer",
    family: "undead",
    description: "A hooded caster that wreathes itself in drifting embers.",
    tint: 0xff9a4a,
    scale: 100,
    behaviour: "caster",
    life: 14,
    armor: 3,
    toHit: 25,
    dmgMin: 2,
    dmgMax: 4,
    element: "fire",
    resist: { fire: 60, cold: 0, lightning: 0, poison: 0 },
    xp: 14,
    moveSpeed: 36,
    radius: 70,
    skills: ["classic.mskill.firebolt"],
    aggroRange: tiles(9),
    keepDistance: tiles(6),
    packSize: [2, 3],
    themes: [CRYPT, FORGE],
    minDepth: 1,
    weight: 6,
  }),
  "classic.monster.blightbloat": monster("blightbloat", {
    name: "Blightbloat",
    family: "ooze",
    description: "A swollen sac of poison that bursts when it gets close.",
    tint: 0x7adc4a,
    scale: 100,
    behaviour: "exploder",
    life: 16,
    armor: 0,
    toHit: 40,
    dmgMin: 6,
    dmgMax: 12,
    element: "poison",
    resist: { fire: 0, cold: 0, lightning: 0, poison: 100 },
    xp: 12,
    moveSpeed: 44,
    radius: 70,
    skills: ["classic.mskill.burst"],
    aggroRange: tiles(8),
    keepDistance: 0,
    packSize: [2, 4],
    themes: [CAVES, ABYSS],
    minDepth: 2,
    weight: 10,
    onDeathSkill: "classic.mskill.burst",
  }),
  "classic.monster.bristleback": monster("bristleback", {
    name: "Bristleback",
    family: "beast",
    description: "A bristling boar-like brute that charges in straight lines.",
    tint: 0x8c6a4f,
    scale: 100,
    behaviour: "charger",
    life: 30,
    armor: 10,
    toHit: 35,
    dmgMin: 4,
    dmgMax: 8,
    element: "phys",
    resist: { fire: 0, cold: 0, lightning: 0, poison: 0 },
    xp: 20,
    moveSpeed: 48,
    radius: 90,
    skills: ["classic.mskill.gore", "classic.mskill.charge"],
    aggroRange: tiles(9),
    keepDistance: 0,
    packSize: [2, 4],
    themes: [CAVES],
    minDepth: 2,
    weight: 10,
  }),
  "classic.monster.cairn_brute": monster("cairn_brute", {
    name: "Cairn Brute",
    family: "golem",
    description: "A slow pile of fitted stones that hits like a collapsing wall.",
    tint: 0x7d8590,
    scale: 140,
    behaviour: "tank",
    life: 60,
    armor: 18,
    toHit: 30,
    dmgMin: 5,
    dmgMax: 10,
    element: "phys",
    resist: { fire: 0, cold: 0, lightning: 30, poison: 100 },
    xp: 30,
    moveSpeed: 26,
    radius: 110,
    skills: ["classic.mskill.claw", "classic.mskill.slam"],
    aggroRange: tiles(8),
    keepDistance: 0,
    packSize: [1, 2],
    themes: [CAVES, FORGE, ABYSS],
    minDepth: 3,
    weight: 5,
  }),
  "classic.monster.webskitter": monster("webskitter", {
    name: "Webskitter",
    family: "vermin",
    description: "A many-legged spinner whose bite leaves a sickly sheen.",
    tint: 0x6e4a8e,
    scale: 70,
    behaviour: "swarm",
    life: 9,
    armor: 3,
    toHit: 35,
    dmgMin: 2,
    dmgMax: 4,
    element: "poison",
    resist: { fire: 0, cold: 0, lightning: 0, poison: 100 },
    xp: 6,
    moveSpeed: 60,
    radius: 60,
    skills: ["classic.mskill.bite"],
    aggroRange: tiles(8),
    keepDistance: 0,
    packSize: [5, 8],
    themes: [CAVES, ABYSS],
    minDepth: 3,
    weight: 10,
  }),
  "classic.monster.hollow_cantor": monster("hollow_cantor", {
    name: "Hollow Cantor",
    family: "undead",
    description: "A chanting husk that calls the dead back to its side.",
    tint: 0x6a7fb8,
    scale: 100,
    behaviour: "summoner",
    life: 20,
    armor: 4,
    toHit: 20,
    dmgMin: 2,
    dmgMax: 4,
    element: "cold",
    resist: { fire: 0, cold: 50, lightning: 0, poison: 20 },
    xp: 25,
    moveSpeed: 34,
    radius: 70,
    skills: ["classic.mskill.shadebolt", "classic.mskill.raise"],
    aggroRange: tiles(9),
    keepDistance: tiles(6),
    packSize: [1, 2],
    themes: [CRYPT, ABYSS],
    // Depth 2 (design said 4): its raised husks overwhelm level-1 heroes, but crypt
    // depths 2-4 need the variety.
    minDepth: 2,
    weight: 6,
  }),
  "classic.monster.cinder_imp": monster("cinder_imp", {
    name: "Cinder Imp",
    family: "demon",
    description: "A fast, spiteful imp that trails sparks wherever it runs.",
    tint: 0xff5a2a,
    scale: 80,
    behaviour: "rusher",
    life: 12,
    armor: 5,
    toHit: 35,
    dmgMin: 3,
    dmgMax: 5,
    element: "fire",
    resist: { fire: 80, cold: 0, lightning: 0, poison: 0 },
    xp: 10,
    moveSpeed: 58,
    radius: 60,
    skills: ["classic.mskill.claw"],
    aggroRange: tiles(9),
    keepDistance: 0,
    packSize: [4, 7],
    themes: [FORGE],
    minDepth: 5,
    weight: 10,
  }),
  "classic.monster.rime_wraith": monster("rime_wraith", {
    name: "Rime Wraith",
    family: "spirit",
    description: "A frost-cold ghost that hurls shards of rime from a distance.",
    tint: 0x9fe8ff,
    scale: 100,
    behaviour: "caster",
    life: 18,
    armor: 6,
    toHit: 35,
    // Balance (quest fix): 3-7 made its frostbolt the top killer at depths 9-11 for every
    // class (L19 heroes, 4 seeds x 20 000 ticks each: 31 deaths -> 19 at 2-5).
    dmgMin: 2,
    dmgMax: 5,
    element: "cold",
    resist: { fire: 0, cold: 80, lightning: 0, poison: 60 },
    xp: 18,
    moveSpeed: 44,
    radius: 70,
    skills: ["classic.mskill.frostbolt"],
    aggroRange: tiles(10),
    keepDistance: tiles(5),
    packSize: [2, 3],
    themes: [ABYSS, FORGE],
    minDepth: 6,
    weight: 10,
  }),
  // Hero summon (Spark Sentry). Never placed by population.
  "classic.monster.sentry": monster("sentry", {
    name: "Spark Sentry",
    family: "construct",
    description: "A humming brass totem that zaps any enemy in sight.",
    tint: 0xffe066,
    scale: 90,
    behaviour: "totem",
    life: 30,
    armor: 10,
    toHit: 50,
    dmgMin: 3,
    dmgMax: 8,
    element: "lightning",
    resist: { fire: 0, cold: 0, lightning: 100, poison: 0 },
    xp: 0,
    moveSpeed: 0,
    radius: 70,
    skills: ["classic.mskill.sentry_bolt"],
    aggroRange: tiles(6),
    keepDistance: 0,
    packSize: [1, 1],
    themes: [],
    minDepth: 1,
    weight: 1,
  }),
};

type BossBody = Omit<
  Body,
  | "behaviour"
  | "scale"
  | "radius"
  | "aggroRange"
  | "packSize"
  | "themes"
  | "minDepth"
  | "weight"
  | "keepDistance"
> & {
  depth: number;
  title: string;
  minions: string;
  minionCount: number;
};

function boss(key: string, p: BossBody): MonsterProto {
  const { depth, title, minions, minionCount, ...rest } = p;
  return monster(key, {
    ...rest,
    behaviour: "boss",
    scale: 160,
    radius: 140,
    aggroRange: tiles(12),
    keepDistance: 0,
    packSize: [1, 1],
    themes: [],
    minDepth: depth,
    weight: 1,
    boss: { depth, title, minions, minionCount },
  });
}

type Phase = NonNullable<MonsterProto["phases"]>[number];

/** A boss phase (wave A, docs/design/wave-A.md §6.2). */
function phase(
  atPct: number,
  message: string,
  o: { skills?: string[]; summon?: boolean; enragePct?: number } = {},
): Phase {
  return {
    atPct,
    message,
    skills: o.skills ?? [],
    summon: o.summon ?? false,
    enragePct: o.enragePct ?? 0,
  };
}

const QUAKE = "classic.mskill.boss_quake";
const CLEAVE = "classic.mskill.boss_cleave";
const RUSH = "classic.mskill.boss_rush";
const METEOR = "classic.mskill.boss_meteor";
const FROST_NOVA = "classic.mskill.boss_frost_nova";
const PYRE_RING = "classic.mskill.boss_pyre_ring";
const VOLLEY = "classic.mskill.boss_volley";

const BOSSES: Record<string, MonsterProto> = {
  "classic.monster.boss_warden": boss("boss_warden", {
    name: "Morrow, the Grave Warden",
    family: "undead",
    description: "The keeper of the first crypt, still guarding the dead it was paid to bury.",
    tint: 0xb9c3a0,
    life: 600,
    armor: 20,
    toHit: 40,
    dmgMin: 8,
    dmgMax: 14,
    element: "phys",
    resist: { fire: 0, cold: 30, lightning: 0, poison: 60 },
    xp: 400,
    moveSpeed: 36,
    skills: ["classic.mskill.claw", CLEAVE, QUAKE],
    phases: [
      phase(
        70,
        'Morrow strikes his spade on the flagstones: "Up, my wards. The dead keep their posts."',
        {
          summon: true,
        },
      ),
      phase(35, "Morrow's lantern gutters out, and the Warden stops holding back.", {
        skills: [RUSH],
        summon: true,
        enragePct: 25,
      }),
    ],
    depth: 4,
    title: "the Grave Warden",
    minions: "classic.monster.husk",
    minionCount: 4,
  }),
  "classic.monster.boss_tunnel_mother": boss("boss_tunnel_mother", {
    name: "Skarn, the Tunnel Mother",
    family: "vermin",
    description: "A bloated matriarch that spills her brood out of the dark tunnels.",
    tint: 0x8a5a3a,
    life: 1100,
    armor: 22,
    toHit: 45,
    dmgMin: 10,
    dmgMax: 18,
    element: "phys",
    resist: { fire: 0, cold: 0, lightning: 0, poison: 80 },
    xp: 900,
    moveSpeed: 40,
    skills: ["classic.mskill.gore", RUSH, QUAKE],
    phases: [
      phase(65, "Skarn shrieks and the walls answer: her brood pours out of the tunnels.", {
        summon: true,
      }),
      phase(30, "Skarn tears through her own nest in a blind frenzy.", {
        skills: [CLEAVE],
        summon: true,
        enragePct: 30,
      }),
    ],
    depth: 8,
    title: "the Tunnel Mother",
    minions: "classic.monster.gnawling",
    minionCount: 8,
  }),
  "classic.monster.boss_ninth_flame": boss("boss_ninth_flame", {
    name: "Vessa of the Ninth Flame",
    family: "demon",
    description: "A sorceress who burns with the last of a dead sun, and never sleeps.",
    tint: 0xff7a1a,
    life: 1500,
    armor: 16,
    toHit: 50,
    dmgMin: 12,
    dmgMax: 20,
    element: "fire",
    resist: { fire: 80, cold: 0, lightning: 0, poison: 0 },
    xp: 1600,
    moveSpeed: 38,
    skills: ["classic.mskill.firebolt", VOLLEY, METEOR, PYRE_RING],
    phases: [
      phase(70, "Vessa sings her seers up out of the ash.", { summon: true }),
      phase(40, "The Ninth Flame burns brighter, and the floor begins to smoulder.", {
        skills: [QUAKE],
        enragePct: 20,
      }),
      phase(15, "Vessa becomes a pillar of white fire.", { summon: true, enragePct: 50 }),
    ],
    depth: 12,
    title: "of the Ninth Flame",
    minions: "classic.monster.ash_seer",
    minionCount: 3,
  }),
  "classic.monster.boss_hollow_king": boss("boss_hollow_king", {
    name: "The Hollow King",
    family: "undead",
    description: "A crowned husk ruling the deepest halls, its empty eyes full of rime.",
    tint: 0xc8e6ff,
    life: 2400,
    armor: 30,
    toHit: 55,
    dmgMin: 15,
    dmgMax: 26,
    element: "cold",
    resist: { fire: 0, cold: 75, lightning: 0, poison: 50 },
    xp: 3000,
    moveSpeed: 36,
    skills: ["classic.mskill.claw", CLEAVE, QUAKE, VOLLEY],
    phases: [
      phase(75, "The Hollow King lifts one hand, and his wraiths come to kneel.", {
        summon: true,
      }),
      phase(50, "Frost cracks across the throne room floor.", {
        skills: [FROST_NOVA],
        enragePct: 15,
      }),
      phase(25, "The crown blazes cold: the Hollow King will not fall quietly.", {
        skills: [RUSH],
        summon: true,
        enragePct: 40,
      }),
    ],
    depth: 16,
    title: "the Hollow King",
    minions: "classic.monster.rime_wraith",
    minionCount: 3,
  }),
};

type GuardianBody = Omit<
  Body,
  | "behaviour"
  | "radius"
  | "aggroRange"
  | "packSize"
  | "themes"
  | "minDepth"
  | "weight"
  | "keepDistance"
  | "guardian"
>;

/**
 * Rift guardian (wave A §6.2, §7): behaviour boss with phases, never placed
 * by population or world (themes [], no `boss` block): classic.rift spawns
 * it when the rift's progress bar fills (RiftProto.guardians).
 */
function guardian(key: string, p: GuardianBody): MonsterProto {
  return monster(key, {
    ...p,
    behaviour: "boss",
    radius: 140,
    aggroRange: tiles(14),
    keepDistance: 0,
    packSize: [1, 1],
    themes: [],
    minDepth: 1,
    weight: 1,
    guardian: true,
  });
}

const GUARDIANS: Record<string, MonsterProto> = {
  "classic.monster.guardian_maw": guardian("guardian_maw", {
    name: "The Gnashing Maw",
    family: "aberration",
    description: "A wall of teeth on legs that the Rift grows to guard its heart.",
    tint: 0xa8325e,
    scale: 150,
    life: 2000,
    armor: 26,
    toHit: 55,
    dmgMin: 14,
    dmgMax: 24,
    element: "phys",
    resist: { fire: 20, cold: 20, lightning: 20, poison: 40 },
    xp: 2500,
    moveSpeed: 40,
    skills: ["classic.mskill.claw", CLEAVE, QUAKE],
    phases: [
      phase(60, "The Maw's teeth grind faster, and it lowers its head to charge.", {
        skills: [RUSH],
        enragePct: 20,
      }),
      phase(25, "The Gnashing Maw howls and snaps at everything around it.", { enragePct: 45 }),
    ],
  }),
  "classic.monster.guardian_choir": guardian("guardian_choir", {
    name: "Choir of Cinders",
    family: "spirit",
    description: "A knot of burning voices that sings the Rift shut behind its visitors.",
    tint: 0xffa64d,
    scale: 150,
    life: 1700,
    armor: 18,
    toHit: 55,
    dmgMin: 13,
    dmgMax: 22,
    element: "fire",
    resist: { fire: 60, cold: 20, lightning: 20, poison: 20 },
    xp: 2500,
    moveSpeed: 36,
    skills: ["classic.mskill.firebolt", VOLLEY, FROST_NOVA],
    phases: [
      phase(60, "The Choir's voices rise into a roar of falling embers.", {
        skills: [METEOR],
        enragePct: 20,
      }),
      phase(25, "Every voice of the Choir screams at once.", { enragePct: 45 }),
    ],
  }),
};

export const MONSTERS: Record<string, MonsterProto> = { ...REGULAR, ...BOSSES, ...GUARDIANS };
