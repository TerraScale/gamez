export const meta = {
  name: 'gamez-qa',
  description: 'Reusable browser + sim QA for gamez: parallel Haiku 5.5 QA lenses (headless Chrome via tools/qa), Opus triage, parallel Haiku fixers with Opus escalation, Opus integration, Haiku re-verification until clean',
  whenToUse: 'Any time you want the live game QA-tested and fixed. args: { focuses?: [{key, focus}], rounds?: number (default 2), note?: string (extra constraints, e.g. paths not to touch), fix?: boolean (default true) }',
  phases: [
    { title: 'Model check', model: 'claude-haiku-5-5' },
    { title: 'QA', detail: 'parallel Haiku lenses' },
    { title: 'Triage', detail: 'Opus groups findings into disjoint fix tasks' },
    { title: 'Fix', detail: 'parallel Haiku fixers (Opus escalation)' },
    { title: 'Integrate', detail: 'Opus runs every gate' },
    { title: 'Reverify', detail: 'Haiku re-checks lenses that had blocker/major findings' },
  ],
}

const HAIKU = 'claude-haiku-5-5'
const opts = args || {}
const MAX_ROUNDS = opts.rounds || 2
const DO_FIX = opts.fix !== false

const RESULT = { type: 'object', properties: { gatePassed: { type: 'boolean' }, summary: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, followUps: { type: 'array', items: { type: 'string' } } }, required: ['gatePassed', 'summary', 'filesChanged', 'followUps'] }
const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
      title: { type: 'string' }, evidence: { type: 'string' },
      screenshots: { type: 'array', items: { type: 'string' } }, suggestedFix: { type: 'string' },
    }, required: ['severity', 'title', 'evidence', 'screenshots', 'suggestedFix'] } },
    passed: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['findings', 'passed', 'summary'],
}

const DEFAULT_FOCUSES = [
  { key: 'gameplay-loop', focus: 'Classic gameplay loop per class: Idle x8 ~5 min and Auto x1 ~2 min — kills, XP and levels, skills cast, potions picked up and drunk, loot equipped, town trips (sell/buy/heal/repair), stairs down, bosses, rifts, deaths handled; no livelock (60 s at x8 without kills/progress).' },
  { key: 'quests', focus: 'Quests end to end: every quest in modules/classic/src/content/quests.ts can be offered by its giver, accepted, progressed (kill/clear/boss/collect targets count correctly), completed, turned in for its rewards, and chained via `after`; quest tracker and quest log (L) update live; toasts show; quest state survives reload/server sync; Auto and Idle accept, progress and turn in quests on their own.' },
  { key: 'animations-labels', focus: 'Animations and signs: every unit animates idle/walk/attack/cast/hit/death in 8 facings (use ?qa=gallery and live play); nameplates (NPC roles, champion/unique/boss colours), loot labels by rarity, damage numbers (normal/crit/miss/heal/DoT), health bars, quest markers, signs, minimap icons, toasts; readable and not overlapping.' },
  { key: 'hud-panels', focus: 'Every HUD element and panel at desktop (1280x800, 1920x1080) and phone (375x812, 390x844, landscape): orbs, XP bar, skill bar + hotkeys, belt, mode/speed toggle, minimap/map, character, inventory, skills/talents, quest log, settings, vendors (alchemist, smith, gambler, rag buyer), stash, chat, guild, ranks, account; every action in them works; touch targets >= 44px; no clipping or overlap.' },
  { key: 'spells-art', focus: 'Spells and art: in Manual, cast every skill of each class at monsters — cast animation, projectile/AoE/chain/nova/summon/buff effects, statuses, mana and cooldowns; monster and boss skills render; window.__gamez.render.missingIds and the gallery show no missing/magenta art.' },
  { key: 'modes-platform', focus: 'Other modes and platform: mode picker and back navigation; steps, duel and Town Plaza still work; login/account/guest linking, leaderboards, chat, guilds, classic town presence (second tab sees the first); no console errors anywhere.' },
]
const FOCUSES = opts.focuses && opts.focuses.length ? opts.focuses : DEFAULT_FOCUSES

