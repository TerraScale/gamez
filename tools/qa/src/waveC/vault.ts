/**
 * Wave C QA scenario: vault-waiting (ADR 0006 §13). OWNER: T-escrow.
 *
 *   vault-waiting  over HTTP: two guests register, B's vault is filled to its
 *                  limit with dev grants, A trades one item to B and both
 *                  accept, so the delivery waits in custody. The page then
 *                  loads as B: the Vault sheet must show the "deliveries are
 *                  waiting" banner, and the Notices sheet the vault.full notice.
 *
 *   node tools/qa/src/run.ts vault-waiting --url http://127.0.0.1:<port> [--viewport phone]
 */
import { openPicker, type Run } from "../run.ts";
import type { Runner } from "./index.ts";

const SESSION_KEY = "gamez.guest.v1";
const VAULT_MAX = 200;
const GRANT_BATCH = 20;

interface Session {
  token: string;
  accountId: string;
  name: string;
  kind: string;
}

async function call<T>(
  base: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

/** A registered account: guest login, then register in place. */
async function registered(base: string, label: string): Promise<Session> {
  const res = await fetch(`${base}/api/guest`, { method: "POST" });
  const guest = { body: (await res.json()) as { token: string; accountId: string } };
  const reg = await call<{ token: string; account: { accountId: string; displayName: string } }>(
    base,
    "/api/auth/register",
    guest.body.token,
    { email: `${label}@example.test`, password: "vault-password-123", displayName: label },
  );
  if (reg.status !== 200) throw new Error(`register ${label}: HTTP ${reg.status}`);
  return {
    token: reg.body.token,
    accountId: reg.body.account.accountId,
    name: reg.body.account.displayName,
    kind: "registered",
  };
}

function dust(i: number) {
  return {
    itemId: "universal.material.ember_dust",
    origin: "",
    count: 1,
    universal: true,
    tradable: true,
    summary: {
      name: "Ember Dust",
      rarity: "common",
      level: 0,
      category: "material",
      slot: null,
      icon: "item.ember_dust",
      lines: [`#${i}`],
    },
    data: null,
  };
}

async function openSheet(run: Run, button: string, title: string): Promise<void> {
  const clicked = await run.page.evaluate<boolean>(
    `(() => { const re = new RegExp(${JSON.stringify(button)}, "i");
      const b = [...document.querySelectorAll(".economy-bar button")].find((el) => re.test((el.innerText || el.getAttribute("aria-label") || "").trim()));
      if (!b) return false; b.click(); return true; })()`,
  );
  if (!clicked) throw new Error(`no ${button} button in the economy bar`);
  await run.page.waitFor(
    `document.querySelector('.sheet-backdrop:not([hidden]) h2')?.textContent === ${JSON.stringify(title)}`,
    10_000,
  );
  await run.page
    .waitFor(
      `!(document.querySelector('.sheet-backdrop:not([hidden]) .sheet-body')?.textContent ?? '').includes('Loading')`,
      20_000,
    )
    .catch(() => undefined);
  await run.page.wait(400);
}

async function vaultWaiting(run: Run): Promise<void> {
  const base = run.args.url;
  const stamp = Date.now().toString(36).slice(-6);
  const a = await registered(base, `VaultA${stamp}`);
  const b = await registered(base, `VaultB${stamp}`);

  const gift = await call<{ items?: { uid: string }[] }>(base, "/api/dev/economy/grant", a.token, {
    opId: `qa-vw-a-${stamp}`,
    items: [dust(0)],
  });
  for (let n = 0; n * GRANT_BATCH < VAULT_MAX; n++) {
    const items = Array.from({ length: GRANT_BATCH }, (_, i) => dust(n * GRANT_BATCH + i));
    await call(base, "/api/dev/economy/grant", b.token, { opId: `qa-vw-b-${stamp}-${n}`, items });
  }
  const opened = await call<{ id: string }>(base, "/api/trade", a.token, {
    opId: `qa-vw-open-${stamp}`,
    with: b.accountId,
  });
  const id = opened.body.id;
  await call(base, `/api/trade/${id}/offer`, a.token, {
    coin: 0,
    uids: [gift.body.items?.[0]?.uid],
  });
  const offer = await call<{ offers: { a: { version: number }; b: { version: number } } }>(
    base,
    `/api/trade/${id}/offer`,
    b.token,
    { coin: 0, uids: [] },
  );
  const versions = [offer.body.offers.a.version, offer.body.offers.b.version];
  await call(base, `/api/trade/${id}/accept`, a.token, { versions });
  const accepted = await call<{ status: string }>(base, `/api/trade/${id}/accept`, b.token, {
    versions,
  });
  run.check("the trade waits in custody", accepted.body.status === "committing", accepted.body);
  const vault = await call<{ items: unknown[]; waiting?: { count: number } }>(
    base,
    "/api/account/vault",
    b.token,
  );
  run.check("the vault API reports 1 waiting delivery", vault.body.waiting?.count === 1, {
    items: vault.body.items.length,
    waiting: vault.body.waiting,
  });

  // The page as B.
  await openPicker(run, "");
  await run.page.evaluate<void>(
    `localStorage.setItem(${JSON.stringify(SESSION_KEY)}, ${JSON.stringify(JSON.stringify(b))})`,
  );
  await run.page.open(run.url(""));
  await run.page.waitFor("document.querySelector('.economy-bar') !== null", 30_000);
  await run.page.wait(500);

  await openSheet(run, "^Vault$", "Vault");
  const banner = await run.page.evaluate<string | null>(
    `[...document.querySelectorAll('.sheet-backdrop:not([hidden]) [role=status]')].map((p) => p.textContent).find((t) => /waiting for a free slot/.test(t ?? "")) ?? null`,
  );
  await run.shot("vault-waiting");
  run.check("the Vault sheet shows the waiting banner", banner !== null, banner);
  const layout = await run.page.evaluate<{ scrollW: number; innerW: number }>(
    "({ scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth })",
  );
  run.check("no horizontal scroll with the banner", layout.scrollW <= layout.innerW, layout);
  await run.page.press("Escape");
  await run.page.waitFor("document.querySelectorAll('.sheet-backdrop').length === 0", 5_000);

  await openSheet(run, "Inbox|Notices", "Notices");
  const notice = await run.page.evaluate<boolean>(
    `(document.querySelector('.sheet-backdrop:not([hidden]) .sheet-body')?.textContent ?? '').includes('Your vault is full')`,
  );
  await run.shot("notices-vault-full");
  run.check("the inbox lists the vault.full notice", notice);
}

export const VAULT_RUNNERS: Record<string, Runner> = {
  "vault-waiting": vaultWaiting,
};
