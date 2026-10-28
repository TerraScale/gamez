import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetManifest } from "@gamez/assets";
import type { ModeInfo } from "@gamez/protocol";
import {
  AccountPanel,
  accountChangeText,
  GuildView,
  LeaderboardView,
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
import { createPlatform } from "../platform/index.ts";
import { loadManifest, createServices, modeInfos } from "./services.ts";
import { ModeHost } from "./ModeHost.tsx";
import { ModePicker } from "./ModePicker.tsx";
import { Sheet } from "./Sheet.tsx";
import { Toast } from "./Toast.tsx";
import { SOCIAL_CLASSES } from "./classes.ts";
import { applyAuthFragment, type Notice } from "./notices.ts";
import { useAccount } from "./useAccount.ts";
import "./app.css";

/** Notice display time (ms). */
const NOTICE_MS = 5000;

type Boot =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | {
      status: "ready";
      session: Session;
      manifest: AssetManifest;
      platform: PlatformServices | undefined;
    };

type SheetId = "account" | "leaderboards" | "guild";

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
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Latest session for the platform SDK, which reads it per request. */
  const sessionRef = useRef<Session | null>(null);

  const ready = boot.status === "ready" ? boot : null;
  const platform = ready?.platform;
  const token = ready?.session.token ?? "";
  const { account, refresh } = useAccount(platform, token);

  const exit = useCallback(() => setRunning(null), []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const notify = useCallback((n: Notice) => setNotice(n), []);

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
  useEffect(() => {
    let live = true;
    const fromOauth = applyAuthFragment(consumeAuthFragment(), setSession);
    if (fromOauth) setNotice(fromOauth);
    Promise.all([getSession(), loadManifest()]).then(
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

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // Services are rebuilt whenever the boot data changes (session change included).
  const services = useMemo(
    () => (running && ready ? createServices(ready, exit) : null),
    [running, ready, exit],
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

  if (running && services) {
    return <ModeHost view={running} services={services} onExit={exit} />;
  }

  const pick = (mode: ModeInfo) => {
    const view = findModeView(mode.id);
    if (view) setRunning(view);
  };

  return (
    <>
      <ModePicker
        key={boot.session.token}
        session={boot.session}
        modes={MODE_LIST}
        isAvailable={(id) => findModeView(id) !== undefined}
        onPick={pick}
        platform={platform}
        account={account}
        onOpenAccount={() => setSheet("account")}
        onOpenLeaderboards={() => setSheet("leaderboards")}
        onOpenGuild={() => setSheet("guild")}
      />
      {platform && sheet === "account" ? (
        <Sheet title="Account" onClose={closeSheet}>
          <AccountPanel
            auth={platform.auth}
            account={account}
            compact
            onChanged={(change) => {
              refresh();
              notify({ tone: "ok", text: accountChangeText(change) });
              // Signed out: close the sheet so the header chip is reachable again (phone).
              if (change === "signed-out") closeSheet();
            }}
          />
        </Sheet>
      ) : null}
      {platform && sheet === "leaderboards" ? (
        <Sheet title="Leaderboards" onClose={closeSheet}>
          <LeaderboardView
            api={platform.leaderboards}
            mode="classic"
            classes={SOCIAL_CLASSES}
            selfId={account?.accountId ?? null}
            compact
          />
        </Sheet>
      ) : null}
      {platform && sheet === "guild" ? (
        <Sheet title="Guild" onClose={closeSheet}>
          <GuildView
            guilds={platform.guilds}
            account={account}
            chat={platform.chat}
            compact
            onChanged={refresh}
          />
        </Sheet>
      ) : null}
      <Toast notice={notice} />
    </>
  );
}
