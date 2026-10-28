import { describe, expect, it } from "vite-plus/test";
import {
  createModerator,
  LlamaGuardModerator,
  LLAMA_GUARD_MODEL,
  OffModerator,
  parseGuardOutput,
  StubModerator,
} from "../../src/server/chat/moderation.ts";

describe("parseGuardOutput", () => {
  it("reads safe answers, plain or wrapped in a response object", () => {
    expect(parseGuardOutput("safe")).toEqual({ safe: true, categories: [], source: "llama-guard" });
    expect(parseGuardOutput({ response: "  Safe\n" })).toMatchObject({ safe: true });
  });

  it("reads unsafe answers with their hazard codes", () => {
    expect(parseGuardOutput("unsafe\nS1")).toEqual({
      safe: false,
      categories: ["S1"],
      source: "llama-guard",
    });
    expect(parseGuardOutput({ response: "unsafe\nS10, S2 S2" })).toEqual({
      safe: false,
      categories: ["S10", "S2"],
      source: "llama-guard",
    });
    expect(parseGuardOutput("unsafe")).toMatchObject({ safe: false, categories: [] });
  });

  it("returns null for unreadable answers", () => {
    expect(parseGuardOutput("maybe")).toBeNull();
    expect(parseGuardOutput({})).toBeNull();
    expect(parseGuardOutput(42)).toBeNull();
    expect(parseGuardOutput(null)).toBeNull();
  });
});

describe("LlamaGuardModerator", () => {
  it("calls the model with the message and parses the verdict", async () => {
    const calls: { model: string; input: unknown }[] = [];
    const ai = {
      run: async (model: string, input: unknown) => {
        calls.push({ model, input });
        return { response: "unsafe\nS1" };
      },
    };
    const verdict = await new LlamaGuardModerator(ai).classify("bad text");
    expect(verdict).toEqual({ safe: false, categories: ["S1"], source: "llama-guard" });
    expect(calls).toEqual([
      {
        model: LLAMA_GUARD_MODEL,
        input: { messages: [{ role: "user", content: "bad text" }] },
      },
    ]);
  });

  it("counts a failed call as safe with source error, and logs it", async () => {
    const logged: string[] = [];
    const ai = {
      run: async () => {
        throw new Error("AI down");
      },
    };
    const verdict = await new LlamaGuardModerator(ai, (m) => logged.push(m)).classify("hi");
    expect(verdict).toEqual({ safe: true, categories: [], source: "error" });
    expect(logged.length).toBe(1);
  });

  it("counts an unreadable answer as safe with source error", async () => {
    const ai = { run: async () => ({ weird: true }) };
    const verdict = await new LlamaGuardModerator(ai, () => {}).classify("hi");
    expect(verdict).toEqual({ safe: true, categories: [], source: "error" });
  });
});

describe("stub and off moderators", () => {
  it("flags only the stub marker", async () => {
    const stub = new StubModerator();
    expect(await stub.classify("[unsafe-test] hi")).toMatchObject({ safe: false, source: "stub" });
    expect(await stub.classify("hi")).toMatchObject({ safe: true, source: "stub" });
  });

  it("is always safe when off", async () => {
    expect(await new OffModerator().classify("[unsafe-test]")).toMatchObject({
      safe: true,
      source: "off",
    });
  });
});

describe("createModerator", () => {
  const ai = { run: async () => "safe" };

  it("uses Llama Guard when AI is bound", () => {
    expect(createModerator({ AI: ai }).name).toBe("llama-guard");
    expect(createModerator({ AI: ai, MODERATION: "llama-guard" }).name).toBe("llama-guard");
  });

  it("uses the stub without a binding, and when MODERATION says stub", () => {
    expect(createModerator({}).name).toBe("stub");
    expect(createModerator({ MODERATION: "llama-guard" }).name).toBe("stub");
    expect(createModerator({ AI: ai, MODERATION: "stub" }).name).toBe("stub");
  });

  it("is off when MODERATION says off, binding or not", () => {
    expect(createModerator({ MODERATION: "off" }).name).toBe("off");
    expect(createModerator({ AI: ai, MODERATION: " OFF " }).name).toBe("off");
  });
});
