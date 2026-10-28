import { useCallback, useEffect, useMemo, useState } from "react";
import { classicGalleryView } from "@gamez/mode-classic/client";
import type { AssetManifest } from "@gamez/assets";
import type { ModeInfo } from "@gamez/protocol";
import type { ClientModeView, ClientServices, Session } from "@gamez/ui-host";
import { findModeView } from "../modes/index.ts";
import { getSession } from "../session.ts";
import { loadManifest, createServices, modeInfos } from "./services.ts";
import { ModeHost } from "./ModeHost.tsx";
import { ModePicker } from "./ModePicker.tsx";
import "./app.css";

type Boot =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; session: Session; manifest: AssetManifest };

interface Running {
  view: ClientModeView;
  services: ClientServices;
}

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

function QaGallery({ boot }: { boot: { session: Session; manifest: AssetManifest } }) {
  const services = useMemo(() => createServices(boot, leaveQa), [boot]);
  return <ModeHost view={classicGalleryView} services={services} onExit={leaveQa} />;
}

export function App() {
  const [boot, setBoot] = useState<Boot>(LOADING);
  const [attempt, setAttempt] = useState(0);
  const [running, setRunning] = useState<Running | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([getSession(), loadManifest()]).then(
      ([session, manifest]) => {
        if (live) setBoot({ status: "ready", session, manifest });
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

  const exit = useCallback(() => setRunning(null), []);

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

  if (running) {
    return <ModeHost view={running.view} services={running.services} onExit={exit} />;
  }

  const pick = (mode: ModeInfo) => {
    const view = findModeView(mode.id);
    if (!view) return;
    const services = createServices(boot, exit);
    setRunning({ view, services });
  };

  return (
    <ModePicker
      session={boot.session}
      modes={MODE_LIST}
      isAvailable={(id) => findModeView(id) !== undefined}
      onPick={pick}
    />
  );
}
