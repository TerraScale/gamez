/**
 * Async moderation (wave-B.md §5, plan §9). A Moderator classifies a message
 * after it was broadcast; an unsafe verdict hides it and adds a strike.
 *
 * - LlamaGuardModerator: Workers AI `@cf/meta/llama-guard-3-8b` (env.AI). Any
 *   error or unreadable answer counts as safe with source "error" (logged).
 * - StubModerator: local/e2e. Flags texts that contain "[unsafe-test]".
 * - OffModerator: MODERATION=off, always safe.
 */
import type { WorkersAiLike } from "../contracts.ts";

export const LLAMA_GUARD_MODEL = "@cf/meta/llama-guard-3-8b";
export const STUB_UNSAFE_MARKER = "[unsafe-test]";

export type ModerationSource = "llama-guard" | "stub" | "off" | "error";

export interface Verdict {
  safe: boolean;
  /** Llama Guard hazard codes ("S1" …) or stub labels. */
  categories: string[];
  source: ModerationSource;
}

export interface Moderator {
  readonly name: ModerationSource;
  /** Never throws: failures return a safe verdict with source "error". */
  classify(text: string): Promise<Verdict>;
}

/**
 * Reads a Llama Guard answer: "safe", or "unsafe" then hazard codes on the
 * following lines ("unsafe\nS1"). Null when the answer is unreadable.
 */
export function parseGuardOutput(output: unknown): Verdict | null {
  let text: unknown = output;
  if (typeof output === "object" && output !== null && "response" in output) {
    text = (output as { response: unknown }).response;
  }
  if (typeof text !== "string") return null;
  const head = /^\s*(safe|unsafe)\b/i.exec(text);
  if (!head) return null;
  if (head[1]!.toLowerCase() === "safe")
    return { safe: true, categories: [], source: "llama-guard" };
  const codes = new Set<string>();
  for (const m of text.slice(head[0].length).matchAll(/\bS(\d{1,2})\b/gi)) codes.add(`S${m[1]}`);
  return { safe: false, categories: [...codes].sort(), source: "llama-guard" };
}

export class LlamaGuardModerator implements Moderator {
  readonly name = "llama-guard" as const;

  constructor(
    private readonly ai: WorkersAiLike,
    private readonly log: (message: string, err?: unknown) => void = (m, e) => console.warn(m, e),
  ) {}

  async classify(text: string): Promise<Verdict> {
    const error: Verdict = { safe: true, categories: [], source: "error" };
    try {
      const out = await this.ai.run(LLAMA_GUARD_MODEL, {
        messages: [{ role: "user", content: text }],
      });
      const verdict = parseGuardOutput(out);
      if (verdict) return verdict;
      this.log("moderation: unreadable Llama Guard answer", out);
      return error;
    } catch (err) {
      this.log("moderation: Llama Guard call failed", err);
      return error;
    }
  }
}

export class StubModerator implements Moderator {
  readonly name = "stub" as const;

  async classify(text: string): Promise<Verdict> {
    if (text.includes(STUB_UNSAFE_MARKER)) {
      return { safe: false, categories: ["stub"], source: "stub" };
    }
    return { safe: true, categories: [], source: "stub" };
  }
}

export class OffModerator implements Moderator {
  readonly name = "off" as const;

  async classify(_text: string): Promise<Verdict> {
    return { safe: true, categories: [], source: "off" };
  }
}

/**
 * MODERATION "off" -> OffModerator. Otherwise Llama Guard when env.AI is
 * bound and MODERATION is not "stub"; without the binding (local dev) the stub.
 */
export function createModerator(env: { AI?: WorkersAiLike; MODERATION?: string }): Moderator {
  const mode = (env.MODERATION ?? "").trim().toLowerCase();
  if (mode === "off") return new OffModerator();
  if (mode !== "stub" && env.AI) return new LlamaGuardModerator(env.AI);
  return new StubModerator();
}
