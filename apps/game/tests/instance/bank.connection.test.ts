/**
 * VerifiedClient bank frames (docs/design/wave-C.md §2.2): sendBank only
 * while online, the server's "bank" answer reaches handlers.bank (after a
 * vstate), malformed answers are dropped.
 */
import type { VerifiedClientMessage, VerifiedServerMessage } from "@gamez/protocol";
import type { BankAnswer, VerifiedHandlers, VerifiedStatus } from "@gamez/ui-host";
import { describe, expect, it } from "vite-plus/test";
import type { SocketLike } from "../../src/client/instance/connection.ts";
import { parseVerifiedServerMessage, VerifiedClient } from "../../src/client/instance/verified.ts";

class Sock implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: VerifiedClientMessage[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as VerifiedClientMessage);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

const answer: Extract<VerifiedServerMessage, { t: "bank" }> = {
  t: "bank",
  opId: "op_conn_00001",
  result: { ok: true, coin: 19, gold: 20, balance: 19 },
  applied: { tick: 40, name: "classic.bank", payload: { opId: "op_conn_00001" }, hash: "abc" },
};

function vstate(): VerifiedServerMessage {
  return {
    t: "vstate",
    instanceId: "classic:me:1",
    mode: "classic",
    contentHash: "c",
    epoch: 1,
    tick: 40,
    hash: "h",
    continued: true,
    snapshot: null,
    offline: null,
    imported: false,
    importable: false,
    serverTime: 1,
    limits: {
      maxTicksPerSegment: 400,
      maxInputsPerSegment: 256,
      segmentEveryMs: 2000,
      maxPendingTicks: 12000,
      creditCapMs: 900000,
    },
  };
}

async function started() {
  const sock = new Sock();
  const banks: BankAnswer[] = [];
  const statuses: VerifiedStatus[] = [];
  const handlers: VerifiedHandlers = {
    resume: () => null,
    state: () => {},
    verified: () => {},
    resync: () => {},
    status: (s) => statuses.push(s),
    bank: (a) => banks.push(a),
  };
  const client = new VerifiedClient({
    mode: "classic",
    session: () => ({ token: "tok", accountId: "me", name: "Me", kind: "guest" }) as never,
    createSocket: () => sock,
    url: () => "ws://test",
    now: () => 0,
  });
  client.start(handlers);
  await settle();
  return { sock, client, banks, statuses };
}

describe("VerifiedClient bank", () => {
  it("parses bank answers strictly", () => {
    expect(parseVerifiedServerMessage(JSON.stringify(answer))).toEqual(answer);
    const fail = {
      t: "bank",
      opId: "op_conn_00002",
      result: { ok: false, code: "disabled", message: "closed" },
      applied: null,
    };
    expect(parseVerifiedServerMessage(JSON.stringify(fail))).toEqual(fail);
    const bad = [
      { ...answer, opId: 5 },
      { ...answer, result: { ok: true } },
      { ...answer, result: { ok: false, code: "x" } },
      { ...answer, applied: { tick: "1", name: "x", hash: "y" } },
      { ...answer, applied: undefined },
    ];
    for (const b of bad) expect(parseVerifiedServerMessage(JSON.stringify(b))).toBeNull();
  });

  it("sends bank only while online and hands answers to handlers.bank", async () => {
    const { sock, client, banks } = await started();
    const msg = {
      opId: "op_conn_00001",
      op: { kind: "depositGold" as const, gold: 20 },
      at: { tick: 40, hash: "h" },
    };
    expect(client.sendBank(msg)).toBe(false);
    sock.open();
    // An answer before the join completed is ignored.
    sock.deliver(answer);
    await settle();
    expect(banks).toEqual([]);
    sock.deliver(vstate());
    await settle();
    expect(client.status).toBe("online");
    expect(client.sendBank(msg)).toBe(true);
    expect(sock.sent.at(-1)).toEqual({ t: "bank", ...msg });
    sock.deliver(answer);
    await settle();
    expect(banks).toEqual([{ opId: answer.opId, result: answer.result, applied: answer.applied }]);
    client.close();
    expect(client.sendBank(msg)).toBe(false);
  });
});
