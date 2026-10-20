// Phase G (spec §5.7): the repair ladder. Run when the best schedule still violates a serve window or when
// Phase C's critical-path check fails. Rungs 1–4 try to change the schedule (each reported with its effect);
// rungs 5–6 are proposals to the host, reported as diagnostics with a `delta`, never applied silently.

import { dispatch } from './dispatch.js'
import { computeWindows } from './windows.js'
import { rechooseBursts, applyChainHints } from './pipeline.js'

const INF = Number.POSITIVE_INFINITY

/** Order of the rungs; the diagnostic `code` of each. */
export const RUNGS = ['REPAIR_FLOAT', 'REPAIR_SLACK', 'REPAIR_CHUNK', 'REPAIR_HOLDING', 'REPAIR_SPREAD', 'REPAIR_DELAY', 'REPAIR_START']

/** Per-dish lateness (seconds past serveTime + lateTolerance) of a dispatch result; an unplaced sink counts an hour. */
export function dishLateness(result, graph, t0) {
  return graph.dishes.map((gd) => {
    const x = (result.dishes || []).find((d) => d.dishId === gd.id)
    const latestRel = (gd.serveTime + (gd.lateTolerance || 0) - t0) / 1000
    if (!x || x.plannedServeRel === null || x.plannedServeRel === undefined) return { dishId: gd.id, late: 3600, plannedServeRel: null, latestRel }
    return { dishId: gd.id, late: Math.max(0, x.plannedServeRel - latestRel), plannedServeRel: x.plannedServeRel, latestRel }
  })
}

/** Total lateness in seconds. */
export function lateness(result, graph, t0) {
  return dishLateness(result, graph, t0).reduce((a, d) => a + d.late, 0)
}

const minutes = (s) => Math.round(s / 60)

/** Rung 1: let floating preparation start earlier than the float window allows. */
export function repairFloat(ctx) {
  const { graph, session, windows, dispatchOpts, policy } = ctx
  if (policy.miseEnPlace) return null
  let best = null
  for (const factor of [3, Infinity]) {
    const wider = { ...session, policy: { ...policy, floatWindowSeconds: factor === Infinity ? 1e9 : (policy.floatWindowSeconds ?? 3600) * factor } }
    const alt = dispatch(graph, wider, windows, dispatchOpts)
    const late = lateness(alt, graph, session.t0)
    if (late < (best ? best.late : ctx.late) - 1e-9) {
      best = { result: alt, session: wider, late, diagnostic: { code: 'REPAIR_FLOAT', message: `Floating preparation was allowed to start ${factor === Infinity ? 'any time' : `${factor}× earlier`} to reduce lateness.`, delta: ctx.late - late } }
    }
    if (best && best.late <= 0) break
  }
  return best
}

/** Rung 2: drop the slack buffer before hard deadlines (R is a soft term; this just reports it). */
export function repairSlack(ctx) {
  const { graph, session, dispatchOpts, frozenWindows } = ctx
  const win = computeWindows(graph, session.t0, { slackBuffer: 0, frozen: frozenWindows })
  const alt = dispatch(graph, session, win.windows, dispatchOpts)
  const late = lateness(alt, graph, session.t0)
  if (late >= ctx.late - 1e-9) return null
  return { result: alt, windows: win.windows, late, diagnostic: { code: 'REPAIR_SLACK', message: `The ${minutes(ctx.slack || 0)} min safety slack before deadlines was dropped to reduce lateness.`, delta: ctx.late - late } }
}

