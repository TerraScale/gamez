/**
 * Canonical JSON: validation, deep cloning and stable hashing of plain data.
 *
 * "Plain data" is null, booleans, finite numbers, strings, arrays and objects
 * whose prototype is Object.prototype or null. Everything else (functions,
 * undefined, NaN/Infinity, bigint, symbols, Map/Set, class instances, cycles)
 * is rejected with an error naming the offending path.
 */

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number") return String(value);
  if (typeof value === "function") return "a function";
  if (typeof value === "object" && value !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    return name ? `a ${name} instance` : "a non-plain object";
  }
  return typeof value;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function notJson(path: string, value: unknown): Error {
  return new TypeError(`Not plain JSON data at ${path}: ${describe(value)}`);
}

/** Plain-object keys sorted by UTF-16 code units (locale independent). */
function sortedKeys(obj: object): string[] {
  return sortKeys(Object.keys(obj));
}

/**
 * Sorts distinct strings in place by UTF-16 code units, like `keys.sort()`.
 * Object key lists are short (and often already in order), where an
 * insertion sort with `<` is several times faster than the sort builtin;
 * every component clone sorts its keys.
 */
export function sortKeys(keys: string[]): string[] {
  const n = keys.length;
  if (n > 32) return keys.sort(compareStrings);
  for (let i = 1; i < n; i++) {
    const k = keys[i]!;
    let j = i - 1;
    if (!(keys[j]! > k)) continue;
    while (j >= 0 && keys[j]! > k) {
      keys[j + 1] = keys[j]!;
      j--;
    }
    keys[j + 1] = k;
  }
  return keys;
}

/** Locale-independent string comparison used for every kernel sort. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Canonical JSON text: object keys sorted, arrays in order. Throws on non-JSON values. */
export function canonicalJson(value: unknown): string {
  const parts: string[] = [];
  const stack = new Set<object>();
  const walk = (v: unknown, path: string): void => {
    switch (typeof v) {
      case "string":
        parts.push(JSON.stringify(v));
        return;
      case "boolean":
        parts.push(v ? "true" : "false");
        return;
      case "number":
        if (!Number.isFinite(v)) throw notJson(path, v);
        parts.push(JSON.stringify(v));
        return;
      case "object": {
        if (v === null) {
          parts.push("null");
          return;
        }
        if (stack.has(v)) throw new TypeError(`Not plain JSON data at ${path}: circular reference`);
        stack.add(v);
        if (Array.isArray(v)) {
          parts.push("[");
          for (let i = 0; i < v.length; i++) {
            if (i > 0) parts.push(",");
            walk(v[i], `${path}[${i}]`);
          }
          parts.push("]");
        } else {
          if (!isPlainObject(v)) throw notJson(path, v);
          parts.push("{");
          let first = true;
          for (const k of sortedKeys(v)) {
            if (!first) parts.push(",");
            first = false;
            parts.push(JSON.stringify(k), ":");
            walk((v as Record<string, unknown>)[k], `${path}.${k}`);
          }
          parts.push("}");
        }
        stack.delete(v);
        return;
      }
      default:
        throw notJson(path, v);
    }
  };
  walk(value, "$");
  return parts.join("");
}

/** Fast-path failure: the slow, path-tracking walk then reports the real error. */
const INVALID: unique symbol = Symbol("invalid");
/** Deeper than this, the fast path gives up (and a cycle is reported by the slow path). */
const FAST_MAX_DEPTH = 64;

/** Validating deep clone without path bookkeeping; returns INVALID on any problem. */
function fastClone(v: unknown, depth: number): unknown {
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return Number.isFinite(v) ? v : INVALID;
    case "object": {
      if (v === null) return null;
      if (depth > FAST_MAX_DEPTH) return INVALID;
      if (Array.isArray(v)) {
        const n = v.length;
        const arr: unknown[] = Array.from({ length: n });
        for (let i = 0; i < n; i++) {
          const c = fastClone(v[i], depth + 1);
          if (c === INVALID) return INVALID;
          arr[i] = c;
        }
        return arr;
      }
      if (!isPlainObject(v)) return INVALID;
      // UTF-16 code unit order, like compareStrings().
      const keys = sortKeys(Object.keys(v));
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        const field = (v as Record<string, unknown>)[k];
        if (field === undefined) continue;
        const c = fastClone(field, depth + 1);
        if (c === INVALID) return INVALID;
        obj[k] = c;
      }
      return obj;
    }
    default:
      return INVALID;
  }
}

