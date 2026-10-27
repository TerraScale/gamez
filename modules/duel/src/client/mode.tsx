/**
 * Duel client entry: mounts the React screen into the app's host and wires
 * its actions to the instance connection (predicted locally, reconciled by
 * the server). Cleanup unmounts React and closes the connection.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ClientModeView, InstanceConnection, InstanceView } from "@gamez/ui-host";
import { buildBattleView, describeEvent } from "./model.ts";
import { DuelScreen, type LogLine } from "./screen.tsx";

/** Most recent log lines kept on screen. */
const LOG_LIMIT = 120;

function DuelApp({ conn }: { conn: InstanceConnection }) {
  const [view, setView] = useState<InstanceView>(() => conn.getView());
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const alive = useRef(true);
  const nextId = useRef(0);

  useEffect(() => {
    alive.current = true;
    const off = conn.subscribe(setView);
    return () => {
      alive.current = false;
      off();
    };
  }, [conn]);

  const send = useCallback(
    async (name: string, payload: unknown) => {
      setBusy(true);
      try {
        const res = await conn.act(name, payload);
        if (res.ok && alive.current) {
          const texts = res.events.map(describeEvent).filter((t): t is string => t !== null);
          if (texts.length > 0) {
            const first = nextId.current;
            nextId.current += texts.length;
            setLog((prev) =>
              [...prev, ...texts.map((text, i) => ({ id: first + i, text }))].slice(-LOG_LIMIT),
            );
          }
        }
        return res;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [conn],
  );

  const screen = view.world ? buildBattleView(view.world, conn.loaded.registry) : null;

  return (
    <DuelScreen
      view={screen}
      status={view.status}
      error={view.error}
      log={log}
      busy={busy}
      switchOpen={switchOpen}
      onMove={(moveId) => void send("duel.useMove", { moveId })}
      onSwitch={(slot) =>
        void send("duel.switch", { slot }).then((res) => {
          if (res.ok) setSwitchOpen(false);
        })
      }
      onCapture={() => void send("duel.capture", null)}
      onFlee={() => void send("duel.flee", null)}
      onNext={() => void send("duel.nextBattle", null)}
      onHeal={() => void send("duel.heal", null)}
      onToggleSwitch={() => setSwitchOpen((open) => !open)}
    />
  );
}

export const duelView: ClientModeView = {
  modeId: "duel",
  mount(host, services) {
    const conn = services.connectInstance("duel");
    const root = createRoot(host);
    root.render(<DuelApp conn={conn} />);
    return () => {
      root.unmount();
      conn.close();
    };
  },
};
