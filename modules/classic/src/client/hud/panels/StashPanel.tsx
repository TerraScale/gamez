/** Stash chest: take items out, put bag items in (panel "stash"). */
import { ACTION } from "../../../actions.ts";
import type { ItemView } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, Section, type SlotProps } from "../common.tsx";
import { fmtInt, pluralize, rarityHex } from "../format.ts";
import { ItemIcon } from "../icons.tsx";
import { C, labelStyle } from "../styles.ts";

function Entry({
  item,
  action,
  label,
  onAct,
}: {
  item: ItemView;
  action: string;
  label: string;
  onAct: () => void;
}) {
  const color = rarityHex(item.rarity);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 0",
        borderBottom: `1px dashed ${C.faint}`,
      }}
    >
      <ItemIcon category={item.category} color={color} size={28} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color, fontWeight: 600 }}>{item.name}</div>
        <div style={labelStyle}>{item.lines.join(" · ")}</div>
      </div>
      <Btn label={`${action} ${item.name}`} onClick={onAct}>
        {label}
      </Btn>
    </div>
  );
}

export function StashPanel({ api }: SlotProps) {
  const stash = useSelect(api.hud, (s) => s.stash);
  const size = useSelect(api.hud, (s) => s.stashSize);
  const bag = useSelect(api.hud, (s) => s.inventory.items.map((p) => p.item));
  const inTown = useSelect(api.hud, (s) => s.area?.isTown ?? false);
  return (
    <PanelFrame
      api={api}
      id="stash"
      title="Stash"
      width={440}
      subtitle={`${fmtInt(stash.length)} of ${pluralize(size, "slot")}${inTown ? "" : " · the stash is in town"}`}
    >
      <Section title="In the stash">
        {stash.length === 0 ? <p style={labelStyle}>The stash is empty.</p> : null}
        {stash.map((item) => (
          <Entry
            key={item.uid}
            item={item}
            action="Take"
            label="Take"
            onAct={() => api.act(ACTION.stashTake, { uid: item.uid })}
          />
        ))}
      </Section>
      <Section title="In your bag">
        {bag.length === 0 ? <p style={labelStyle}>Your bag is empty.</p> : null}
        {bag.map((item) => (
          <Entry
            key={item.uid}
            item={item}
            action="Put"
            label="Put"
            onAct={() => api.act(ACTION.stashPut, { uid: item.uid })}
          />
        ))}
      </Section>
    </PanelFrame>
  );
}
