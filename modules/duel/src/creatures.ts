/**
 * duel.creatures: the duel data. Four elements with a small effectiveness
 * chart, eleven moves and eight original creatures. All names and designs are
 * original to this game.
 */
import { defineModule, type Registry } from "@gamez/kernel";
import type { CreatureDef, ElementDef, MoveDef } from "./schema.ts";

const ELEMENTS: [string, ElementDef][] = [
  ["ember", { name: "Ember", strong: ["sprout"], weak: ["tide"] }],
  ["sprout", { name: "Sprout", strong: ["tide"], weak: ["ember"] }],
  ["tide", { name: "Tide", strong: ["ember"], weak: ["sprout"] }],
  ["volt", { name: "Volt", strong: ["tide", "sprout"], weak: ["ember"] }],
];

const MOVES: [string, MoveDef][] = [
  [
    "ember-lash",
    { name: "Ember Lash", element: "ember", power: 40, accuracy: 100, pp: 25, drain: 0 },
  ],
  [
    "cinder-burst",
    { name: "Cinder Burst", element: "ember", power: 75, accuracy: 85, pp: 10, drain: 0 },
  ],
  [
    "flare-dash",
    { name: "Flare Dash", element: "ember", power: 55, accuracy: 95, pp: 15, drain: 0 },
  ],
  [
    "leaf-whip",
    { name: "Leaf Whip", element: "sprout", power: 40, accuracy: 100, pp: 25, drain: 0 },
  ],
  [
    "thorn-volley",
    { name: "Thorn Volley", element: "sprout", power: 65, accuracy: 85, pp: 12, drain: 0 },
  ],
  [
    "sap-drain",
    { name: "Sap Drain", element: "sprout", power: 50, accuracy: 95, pp: 12, drain: 50 },
  ],
  ["tidal-jab", { name: "Tidal Jab", element: "tide", power: 40, accuracy: 100, pp: 25, drain: 0 }],
  ["undertow", { name: "Undertow", element: "tide", power: 70, accuracy: 80, pp: 10, drain: 0 }],
  [
    "splash-quick",
    { name: "Splash Quick", element: "tide", power: 30, accuracy: 100, pp: 30, drain: 0 },
  ],
  [
    "static-nip",
    { name: "Static Nip", element: "volt", power: 35, accuracy: 100, pp: 25, drain: 0 },
  ],
  ["bolt-drive", { name: "Bolt Drive", element: "volt", power: 80, accuracy: 75, pp: 8, drain: 0 }],
];

const CREATURES: [string, CreatureDef][] = [
  [
    "cindrel",
    {
      name: "Cindrel",
      blurb: "A quick ember fox that sheds sparks when it runs.",
      element: "ember",
      stats: { hp: 42, atk: 40, def: 30, spd: 44 },
      moves: ["ember-lash", "cinder-burst", "flare-dash", "static-nip"],
      captureRate: 60,
    },
  ],
  [
    "scorchug",
    {
      name: "Scorchug",
      blurb: "A slow, armoured grub with a warm, glowing belly.",
      element: "ember",
      stats: { hp: 52, atk: 46, def: 38, spd: 24 },
      moves: ["ember-lash", "cinder-burst", "flare-dash", "undertow"],
      captureRate: 45,
    },
  ],
  [
    "mossbud",
    {
      name: "Mossbud",
      blurb: "A shy bud creature that hides in the shade of ferns.",
      element: "sprout",
      stats: { hp: 40, atk: 30, def: 36, spd: 36 },
      moves: ["leaf-whip", "sap-drain", "ember-lash", "splash-quick"],
      captureRate: 120,
    },
  ],
  [
    "thornwick",
    {
      name: "Thornwick",
      blurb: "A prickly hedgehog-like sprout that fires its quills.",
      element: "sprout",
      stats: { hp: 46, atk: 44, def: 40, spd: 28 },
      moves: ["thorn-volley", "leaf-whip", "sap-drain", "undertow"],
      captureRate: 70,
    },
  ],
  [
    "pearlet",
    {
      name: "Pearlet",
      blurb: "A calm shell-backed creature that rolls over rocks.",
      element: "tide",
      stats: { hp: 50, atk: 28, def: 48, spd: 22 },
      moves: ["tidal-jab", "splash-quick", "undertow", "leaf-whip"],
      captureRate: 90,
    },
  ],
  [
    "brinepaw",
    {
      name: "Brinepaw",
      blurb: "A playful otter-like swimmer with very fast paws.",
      element: "tide",
      stats: { hp: 36, atk: 42, def: 26, spd: 50 },
      moves: ["tidal-jab", "splash-quick", "static-nip", "undertow"],
      captureRate: 80,
    },
  ],
  [
    "zapwing",
    {
      name: "Zapwing",
      blurb: "A small bird whose feathers crackle before a storm.",
      element: "volt",
      stats: { hp: 34, atk: 38, def: 24, spd: 56 },
      moves: ["static-nip", "bolt-drive", "tidal-jab", "leaf-whip"],
      captureRate: 55,
    },
  ],
  [
    "voltmite",
    {
      name: "Voltmite",
      blurb: "A stocky beetle that stores charge in its shell.",
      element: "volt",
      stats: { hp: 44, atk: 46, def: 34, spd: 40 },
      moves: ["bolt-drive", "static-nip", "thorn-volley", "cinder-burst"],
      captureRate: 35,
    },
  ],
];

export default defineModule({
  id: "duel.creatures",
  version: "1.0.0",
  data(reg: Registry) {
    for (const [id, proto] of ELEMENTS) reg.define("duel.element", id, proto);
    for (const [id, proto] of MOVES) reg.define("duel.move", id, proto);
    for (const [id, proto] of CREATURES) reg.define("duel.creature", id, proto);
  },
  /** Cross-references are checked once every stage has run, so a typo fails at load. */
  dataFinal(reg: Registry) {
    for (const [id, el] of reg.all<ElementDef>("duel.element")) {
      for (const other of [...el.strong, ...el.weak]) {
        if (!reg.has("duel.element", other)) throw new Error(`element ${id}: unknown ${other}`);
      }
      if (el.strong.some((x) => el.weak.includes(x))) {
        throw new Error(`element ${id}: strong and weak overlap`);
      }
    }
    for (const [id, move] of reg.all<MoveDef>("duel.move")) {
      if (!reg.has("duel.element", move.element)) throw new Error(`move ${id}: bad element`);
    }
    for (const [id, c] of reg.all<CreatureDef>("duel.creature")) {
      if (!reg.has("duel.element", c.element)) throw new Error(`creature ${id}: bad element`);
      if (c.moves.length !== 4 || new Set(c.moves).size !== 4) {
        throw new Error(`creature ${id}: needs four distinct moves`);
      }
      for (const m of c.moves) {
        if (!reg.has("duel.move", m)) throw new Error(`creature ${id}: unknown move ${m}`);
      }
      if (!Number.isInteger(c.captureRate) || c.captureRate < 1 || c.captureRate > 255) {
        throw new Error(`creature ${id}: captureRate must be 1..255`);
      }
    }
  },
});
