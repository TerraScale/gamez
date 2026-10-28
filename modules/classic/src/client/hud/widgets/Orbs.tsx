/** Life and mana orbs: liquid fill inside a round frame, value text on top (classic.hud.bottom). */
import { useSelect } from "../hooks.ts";
import { useHudLayout, type SlotProps } from "../common.tsx";
import { bottomOrderFor } from "../layout.ts";
import { fillPercent, fmtInt } from "../format.ts";
import { C } from "../styles.ts";

interface OrbViewProps {
  label: string;
  cur: number;
  max: number;
  color: string;
  lighter: string;
  dark: string;
  order: number;
  marginLeft?: string;
  marginRight?: string;
  compact: boolean;
}

function OrbView({
  label,
  cur,
  max,
  color,
  lighter,
  dark,
  order,
  marginLeft,
  marginRight,
  compact,
}: OrbViewProps) {
  const size = compact ? 64 : 96;
  const text = `${fmtInt(cur)} / ${fmtInt(max)}`;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={cur}
      title={`${label}: ${text}`}
      style={{
        pointerEvents: "auto",
        order,
        marginLeft,
        marginRight,
        alignSelf: "flex-end",
        position: "relative",
        width: size,
        height: size,
        flex: "none",
        borderRadius: "50%",
        overflow: "hidden",
        background: dark,
        border: `2px solid ${C.border}`,
        boxShadow: "0 4px 14px rgba(0, 0, 0, 0.55), inset 0 0 14px rgba(0, 0, 0, 0.7)",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: `${fillPercent(cur, max)}%`,
          background: `linear-gradient(to top, ${color}, ${lighter})`,
          transition: "height 150ms linear",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          textShadow: "0 1px 3px #000",
          lineHeight: 1.15,
          pointerEvents: "none",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: compact ? 13 : 16 }}>{fmtInt(cur)}</span>
        <span style={{ fontSize: 11, opacity: 0.9 }}>{`/ ${fmtInt(max)}`}</span>
      </div>
    </div>
  );
}

export function LifeOrb({ api }: SlotProps) {
  const hero = useSelect(api.hud, (s) =>
    s.hero ? { life: s.hero.life, lifeMax: s.hero.lifeMax } : null,
  );
  const layout = useHudLayout(api);
  if (!hero) return null;
  return (
    <OrbView
      label="Life"
      cur={hero.life}
      max={hero.lifeMax}
      color={C.life}
      lighter="#e8574a"
      dark={C.lifeDark}
      order={bottomOrderFor(layout, "life")}
      // Short layout: the orb sits in the left corner and the belt and skills centre between the orbs.
      marginRight={layout === "short" ? "auto" : undefined}
      compact={layout !== "desktop"}
    />
  );
}

export function ManaOrb({ api }: SlotProps) {
  const hero = useSelect(api.hud, (s) =>
    s.hero ? { mana: s.hero.mana, manaMax: s.hero.manaMax } : null,
  );
  const layout = useHudLayout(api);
  if (!hero) return null;
  return (
    <OrbView
      label="Mana"
      cur={hero.mana}
      max={hero.manaMax}
      color={C.mana}
      lighter="#5b9cf0"
      dark={C.manaDark}
      order={bottomOrderFor(layout, "mana")}
      marginLeft={layout !== "desktop" ? "auto" : undefined}
      compact={layout !== "desktop"}
    />
  );
}
