/**
 * Chat word filter (wave-B.md §5). Pure: no I/O, no clock.
 *
 * Matching runs on a "skeleton" of the text: lowercase, leetspeak mapped to
 * letters (4 -> a, 3 -> e, 1 -> i, 0 -> o, 5 -> s, 7 -> t, @ -> a, $ -> s,
 * ! -> i, + -> t), digits and the joiners . - _ * ' dropped (so "f.u.c.k" and
 * "f_u_c_k" match), repeated letters collapsed (so "fuuuck" matches). A listed
 * word matches only as a whole word: it must start and end at a boundary,
 * which is the text edge, whitespace or punctuation other than the joiners.
 * So "scrap" is not "crap".
 *
 * Known limits (accepted, "light but solid"): "damn.stuff" is not a boundary
 * match, and a leetspeak "!" right after a word counts as a letter.
 */
import { BLOCK_PHRASES, BLOCK_WORDS, MASK_WORDS } from "./words.ts";

const LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
  "+": "t",
};

const JOINERS = ".-_*'";

/** Letters of a text with the original index of each one. */
export interface Skeleton {
  letters: string[];
  /** Index of the first original character of each letter. */
  from: number[];
  /** Index of the last original character of each letter (repeats are merged). */
  to: number[];
  /** gap[i]: whitespace or punctuation lies between letters[i - 1] and letters[i]. */
  gap: boolean[];
}

/** Builds the skeleton of `text` (see the module comment). */
export function skeleton(text: string): Skeleton {
  const letters: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  const gap: boolean[] = [];
  let pending = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!.toLowerCase();
    // A leetspeak symbol only counts when a letter or digit follows it ("$hit"),
    // so a trailing "!" stays punctuation ("crap!").
    const symbolLeet = LEET[ch] !== undefined && !/[0-9]/.test(ch);
    if (symbolLeet && !/[a-z0-9]/i.test(text[i + 1] ?? "")) {
      pending = true;
      continue;
    }
    const mapped = LEET[ch] ?? ch;
    if (mapped.length === 1 && mapped >= "a" && mapped <= "z") {
      const last = letters.length - 1;
      if (last >= 0 && !pending && letters[last] === mapped && to[last] === i - 1) {
        to[last] = i;
        continue;
      }
      letters.push(mapped);
      from.push(i);
      to.push(i);
      gap.push(pending);
      pending = false;
    } else if (JOINERS.includes(ch) || (ch >= "0" && ch <= "9")) {
      // Dropped: obfuscation inside a word.
    } else {
      pending = true;
    }
  }
  return { letters, from, to, gap };
}

const MASK = MASK_WORDS.map((w) => skeleton(w).letters);
const BLOCK = BLOCK_WORDS.map((w) => skeleton(w).letters);
const PHRASES = BLOCK_PHRASES.map((p) => skeleton(p).letters.join(""));

/** Inclusive [first, last] original indexes of every whole-word match. */
function spans(sk: Skeleton, words: readonly string[][]): [number, number][] {
  const out: [number, number][] = [];
  const n = sk.letters.length;
  for (let i = 0; i < n; i++) {
    if (i > 0 && !sk.gap[i]) continue;
    for (const w of words) {
      const j = i + w.length;
      if (j > n) continue;
      if (j < n && !sk.gap[j]) continue;
      let ok = true;
      for (let k = 0; k < w.length; k++) {
        if (sk.letters[i + k] !== w[k]) {
          ok = false;
          break;
        }
      }
      if (ok) out.push([sk.from[i]!, sk.to[j - 1]!]);
    }
  }
  return out;
}

/** True when the text contains a link (scheme, www. or a common domain). */
export function hasLink(text: string): boolean {
  return /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(?:com|net|org|io|gg|dev|app|xyz|me|tv|co|info|biz)\b/i.test(
    text,
  );
}

export type FilterResult =
  | { ok: true; text: string; masked: boolean }
  | { ok: false; reason: "link" | "blocked" };

/**
 * Filters one message. Guests (`allowLinks: false`) may not post links; a
 * block word rejects the message; mask words become `*` (whitespace is kept).
 */
export function filterChat(text: string, opts: { allowLinks: boolean }): FilterResult {
  if (!opts.allowLinks && hasLink(text)) return { ok: false, reason: "link" };
  const sk = skeleton(text);
  const compact = sk.letters.join("");
  if (spans(sk, BLOCK).length > 0 || PHRASES.some((p) => compact.includes(p))) {
    return { ok: false, reason: "blocked" };
  }
  const hits = spans(sk, MASK);
  if (hits.length === 0) return { ok: true, text, masked: false };
  const chars = text.split("");
  for (const [a, b] of hits) {
    for (let k = a; k <= b; k++) if (!/\s/.test(chars[k]!)) chars[k] = "*";
  }
  return { ok: true, text: chars.join(""), masked: true };
}