/** Rung 3: finer chunks (below minChunk, more switches) and every chain at full workforce. */
export function repairChunk(ctx) {
  const { graph, session, windows, dispatchOpts, policy, balances, participantIds } = ctx
  const finer = { ...session, policy: { ...policy, minChunkSeconds: Math.min(60, policy.minChunkSeconds || 180) } }
  const opts = { ...dispatchOpts }
  if (balances && balances.length) {
    const hints = applyChainHints(graph, balances.map((b) => rechooseBursts(b, { workforceDelta: b.k })), participantIds || [])
    opts.preferAssignments = { ...(dispatchOpts.preferAssignments || {}), ...hints.preferAssignments }
    opts.chunkPlan = { ...hints.chunkPlan, ...(dispatchOpts.chunkPlan || {}) }
  }
  const alt = dispatch(graph, finer, windows, opts)
  const late = lateness(alt, graph, session.t0)
  if (late >= ctx.late - 1e-9) return null
  return { result: alt, session: finer, dispatchOpts: opts, late, diagnostic: { code: 'REPAIR_CHUNK', message: 'Divisible work was chunked below the minimum run length and chains staffed fully, at the cost of more switches.', delta: ctx.late - late } }
}

/** Rung 4: a holding resource whose `keeps` matches the dish temperature extends the hold of its final outputs. */
export function repairHolding(ctx) {
  const { graph, session, dispatchOpts, frozenWindows, slack } = ctx
  const holding = session.inventory?.holding || []
  const lateDishes = dishLateness(ctx.result, graph, session.t0).filter((d) => d.late > 0)
  const targets = []
  for (const d of lateDishes) {
    const gd = graph.dishes.find((x) => x.id === d.dishId)
    if (!gd || !Number.isFinite(gd.hold)) continue
    const keeps = gd.temperature === 'hot' ? 'hot' : gd.temperature === 'cold' ? 'cold' : null
    const h = keeps ? holding.find((x) => x.keeps === keeps && (x.slots || 0) > 0) : null
    if (h) targets.push({ dish: gd, holding: h })
  }
  if (!targets.length) return null
  const tasks = { ...graph.tasks }
  const edges = graph.edges.map((e) => ({ ...e }))
  for (const { dish, holding: h } of targets) {
    const maxHold = h.maxHold || INF
    for (const e of edges) {
      if (e.kind === 'maxlag' && e.to === dish.sinkId) {
        e.hold = Math.max(e.hold || 0, maxHold)
        if (tasks[e.from]) tasks[e.from] = { ...tasks[e.from], hold: Math.max(tasks[e.from].hold || 0, maxHold) }
      }
    }
  }
  const graph2 = { ...graph, tasks, edges }
  const win = computeWindows(graph2, session.t0, { slackBuffer: slack || 0, frozen: frozenWindows })
  const alt = dispatch(graph2, session, win.windows, dispatchOpts)
  const late = lateness(alt, graph2, session.t0)
  if (late >= ctx.late - 1e-9) return null
  const notes = targets.map(({ dish, holding: h }) => `${dish.title}: transfer the finished portions to the ${h.type}`).join('; ')
  return { result: alt, graph: graph2, windows: win.windows, late, diagnostic: { code: 'REPAIR_HOLDING', message: `A holding resource decouples portions from the serve time. ${notes}.`, delta: ctx.late - late, holding: targets.map((t) => ({ dish: t.dish.id, type: t.holding.type })) } }
}

/** Rung 5: report the serve-window spread of dishes whose sequential batches cannot all be hot (nothing to change). */
export function repairSpread(ctx) {
  const { graph, result } = ctx
  const out = []
  for (const gd of graph.dishes) {
    const dd = (result.dishes || []).find((x) => x.dishId === gd.id)
    if (!dd || !Number.isFinite(gd.hold) || !(dd.spread > gd.hold)) continue
    out.push({ code: 'REPAIR_SPREAD', message: `${gd.title}: the batches finish ${minutes(dd.spread)} min apart, ${minutes(dd.spread - gd.hold)} min more than the ${minutes(gd.hold)} min hold; they are scheduled back-to-back so the spread is minimal.`, dish: gd.id, delta: dd.spread - gd.hold })
  }
  return out
}

