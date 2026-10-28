/**
 * Wave A panel "talents" (docs/design/wave-A.md §3, §10) — OWNER: T-talents.
 * Branch columns x tier rows on desktop; one branch at a time on phones
 * (segmented control). Node buttons are 44 px tall with rank pips. The details
 * area learns the selected node; the footer resets for gold in town.
 * TalentsBody is also embedded by the Skills panel's Talents tab.
 */
import { useState, type CSSProperties } from "react";
import { ACTION } from "../../../actions.ts";
import type { TalentNodeView, TalentsView } from "../../contract.ts";
import { Btn, PanelFrame, useHudLayout, type SlotProps } from "../common.tsx";
import { useSelect } from "../hooks.ts";
import { fmtInt } from "../format.ts";
import { C, FONT, labelStyle, TOUCH } from "../styles.ts";
import { talentsSummary } from "../../model/talents.ts";

const TIERS = [0, 1, 2, 3, 4] as const;

function NodePips({ rank, maxRank }: { rank: number; maxRank: number }) {
  const pips: CSSProperties = { width: 7, height: 7, borderRadius: 2, display: "inline-block" };
  return (
    <span aria-hidden="true" style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
      {Array.from({ length: maxRank }, (_, i) => (
        <span
          key={i}
          style={{
            ...pips,
            background: i < rank ? C.goldBright : "transparent",
            border: `1px solid ${i < rank ? C.goldBright : C.faint}`,
          }}
        />
      ))}
    </span>
  );
}

function NodeButton({
  node,
  selected,
  onPick,
}: {
  node: TalentNodeView;
  selected: boolean;
  onPick: () => void;
}) {
  const edge = selected ? C.goldBright : node.learnable ? C.gold : C.border;
  const state = node.rank >= node.maxRank ? ", maxed" : node.locked ? ", locked" : "";
  return (
    <button
      type="button"
      aria-label={`${node.name}, rank ${node.rank} of ${node.maxRank}${state}`}
      aria-pressed={selected}
      onClick={onPick}
      style={{
        minHeight: TOUCH,
        width: "100%",
        padding: "6px 8px",
        textAlign: "left",
        borderRadius: 8,
        border: `1px solid ${edge}`,
        boxShadow: selected ? `0 0 0 2px ${C.goldBright}` : "none",
        background: node.rank > 0 ? "rgba(243, 210, 122, 0.12)" : C.button,
        color: node.locked && node.rank === 0 ? C.faint : C.text,
        font: `600 12px/1.25 ${FONT}`,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        opacity: node.locked && node.rank === 0 ? 0.7 : 1,
        cursor: "pointer",
      }}
    >
      <span>{node.name}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <NodePips rank={node.rank} maxRank={node.maxRank} />
        {node.learnable ? (
          <span style={{ color: C.ok, fontSize: 11 }}>Ready</span>
        ) : node.locked ? (
          <span style={{ color: C.faint, fontSize: 11 }}>Locked</span>
        ) : null}
      </span>
    </button>
  );
}

/** Why a node cannot be learned yet, in words (empty when it can or is maxed). */
function hintFor(view: TalentsView, node: TalentNodeView): string {
  if (node.rank >= node.maxRank) return "Maxed";
  if (node.learnable) return "Ready to learn";
  const tier = view.tierPoints * node.tier;
  if (view.spent < tier) return `Needs ${fmtInt(tier)} points spent in the ${view.name} tree`;
  const req = node.requires === null ? null : view.nodes.find((n) => n.id === node.requires);
  if (req && req.rank < 1) return `Needs ${req.name} first`;
  if (view.points < 1) return "No talent points left (earned on level up)";
  return node.locked ? "Locked" : "";
}

