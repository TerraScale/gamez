/** Hovered or focused enemy: name in its rarity colour, mods and life (classic.hud.target). */
import { hex } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { ProgressBar, type SlotProps } from "../common.tsx";
import { fillPercent, fmtInt, monsterHex } from "../format.ts";
import { C, labelStyle, panelStyle } from "../styles.ts";

export function TargetBar({ api }: SlotProps) {
  const target = useSelect(api.hud, (s) => s.target);
  if (!target) return null;
  const color = monsterHex(target.rarity);
  return (
    <div
      aria-label="Target"
      style={{
        ...panelStyle,
        padding: "6px 12px",
        minWidth: 200,
        maxWidth: 320,
        textAlign: "center",
      }}
    >
      <div style={{ color, fontWeight: 700 }}>
        {target.name}
        <span style={{ ...labelStyle, fontWeight: 400 }}>{` · level ${fmtInt(target.level)}`}</span>
      </div>
      {target.mods.length > 0 ? (
        <div style={{ ...labelStyle, color: hex(0xc8873a) }}>{target.mods.join(" · ")}</div>
      ) : null}
      <div style={{ margin: "4px 0 2px" }}>
        <ProgressBar
          pct={fillPercent(target.life, target.lifeMax)}
          color={C.life}
          height={8}
          label="Target life"
        />
      </div>
      <div style={labelStyle}>{`${fmtInt(target.life)} / ${fmtInt(target.lifeMax)}`}</div>
    </div>
  );
}