/** Rung 6: propose a later serve time (= planned serve) for the latest dish; dishes sharing a serve time move together. */
export function repairDelay(ctx) {
  const { graph, result, session } = ctx
  const late = dishLateness(result, graph, session.t0).filter((d) => d.late > 0)
  if (!late.length) return []
  const worst = late.reduce((a, b) => (b.late > a.late ? b : a), late[0])
  const worstDish = graph.dishes.find((d) => d.id === worst.dishId)
  const out = []
  for (const d of late) {
    const gd = graph.dishes.find((x) => x.id === d.dishId)
    const shared = gd.serveTime === worstDish.serveTime
    const delta = shared ? worst.late : d.late
    out.push({ code: 'REPAIR_DELAY', message: `${gd.title}: serve ${minutes(delta)} min later (${new Date(gd.serveTime + delta * 1000).toISOString().slice(11, 16)} UTC)${shared && late.length > 1 ? ', together with the dishes sharing its serve time' : ''}. Proposal, not applied.`, dish: gd.id, delta, proposedServeTime: gd.serveTime + Math.ceil(delta) * 1000 })
  }
  return out
}

/** Rung 7: propose an earlier start (when one was given) or more participants, with the shortfall. */
export function repairStart(ctx) {
  const { graph, result, session } = ctx
  const total = lateness(result, graph, session.t0)
  const infeasible = !!ctx.criticalPathInfeasible
  if (total <= 0 && !infeasible) return []
  const shortfall = Math.max(total, infeasible ? (ctx.criticalShortfall || 0) : 0)
  const cooks = session.participants.filter((p) => p.role !== 'spectator').length
  const given = session.startTime !== null && session.startTime !== undefined
  const msg = given
    ? `Start ${minutes(shortfall)} min earlier${infeasible ? ' (the critical path does not fit from this start)' : ''}, or add a participant (${cooks} now).`
    : `Add a participant (${cooks} now) or start ${minutes(shortfall)} min earlier; ${infeasible ? 'the critical path does not fit' : 'the people are the bottleneck'}.`
  return [{ code: 'REPAIR_START', message: `${msg} Proposal, not applied.`, delta: shortfall, participants: cooks }]
}

/**
 * Run the ladder. Rungs 1–4 are applied in order while a dish is still late; 5–7 are reports.
 * @param {object} ctx { graph, session (normalised, t0), windows, dispatchOpts, result, policy, slack, frozenWindows,
 *   balances, participantIds, criticalPathInfeasible }
 * @returns {{ result, graph, session, windows, dispatchOpts, diagnostics: Array, applied: string[] }}
 */
export function repair(ctx0) {
  const ctx = { ...ctx0 }
  ctx.late = lateness(ctx.result, ctx.graph, ctx.session.t0)
  const diagnostics = []
  const applied = []
  for (const rung of [repairFloat, repairSlack, repairChunk, repairHolding]) {
    if (ctx.late <= 0) break
    let out = null
    try { out = rung(ctx) } catch (err) { diagnostics.push({ code: 'REPAIR_ERROR', message: `${rung.name} failed: ${err.message}` }); continue }
    if (!out) continue
    ctx.result = out.result
    if (out.session) ctx.session = out.session
    if (out.windows) ctx.windows = out.windows
    if (out.graph) ctx.graph = out.graph
    if (out.dispatchOpts) ctx.dispatchOpts = out.dispatchOpts
    ctx.late = out.late
    diagnostics.push(out.diagnostic)
    applied.push(out.diagnostic.code)
  }
  diagnostics.push(...repairSpread(ctx))
  if (ctx.late > 0 || ctx.criticalPathInfeasible) {
    diagnostics.push(...repairDelay(ctx))
    diagnostics.push(...repairStart(ctx))
  }
  return { result: ctx.result, graph: ctx.graph, session: ctx.session, windows: ctx.windows, dispatchOpts: ctx.dispatchOpts, diagnostics, applied, late: ctx.late }
}
