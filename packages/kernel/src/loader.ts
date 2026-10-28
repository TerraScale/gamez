/**
 * Mode loader: resolves module globs against a catalog, orders modules by
 * their dependencies, runs the data stages, freezes the registry, collects
 * systems/actions and applies overrides.
 */
import { compareStrings, stableHash } from "./hash.ts";
import { RegistryImpl } from "./registry.ts";
import type {
  ActionDef,
  LoadedMode,
  ModeSpec,
  ModuleSpec,
  Override,
  SimContext,
  SystemDef,
  SystemStage,
  World,
} from "./types.ts";

const STAGE_RANK: Record<SystemStage, number> = { pre: 0, update: 1, post: 2 };
const DATA_STAGES = ["data", "dataUpdates", "dataFinal"] as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "steps.*" matches "steps.combat" and "steps.ai.basic"; "*" matches all; exact ids match themselves. */
export function matchGlob(pattern: string, id: string): boolean {
  if (!pattern.includes("*")) return pattern === id;
  const parts = pattern.split("*");
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (!id.startsWith(first)) return false;
  let pos = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const at = id.indexOf(parts[i]!, pos);
    if (at < 0) return false;
    pos = at + parts[i]!.length;
  }
  return id.length - last.length >= pos && id.endsWith(last);
}

/** Resolves the mode's patterns to a set of modules, validating the catalog and required deps. */
function resolveModules(mode: ModeSpec, catalog: readonly ModuleSpec[]): Map<string, ModuleSpec> {
  const byId = new Map<string, ModuleSpec>();
  for (const m of catalog) {
    if (typeof m.id !== "string" || m.id === "")
      throw new Error("Module catalog: a module has no id");
    if (byId.has(m.id)) throw new Error(`Module catalog: duplicate module id "${m.id}"`);
    if (typeof m.version !== "string" || m.version === "")
      throw new Error(`Module "${m.id}" has no version`);
    byId.set(m.id, m);
  }
  const selected = new Map<string, ModuleSpec>();
  for (const pattern of mode.modules) {
    let matched = 0;
    for (const m of byId.values()) {
      if (matchGlob(pattern, m.id)) {
        selected.set(m.id, m);
        matched++;
      }
    }
    if (matched === 0)
      throw new Error(
        `Mode "${mode.id}": module pattern "${pattern}" matches no module in the catalog`,
      );
  }
  for (const m of selected.values()) {
    for (const dep of m.deps ?? []) {
      if (selected.has(dep)) continue;
      const where = byId.has(dep)
        ? `is in the catalog but not in mode "${mode.id}" (add it to the mode's modules)`
        : "is not in the catalog";
      throw new Error(`Module "${m.id}" requires module "${dep}", which ${where}`);
    }
  }
  return selected;
}

/** Finds one dependency cycle among `remaining` (each id -> ids it must load after). */
function findCycle(remaining: Map<string, string[]>): string[] {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, "visiting");
    path.push(id);
    for (const dep of [...(remaining.get(id) ?? [])].sort(compareStrings)) {
      if (!remaining.has(dep)) continue;
      const s = state.get(dep);
      if (s === "visiting") return [...path.slice(path.indexOf(dep)), dep];
      if (s === undefined) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of [...remaining.keys()].sort(compareStrings)) {
    if (state.has(id)) continue;
    const found = visit(id);
    if (found) return found;
  }
  return [...remaining.keys()];
}

/** Stable topological order: a module loads after its deps and present optionalDeps; ties by id. */
function orderModules(selected: Map<string, ModuleSpec>): ModuleSpec[] {
  const after = new Map<string, string[]>();
  for (const m of selected.values()) {
    const before = [...(m.deps ?? []), ...(m.optionalDeps ?? []).filter((d) => selected.has(d))];
    after.set(m.id, [...new Set(before)]);
  }
  const placed = new Set<string>();
  const order: ModuleSpec[] = [];
  const remaining = new Map(after);
  while (remaining.size > 0) {
    let next: string | null = null;
    for (const [id, deps] of remaining) {
      if (deps.every((d) => placed.has(d)) && (next === null || compareStrings(id, next) < 0))
        next = id;
    }
    if (next === null)
      throw new Error(`Module dependency cycle: ${findCycle(remaining).join(" -> ")}`);
    remaining.delete(next);
    placed.add(next);
    order.push(selected.get(next)!);
  }
  return order;
}

interface SystemSlot {
  def: SystemDef;
  moduleIndex: number;
  moduleId: string;
  run: SystemDef["run"];
  disabledBy: string | null;
}

interface ActionSlot {
  moduleId: string;
  def: ActionDef<any>;
  apply: ActionDef<any>["apply"];
  disabledBy: string | null;
}

function collectSystems(modules: ModuleSpec[]): Map<string, SystemSlot> {
  const systems = new Map<string, SystemSlot>();
  modules.forEach((m, moduleIndex) => {
    for (const def of m.systems ?? []) {
      if (typeof def.id !== "string" || def.id === "")
        throw new Error(`Module "${m.id}": a system has no id`);
      const prev = systems.get(def.id);
      if (prev)
        throw new Error(
          `Duplicate system id "${def.id}" in modules "${prev.moduleId}" and "${m.id}"`,
        );
      const stage = def.stage ?? "update";
      if (!(stage in STAGE_RANK))
        throw new Error(`System "${def.id}" (module "${m.id}"): unknown stage "${stage}"`);
      if (def.order !== undefined && !Number.isFinite(def.order)) {
        throw new Error(`System "${def.id}" (module "${m.id}"): order must be a finite number`);
      }
      if (typeof def.run !== "function")
        throw new Error(`System "${def.id}" (module "${m.id}"): run is not a function`);
      systems.set(def.id, {
        def,
        moduleIndex,
        moduleId: m.id,
        run: (w, ctx) => def.run(w, ctx),
        disabledBy: null,
      });
    }
  });
  return systems;
}

