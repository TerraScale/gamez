/**
 * Synthesised one-shot sounds (recipes). Each recipe schedules a few tones and
 * noise bursts on a Voice; levels are relative (the cue sets the voice gain).
 * Client only. Names describe the sound, not the event.
 */
import type { Element } from "../../types.ts";
import type { Voice } from "./engine.ts";

export type Recipe = (v: Voice) => void;

// ---- combat impacts ---------------------------------------------------------

export function hitPhys(v: Voice): void {
  v.noise({ filter: "lowpass", f0: 900, f1: 200, dur: 0.09, vol: 0.5 });
  v.tone({ wave: "sine", f0: 140, f1: 60, dur: 0.12, vol: 0.35 });
}

export function hitFire(v: Voice): void {
  v.noise({ filter: "bandpass", f0: 400, f1: 2200, dur: 0.22, vol: 0.3, q: 1.2 });
  for (const at of [0.02, 0.05, 0.09]) {
    v.noise({ at, filter: "highpass", f0: 3000, dur: 0.02, vol: 0.22 });
  }
}

export function hitCold(v: Voice): void {
  v.tone({ wave: "sine", f0: 1800, f1: 1500, dur: 0.35, vol: 0.18 });
  v.tone({ wave: "sine", f0: 2700, dur: 0.25, vol: 0.08, at: 0.005 });
  v.noise({ filter: "highpass", f0: 6000, dur: 0.03, vol: 0.12 });
}

export function hitLightning(v: Voice): void {
  v.tone({ wave: "square", f0: 1200, f1: 200, dur: 0.14, vol: 0.12, lp: 3000 });
  v.noise({ filter: "highpass", f0: 4000, dur: 0.06, vol: 0.2 });
}

export function hitPoison(v: Voice): void {
  v.tone({ wave: "sine", f0: 300, f1: 600, dur: 0.12, vol: 0.14 });
  v.tone({ wave: "sine", f0: 500, f1: 900, dur: 0.05, at: 0.04, vol: 0.14 });
}

const HIT: Record<Element, Recipe> = {
  phys: hitPhys,
  fire: hitFire,
  cold: hitCold,
  lightning: hitLightning,
  poison: hitPoison,
};

export function hitRecipe(element: Element): Recipe {
  return HIT[element] ?? hitPhys;
}

/** Extra low thump layered on a critical hit. */
export function critThump(v: Voice): void {
  v.tone({ wave: "sine", f0: 80, f1: 40, dur: 0.18, vol: 0.4 });
}

export function heroHurt(v: Voice): void {
  v.tone({ wave: "sawtooth", f0: 260, f1: 130, dur: 0.22, vol: 0.2, lp: 1200 });
  v.noise({ filter: "lowpass", f0: 500, dur: 0.15, vol: 0.2 });
}

export function swish(v: Voice): void {
  v.noise({ filter: "bandpass", f0: 1400, f1: 2600, dur: 0.12, vol: 0.12 });
}

// ---- deaths -----------------------------------------------------------------

export function deathNormal(v: Voice): void {
  v.tone({ wave: "triangle", f0: 300, f1: 90, dur: 0.18, vol: 0.25 });
  v.noise({ filter: "lowpass", f0: 700, dur: 0.08, vol: 0.15 });
}

export function deathHeavy(v: Voice): void {
  v.tone({ wave: "sine", f0: 160, f1: 40, dur: 0.6, vol: 0.45 });
  v.noise({ filter: "lowpass", f0: 400, dur: 0.3, vol: 0.3 });
  v.tone({ wave: "square", f0: 90, f1: 45, dur: 0.5, at: 0.05, vol: 0.15, lp: 400 });
}

export function deathBoss(v: Voice): void {
  deathHeavy(v);
  v.tone({ wave: "sawtooth", f0: 220, f1: 55, dur: 1.4, at: 0.1, vol: 0.12, lp: 700 });
}

export function heroDeath(v: Voice): void {
  v.tone({ wave: "sawtooth", f0: 440, f1: 110, dur: 1.1, vol: 0.25, lp: 1000 });
  v.tone({ wave: "sine", f0: 220, f1: 55, dur: 1.4, vol: 0.3 });
}

// ---- casts ------------------------------------------------------------------

