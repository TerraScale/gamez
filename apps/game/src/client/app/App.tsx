import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetManifest } from "@gamez/assets";
import type { ModeInfo } from "@gamez/protocol";
import {
  accountChangeText,
  type AccountChange,
  type ClientModeView,
  type PlatformServices,
  type Session,
} from "@gamez/ui-host";
import { findModeView, galleryView } from "../modes/index.ts";
import {
  consumeAuthFragment,
  getSession,
  loadSession,
  onSessionChange,
  setSession,
} from "../session.ts";
import { redeemOAuthLink } from "../platform/auth.ts";
import { createPlatform } from "../platform/index.ts";
import { loadManifest, createServices, modeInfos } from "./services.ts";
import { ModeHost } from "./ModeHost.tsx";
import { ModePicker } from "./ModePicker.tsx";
import { ShellSheets } from "./ShellSheets.tsx";
import { Toast } from "./Toast.tsx";
import { applyAuthFragment, applyOAuthLink, type Notice } from "./notices.ts";
import { clearShellFragment, firstPaidReturn, parseShellFragment } from "./fragments.ts";
import {
  flagOn,
  noticeTarget,
  pushItem,
  screenFlag,
  visibleEntries,
  type ShellItem,
} from "./screens.ts";
import { useAccount } from "./useAccount.ts";
import { useFeatureFlags, useNotices } from "./useShellData.ts";
import "./app.css";

/** Notice display time (ms). */
const NOTICE_MS = 5000;

/** The live-ops dashboard (#admin): loaded only when asked for. */
const AdminScreen = lazy(() =>
  import("../admin/index.tsx").then((m) => ({ default: m.AdminScreen })),
);

type Boot =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | {
      status: "ready";
      session: Session;
      manifest: AssetManifest;
      platform: PlatformServices | undefined;
    };

const LOADING: Boot = { status: "loading" };
const MODE_LIST = modeInfos();

/** `?qa=gallery`: the classic QA gallery (tools/qa), not reachable from the picker. */
function qaRoute(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("qa");
  } catch {
    return null;
  }
}
const QA_ROUTE = qaRoute();

function leaveQa(): void {
  window.location.assign("/");
}

function QaGallery({ boot }: { boot: Extract<Boot, { status: "ready" }> }) {
  const services = useMemo(() => createServices(boot, leaveQa), [boot]);
  return <ModeHost view={galleryView} services={services} onExit={leaveQa} />;
}

