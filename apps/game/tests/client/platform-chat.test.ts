import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CHAT_HISTORY, type ChatMessage } from "@gamez/protocol";
import {
  CHAT_MAX_VIEW,
  CHAT_SEND_TIMEOUT_MS,
  createChatApi,
  type ChatSocket,
} from "../../src/client/platform/chat.ts";
import type { ChatChannelClient, ChatChannelView } from "@gamez/ui-host";

/** Fake browser WebSocket: the test drives open, message and close by hand. */
class FakeChatSocket implements ChatSocket {
  static instances: FakeChatSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;

  constructor(readonly url: string) {
    FakeChatSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }

  // Test controls.
  open(): void {
    this.readyState = FakeChatSocket.OPEN;
  }

  frame(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  drop(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const ORIGIN = "http://localhost:5173";

function msg(id: string, from = "acc-2", text = "hi"): ChatMessage {
  return {
    id,
    channel: "global",
    from,
    name: `Name-${from}`,
    text,
    at: Number(id.split("-")[0]) || 1,
  };
}

/** A channel that has been welcomed (online), with an optional history. */
function online(
  api: ReturnType<typeof createChatApi>,
  channel = "global",
  history: ChatMessage[] = [],
) {
  const client = api.join(channel);
  const socket = FakeChatSocket.instances.at(-1);
  if (!socket) throw new Error("no socket");
  socket.open();
  socket.frame({
    t: "welcome",
    channel,
    self: { accountId: "acc-1", displayName: "Me" },
    history,
    mutedUntil: null,
    blocked: [],
  });
  return { client, socket };
}

function makeApi(token: () => string | null = () => "tok") {
  return createChatApi({ token, origin: ORIGIN, WebSocket: FakeChatSocket as never });
}

/** Records every view a client publishes. */
function watch(client: ChatChannelClient): ChatChannelView[] {
  const views: ChatChannelView[] = [];
  client.subscribe((v) => views.push(v));
  return views;
}

beforeEach(() => {
  FakeChatSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chat socket lifecycle", () => {
  it("opens /ws/chat with the token and channel and waits for the welcome", () => {
    const api = makeApi();
    const client = api.join("mode:classic");
    expect(FakeChatSocket.instances).toHaveLength(1);
    expect(FakeChatSocket.instances[0]?.url).toBe(
      "ws://localhost:5173/ws/chat?token=tok&channel=mode%3Aclassic",
    );
    expect(client.getView()).toMatchObject({
      channel: "mode:classic",
      status: "connecting",
      messages: [],
    });
  });

  it("welcome brings the history, status online, and the mute and block lists", () => {
    const api = makeApi();
    const client = api.join("global");
    const socket = FakeChatSocket.instances[0];
    socket?.open();
    socket?.frame({
      t: "welcome",
      channel: "global",
      self: { accountId: "acc-1", displayName: "Me" },
      history: [msg("1-a", "acc-2"), msg("2-b", "acc-3")],
      mutedUntil: 999,
      blocked: ["acc-3"],
    });
    const view = client.getView();
    expect(view.status).toBe("online");
    expect(view.mutedUntil).toBe(999);
    expect(view.blocked).toEqual(["acc-3"]);
    // Blocked senders are removed from the history as well.
    expect(view.messages.map((m) => m.id)).toEqual(["1-a"]);
  });

  it("appends live messages once, and removes hidden ones", () => {
    const api = makeApi();
    const { client, socket } = online(api, "global", [msg("1-a")]);
    const views = watch(client);
    socket.frame({ t: "message", msg: msg("2-b") });
    socket.frame({ t: "message", msg: msg("2-b") }); // duplicate id: ignored
    expect(client.getView().messages.map((m) => m.id)).toEqual(["1-a", "2-b"]);
    expect(views.length).toBeGreaterThan(0);

    socket.frame({ t: "hidden", ids: ["1-a"] });
    expect(client.getView().messages.map((m) => m.id)).toEqual(["2-b"]);
  });

  it("caps the view at two histories, dropping the oldest", () => {
    const api = makeApi();
    const { client, socket } = online(api);
    for (let i = 0; i < CHAT_MAX_VIEW + 5; i++) socket.frame({ t: "message", msg: msg(`${i}-x`) });
    const ids = client.getView().messages.map((m) => m.id);
    expect(ids).toHaveLength(CHAT_MAX_VIEW);
    expect(ids[0]).toBe("5-x");
    expect(CHAT_MAX_VIEW).toBe(CHAT_HISTORY * 2);
  });

  it("drops messages from blocked senders, live and after a block", () => {
    const api = makeApi();
    const { client, socket } = online(api, "global", [msg("1-a", "acc-9")]);
    expect(client.getView().messages).toHaveLength(1);
    client.block("acc-9", true);
    expect(client.getView().messages).toHaveLength(0);
    expect(socket.sent).toContainEqual({ t: "block", accountId: "acc-9", blocked: true });
    socket.frame({ t: "message", msg: msg("3-c", "acc-9") });
    expect(client.getView().messages).toHaveLength(0);
    client.block("acc-9", false);
    expect(socket.sent.at(-1)).toEqual({ t: "block", accountId: "acc-9", blocked: false });
  });

  it("applies server muted and blocked frames", () => {
    const api = makeApi();
    const { client, socket } = online(api, "global", [msg("1-a", "acc-5")]);
    socket.frame({ t: "muted", until: 5000, reason: "Slow down" });
    expect(client.getView()).toMatchObject({
      mutedUntil: 5000,
      error: { code: "muted", message: "Slow down" },
    });
    socket.frame({ t: "blocked", blocked: ["acc-5"] });
    expect(client.getView().blocked).toEqual(["acc-5"]);
    expect(client.getView().messages).toHaveLength(0);
  });

  it("ignores garbage frames", () => {
    const api = makeApi();
    const { client, socket } = online(api);
    socket.onmessage?.({ data: "not json" });
    socket.onmessage?.({ data: 42 });
    socket.frame({ nope: true });
    expect(client.getView().status).toBe("online");
  });

  it("reuses one socket for repeated joins and closes it with the last handle", () => {
    const api = makeApi();
    const a = api.join("guild:iron-wolves");
    const b = api.join("guild:iron-wolves");
    expect(FakeChatSocket.instances).toHaveLength(1);
    a.close();
    expect(FakeChatSocket.instances[0]?.closedWith).toBeNull();
    b.close();
    expect(FakeChatSocket.instances[0]?.closedWith).toBe(1000);
    // Closing twice is harmless.
    b.close();
    // A later join opens a new socket.
    api.join("guild:iron-wolves");
    expect(FakeChatSocket.instances).toHaveLength(2);
  });

  it("a closed handle stops receiving updates", () => {
    const api = makeApi();
    const { client, socket } = online(api);
    const views: ChatChannelView[] = [];
    client.subscribe((v) => views.push(v));
    const other = api.join("global");
    client.close();
    socket.frame({ t: "message", msg: msg("9-z") });
    expect(views).toHaveLength(0);
    other.close();
  });
});

describe("chat sending", () => {
  it("resolves send on ack with the nonce and sends the trimmed text", async () => {
    const api = makeApi();
    const { client, socket } = online(api);
    const pending = client.send("  hello there ");
    const frame = socket.sent.at(-1) as { t: string; text: string; nonce: string };
    expect(frame).toMatchObject({ t: "send", text: "hello there" });
    socket.frame({ t: "ack", nonce: frame.nonce, id: "7-q" });
    expect(await pending).toEqual({ ok: true, value: { id: "7-q" } });
  });

  it("resolves with the server error and sets the view error on rate limit", async () => {
    const api = makeApi();
    const { client, socket } = online(api);
    const pending = client.send("spam");
    const frame = socket.sent.at(-1) as { nonce: string };
    socket.frame({ t: "error", code: "rate_limited", message: "Slow down", nonce: frame.nonce });
    expect(await pending).toEqual({ ok: false, code: "rate_limited", message: "Slow down" });
    expect(client.getView().error).toEqual({ code: "rate_limited", message: "Slow down" });
  });

  it("clears the view error on the next successful send", async () => {
    const api = makeApi();
    const { client, socket } = online(api);
    socket.frame({ t: "error", code: "filtered", message: "No" });
    expect(client.getView().error).not.toBeNull();
    const pending = client.send("fine");
    socket.frame({ t: "ack", nonce: (socket.sent.at(-1) as { nonce: string }).nonce, id: "1-z" });
    await pending;
    expect(client.getView().error).toBeNull();
  });

  it("rejects empty and too long text without a frame", async () => {
    const api = makeApi();
    const { client, socket } = online(api);
    expect(await client.send("   ")).toMatchObject({ ok: false, code: "empty" });
    expect(await client.send("x".repeat(281))).toMatchObject({ ok: false, code: "too_long" });
    expect(socket.sent).toHaveLength(0);
  });

  it("answers offline without a frame while the socket is not online", async () => {
    const api = makeApi();
    const client = api.join("global");
    const socket = FakeChatSocket.instances[0];
    // Still connecting (no welcome yet).
    expect(await client.send("hi")).toMatchObject({ ok: false, code: "offline" });
    expect(socket?.sent).toHaveLength(0);
  });

  it("fails pending sends when the socket drops, then reconnects", async () => {
    const api = makeApi();
    const { client, socket } = online(api);
    const pending = client.send("in flight");
    socket.drop(1006);
    expect(await pending).toMatchObject({ ok: false, code: "offline" });
    expect(client.getView().status).toBe("offline");
  });

  it("times out a send that is never answered", async () => {
    const api = makeApi();
    const { client } = online(api);
    const pending = client.send("silence");
    await vi.advanceTimersByTimeAsync(CHAT_SEND_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ ok: false, code: "timeout" });
  });

  it("sends report frames with the message id and reason", () => {
    const api = makeApi();
    const { client, socket } = online(api, "global", [msg("1-a")]);
    client.report("1-a", "abuse");
    expect(socket.sent.at(-1)).toEqual({ t: "report", id: "1-a", reason: "abuse" });
  });
});

describe("chat reconnects and close codes", () => {
  it("reconnects with backoff after a dropped socket and resumes with a new welcome", async () => {
    const api = makeApi();
    const { client, socket } = online(api);
    socket.drop(1006);
    expect(client.getView().status).toBe("offline");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeChatSocket.instances).toHaveLength(2);
    const next = FakeChatSocket.instances[1];
    next?.open();
    next?.frame({
      t: "welcome",
      channel: "global",
      self: { accountId: "acc-1", displayName: "Me" },
      history: [],
      mutedUntil: null,
      blocked: [],
    });
    expect(client.getView().status).toBe("online");
  });

  it("waits the longest backoff after 4429 (per-IP connect limit), then reconnects", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.9);
    try {
      const api = makeApi();
      const { client, socket } = online(api);
      socket.drop(4429);
      expect(client.getView().status).toBe("offline");
      // A plain drop would retry after 0.9 x 500 ms; 4429 jumps to 0.9 x 10 s.
      await vi.advanceTimersByTimeAsync(8_000);
      expect(FakeChatSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(FakeChatSocket.instances).toHaveLength(2);
    } finally {
      random.mockRestore();
    }
  });

  it("does not reconnect after 4401 and marks the channel offline", async () => {
    const api = makeApi();
    const { client, socket } = online(api);
    socket.drop(4401);
    expect(client.getView()).toMatchObject({
      status: "offline",
      error: { code: "unauthorized" },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeChatSocket.instances).toHaveLength(1);
  });

  it("closes the channel with a forbidden error on 4403 and does not reconnect", async () => {
    const api = makeApi();
    const { client, socket } = online(api);
    socket.drop(4403);
    expect(client.getView()).toMatchObject({ status: "closed", error: { code: "forbidden" } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeChatSocket.instances).toHaveLength(1);
  });

  it("a join after 4401 opens a fresh socket (after sign-in)", () => {
    const api = makeApi();
    const { socket } = online(api);
    socket.drop(4401);
    api.join("global");
    expect(FakeChatSocket.instances).toHaveLength(2);
  });

  it("stops reconnecting once the last handle is closed", async () => {
    const api = makeApi();
    const { client, socket } = online(api);
    socket.drop(1006);
    client.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeChatSocket.instances).toHaveLength(1);
  });
});
