/**
 * Arena balance matrix (ADR 0006 §13, docs/bench/2026-10-arena-balance.md).
 *
 * Builds archetypes from real classic heroes (new hero per class, mapped with
 * classicArenaBuild), then fights every ordered pair over N seeds with the
 * same fight() the server and the client replay use. Prints a markdown table:
 * the row build's win rate when it attacks the column build.
 *
 *   node --experimental-transform-types src/arena-balance.ts [seeds=300]
 *
 * Deterministic: the same seeds give the same table. Not sim code.
 */
import { createSim, loadMode, type LoadedMode } from "@gamez/kernel";
import { fight } from "@gamez/mode-arena";
import {
  classicArenaBuild,
  KIND,
  mode as classicMode,
  modules as classicModules,
  type ClassicArenaBuild,
  type SkillProto,
} from "@gamez/mode-classic";
/** The ArenaBuild that fight() takes (protocol type, read from the arena's own signature). */
type ArenaBuild = Parameters<typeof fight>[0];
type ArenaSkill = ArenaBuild["skills"][number];

const SEEDS = Number(process.argv[2] ?? 300);
const loaded: LoadedMode = loadMode(classicMode, classicModules);

/** A new hero of a class, mapped to its arena build (real classic numbers). */
function heroBuild(classId: string): ClassicArenaBuild {
  const sim = createSim(loaded, { seed: 2026 });
  const res = sim.dispatch("classic.newHero", { classId, name: "Tester" }, null);
  if (!res.ok) throw new Error(`newHero ${classId}: ${res.error?.code}`);
  sim.step(1);
  const b = classicArenaBuild(sim.world, loaded.registry);
  if (!b) throw new Error(`no build for ${classId}`);
  return b;
}

/** Mend as the arena sees it at rank 1 (classic heal 20 %, cooldown 200 -> 100 arena ticks). */
function mendSkill(): ArenaSkill {
  const p = loaded.registry.get<SkillProto>(KIND.skill, "classic.skill.mend");
  if (!p?.heal) throw new Error("classic.skill.mend has no heal");
  return {
    id: "classic.skill.mend",
    name: p.name.slice(0, 40),
    kind: "heal",
    power: p.heal.pct,
    cooldown: Math.max(10, Math.ceil(p.cooldown / 2)),
    range: 0,
  };
}

interface Arch {
  key: string;
  build: ArenaBuild;
}

function withIdentity(b: ClassicArenaBuild, key: string): ArenaBuild {
  return { ...b, accountId: key, displayName: key, sourceHash: "bench" };
}

/** Three classes x (plain, class bar, class bar + Mend). */
function archetypes(): Arch[] {
  const out: Arch[] = [];
  for (const classId of ["classic.warrior", "classic.rogue", "classic.sorcerer"]) {
    const base = heroBuild(classId);
    const short = classId.replace("classic.", "");
    const bar = base.skills;
    const plain = { ...base, skills: [] as ArenaSkill[] };
    const mend = { ...base, skills: [...bar.filter((s) => s.kind !== "heal"), mendSkill()] };
    out.push({ key: `${short}-plain`, build: withIdentity(plain, `${short}-plain`) });
    out.push({ key: `${short}-bar`, build: withIdentity(base, `${short}-bar`) });
    out.push({ key: `${short}-mend`, build: withIdentity(mend, `${short}-mend`) });
  }
  return out;
}

const archs = archetypes();
const n = archs.length;
/** wins[i][j]: i attacks j, i wins (attacker or defender side as the fight decides). */
const wins: number[][] = Array.from({ length: n }, () => Array<number>(n).fill(0));
const draws: number[][] = Array.from({ length: n }, () => Array<number>(n).fill(0));

for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = fight(archs[i]!.build, archs[j]!.build, seed);
      if (r.winner === "attacker") wins[i]![j]! += 1;
      else if (r.winner === "draw") draws[i]![j]! += 1;
    }
  }
}

const pct = (v: number) => `${((100 * v) / SEEDS).toFixed(0)}`;
const header = ["attacker \\ defender", ...archs.map((a) => a.key)];
const lines: string[] = [];
lines.push(
  `Seeds per pair: ${SEEDS} (seeds 1..${SEEDS}). Cell = % of fights the row build wins when it attacks the column build (draws count for neither).`,
);
lines.push("");
lines.push(`| ${header.join(" | ")} |`);
lines.push(`|${header.map(() => "---").join("|")}|`);
for (let i = 0; i < n; i++) {
  const cells = archs.map((_, j) => pct(wins[i]![j]!));
  lines.push(`| ${archs[i]!.key} | ${cells.join(" | ")} |`);
}
lines.push("");
lines.push("Overall win rate per build (both sides, every opponent, incl. mirror; draws = half):");
lines.push("");
lines.push("| build | as attacker win % | as defender win % | overall % | draw % |");
lines.push("|---|---|---|---|---|");
for (let i = 0; i < n; i++) {
  let asAtk = 0;
  let defWins = 0;
  let draw = 0;
  for (let j = 0; j < n; j++) {
    asAtk += wins[i]![j]!;
    draw += draws[i]![j]!;
    // j attacks i: i wins as defender when j neither wins nor draws.
    defWins += SEEDS - wins[j]![i]! - draws[j]![i]!;
    draw += draws[j]![i]!;
  }
  const games = n * SEEDS;
  const atkRate = (100 * asAtk) / games;
  const defRate = (100 * defWins) / games;
  const overall = (100 * (asAtk + defWins)) / (2 * games);
  const drawRate = (100 * draw) / (2 * games);
  lines.push(
    `| ${archs[i]!.key} | ${atkRate.toFixed(1)} | ${defRate.toFixed(1)} | ${overall.toFixed(1)} | ${drawRate.toFixed(1)} |`,
  );
}

console.log(lines.join("\n"));