export function App() {
  const [boot, setBoot] = useState<Boot>(LOADING);
  const [attempt, setAttempt] = useState(0);
  const [running, setRunning] = useState<ClientModeView | null>(null);
  /** Shell sheets, bottom first. They stack over the picker and over a running mode. */
  const [stack, setStack] = useState<ShellItem[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  /** Latest session for the platform SDK, which reads it per request. */
  const sessionRef = useRef<Session | null>(null);

  const ready = boot.status === "ready" ? boot : null;
  const platform = ready?.platform;
  const token = ready?.session.token ?? "";
  const { account, refresh } = useAccount(platform, token);
  const flags = useFeatureFlags(platform?.config, token);
  // Read by openShell, which must stay stable: services (and the running mode) depend on it.
  const flagsRef = useRef(flags);
  useEffect(() => {
    flagsRef.current = flags;
  }, [flags]);

  const exit = useCallback(() => setRunning(null), []);
  const notify = useCallback((n: Notice) => setNotice(n), []);
  const closeFrom = useCallback((index: number) => setStack((s) => s.slice(0, index)), []);

  /** Opens a sheet unless its feature is switched off (wave C §9.2 kill switches). */
  const openShell = useCallback((item: ShellItem) => {
    if (!flagOn(flagsRef.current, screenFlag(item))) {
      setNotice({ tone: "info", text: "That is not available right now." });
      return;
    }
    setStack((s) => pushItem(s, item));
  }, []);

  const inbox = useNotices(platform?.vault, ready !== null, (n) => {
    notify({
      tone: "info",
      text: n.text,
      action: {
        label: "Open",
        run: () => {
          setNotice(null);
          openShell(noticeTarget(n) ?? { id: "notices" });
        },
      },
    });
  });

  // The bell is stale after the inbox sheet closes: read it again.
  const hasNotices = stack.some((s) => s.id === "notices");
  const hadNotices = useRef(false);
  const refreshInbox = inbox.refresh;
  useEffect(() => {
    if (hadNotices.current && !hasNotices) refreshInbox();
    hadNotices.current = hasNotices;
  }, [hasNotices, refreshInbox]);

  // A session change (login, register, logout, OAuth return) replaces the boot session.
  // Services derive from boot, so a running mode is remounted with the new session.
  useEffect(
    () =>
      onSessionChange(() => {
        const s = loadSession();
        if (!s) return;
        sessionRef.current = s;
        setBoot((b) => (b.status === "ready" ? { ...b, session: s } : b));
      }),
    [],
  );

  // Boot: OAuth return first (it may replace the stored session), then the guest session and manifest.
  // ADR 0007 R4: only a return this tab started counts. A link return is
  // redeemed with the current session as the bearer (R3).
  useEffect(() => {
    let live = true;
    const fragment = consumeAuthFragment();
    const fromOauth = applyAuthFragment(fragment, setSession);
    if (fromOauth) setNotice(fromOauth);
    const linkCode = fragment !== null && "link" in fragment ? fragment.link : null;
    const sessionReady = getSession().then(async (current) => {
      if (linkCode === null) return current;
      const linked = await applyOAuthLink(linkCode, current, redeemOAuthLink, setSession);
      if (live) setNotice(linked.notice);
      return linked.session;
    });
    Promise.all([sessionReady, loadManifest()]).then(
      ([session, manifest]) => {
        if (!live) return;
        sessionRef.current = session;
        const platform = createPlatform(() => sessionRef.current ?? session);
        setBoot({ status: "ready", session, manifest, platform });
      },
      (err: unknown) => {
        if (live)
          setBoot({ status: "failed", message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  // Payment returns (#store=paid|cancel) and #admin, on boot and on later hash changes (wave C §10.4).
  const isReady = ready !== null;
  useEffect(() => {
    if (!isReady) return;
    const apply = () => {
      const fragment = parseShellFragment(window.location.hash);
      if (fragment === null) return;
      clearShellFragment();
      if (fragment.kind === "admin") {
        setAdminOpen(true);
        return;
      }
      if (fragment.outcome === "paid") {
        setNotice({
          tone: "ok",
          text: firstPaidReturn(fragment.order) ? "Purchase complete." : "Order already confirmed.",
        });
        // The webhook fulfils the order; re-read the account so the new balance shows.
        platform?.account.wallet().then(
          () => refresh(),
          () => refresh(),
        );
      } else {
        setNotice({ tone: "info", text: "Checkout cancelled." });
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [isReady, platform, refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // Services are rebuilt whenever the boot data changes (session change included).
  const services = useMemo(
    () => (running && ready ? createServices(ready, exit, openShell) : null),
    [running, ready, exit, openShell],
  );

  const retry = () => {
    setBoot(LOADING);
    setAttempt((n) => n + 1);
  };

  if (boot.status === "loading") return <p className="screen-message">Loading…</p>;
  if (boot.status === "failed") {
    return (
      <div className="screen-message">
        <p>Could not sign in: {boot.message}</p>
        <button type="button" className="primary" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }

  if (QA_ROUTE === "gallery") return <QaGallery boot={boot} />;

  const pick = (mode: ModeInfo) => {
    const view = findModeView(mode.id);
    if (view) setRunning(view);
  };

  const onAccountChanged = (change: AccountChange) => {
    refresh();
    notify({ tone: "ok", text: accountChangeText(change) });
  };

  return (
    <>
      {running && services ? (
        <ModeHost view={running} services={services} onExit={exit} />
      ) : (
        <ModePicker
          key={boot.session.token}
          session={boot.session}
          modes={MODE_LIST}
          isAvailable={(id) => findModeView(id) !== undefined}
          onPick={pick}
          platform={platform}
          account={account}
          onOpenAccount={() => openShell({ id: "account" })}
          onOpenLeaderboards={() => openShell({ id: "leaderboards" })}
          onOpenGuild={() => openShell({ id: "guild" })}
          economy={{
            entries: visibleEntries(platform, flags),
            unread: inbox.unread,
            onOpen: openShell,
          }}
        />
      )}
      <ShellSheets
        items={stack}
        platform={platform}
        session={boot.session}
        account={account}
        onCloseFrom={closeFrom}
        onOpen={openShell}
        onAccountChanged={onAccountChanged}
        onRefreshAccount={refresh}
        onCheckout={(url) => window.location.assign(url)}
      />
      {adminOpen ? (
        <div className="admin-layer">
          <Suspense fallback={<p className="screen-message">Loading…</p>}>
            <AdminScreen
              session={boot.session}
              platform={platform}
              onClose={() => setAdminOpen(false)}
            />
          </Suspense>
        </div>
      ) : null}
      <Toast notice={notice} />
    </>
  );
}
