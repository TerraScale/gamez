/**
 * Classic audio (wave A, T-audio): event -> sound table, the WebAudio engine
 * (through an injected fake AudioContext: no real audio), voice cap, rate
 * limits, settings -> gains, music crossfade and boss duck, destroy/unlock.
 */
import type { FrozenRegistry, GameEvent } from "@gamez/kernel";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ClassicEventType } from "../src/events.ts";
import { KIND } from "../src/types.ts";
import { SKILLS } from "../src/content/skills.ts";
import { SUB } from "../src/fixed.ts";
import type { Settings } from "../src/client/contract.ts";
import { DEFAULT_SETTINGS } from "../src/client/persist.ts";
import {
  BATCH_CAP,
  createAudio,
  HEAR_RANGE_TILES,
  type AudioFrame,
  type ClassicAudio,
} from "../src/client/audio/index.ts";
import { cueFor, mappedEventTypes, type CueEnv } from "../src/client/audio/cues.ts";
import { MAX_VOICES } from "../src/client/audio/engine.ts";
import {
  CROSSFADE_SEC,
  degreeMidi,
  midiHz,
  THEMES,
  themeForArea,
} from "../src/client/audio/music.ts";

// ---- fake WebAudio ----------------------------------------------------------

class FakeParam {
  value = 0;
  ops: string[] = [];
  target: { value: number; when: number; tc: number } | null = null;
  setValueAtTime(v: number, t: number) {
    this.value = v;
    this.ops.push(`set:${v}@${t}`);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.value = v;
    this.ops.push(`lin:${v}@${t}`);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.value = v;
    this.ops.push(`exp:${v}@${t}`);
    return this;
  }
  setTargetAtTime(v: number, t: number, tc: number) {
    this.value = v;
    this.target = { value: v, when: t, tc };
    this.ops.push(`target:${v}@${t}`);
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class FakeNode {
  readonly links: unknown[] = [];
  disconnected = false;
  connect(dest: unknown) {
    this.links.push(dest);
    return dest;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeOsc extends FakeNode {
  type = "sine";
  readonly frequency = new FakeParam();
  readonly detune = new FakeParam();
  started: number | null = null;
  stopped: number | null = null;
  start(t = 0) {
    this.started = t;
  }
  stop(t = 0) {
    this.stopped = t;
  }
}

class FakeFilter extends FakeNode {
  type = "lowpass";
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

class FakePanner extends FakeNode {
  readonly pan = new FakeParam();
}

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
}

class FakeContext {
  currentTime = 0;
  state = "suspended";
  sampleRate = 8000;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly oscs: FakeOsc[] = [];
  readonly filters: FakeFilter[] = [];
  readonly sources: FakeSource[] = [];
  resumes = 0;
  closed = false;
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createOscillator() {
    const o = new FakeOsc();
    this.oscs.push(o);
    return o;
  }
  createBiquadFilter() {
    const f = new FakeFilter();
    this.filters.push(f);
    return f;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createBuffer(_ch: number, length: number) {
    return { length, getChannelData: () => new Float32Array(length) };
  }
  createDynamicsCompressor() {
    return new FakeCompressor();
  }
  createStereoPanner() {
    return new FakePanner();
  }
  resume() {
    this.resumes++;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
}

/** Gesture target that records listeners. */
class FakeTarget {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

// ---- helpers ----------------------------------------------------------------

/** The real skill table as a registry (the only kind the cue table reads). */
const registry = {
  get: (kind: string, id: string) => (kind === KIND.skill ? SKILLS[id] : undefined),
  has: () => false,
  require: () => {
    throw new Error("not used");
  },
  all: () => [],
  kinds: () => [],
  hash: "test",
} as unknown as FrozenRegistry;

const ENV: CueEnv = { registry, hero: 1 };

const FRAME: AudioFrame = { hero: 1, heroX: 10, heroY: 10, speed: 1 };

/** Every classic event type (typed: a new event type fails to compile here). */
const ALL_TYPES: Record<ClassicEventType, true> = {
  "classic.hit": true,
  "classic.miss": true,
  "classic.cast": true,
  "classic.cast.failed": true,
  "classic.effect": true,
  "classic.status": true,
  "classic.death": true,
  "classic.heal": true,
  "classic.xp": true,
  "classic.levelUp": true,
  "classic.statAllocated": true,
  "classic.skillLearned": true,
  "classic.hero.created": true,
  "classic.hero.died": true,
  "classic.hero.respawned": true,
  "classic.quest.accepted": true,
  "classic.quest.progress": true,
  "classic.quest.done": true,
  "classic.quest.completed": true,
  "classic.loot.dropped": true,
  "classic.loot.picked": true,
  "classic.gold": true,
  "classic.potion": true,
  "classic.item.equipped": true,
  "classic.item.unequipped": true,
  "classic.vendor.bought": true,
  "classic.vendor.sold": true,
  "classic.bag.full": true,
  "classic.area.changed": true,
  "classic.level.cleared": true,
  "classic.boss.spawned": true,
  "classic.boss.killed": true,
  "classic.waypoint.unlocked": true,
  "classic.portal.opened": true,
  "classic.npc.opened": true,
  "classic.stash.opened": true,
  "classic.waypoint.opened": true,
  "classic.control": true,
  "classic.auto.plan": true,
  "classic.auto.notice": true,
  "classic.offline.summary": true,
  "classic.command.failed": true,
  "classic.telegraph": true,
  "classic.boss.phase": true,
  "classic.item.broken": true,
  "classic.item.worn": true,
  "classic.gambled": true,
  "classic.set.bonus": true,
  "classic.stash.moved": true,
  "classic.lootFilter.changed": true,
  "classic.repaired": true,
  "classic.upgraded": true,
  "classic.rerolled": true,
  "classic.socket.added": true,
  "classic.gem.socketed": true,
  "classic.gems.removed": true,
  "classic.gems.combined": true,
  "classic.talent.points": true,
  "classic.talent.learned": true,
  "classic.talents.reset": true,
  "classic.rift.panel": true,
  "classic.rift.unlocked": true,
  "classic.rift.opened": true,
  "classic.rift.progress": true,
  "classic.rift.guardian": true,
  "classic.rift.completed": true,
  "classic.rift.failed": true,
  "classic.achievement.unlocked": true,
};

/** Events that are deliberately silent (null in the table). */
const SILENT: ClassicEventType[] = [
  "classic.cast.failed",
  "classic.status",
  "classic.xp",
  "classic.hero.died",
  "classic.quest.progress",
  "classic.item.unequipped",
  "classic.control",
  "classic.auto.plan",
  "classic.auto.notice",
];

/** A payload with the fields the table reads (plausible values, not a real event). */
function sample(type: string): GameEvent {
  return {
    type,
    source: 2,
    target: 1,
    caster: 2,
    entity: 3,
    killer: 2,
    hero: 1,
    skill: "classic.skill.ember_bolt",
    amount: 9,
    element: "fire",
    crit: true,
    dot: false,
    heroHit: false,
    byHero: false,
    x: 12 * SUB,
    y: 11 * SUB,
    tx: 12 * SUB,
    ty: 11 * SUB,
    blocked: false,
    effect: "fx.frost_ring",
    radius: 300,
    points: [
      { x: 1 * SUB, y: 1 * SUB },
      { x: 2 * SUB, y: 2 * SUB },
    ],
    isHero: false,
    rarity: "boss",
    monster: "classic.monster.bonewarden",
    name: "Sample",
    kind: "item",
    depth: 3,
    theme: "classic.theme.crypt",
    via: "stairs",
    ticks: 40,
    fireAt: 60,
    shape: "circle",
    phase: 2,
    enraged: true,
    success: true,
    active: 2,
    pieces: 2,
    gold: 5,
    xp: 5,
    total: 10,
    reason: "test",
    ms: 1000,
    uid: 7,
    tab: 1,
    uids: [7, 8],
    slot: "weapon",
    level: 3,
    cost: 4,
    price: 4,
    npc: "classic.npc.smith",
    proto: "classic.npc.smith",
    role: "smith",
    node: "classic.talent.warrior.cleave",
    rank: 1,
    refunded: 1,
    record: { depth: 100003, level: 3, run: 1, score: 10, outcome: "completed" },
    fee: 2,
    run: 1,
    pct: 50,
    attr: "str",
    statPoints: 1,
    skillPoints: 1,
    mode: "idle",
    speed: 1,
    plan: "descend",
    note: "note",
    code: "stash_full",
    message: "msg",
    op: "buy",
    status: "slow",
    until: 100,
    progress: 1,
    count: 2,
    quest: "classic.quest.first",
    classId: "classic.warrior",
    gems: ["classic.gem.ruby"],
    gem: "classic.gem.ruby",
    from: "classic.gem.ruby",
    to: "classic.gem.topaz",
    set: "classic.set.wolf",
    lifeBefore: 1,
    lifeAfter: 2,
    manaBefore: 1,
    manaAfter: 2,
    base: "classic.item.potion",
    goldLost: 1,
    xpLost: 1,
    kills: 1,
    items: 1,
    levels: 1,
    id: "classic.achievement.first",
    title: null,
  };
}

function frameAt(over: Partial<AudioFrame> = {}): AudioFrame {
  return { ...FRAME, ...over };
}

const made: ClassicAudio[] = [];

function setup(opts: { settings?: Settings; clock?: () => number; withTarget?: boolean } = {}): {
  audio: ClassicAudio;
  ctx: FakeContext;
  target: FakeTarget;
  clock: { now: number };
} {
  const ctx = new FakeContext();
  const target = new FakeTarget();
  const clock = { now: 0 };
  const audio = createAudio({
    registry,
    settings: opts.settings ?? { ...DEFAULT_SETTINGS },
    context: () => ctx as never,
    target: opts.withTarget === false ? null : (target as never),
    clock: opts.clock ?? (() => clock.now),
  });
  made.push(audio);
  return { audio, ctx, target, clock };
}

function allEvents(): GameEvent[] {
  return Object.keys(ALL_TYPES).map((t) => sample(t));
}

/** Classic hits in a row with one positional offset (distinct keys via crit toggling). */
function hitEvents(n: number, overrides: Record<string, unknown> = {}): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      type: "classic.hit",
      source: 2,
      target: 3,
      skill: "classic.skill.attack",
      amount: 3,
      element: "phys",
      crit: false,
      dot: false,
      heroHit: false,
      byHero: true,
      x: 11 * SUB,
      y: 10 * SUB,
      ...overrides,
    });
  }
  return out;
}

function cleanup(): void {
  for (const a of made.splice(0)) a.destroy();
}

afterEach(cleanup);

// ---- tests --------------------------------------------------------------------

describe("classic audio: event table", () => {
  it("every event type is listed exactly once and mapped", () => {
    expect(mappedEventTypes()).toEqual(Object.keys(ALL_TYPES).sort());
  });

  it("every type gives a cue or an explicit silent (no throw, sample payloads)", () => {
    for (const type of Object.keys(ALL_TYPES)) {
      const cue = cueFor(sample(type), ENV);
      if ((SILENT as string[]).includes(type)) {
        expect(cue, type).toBeNull();
      } else if (cue !== null) {
        expect(cue.key.length, type).toBeGreaterThan(0);
        expect(cue.gapMs, type).toBeGreaterThanOrEqual(0);
        expect([0, 1, 2], type).toContain(cue.prio);
        expect(typeof cue.play, type).toBe("function");
      }
    }
  });

  it("the table chooses by element, rarity and skill family", () => {
    const fire = cueFor(sample("classic.hit"), ENV);
    const cold = cueFor({ ...sample("classic.hit"), element: "cold" }, ENV);
    expect(fire?.key).toBe("hit.fire.crit");
    expect(cold?.key).toBe("hit.cold.crit");
    const normal = cueFor({ ...sample("classic.death"), rarity: "normal", isHero: false }, ENV);
    const boss = cueFor({ ...sample("classic.death"), rarity: "boss" }, ENV);
    expect(normal?.key).toBe("death.normal");
    expect(boss?.key).toBe("death.boss");
    expect(boss!.prio).toBeGreaterThan(normal!.prio);
    const spell = cueFor({ ...sample("classic.cast"), skill: "classic.skill.ember_bolt" }, ENV);
    const melee = cueFor({ ...sample("classic.cast"), skill: "classic.skill.attack" }, ENV);
    expect(spell?.key).toBe("cast.spell.fire");
    expect(melee?.key).toBe("cast.swing");
    expect(cueFor({ ...sample("classic.cast"), skill: "nope" }, ENV)).toBeNull();
  });

  it("loot cues step up with rarity and gold / potions get their own cue", () => {
    const rare = cueFor({ ...sample("classic.loot.dropped"), rarity: "rare" }, ENV);
    const normal = cueFor({ ...sample("classic.loot.dropped"), rarity: "normal" }, ENV);
    const unique = cueFor({ ...sample("classic.loot.dropped"), rarity: "unique" }, ENV);
    expect(normal!.prio).toBeLessThan(rare!.prio);
    expect(rare!.prio).toBeLessThan(unique!.prio);
    expect(cueFor({ ...sample("classic.loot.dropped"), kind: "gold" }, ENV)?.key).toBe("loot.gold");
  });

  it("classic.effect: arc aim points are silent, chains zap, booms carry the radius", () => {
    expect(cueFor({ ...sample("classic.effect"), points: [{ x: 0, y: 0 }] }, ENV)).toBeNull();
    expect(cueFor(sample("classic.effect"), ENV)?.key).toBe("fx.zap");
    const boom = cueFor(
      { ...sample("classic.effect"), effect: "fx.cinder_orb", points: [], radius: 512 },
      ENV,
    );
    expect(boom?.key).toBe("fx.boom.cinder_orb");
  });

  it("telegraph and boss phases are important", () => {
    const tele = cueFor(sample("classic.telegraph"), ENV);
    expect(tele?.prio).toBe(2);
    const phase = cueFor(sample("classic.boss.phase"), ENV);
    expect(phase?.prio).toBe(2);
  });
});

describe("classic audio: no WebAudio", () => {
  it("is a silent no-op and never throws for any event", () => {
    const audio = createAudio({
      registry,
      settings: { ...DEFAULT_SETTINGS },
      target: null,
    });
    expect(() => {
      audio.onEvents(allEvents(), FRAME);
      audio.applySettings({ ...DEFAULT_SETTINGS, muted: true });
      audio.unlock();
      audio.onEvents([], FRAME);
      audio.destroy();
      audio.destroy();
    }).not.toThrow();
    expect(audio.stats?.().running).toBe(false);
    expect(audio.stats?.().played).toBe(0);
  });

  it("a throwing AudioContext factory is silent too", () => {
    const audio = createAudio({
      registry,
      settings: { ...DEFAULT_SETTINGS },
      context: () => {
        throw new Error("blocked");
      },
      target: null,
    });
    made.push(audio);
    expect(() => {
      audio.unlock();
      audio.onEvents(allEvents(), FRAME);
    }).not.toThrow();
    expect(audio.stats?.().played).toBe(0);
  });
});

describe("classic audio: engine and budgets", () => {
  it("starts suspended and creates nothing before a gesture", () => {
    const { audio, ctx } = setup();
    audio.onEvents(hitEvents(3), FRAME);
    expect(ctx.oscs.length).toBe(0);
    expect(ctx.resumes).toBe(0);
    cleanup();
  });

  it("unlock resumes the context once it exists", () => {
    const { audio, ctx } = setup();
    audio.unlock();
    expect(ctx.resumes).toBe(1);
    expect(ctx.state).toBe("running");
    cleanup();
  });

  it("a pointer or key gesture resumes and removes its listeners", () => {
    const { ctx, target } = setup();
    expect(target.count("pointerdown")).toBe(1);
    expect(target.count("keydown")).toBe(1);
    target.fire("keydown");
    expect(ctx.resumes).toBe(1);
    expect(target.count("pointerdown")).toBe(0);
    expect(target.count("keydown")).toBe(0);
    cleanup();
  });

  it("the 12-voice cap holds under a 500-event batch", () => {
    const { audio, ctx, clock } = setup();
    audio.unlock();
    const batch = [...hitEvents(250, { crit: true }), ...hitEvents(250, { element: "fire" })];
    audio.onEvents(batch, FRAME);
    expect(audio.stats?.().voices).toBeLessThanOrEqual(MAX_VOICES);
    // Many batches at the same clock tick: the audio clock does not advance, so
    // voices never end and the cap must steal rather than grow.
    for (let i = 0; i < 40; i++) {
      clock.now += 1000;
      audio.onEvents(
        [
          ...hitEvents(10, { crit: true }),
          { ...sample("classic.loot.dropped"), rarity: "rare", x: 11 * SUB, y: 10 * SUB },
          { ...sample("classic.cast"), skill: "classic.skill.ember_bolt", caster: 1 },
        ],
        FRAME,
      );
    }
    const stats = audio.stats!();
    expect(stats.voices).toBeLessThanOrEqual(MAX_VOICES);
    expect(stats.stolen).toBeGreaterThan(0);
    // Every oscillator that was stolen was stopped, not left running.
    const stopped = ctx.oscs.filter((o) => o.stopped !== null).length;
    expect(stopped).toBeGreaterThan(0);
    cleanup();
  });

  it("batches are capped per batch (24 at normal speed, 8 at x4, 4 at x8)", () => {
    for (const [speed, cap] of [
      [1, BATCH_CAP.normal],
      [4, BATCH_CAP.fast],
      [8, BATCH_CAP.fastest],
    ] as const) {
      const { audio, clock } = setup();
      audio.unlock();
      clock.now = 10_000;
      // Every event type at once: far more candidate sounds than any cap.
      audio.onEvents(allEvents(), frameAt({ speed }));
      const played = audio.stats!().played;
      expect(played, `speed ${speed}`).toBeLessThanOrEqual(cap);
      expect(played, `speed ${speed} fills the cap`).toBe(cap);
      cleanup();
    }
  });

  it("rate limits: the same key is not replayed inside its gap", () => {
    const { audio, clock } = setup();
    audio.unlock();
    clock.now = 1000;
    audio.onEvents(hitEvents(200), FRAME);
    expect(audio.stats!().played).toBe(1);
    clock.now = 1100; // hit.phys gap is 45 ms
    audio.onEvents(hitEvents(200), FRAME);
    expect(audio.stats!().played).toBe(2);
    cleanup();
  });

  it("at x8 minor hits and misses are dropped entirely", () => {
    const { audio, clock } = setup();
    audio.unlock();
    clock.now = 1000;
    const misses: GameEvent[] = [];
    for (let i = 0; i < 200; i++) {
      misses.push({ ...sample("classic.miss"), x: 11 * SUB, y: 10 * SUB });
    }
    audio.onEvents(misses, frameAt({ speed: 8 }));
    expect(audio.stats!().played).toBe(0);
    audio.onEvents(hitEvents(50), frameAt({ speed: 8 }));
    expect(audio.stats!().played).toBe(0);
    // Important sounds still play at x8.
    audio.onEvents([sample("classic.boss.killed")], frameAt({ speed: 8 }));
    expect(audio.stats!().played).toBe(1);
    cleanup();
  });

  it("positioned sounds far from the hero are not played", () => {
    const { audio, clock } = setup();
    audio.unlock();
    clock.now = 1000;
    const far = hitEvents(1, { x: (10 + HEAR_RANGE_TILES + 5) * SUB, y: 10 * SUB });
    audio.onEvents(far, FRAME);
    expect(audio.stats!().played).toBe(0);
    cleanup();
  });

  it("wraps every event in a guard: a broken payload does not stop the batch", () => {
    const { audio, clock } = setup();
    audio.unlock();
    clock.now = 1000;
    const broken = [
      { type: "classic.effect" }, // missing points / radius
      { type: "classic.hit" }, // missing element
      { type: "classic.cast", skill: 5 },
      sample("classic.boss.killed"),
    ] as GameEvent[];
    expect(() => audio.onEvents(broken, FRAME)).not.toThrow();
    expect(audio.stats!().played).toBeGreaterThanOrEqual(1);
    cleanup();
  });
});

describe("classic audio: settings, music and boss duck", () => {
  it("settings become master x sfx and master x music gains, with mute", () => {
    const { audio, ctx } = setup({
      settings: {
        ...DEFAULT_SETTINGS,
        masterVolume: 50,
        sfxVolume: 80,
        musicVolume: 40,
        muted: false,
      },
    });
    audio.unlock();
    // Engine creates master, sfxBus, musicBus in that order (then the duck, layers, voices).
    const [master, sfxBus, musicBus] = ctx.gains;
    expect(master!.gain.value).toBeCloseTo(0.5, 5);
    expect(sfxBus!.gain.value).toBeCloseTo(0.8, 5);
    expect(musicBus!.gain.value).toBeCloseTo(0.4, 5);
    audio.applySettings({
      ...DEFAULT_SETTINGS,
      masterVolume: 100,
      sfxVolume: 10,
      musicVolume: 100,
      muted: true,
    });
    expect(master!.gain.value).toBe(0);
    expect(sfxBus!.gain.value).toBeCloseTo(0.1, 5);
    audio.applySettings({
      ...DEFAULT_SETTINGS,
      masterVolume: 100,
      sfxVolume: 100,
      musicVolume: 100,
      muted: false,
    });
    expect(master!.gain.value).toBe(1);
    cleanup();
  });

  it("settings applied before the context exists are used when it is created", () => {
    const { audio, ctx } = setup();
    audio.applySettings({ ...DEFAULT_SETTINGS, masterVolume: 30, muted: false });
    audio.unlock();
    expect(ctx.gains[0]!.gain.value).toBeCloseTo(0.3, 5);
    cleanup();
  });

  it("theme switch schedules a 2 s crossfade (fade in, fade out)", () => {
    const { audio, ctx, clock } = setup();
    audio.unlock();
    clock.now = 0;
    ctx.currentTime = 0;
    audio.onEvents(
      [{ ...sample("classic.area.changed"), depth: 3, theme: "classic.theme.crypt" }],
      FRAME,
    );
    expect(audio.stats!().theme).toBe("crypt");
    ctx.currentTime = 10;
    audio.onEvents(
      [{ ...sample("classic.area.changed"), depth: 5, theme: "classic.theme.forge" }],
      FRAME,
    );
    expect(audio.stats!().theme).toBe("forge");
    // The new layer ramps 0 -> 1 over CROSSFADE_SEC from the switch time.
    const fadeIn = ctx.gains.find((g) => g.gain.ops.includes(`lin:1@${10 + CROSSFADE_SEC}`));
    expect(fadeIn, "fade-in ramp").toBeDefined();
    // The old layer is faded out with a target of 0 starting at the switch.
    const fadeOut = ctx.gains.find((g) => g.gain.target?.value === 0 && g.gain.target.when === 10);
    expect(fadeOut, "fade-out").toBeDefined();
    // Same theme again: no new crossfade (no new fade-in ramp anywhere).
    const ramps = (): number =>
      ctx.gains.filter((g) => g.gain.ops.some((o) => o.startsWith("lin:1@"))).length;
    const before = ramps();
    audio.onEvents(
      [{ ...sample("classic.area.changed"), depth: 6, theme: "classic.theme.forge" }],
      FRAME,
    );
    expect(ramps()).toBe(before);
    cleanup();
  });

  it("boss fights duck the score until the boss dies or the area changes", () => {
    const { audio, ctx, clock } = setup();
    audio.unlock();
    clock.now = 0;
    audio.onEvents([sample("classic.boss.spawned")], FRAME);
    expect(audio.stats!().ducked).toBe(true);
    const duck = ctx.gains.find((g) => g.gain.target?.value === 0.5);
    expect(duck, "duck to -6 dB").toBeDefined();
    audio.onEvents([sample("classic.boss.phase")], FRAME);
    expect(audio.stats!().ducked).toBe(true);
    audio.onEvents([sample("classic.boss.killed")], FRAME);
    expect(audio.stats!().ducked).toBe(false);
    audio.onEvents([sample("classic.boss.spawned")], FRAME);
    audio.onEvents(
      [{ ...sample("classic.area.changed"), depth: 2, theme: "classic.theme.caves" }],
      FRAME,
    );
    expect(audio.stats!().ducked).toBe(false);
    cleanup();
  });

  it("rift depths use the rift theme", () => {
    const { audio } = setup();
    audio.unlock();
    audio.onEvents(
      [{ ...sample("classic.area.changed"), depth: 100_003, theme: "classic.theme.caves" }],
      FRAME,
    );
    expect(audio.stats!().theme).toBe("rift");
    cleanup();
  });

  it("destroy stops the score, closes the context and removes listeners", () => {
    const { audio, ctx, target } = setup();
    audio.unlock();
    audio.onEvents(hitEvents(3), FRAME);
    audio.destroy();
    expect(ctx.closed).toBe(true);
    expect(target.count("pointerdown")).toBe(0);
    expect(target.count("keydown")).toBe(0);
    const oscCount = ctx.oscs.length;
    // Nothing is scheduled after destroy.
    expect(() => audio.onEvents(allEvents(), FRAME)).not.toThrow();
    expect(() => audio.unlock()).not.toThrow();
    expect(ctx.oscs.length).toBe(oscCount);
  });
});

describe("classic audio: music helpers", () => {
  it("areas map to themes; rift depths win; unknown themes fall back to town", () => {
    expect(themeForArea(3, "classic.theme.crypt")).toBe("crypt");
    expect(themeForArea(4, "classic.theme.forge")).toBe("forge");
    expect(themeForArea(100_002, "classic.theme.abyss")).toBe("rift");
    expect(themeForArea(1, "test.theme")).toBe("town");
    expect(themeForArea(0, "classic.theme.town")).toBe("town");
  });

  it("every theme is in its mode and tempo range", () => {
    for (const t of Object.values(THEMES)) {
      expect(t.scale.length).toBeGreaterThanOrEqual(5);
      expect(t.barSec).toBeGreaterThan(4);
      expect(t.barSec).toBeLessThan(14);
      expect(t.density).toBeGreaterThan(0);
      expect(t.density).toBeLessThan(1);
      const low = degreeMidi(t, 0);
      expect(low).toBeGreaterThan(20);
      expect(low).toBeLessThan(90);
    }
    expect(midiHz(69)).toBeCloseTo(440, 6);
  });
});
