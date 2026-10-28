/** Hero buffs and debuffs: a chip per status with its name and seconds left (classic.hud.target). */
import { hex } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import type { SlotProps } from "../common.tsx";
import { C, panelStyle } from "../styles.ts";

export function StatusBar({ api }: SlotProps) {
  const statuses = useSelect(api.hud, (s) => s.hero?.statuses ?? EMPTY);
  if (statuses.length === 0) return null;
  return (
    <ul
      aria-label="Hero statuses"
      style={{
        listStyle: "none",
        margin: "0 0 6px",
        padding: 0,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: 6,
      }}
    >
      {statuses.map((s) => (
        <li
          key={s.id}
          title={`${s.name}: ${s.secondsLeft}s left`}
          style={{
            ...panelStyle,
            padding: "3px 8px",
            fontSize: 12,
            fontWeight: 600,
            color: s.kind === "buff" ? C.goldBright : hex(s.tint || 0xff8080),
            borderColor: hex(s.tint || 0x808080),
          }}
        >
          {`${s.name} ${s.secondsLeft}s`}
        </li>
      ))}
    </ul>
  );
}

const EMPTY: readonly never[] = [];
