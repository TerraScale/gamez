/**
 * Wave B e2e: chat (docs/design/wave-B.md §5). Two fresh guests talk in
 * "global": delivery, word masking, Llama Guard stand-in (the stub moderator)
 * hides a "[unsafe-test]" line, guests cannot post links, the rate limit (guests:
 * 3 at once, then one per 5 s) answers rate_limited, a block stops delivery, and
 * a report lands in D1 chat_report exactly once (poll up to 20 s). OWNER: T-chat.
 */
import type { ChatMessage, ChatServerMessage } from "@gamez/protocol";
import { loginGuest } from "./client.ts";
import { ChatBot } from "./chat-client.ts";
import type { E2eFeature } from "./features.ts";
import { check } from "./report.ts";

const isWelcome = (m: ChatServerMessage): m is Extract<ChatServerMessage, { t: "welcome" }> =>
  m.t === "welcome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Guest buckets refill one message per 5 s; wait a little over that. */
const GUEST_REFILL_MS = 5500;

/** The message a bot received with this id, or undefined. */
function messageWithId(bot: ChatBot, id: string): ChatMessage | undefined {
  return bot.frames("message").find((f) => f.msg.id === id)?.msg;
}

export const chatFeature: E2eFeature = {
  name: "chat",
  async run(ctx) {
    const [guestA, guestB] = await Promise.all([loginGuest(ctx.url), loginGuest(ctx.url)]);
    const a = new ChatBot(ctx.url, guestA.token, "global", "A");
    const b = new ChatBot(ctx.url, guestB.token, "global", "B");
    try {
      await Promise.all([a.opened, b.opened]);
      const [wa, wb] = await Promise.all([
        a.waitFor("welcome", isWelcome),
        b.waitFor("welcome", isWelcome),
      ]);
      check(
        wa.self.accountId === guestA.accountId &&
          wb.channel === "global" &&
          wa.blocked.length === 0,
        "chat: both guests get a global welcome",
      );

      // 1. A talks, B hears it.
      const ackHello = await a.outcome(a.say("hello from A", "hi-1"));
      const heard = await b.waitFor(
        "A's line at B",
        (m): m is Extract<ChatServerMessage, { t: "message" }> =>
          m.t === "message" && m.msg.id === (ackHello.t === "ack" ? ackHello.id : ""),
      );
      check(
        ackHello.t === "ack" &&
          heard.msg.text === "hello from A" &&
          heard.msg.from === guestA.accountId,
        "chat: B receives A's line (acked, attributed)",
      );

      // 2. A masked word arrives masked.
      const ackMask = await a.outcome(a.say("damn it", "mask-1"));
      const maskedId = ackMask.t === "ack" ? ackMask.id : "";
      await b.waitFor(
        "masked line at B",
        (m): m is Extract<ChatServerMessage, { t: "message" }> =>
          m.t === "message" && m.msg.id === maskedId,
      );
      const masked = messageWithId(b, maskedId)?.text ?? "";
      check(
        masked === "**** it" && !/damn/i.test(masked),
        `chat: a listed word is masked at B (got "${masked}")`,
      );

      // 3. "[unsafe-test]" is delivered, then hidden by moderation.
      const ackUnsafe = await a.outcome(a.say("[unsafe-test] hi there", "unsafe-1"));
      const unsafeId = ackUnsafe.t === "ack" ? ackUnsafe.id : "";
      const hidden = await b.waitFor(
        "hidden notice for the unsafe line",
        (m): m is Extract<ChatServerMessage, { t: "hidden" }> =>
          m.t === "hidden" && m.ids.includes(unsafeId),
        10_000,
      );
      check(hidden.ids.includes(unsafeId), "chat: a stub-unsafe line is hidden for everyone");

      // 4. Guests cannot post links: the guest bucket still has a token after one refill.
      await sleep(GUEST_REFILL_MS);
      const link = await a.outcome(a.say("see https://example.com", "link-1"));
      check(
        link.t === "error" && link.code === "filtered",
        `chat: a guest's link is refused (${link.t === "error" ? link.code : "acked"})`,
      );

      // 5. Ten quick sends: the guest bucket is empty, so they are rate limited.
      const burst: string[] = [];
      for (let i = 1; i <= 10; i++) burst.push(a.say(`spam line ${i} ${Date.now()}`, `spam-${i}`));
      let limited = 0;
      for (const n of burst) {
        const out = await a.outcome(n);
        if (out.t === "error" && out.code === "rate_limited") limited++;
      }
      check(limited >= 8, `chat: 10 quick sends -> rate_limited (${limited} of 10 refused)`);

      // 6. B blocks A: A's next line never reaches B.
      await sleep(GUEST_REFILL_MS);
      const beforeBlock = b.log.length;
      b.send({ t: "block", accountId: guestA.accountId, blocked: true });
      const blocked = await b.waitFor(
        "B's block list",
        (m): m is Extract<ChatServerMessage, { t: "blocked" }> => m.t === "blocked",
        10_000,
        beforeBlock,
      );
      check(blocked.blocked.includes(guestA.accountId), "chat: B's block list holds A");
      const ackAfter = await a.outcome(a.say("after the block", "block-1"));
      check(ackAfter.t === "ack", "chat: A's line after the block is still acked to A");
      await sleep(1500);
      const leaked = b.log.some(
        (r) => r.msg.t === "message" && r.msg.msg.text === "after the block",
      );
      check(!leaked, "chat: B does not receive A's line after the block");

      // 7. B reports A's first line. D1 gets one row, even when reported twice.
      const reportId = ackHello.t === "ack" ? ackHello.id : "";
      b.send({ t: "report", id: reportId, reason: "spam" });
      b.send({ t: "report", id: reportId, reason: "spam" });
      let rows: { reported_id: string; reason: string; channel: string }[] = [];
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        rows = await ctx.db.query<{ reported_id: string; reason: string; channel: string }>(
          "SELECT reported_id, reason, channel FROM chat_report WHERE message_id = ? AND reporter_id = ?",
          [reportId, guestB.accountId],
        );
        if (rows.length > 0) break;
        await sleep(200);
      }
      check(rows.length === 1, `chat: B's report is in D1 chat_report (rows: ${rows.length})`);
      check(
        rows[0]?.reported_id === guestA.accountId &&
          rows[0]?.reason === "spam" &&
          rows[0]?.channel === "global",
        "chat: the D1 row names the reported account, the reason and the channel",
      );
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  },
};