/**
 * Deep-clones plain JSON data, validating it on the way. Object fields whose
 * value is undefined are dropped (as JSON.stringify does); every other
 * non-JSON value throws. Object keys of the clone are in sorted order.
 *
 * `path` names the value in error messages; pass a function to build it only
 * when an error is thrown. Valid data takes a fast path with no path
 * bookkeeping; anything else is re-walked to report the exact error.
 */
export function cloneJson<T>(value: T, path: string | (() => string) = "$"): T {
  const fast = fastClone(value, 0);
  if (fast !== INVALID) return fast as T;
  const stack = new Set<object>();
  const walk = (v: unknown, p: string): unknown => {
    switch (typeof v) {
      case "string":
      case "boolean":
        return v;
      case "number":
        if (!Number.isFinite(v)) throw notJson(p, v);
        return v;
      case "object": {
        if (v === null) return null;
        if (stack.has(v)) throw new TypeError(`Not plain JSON data at ${p}: circular reference`);
        stack.add(v);
        let out: unknown;
        if (Array.isArray(v)) {
          const arr: unknown[] = Array.from({ length: v.length });
          for (let i = 0; i < v.length; i++) arr[i] = walk(v[i], `${p}[${i}]`);
          out = arr;
        } else {
          if (!isPlainObject(v)) throw notJson(p, v);
          const obj: Record<string, unknown> = {};
          for (const k of sortedKeys(v)) {
            const field = (v as Record<string, unknown>)[k];
            if (field !== undefined) obj[k] = walk(field, `${p}.${k}`);
          }
          out = obj;
        }
        stack.delete(v);
        return out;
      }
      default:
        throw notJson(p, v);
    }
  };
  // Only data deeper than FAST_MAX_DEPTH (without cycles) gets here valid.
  return walk(value, typeof path === "function" ? path() : path) as T;
}

/**
 * cloneJson() for a component value or field, without a path closure (add()
 * and update() run in every hot loop). The error path is
 * `owner[entity]` or `owner[entity].key`.
 */
export function cloneValue(value: unknown, owner: string, e: number, key: string | null): unknown {
  const fast = fastClone(value, 0);
  if (fast !== INVALID) return fast;
  return cloneJson(value, key === null ? `${owner}[${e}]` : `${owner}[${e}].${key}`);
}

/**
 * Deep copy of data that is already stored in the world, for the rollback
 * log. Stored data is plain JSON (it was validated on the way in), so it is
 * not validated again. Keys keep their order, so restoring the copy is exact.
 * A for-in copy is used because it stays fast when one call site sees many
 * object shapes (every component type goes through here).
 */
export function copyStored<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    const arr: unknown[] = value.slice();
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (typeof v === "object" && v !== null) arr[i] = copyStored(v);
    }
    return arr as T;
  }
  const obj: Record<string, unknown> = {};
  for (const k in value) {
    const v: unknown = value[k];
    obj[k] = typeof v === "object" && v !== null ? copyStored(v) : v;
  }
  return obj as T;
}

/** Recursively freezes plain data in place and returns it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

/** FNV-1a over UTF-16 code units. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** MurmurHash3-style lane over UTF-16 code units with fmix32 finaliser. */
function murmur(s: string, seed: number): number {
  let h = seed | 0;
  for (let i = 0; i < s.length; i++) {
    let k = Math.imul(s.charCodeAt(i), 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= s.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Canonical JSON (object keys sorted, arrays in order) hashed to 16 hex chars
 * (an FNV-1a lane and a murmur3-style lane). Throws on non-JSON values.
 */
export function stableHash(value: unknown): string {
  const s = canonicalJson(value);
  return hex32(fnv1a(s)) + hex32(murmur(s, 0x9747b28c));
}