export function castSwing(v: Voice): void {
  v.noise({ filter: "bandpass", f0: 900, f1: 2400, dur: 0.15, vol: 0.25 });
  v.tone({ wave: "triangle", f0: 500, f1: 250, dur: 0.1, vol: 0.08 });
}

export function castArc(v: Voice): void {
  v.noise({ filter: "bandpass", f0: 600, f1: 2000, dur: 0.22, vol: 0.3 });
}

export function castDash(v: Voice): void {
  v.noise({ filter: "lowpass", f0: 300, f1: 1400, dur: 0.3, vol: 0.25 });
}

export function castPulse(v: Voice): void {
  v.noise({ filter: "bandpass", f0: 400, f1: 1200, dur: 0.3, vol: 0.2 });
  v.tone({ wave: "triangle", f0: 300, dur: 0.3, vol: 0.08, fm: { ratio: 2.5, depth: 120 } });
}

export function castBow(v: Voice): void {
  v.tone({ wave: "triangle", f0: 220, f1: 110, dur: 0.08, vol: 0.3 });
  v.noise({ filter: "highpass", f0: 3000, dur: 0.03, vol: 0.1 });
}

/** Spell charge; `release` adds the launch whoosh for projectile spells. */
export function spellCharge(element: Element, release: boolean): Recipe {
  return (v: Voice) => {
    switch (element) {
      case "fire":
        v.tone({ wave: "sawtooth", f0: 180, f1: 520, dur: 0.35, vol: 0.12, lp: 1400 });
        v.noise({ filter: "bandpass", f0: 900, dur: 0.3, vol: 0.08 });
        break;
      case "cold":
        v.tone({ wave: "sine", f0: 900, f1: 1800, dur: 0.35, vol: 0.1 });
        v.tone({ wave: "sine", f0: 1350, dur: 0.3, at: 0.05, vol: 0.06 });
        break;
      case "lightning":
        v.tone({
          wave: "square",
          f0: 150,
          f1: 900,
          dur: 0.25,
          vol: 0.08,
          fm: { ratio: 3, depth: 300 },
        });
        v.noise({ at: 0.2, filter: "highpass", f0: 3000, dur: 0.04, vol: 0.12 });
        break;
      case "poison":
        v.tone({ wave: "sine", f0: 120, f1: 240, dur: 0.3, vol: 0.12 });
        v.tone({ wave: "sine", f0: 500, f1: 800, dur: 0.05, at: 0.15, vol: 0.1 });
        break;
      default:
        v.tone({ wave: "triangle", f0: 200, f1: 400, dur: 0.25, vol: 0.12 });
        break;
    }
    if (release)
      v.noise({ at: 0.25, filter: "bandpass", f0: 1500, f1: 3500, dur: 0.12, vol: 0.14 });
  };
}

export function castHeal(v: Voice): void {
  v.tone({ wave: "sine", f0: 523, f1: 784, dur: 0.4, vol: 0.12 });
  v.tone({ wave: "sine", f0: 659, dur: 0.3, at: 0.1, vol: 0.08 });
}

export function castBuff(v: Voice): void {
  v.tone({ wave: "triangle", f0: 392, f1: 784, dur: 0.3, vol: 0.12 });
  v.tone({ wave: "triangle", f0: 587, dur: 0.3, at: 0.08, vol: 0.09 });
}

export function castSummon(v: Voice): void {
  v.tone({ wave: "triangle", f0: 110, f1: 220, dur: 0.4, vol: 0.18, fm: { ratio: 2, depth: 60 } });
}

export function blinkWhoosh(v: Voice): void {
  v.noise({ filter: "highpass", f0: 800, f1: 4000, dur: 0.18, vol: 0.25 });
  v.tone({ wave: "sine", f0: 900, f1: 300, dur: 0.15, vol: 0.1 });
}

// ---- area effects -----------------------------------------------------------

/** Nova / explosion boom; `scale` 1 = normal radius. */
export function boom(scale: number): Recipe {
  const k = Math.min(1.6, Math.max(0.6, scale));
  return (v: Voice) => {
    v.noise({ filter: "lowpass", f0: 1200, f1: 120, dur: 0.5, vol: 0.5 * k });
    v.tone({ wave: "sine", f0: 110, f1: 35, dur: 0.6, vol: 0.5 * k });
  };
}