const COMMON = `
Repo: /home/mariogk/Projects/gamez — "gamez", a web-first isometric idle RPG on Cloudflare. READ FIRST: AGENTS.md, docs/design/classic.md (+ docs/design/wave-*.md), tools/qa/README.md (headless Chrome harness: \`node tools/qa/src/run.ts <scenario>\`, ?debug=1 window.__gamez hooks and controls, ?qa=gallery).
Rules:
- The user's live dev server runs at http://127.0.0.1:5173 (and on the tailnet) and hot-reloads this tree. Use it for browser QA. NEVER kill it or anything on :5173; if it is briefly down, wait and retry (a watchdog restarts it). For e2e use \`node_modules/.bin/vp run e2e\` (own port).
- Headless Chrome: ~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell (no downloads). Software GL is slow: fps/frame-time numbers are relative only.
- Always use /home/mariogk/Projects/gamez/node_modules/.bin/vp (the global vp is broken for tests). Never git commit/push/stash/checkout/reset; never deploy.
- Sim code must stay deterministic (AGENTS.md §6). ORIGINAL names/art only.
${opts.note ? `- ${opts.note}` : ''}
`

phase('Model check')
const check = await agent('Report the exact model ID stated in your system prompt (the "exact model ID is ..." line). Return only that ID.', { label: 'haiku-model-check', model: HAIKU, schema: { type: 'object', properties: { modelId: { type: 'string' } }, required: ['modelId'] } })
if (!check || check.modelId !== HAIKU) {
  log(`Haiku model check FAILED (got ${check ? check.modelId : 'nothing'}) — stopping, no silent fallback.`)
  return { haikuOk: false, check }
}

function qaPrompt(f, round, prior) {
  return `${COMMON}
YOUR ROLE: QA tester, round ${round}. Do NOT modify repo files. Scratch scripts and screenshots go under /tmp/gamez-qa/wf-${f.key}-r${round}/ only. Combine browser runs (tools/qa against :5173) with headless sim runs where useful (createSim/loadMode from the repo packages, run with node 24 or a vitest file you place under /tmp). Look at your screenshots with the Read tool — visual judgement matters.
FOCUS: ${f.focus}
${prior ? `RE-VERIFICATION after fixes. Previously reported blocker/major findings: ${JSON.stringify(prior)}. Check each explicitly (fixed or not, with evidence), then report anything new.` : ''}
Report concrete findings (severity, evidence with numbers/ids/file:line, screenshot paths, suggested fix) and the checks that passed.`
}

let round = 1
let reports = await parallel(FOCUSES.map(f => () => agent(qaPrompt(f, round, null), { label: `QA ${f.key} (haiku)`, phase: 'QA', model: HAIKU, schema: FINDINGS }).then(r => r && { key: f.key, ...r })))
const history = []