/** The talent tree of the hero's class: points, branches, details and reset. No frame. */
/** `stacked` puts the details under the tree (narrow hosts such as the Skills panel tab). */
export function TalentsBody({ api, stacked = false }: SlotProps & { stacked?: boolean }) {
  const view = useSelect(api.hud, (s) => s.talents ?? null);
  const layout = useHudLayout(api);
  const [branch, setBranch] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);

  if (!view) {
    return <p style={labelStyle}>Talents appear once your hero has a class tree.</p>;
  }

  const oneBranch = layout !== "desktop";
  const cols = oneBranch
    ? [Math.min(branch, view.branches.length - 1)]
    : view.branches.map((_, i) => i);
  // Default selection: the first learnable node, else the first node not maxed.
  const selected =
    view.nodes.find((n) => n.id === picked) ??
    view.nodes.find((n) => n.learnable) ??
    view.nodes.find((n) => n.rank < n.maxRank) ??
    null;
  const spentIn = (col: number) =>
    view.nodes.reduce((sum, n) => (n.col === col ? sum + n.rank : sum), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <footer
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span style={labelStyle}>{talentsSummary(view)}</span>
        <Btn
          label="Reset talents"
          title="Resets work in town only and refund every spent point"
          disabled={!view.canReset}
          height={TOUCH}
          fontSize={12}
          onClick={() => api.act(ACTION.resetTalents, {})}
        >
          {view.resetCost > 0 ? `Reset · ${fmtInt(view.resetCost)} gold` : "Reset talents"}
        </Btn>
      </footer>
      {oneBranch ? (
        <div role="group" aria-label="Branch" style={{ display: "flex", gap: 6 }}>
          {view.branches.map((name, col) => (
            <Btn
              key={name}
              label={`Show ${name}`}
              pressed={cols[0] === col}
              height={TOUCH}
              style={{ flex: 1, fontSize: 12 }}
              onClick={() => setBranch(col)}
            >
              {`${name} (${spentIn(col)})`}
            </Btn>
          ))}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          flexDirection: oneBranch || stacked ? "column" : "row",
          alignItems: "flex-start",
          gap: 10,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))`,
            gap: 6,
            flex: oneBranch || stacked ? "none" : "3 1 0",
            minWidth: 0,
            width: oneBranch || stacked ? "100%" : undefined,
          }}
        >
          {oneBranch
            ? null
            : cols.map((col) => (
                <div key={`h${col}`} style={{ color: C.gold, fontSize: 12, fontWeight: 700 }}>
                  {`${view.branches[col] ?? ""} · ${spentIn(col)}`}
                </div>
              ))}
          {TIERS.flatMap((tier) =>
            cols.map((col) => {
              const node = view.nodes.find((n) => n.tier === tier && n.col === col);
              return node ? (
                <NodeButton
                  key={`${tier}-${col}`}
                  node={node}
                  selected={node.id === selected?.id}
                  onPick={() => setPicked(node.id)}
                />
              ) : (
                <div key={`${tier}-${col}`} aria-hidden="true" />
              );
            }),
          )}
        </div>

        <section
          aria-label="Talent details"
          style={{
            padding: 10,
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            background: "rgba(255, 240, 210, 0.04)",
            minHeight: 96,
            flex: oneBranch || stacked ? "none" : "2 1 0",
            minWidth: 0,
            width: oneBranch || stacked ? "100%" : undefined,
            boxSizing: "border-box",
          }}
        >
          {selected ? (
            <>
              <div style={{ fontWeight: 700 }}>
                {selected.name}{" "}
                <span style={labelStyle}>{`${selected.rank} / ${selected.maxRank}`}</span>
              </div>
              <div style={labelStyle}>{hintFor(view, selected)}</div>
              <div style={{ marginTop: 6 }}>{selected.description}</div>
              {selected.lines.map((line) => (
                <div key={line} style={{ ...labelStyle, marginTop: 2 }}>
                  {line}
                </div>
              ))}
              <div style={{ marginTop: 10 }}>
                <Btn
                  label={`Learn ${selected.name}`}
                  disabled={!selected.learnable}
                  height={TOUCH}
                  onClick={() => api.act(ACTION.learnTalent, { node: selected.id })}
                >
                  Learn
                </Btn>
              </div>
            </>
          ) : (
            <p style={labelStyle}>Select a talent to see what it does.</p>
          )}
        </section>
      </div>
    </div>
  );
}

export function TalentsPanel({ api }: SlotProps) {
  const view = useSelect(api.hud, (s) => s.talents ?? null);
  return (
    <PanelFrame
      api={api}
      id="talents"
      title="Talents"
      width={780}
      subtitle={view ? `${view.name} class tree` : undefined}
    >
      <TalentsBody api={api} />
    </PanelFrame>
  );
}
