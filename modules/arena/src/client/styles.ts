/**
 * Arena screen styles (OWNER: T-arena-sim). One string, rendered once per
 * arena root as a <style> element. Dark classic palette, mobile first (16 px
 * gutter, 44 px targets, no horizontal scroll at 375 px).
 */
export const ARENA_CSS = `
.arena-root{box-sizing:border-box;width:100%;max-width:560px;margin:0 auto;padding:16px;color:#e8dcc0;background:#0d0b09;font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.arena-root *{box-sizing:border-box}
.arena-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.arena-title{margin:0;font-size:22px;color:#d9b26f}
.arena-btn{min-height:44px;min-width:44px;padding:8px 14px;border:1px solid #5c4a2e;border-radius:8px;background:#211a12;color:#e8dcc0;font:inherit;cursor:pointer}
.arena-btn:disabled{opacity:.45;cursor:default}
.arena-btn.arena-primary{background:#6b4f22;border-color:#d9b26f;color:#fff8e6;font-weight:600}
.arena-btn[aria-pressed="true"]{background:#3a2d18;border-color:#d9b26f}
.arena-tabs{display:flex;gap:8px;margin-bottom:12px}
.arena-tabs .arena-btn{flex:1}
.arena-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.arena-stat{padding:8px;border:1px solid #3a2d18;border-radius:8px;background:#17120c;text-align:center}
.arena-stat b{display:block;font-size:20px;color:#fff8e6}
.arena-stat span{font-size:12px;color:#a89c80;text-transform:uppercase;letter-spacing:.04em}
.arena-note{margin:8px 0;font-size:13px;color:#a89c80}
.arena-msg{margin:8px 0;padding:8px 10px;border-radius:8px;background:#2a1612;color:#f0b8a8}
.arena-section{margin-top:16px}
.arena-section h2{margin:0 0 8px;font-size:16px;color:#d9b26f}
.arena-list{list-style:none;margin:0;padding:0}
.arena-row{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 10px;border-bottom:1px solid #2a2118}
.arena-row.arena-you{background:#2b2210;border-radius:8px;border-color:transparent}
.arena-row .arena-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arena-rank{width:32px;color:#a89c80;text-align:right}
.arena-win{color:#9fd287}
.arena-loss{color:#f0a28c}
.arena-draw{color:#c9c2b0}
.arena-dot{display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid #0d0b09;flex:none}
.arena-empty,.arena-loading{padding:16px 0;color:#a89c80;text-align:center}
.arena-cards{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.arena-card{min-width:0;padding:8px 10px;border:1px solid #3a2d18;border-radius:10px;background:#17120c}
.arena-card.arena-dead{opacity:.45}
.arena-cardname{display:block;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.arena-cardclass{display:block;font-size:12px;color:#a89c80}
.arena-hpnum{display:block;margin-top:4px;font-size:12px;color:#c9c2b0;font-variant-numeric:tabular-nums}
.arena-bar{position:relative;height:8px;margin-top:6px;border-radius:4px;background:#2a1612;overflow:hidden}
.arena-bar i{position:absolute;left:0;top:0;bottom:0;background:#8fc96a;transition:width 120ms linear}
.arena-bar i.arena-shield{background:#7aa7e0;opacity:.8}
.arena-lane{position:relative;height:120px;margin:8px 0 4px;border:1px solid #3a2d18;border-radius:10px;background:linear-gradient(#1b150e,#0d0b09);overflow:hidden}
.arena-lane::after{content:"";position:absolute;left:0;right:0;bottom:22px;height:2px;background:#3a2d18}
.arena-avatar{position:absolute;bottom:28px;width:36px;height:36px;margin-left:-18px;border-radius:50%;border:2px solid #0d0b09;color:#0d0b09;font-weight:700;line-height:32px;text-align:center;font-size:16px;transition:left 100ms linear}
.arena-float{position:absolute;bottom:72px;margin-left:-40px;width:80px;text-align:center;font-weight:700;font-size:16px;white-space:nowrap;pointer-events:none;animation:arena-float 900ms ease-out both;text-shadow:0 1px 0 #000;transition:left 100ms linear}
.arena-float.dmg{color:#f0a28c}
.arena-float.crit{color:#ffd35a;font-size:20px}
.arena-float.heal{color:#9fd287}
@keyframes arena-float{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-26px)}}
.arena-caption{min-height:20px;margin:0 0 6px;font-size:13px;color:#d9b26f;text-align:center}
.arena-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.arena-controls input[type=range]{flex:1 1 160px;min-height:44px;accent-color:#d9b26f}
.arena-banner{margin:10px 0;padding:12px;border-radius:10px;text-align:center;font-size:18px;font-weight:700;background:#17120c;border:1px solid #5c4a2e;color:#fff8e6}
.arena-banner small{display:block;margin-top:4px;font-size:13px;font-weight:400;color:#a89c80}
@media (prefers-reduced-motion:reduce){.arena-float{animation:none}.arena-avatar,.arena-float,.arena-bar i{transition:none}}
`;
