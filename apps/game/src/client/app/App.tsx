import { useCallback, useEffect, useState } from "react";
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
