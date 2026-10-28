/** Six skill slots with key labels, mana cost and a cooldown sweep (classic.hud.bottom). */
import { useSelect } from "../hooks.ts";
import { Btn, useHudLayout, type SlotProps } from "../common.tsx";
import { bottomOrderFor } from "../layout.ts";
import { cooldownSweepDeg, fmtInt } from "../format.ts";
import { SkillIcon } from "../icons.tsx";
import { C, labelStyle } from "../styles.ts";

const NO_TAGS: string[] = [];

export function SkillBar({ api }: SlotProps) {
  const slots = useSelect(api.hud, (s) =>
    s.skillBar.map((b) => {
      if (!b.skill) return NO_TAGS;
      return s.skills.find((k) => k.id === b.skill)?.tags ?? NO_TAGS;
    }),
  );
  const bar = useSelect(api.hud, (s) => s.skillBar);
  const layout = useHudLayout(api);
  const compact = layout !== "desktop";
  const size = compact ? 44 : 52;
  return (
    <div
      role="toolbar"
      aria-label="Skill bar"
      style={{
        order: bottomOrderFor(layout, "skill"),
        // Portrait phones put each row on its own line; the landscape band keeps them inline between the orbs.
        flexBasis: layout === "compact" ? "100%" : undefined,
        display: "flex",
        justifyContent: "center",
        gap: compact ? 4 : 6,
        pointerEvents: "none",
      }}
    >
      {bar.map((slot, i) => {
        const tags = slots[i] ?? NO_TAGS;
        const empty = slot.skill === null;
        const sweep = cooldownSweepDeg(slot.cooldownLeft, slot.cooldown);
        const label = empty ? `Empty skill slot ${slot.key}` : `${slot.name} (key ${slot.key})`;
        return (
          <Btn
            key={slot.slot}
            label={label}
            title={label}
            disabled={empty}
            onClick={() => api.castSlot(slot.slot)}
            minWidth={size}
            height={size}
            style={{
              position: "relative",
              width: size,
              padding: 0,
              overflow: "hidden",
              borderRadius: 8,
              background: C.slot,
              border: `1px solid ${slot.usable && !empty ? C.borderStrong : C.border}`,
              opacity: empty ? 0.5 : slot.usable ? 1 : 0.45,
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
              {empty ? null : (
                <SkillIcon
                  tags={tags}
                  skillId={slot.skill}
                  color={slot.usable ? C.goldBright : C.muted}
                  size={size - 18}
                />
              )}
            </span>
            {sweep > 0 ? (
              <span
                aria-hidden="true"
                data-sweep={sweep}
                style={{
                  position: "absolute",
                  inset: 0,
                  background: `conic-gradient(rgba(0, 0, 0, 0.62) ${sweep}deg, transparent 0deg)`,
                }}
              />
            ) : null}
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
            {!empty && slot.manaCost > 0 ? (
              <span
                style={{
                  ...labelStyle,
                  position: "absolute",
                  bottom: 1,
                  right: 3,
                  fontSize: 10,
                  color: C.manaLight,
                }}
              >
                {fmtInt(slot.manaCost)}
              </span>
            ) : null}
          </Btn>
        );
      })}
    </div>
  );
}