export function freezeRing(v: Voice): void {
  v.noise({ filter: "highpass", f0: 2500, dur: 0.3, vol: 0.22 });
  v.tone({ wave: "sine", f0: 1400, f1: 600, dur: 0.4, vol: 0.18 });
}

export function chainZap(v: Voice): void {
  v.tone({ wave: "square", f0: 1400, f1: 300, dur: 0.12, vol: 0.12, lp: 4000 });
  v.noise({ filter: "highpass", f0: 5000, dur: 0.05, vol: 0.15 });
  v.tone({ wave: "square", f0: 1100, f1: 250, dur: 0.1, at: 0.06, vol: 0.08, lp: 3000 });
}

/** Warning that rises for the telegraph's lifetime (seconds). */
export function telegraphWarn(seconds: number): Recipe {
  const dur = Math.min(1.5, Math.max(0.3, seconds));
  return (v: Voice) => {
    v.tone({ wave: "sine", f0: 220, f1: 660, dur, vol: 0.14 });
    v.tone({ wave: "square", f0: 880, dur: 0.05, at: dur - 0.06, vol: 0.06, lp: 2000 });
  };
}

export function bossSting(scale: number): Recipe {
  const k = Math.min(1.4, Math.max(0.6, scale));
  return (v: Voice) => {
    v.tone({ wave: "sawtooth", f0: 110, f1: 55, dur: 1.2, vol: 0.3 * k, lp: 900 });
    v.tone({ wave: "square", f0: 330, f1: 220, dur: 0.6, at: 0.2, vol: 0.1 * k });
  };
}

export function portalHum(v: Voice): void {
  v.tone({ wave: "sine", f0: 110, f1: 330, dur: 1.4, vol: 0.14, fm: { ratio: 1.5, depth: 40 } });
}

export function whoosh(v: Voice): void {
  v.noise({ filter: "bandpass", f0: 300, f1: 1200, dur: 0.6, vol: 0.3 });
  v.tone({ wave: "sine", f0: 200, f1: 100, dur: 0.6, vol: 0.08 });
}

// ---- loot, gold, potions, items ---------------------------------------------

export function coins(v: Voice): void {
  v.tone({ wave: "square", f0: 1800, dur: 0.05, vol: 0.08, lp: 5000 });
  v.tone({ wave: "square", f0: 2400, dur: 0.08, at: 0.05, vol: 0.08, lp: 5000 });
  v.tone({ wave: "square", f0: 2900, dur: 0.1, at: 0.1, vol: 0.08, lp: 5000 });
}

export function coinsDown(v: Voice): void {
  v.tone({ wave: "square", f0: 2900, dur: 0.05, vol: 0.07, lp: 5000 });
  v.tone({ wave: "square", f0: 2100, dur: 0.1, at: 0.05, vol: 0.07, lp: 5000 });
}

export function tick(v: Voice): void {
  v.tone({ wave: "sine", f0: 1100, dur: 0.05, vol: 0.08 });
}

export function click(v: Voice): void {
  v.tone({ wave: "square", f0: 1500, dur: 0.03, vol: 0.07, lp: 4000 });
  v.noise({ filter: "highpass", f0: 3000, dur: 0.01, vol: 0.1 });
}

export function clink(v: Voice): void {
  v.tone({ wave: "triangle", f0: 1800, dur: 0.08, vol: 0.1 });
  v.tone({ wave: "triangle", f0: 2700, dur: 0.06, at: 0.01, vol: 0.06 });
}

export function chime(base: number): Recipe {
  return (v: Voice) => {
    v.tone({ wave: "sine", f0: base, dur: 0.4, vol: 0.12 });
    v.tone({ wave: "sine", f0: base * 1.5, dur: 0.35, at: 0.06, vol: 0.07 });
  };
}

export function magicChime(v: Voice): void {
  v.tone({ wave: "sine", f0: 880, dur: 0.3, vol: 0.1 });
  v.tone({ wave: "sine", f0: 1320, dur: 0.3, at: 0.08, vol: 0.08 });
}

export function rareArpeggio(v: Voice): void {
  [660, 830, 990].forEach((f0, i) => {
    v.tone({ wave: "triangle", f0, dur: 0.2, at: i * 0.09, vol: 0.13 });
  });
}