while (true) {
  const all = reports.filter(Boolean).flatMap(r => r.findings.map(f => ({ lens: r.key, ...f })))
  const serious = all.filter(f => f.severity !== 'minor')
  history.push({ round, findings: all.length, serious: serious.length })
  log(`QA round ${round}: ${all.length} findings (${serious.length} blocker/major)`)
  if (!DO_FIX || !all.length || (round > 1 && !serious.length) || round > MAX_ROUNDS) break

  phase('Triage')
  const triage = await agent(`${COMMON}
YOUR ROLE (Opus): triage QA round ${round}. Findings: ${JSON.stringify(all).slice(0, 60000)}
Deduplicate, drop false positives (verify in code), and group the rest into 1–8 FIX TASKS with DISJOINT ownedPaths. Fix every blocker and major; include cheap minors. Prefer "haiku" (Haiku 5.5); "opus" for at most 2 intricate tasks. Each task prompt is self-contained: findings covered (with evidence), files to change, expected behaviour, regression tests to add, and the gate (vp check clean in owned paths + relevant \`node_modules/.bin/vp test run ...\` passing + a tools/qa run with a screenshot for visual fixes).`,
    { label: `triage r${round} (opus)`, phase: 'Triage', schema: { type: 'object', properties: { tasks: { type: 'array', maxItems: 8, items: { type: 'object', properties: { key: { type: 'string' }, model: { type: 'string', enum: ['haiku', 'opus'] }, ownedPaths: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' } }, required: ['key', 'model', 'ownedPaths', 'prompt'] } }, dropped: { type: 'array', items: { type: 'string' } } }, required: ['tasks', 'dropped'] } })
  if (!triage || !triage.tasks.length) break

  phase('Fix')
  const fixed = await parallel(triage.tasks.map(t => async () => {
    const prompt = `${COMMON}\nYOUR TASK "${t.key}" (QA fix, round ${round}). Paths you own (only touch these): ${t.ownedPaths.join(', ')}. Other fixers work in parallel on other paths.\nGate: vp check 0 errors in your files and your tests pass. Report honestly.\n\n${t.prompt}`
    const isHaiku = t.model !== 'opus'
    const o = { label: `fix ${t.key} (${isHaiku ? 'haiku' : 'opus'})`, phase: 'Fix', schema: RESULT }
    if (isHaiku) o.model = HAIKU
    const first = await agent(prompt, o)
    if (first && first.gatePassed) return { key: t.key, escalated: false, ...first }
    if (!isHaiku) return { key: t.key, escalated: false, ...(first || { gatePassed: false, summary: 'failed', filesChanged: [], followUps: [] }) }
    log(`fix ${t.key}: Haiku failed its gate — escalating to Opus`)
    const retry = await agent(`${prompt}\n\nESCALATION: previous attempt report: ${first ? JSON.stringify(first) : '(none)'}. Keep what is good, finish/fix the rest.`, { label: `fix ${t.key} (opus escalation)`, phase: 'Fix', schema: RESULT })
    return { key: t.key, escalated: true, ...(retry || { gatePassed: false, summary: 'escalation failed', filesChanged: [], followUps: [] }) }
  }))

  phase('Integrate')
  const integ = await agent(`${COMMON}
YOUR ROLE (Opus): integrate QA fixes of round ${round}. Fixer reports: ${JSON.stringify(fixed).slice(0, 40000)}
Make \`node_modules/.bin/vp check\`, \`node_modules/.bin/vp run -r test\`, \`node_modules/.bin/vp -C apps/game build\` and \`node_modules/.bin/vp run e2e\` pass, then run \`node tools/qa/src/run.ts classic-idle <class> 2 8\` for all 3 classes against :5173. If another workflow's in-progress files break a gate (not caused by these fixes), report that precisely instead of editing their files. Report precisely.`, { label: `integrate r${round} (opus)`, phase: 'Integrate', schema: RESULT })
  const h = history[history.length - 1]
  h.fixes = fixed.map(f => f && { key: f.key, gate: f.gatePassed, escalated: f.escalated, summary: (f.summary || '').slice(0, 600) })
  h.integration = integ && { gate: integ.gatePassed, summary: integ.summary.slice(0, 3000), followUps: integ.followUps }

  round++
  phase('Reverify')
  const lenses = FOCUSES.filter(f => serious.some(s => s.lens === f.key))
  if (!lenses.length) break
  reports = await parallel(lenses.map(f => () => agent(qaPrompt(f, round, serious.filter(s => s.lens === f.key)), { label: `reverify ${f.key} (haiku)`, phase: 'Reverify', model: HAIKU, schema: FINDINGS }).then(r => r && { key: f.key, ...r })))
}

return {
  haikuOk: true,
  history,
  open: reports.filter(Boolean).map(r => ({ key: r.key, summary: r.summary, findings: r.findings.map(f => ({ severity: f.severity, title: f.title, evidence: f.evidence.slice(0, 400) })), passed: r.passed })),
}