function collectActions(modules: ModuleSpec[]): Map<string, ActionSlot> {
  const actions = new Map<string, ActionSlot>();
  for (const m of modules) {
    for (const def of m.actions ?? []) {
      if (typeof def.name !== "string" || def.name === "")
        throw new Error(`Module "${m.id}": an action has no name`);
      const prev = actions.get(def.name);
      if (prev)
        throw new Error(
          `Duplicate action name "${def.name}" in modules "${prev.moduleId}" and "${m.id}"`,
        );
      actions.set(def.name, {
        moduleId: m.id,
        def,
        apply: (w, p, ctx) => def.apply(w, p, ctx),
        disabledBy: null,
      });
    }
  }
  return actions;
}

function applyOverride(
  m: ModuleSpec,
  o: Override,
  systems: Map<string, SystemSlot>,
  actions: Map<string, ActionSlot>,
): void {
  const label = `Module "${m.id}" ${o.op}s ${o.kind} "${o.target}"`;
  const slot = o.kind === "system" ? systems.get(o.target) : actions.get(o.target);
  if (!slot)
    throw new Error(
      `${label}, but no ${o.kind} with that ${o.kind === "system" ? "id" : "name"} is loaded`,
    );
  if (slot.disabledBy !== null) {
    if (o.op === "disable") return;
    throw new Error(`${label}, but it was already disabled by module "${slot.disabledBy}"`);
  }
  if (o.op === "disable") {
    slot.disabledBy = m.id;
    return;
  }
  if (o.kind === "system") {
    const s = slot as SystemSlot;
    if (o.op === "replace") {
      const run = o.with;
      s.run = (w, ctx) => run(w, ctx);
    } else {
      const prev = s.run;
      const wrap = o.with;
      s.run = (w: World, ctx: SimContext) => wrap(w, ctx, () => prev(w, ctx));
    }
    return;
  }
  const a = slot as ActionSlot;
  if (o.op === "replace") {
    const def = o.with;
    if (def.name !== o.target)
      throw new Error(`${label} with an action named "${def.name}" (names must match)`);
    a.def = def;
    a.apply = (w, p, ctx) => def.apply(w, p, ctx);
  } else {
    const prev = a.apply;
    const wrap = o.with;
    a.apply = (w, p, ctx) => wrap(w, p, ctx, (p2) => prev(w, p2, ctx));
  }
}

/**
 * Resolves `mode.modules` against `catalog`, orders them (deps/optionalDeps
 * first, ties by id), runs data -> dataUpdates -> dataFinal for every module
 * per stage, freezes the registry, collects systems/actions and applies
 * overrides in load order.
 */
export function loadMode(mode: ModeSpec, catalog: readonly ModuleSpec[]): LoadedMode {
  if (mode.tick.kind === "fixed" && !(Number.isFinite(mode.tick.hz) && mode.tick.hz > 0)) {
    throw new Error(`Mode "${mode.id}": fixed tick hz must be a positive number`);
  }
  const modules = orderModules(resolveModules(mode, catalog));

  const reg = new RegistryImpl();
  for (const stage of DATA_STAGES) {
    for (const m of modules) {
      const fn = m[stage];
      if (!fn) continue;
      reg.setOwner(m.id);
      try {
        fn.call(m, reg);
      } catch (err) {
        throw new Error(`Module "${m.id}" failed in ${stage}: ${errorMessage(err)}`, {
          cause: err,
        });
      }
    }
  }
  reg.setOwner(null);
  const registry = reg.freeze();

  const systemSlots = collectSystems(modules);
  const actionSlots = collectActions(modules);
  for (const m of modules) {
    for (const o of m.overrides ?? []) applyOverride(m, o, systemSlots, actionSlots);
  }

  const systems = [...systemSlots.values()]
    .filter((s) => s.disabledBy === null)
    .sort(
      (a, b) =>
        STAGE_RANK[a.def.stage ?? "update"] - STAGE_RANK[b.def.stage ?? "update"] ||
        (a.def.order ?? 0) - (b.def.order ?? 0) ||
        a.moduleIndex - b.moduleIndex ||
        compareStrings(a.def.id, b.def.id),
    )
    .map((s) =>
      Object.freeze<SystemDef>({
        id: s.def.id,
        stage: s.def.stage ?? "update",
        order: s.def.order ?? 0,
        run: s.run,
      }),
    );

  const actions = new Map<string, ActionDef<any>>();
  for (const name of [...actionSlots.keys()].sort(compareStrings)) {
    const a = actionSlots.get(name)!;
    if (a.disabledBy !== null) continue;
    const def = a.def;
    actions.set(
      name,
      Object.freeze<ActionDef<any>>({
        name,
        parse: (w, p, ctx) => def.parse(w, p, ctx),
        apply: a.apply,
      }),
    );
  }

  const contentHash = stableHash([mode.id, modules.map((m) => [m.id, m.version]), registry.hash]);
  return Object.freeze({
    mode,
    modules: Object.freeze(modules) as ModuleSpec[],
    registry,
    systems: Object.freeze(systems) as SystemDef[],
    actions,
    contentHash,
  });
}