export function fanfare(v: Voice): void {
  [523, 659, 784, 1046].forEach((f0, i) => {
    v.tone({ wave: "triangle", f0, dur: 0.2, at: i * 0.11, vol: 0.14 });
  });
  v.tone({ wave: "sine", f0: 523, dur: 0.9, at: 0.45, vol: 0.12 });
  v.tone({ wave: "sine", f0: 784, dur: 0.9, at: 0.45, vol: 0.1 });
}

export function levelUp(v: Voice): void {
  [523, 659, 784, 1046, 1318].forEach((f0, i) => {
    v.tone({ wave: "triangle", f0, dur: 0.2, at: i * 0.09, vol: 0.15 });
  });
}

export function error(v: Voice): void {
  v.tone({ wave: "square", f0: 150, dur: 0.15, vol: 0.1, lp: 600 });
  v.tone({ wave: "square", f0: 140, dur: 0.15, at: 0.18, vol: 0.1, lp: 600 });
}

export function gulp(kind: "life" | "mana" | "rejuv"): Recipe {
  return (v: Voice) => {
    if (kind !== "mana") {
      v.tone({ wave: "sine", f0: 220, f1: 330, dur: 0.25, vol: 0.2, lp: 800 });
      v.noise({ at: 0.05, filter: "lowpass", f0: 500, dur: 0.1, vol: 0.12 });
    }
    if (kind !== "life") {
      v.tone({
        wave: "sine",
        f0: 440,
        f1: 660,
        dur: 0.3,
        at: kind === "mana" ? 0 : 0.12,
        vol: 0.12,
      });
    }
  };
}

export function crack(v: Voice): void {
  v.noise({ filter: "highpass", f0: 2000, dur: 0.05, vol: 0.4 });
  v.noise({ at: 0.05, filter: "bandpass", f0: 800, dur: 0.18, vol: 0.3 });
  v.tone({ wave: "square", f0: 400, f1: 120, dur: 0.18, vol: 0.1 });
}

export function wornWarn(v: Voice): void {
  v.tone({ wave: "square", f0: 800, dur: 0.06, vol: 0.08 });
  v.tone({ wave: "square", f0: 600, dur: 0.06, at: 0.08, vol: 0.08 });
}

export function rattle(v: Voice): void {
  for (const at of [0, 0.03, 0.06, 0.09]) {
    v.noise({ at, filter: "highpass", f0: 3000, dur: 0.02, vol: 0.15 });
  }
}

export function hammer(v: Voice): void {
  for (const at of [0, 0.12]) {
    v.noise({ at, filter: "bandpass", f0: 1200, q: 4, dur: 0.05, vol: 0.4 });
    v.tone({ wave: "triangle", f0: 500, dur: 0.06, at: at + 0.02, vol: 0.15 });
  }
}

export function sparkle(v: Voice): void {
  v.tone({ wave: "sine", f0: 1200, dur: 0.18, vol: 0.08 });
  v.tone({ wave: "sine", f0: 1600, dur: 0.18, at: 0.05, vol: 0.08 });
  v.tone({ wave: "sine", f0: 2000, dur: 0.18, at: 0.1, vol: 0.08 });
}

export function thunk(v: Voice): void {
  v.tone({ wave: "sine", f0: 160, f1: 60, dur: 0.3, vol: 0.35 });
  v.noise({ filter: "lowpass", f0: 400, dur: 0.15, vol: 0.2 });
}

export function gemChime(v: Voice): void {
  v.tone({ wave: "sine", f0: 2093, dur: 0.6, vol: 0.08 });
  v.tone({ wave: "sine", f0: 3136, dur: 0.5, at: 0.04, vol: 0.05 });
}

export function tap(v: Voice): void {
  v.noise({ filter: "bandpass", f0: 2000, dur: 0.02, vol: 0.3 });
  v.tone({ wave: "triangle", f0: 900, dur: 0.04, vol: 0.12 });
}

export function sigh(v: Voice): void {
  v.noise({ filter: "lowpass", f0: 900, f1: 300, dur: 0.45, vol: 0.2 });
}

export function riftFail(v: Voice): void {
  v.tone({ wave: "sawtooth", f0: 300, f1: 90, dur: 0.9, vol: 0.2, lp: 900 });
}
