/** Four potion slots with counts and the Q W E R keys (classic.hud.bottom). */
import { useSelect } from "../hooks.ts";
import { Btn, useCompact, type SlotProps } from "../common.tsx";
import { bottomOrder } from "../layout.ts";
import { fmtInt } from "../format.ts";
import { PotionIcon } from "../icons.tsx";
import { C, labelStyle } from "../styles.ts";

export function Belt({ api }: SlotProps) {
  const belt = useSelect(api.hud, (s) => s.belt);
  const compact = useCompact(api);
  const size = compact ? 44 : 52;
  return (
    <div
      role="toolbar"
      aria-label="Belt"
      style={{
        order: bottomOrder(compact, "belt"),
        flexBasis: compact ? "100%" : undefined,
        display: "flex",
        justifyContent: "center",
        gap: compact ? 4 : 6,
        pointerEvents: "none",
      }}
    >
      {belt.map((slot, i) => {
        const empty = slot.base === null || slot.count <= 0;
        const label = empty
          ? `Empty belt slot ${slot.key}`
          : `${slot.name} x${fmtInt(slot.count)} (key ${slot.key})`;
        return (
          <Btn
            key={slot.slot}
            label={label}
            title={label}
            disabled={empty}
            onClick={() => api.drink(i)}
            minWidth={size}
            height={size}
            style={{
              position: "relative",
              width: size,
              padding: 0,
              overflow: "hidden",
              borderRadius: 8,
              background: C.slot,
              border: `1px solid ${C.border}`,
              opacity: empty ? 0.45 : 1,
            }}
          >
            <span
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <PotionIcon kind={empty ? null : slot.kind} size={size - 16} />
            </span>
            <span
              style={{
                position: "absolute",
                top: 2,
                left: 4,
                fontSize: 11,
                fontWeight: 700,
                color: C.goldBright,
                textShadow: "0 1px 2px #000",
              }}
            >
              {slot.key}
            </span>
            <span
              style={{
                ...labelStyle,
                position: "absolute",
                bottom: 1,
                right: 3,
                fontSize: 11,
                color: C.text,
              }}
            >
              {fmtInt(slot.count)}
            </span>
          </Btn>
        );
      })}
    </div>
  );
}
