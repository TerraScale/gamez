/**
 * Admin / live-ops dashboard (wave-C.md §9.3, route "#admin"). OWNER: T-admin.
 * T-shell lazy-loads this module and renders <AdminScreen>. Data and actions
 * live here; the parts are in dashboard.tsx and charts.tsx.
 */
import { useCallback, useEffect, useState } from "react";
import type { FeatureFlag } from "@gamez/protocol";
import type { PlatformServices, Session } from "@gamez/ui-host";
import {
  hideMessage,
  isDevHostname,
  loadAdminData,
  makeDevAdmin,
  muteAccount,
  setFlag,
  type AdminData,
} from "./api.ts";
import {
  EconomyCharts,
  FlagsPanel,
  ModerationPanel,
  NotAdmin,
  Tiles,
  WindowPicker,
} from "./dashboard.tsx";
import { ADMIN_CSS } from "./styles.ts";

export interface AdminScreenProps {
  session: Session;
  platform: PlatformServices | undefined;
  onClose: () => void;
}

const WINDOWS = [7, 14, 30];

type Loaded =
  | { state: "loading" }
  | { state: "ready"; data: AdminData }
  | { state: "denied"; status: number; devHost?: boolean }
  | { state: "error"; message: string };

export function AdminScreen({ session, onClose }: AdminScreenProps) {
  const token = session.token;
  const [days, setDays] = useState(14);
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [busyFlag, setBusyFlag] = useState<FeatureFlag | null>(null);
  const [status, setStatus] = useState("");
  const devHost = typeof location !== "undefined" && isDevHostname(location.hostname);

  useEffect(() => {
    let cancelled = false;
    setLoaded({ state: "loading" });
    void loadAdminData(fetch, token, days).then((res) => {
      if (cancelled) return;
      if (res.ok) setLoaded({ state: "ready", data: res.value });
      else if (res.status === 401 || res.status === 403) {
        setLoaded({ state: "denied", status: res.status, devHost: res.devHost });
      } else setLoaded({ state: "error", message: res.message });
    });
    return () => {
      cancelled = true;
    };
  }, [token, days, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const onSetFlag = async (flag: FeatureFlag, value: boolean) => {
    setBusyFlag(flag);
    setStatus("");
    const res = await setFlag(fetch, token, flag, value);
    setBusyFlag(null);
    if (res.ok) {
      setLoaded((prev) =>
        prev.state === "ready"
          ? { state: "ready", data: { ...prev.data, config: res.value } }
          : prev,
      );
      setStatus(`${flag} is now ${value ? "on" : "off"}.`);
    } else {
      setStatus(`Could not change ${flag}: ${res.message}`);
    }
  };

  const onMute = async (accountId: string, channel: string) => {
    setBusy(true);
    setStatus("");
    const res = await muteAccount(fetch, token, channel, accountId);
    setBusy(false);
    setStatus(res.ok ? "Muted for 60 minutes." : `Mute failed: ${res.message}`);
  };

  const onHide = async (channel: string, messageId: string) => {
    setBusy(true);
    setStatus("");
    const res = await hideMessage(fetch, token, channel, messageId);
    setBusy(false);
    if (res.ok) {
      setStatus("Message hidden.");
      reload();
    } else {
      setStatus(`Hide failed: ${res.message}`);
    }
  };

  const onMakeDevAdmin = async () => {
    setBusy(true);
    setStatus("");
    const res = await makeDevAdmin(fetch, token);
    setBusy(false);
    if (res.ok) reload();
    else setStatus(`Could not make you admin: ${res.message}`);
  };

  return (
    <div className="adm" data-testid="admin-screen">
      <style>{ADMIN_CSS}</style>
      <header className="adm-head">
        <div>
          <h1>Live ops</h1>
          <small>Economy, flags and moderation</small>
        </div>
        <div className="adm-row">
          {loaded.state === "ready" ? (
            <WindowPicker days={days} options={WINDOWS} onPick={setDays} />
          ) : null}
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      <p className="adm-status" role="status" aria-live="polite">
        {status}
      </p>

      {loaded.state === "loading" ? <p className="adm-muted">Loading the dashboard…</p> : null}

      {loaded.state === "denied" ? (
        <NotAdmin
          status={loaded.status}
          devHost={loaded.devHost ?? devHost}
          busy={busy}
          onMakeDevAdmin={onMakeDevAdmin}
          onClose={onClose}
        />
      ) : null}

      {loaded.state === "error" ? (
        <section className="adm-section">
          <h2>Dashboard unavailable</h2>
          <p>{loaded.message}</p>
          <div className="adm-row" style={{ marginTop: 12 }}>
            <button type="button" onClick={reload}>
              Try again
            </button>
          </div>
        </section>
      ) : null}

      {loaded.state === "ready" ? (
        <>
          <Tiles telemetry={loaded.data.telemetry} />
          <div style={{ height: 16 }} />
          <EconomyCharts telemetry={loaded.data.telemetry} />
          <div className="adm-grid two">
            <FlagsPanel
              flags={loaded.data.config.flags}
              seasonId={loaded.data.config.seasonId}
              busyFlag={busyFlag}
              onSet={onSetFlag}
            />
            <ModerationPanel
              moderation={loaded.data.moderation}
              busy={busy}
              onMute={onMute}
              onHide={onHide}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
