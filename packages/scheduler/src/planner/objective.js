// Objective (spec §4.2): W_fair·F + W_idle·I + W_switch·S + W_interrupt·N + W_robust·R + W_span·M + W_stable·C,
// plus a large penalty per second of serve-window lateness and per hard-constraint violation (spec §5.6).
// Works directly on a dispatch() result (relative seconds); plan() converts nothing, it just stores the terms.
// All loads and durations are normalised to minutes before weighting.

import { sameContext } from './cost.js'

const INF = Number.POSITIVE_INFINITY
const LOAD_KINDS = new Set(['work', 'cleaning', 'resume', 'appointment', 'check'])

/** Default weights for the two penalty terms the table in §4.2 leaves to §5.6 ("large penalty"). */
export const PENALTY_WEIGHTS = Object.freeze({ late: 10, violation: 1000 })

function mergeIntervals(list) {
  const sorted = list.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0])
  const out = []
  for (const [s, e] of sorted) {
    const last = out[out.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

function overlap(intervals, s, e) {
  let sum = 0
  for (const [a, b] of intervals) {
    const lo = Math.max(a, s), hi = Math.min(b, e)
    if (hi > lo) sum += hi - lo
  }
  return sum
}

/**
 * Evaluate a dispatch() result.
 * @param {object} d dispatch result { items, participants, dishes, diagnostics, done, runtime }
 * @param {object} graph Graph
 * @param {object} session normalised session with `t0` (epoch ms origin of the relative clock)
 * @param {object} policy merged policy (weights, maxIdleStretchSeconds, leadSeconds, stabilityHorizonSeconds, …)
 * @param {object} [opts] { previousPlan, now (relative seconds, default 0), extraViolations (number) }
 * @returns {{ total: number, terms: { fair, idle, switch, interrupt, robust, span, stable, late, violations }, weighted: object }}
 */
export function objectiveOf(d, graph, session, policy, opts = {}) {
  const w = { ...PENALTY_WEIGHTS, ...(policy.weights || {}) }
  const t0 = session.t0 ?? 0
  const now = opts.now ?? 0
  const parts = (d.participants || []).filter((p) => p.role !== 'spectator')
  const items = (d.items || []).filter((it) => it.participantId)
  const byP = new Map(parts.map((p) => [p.id, []]))
  for (const it of items) if (byP.has(it.participantId) && LOAD_KINDS.has(it.kind)) byP.get(it.participantId).push(it)
  for (const list of byP.values()) list.sort((a, b) => a.start - b.start || a.end - b.end)
  const tedium = (it) => (it.kind === 'cleaning' ? 1.5 : graph.tasks[it.taskId]?.tedium ?? 1)
  const speedOf = new Map(parts.map((p) => [p.id, p.speed || 1]))
  // a_j: the hands-on time; a streaming consumer's item may be stretched to its producer's finish (starvation), so
  // the load is the catalogue active time of the units handled, never more than the item itself
  const activeOf = (it) => {
    const len = it.end - it.start
    const t = graph.tasks[it.taskId]
    if (!t || it.kind === 'cleaning' || it.kind === 'appointment' || it.kind === 'check') return len
    let a = t.active || 0
    if (it.units && t.units > 0) a = t.timeModel === 'per-unit' && t.perUnit ? t.perUnit * (it.units.to - it.units.from + 1) : a * (it.units.to - it.units.from + 1) / t.units
    return Math.min(len, a / (speedOf.get(it.participantId) || 1))
  }

  const starts = items.filter((it) => it.kind !== 'blocked').map((it) => it.start)
  const ends = items.filter((it) => it.kind !== 'blocked').map((it) => it.end)
  const planStart = starts.length ? Math.min(...starts) : now
  const planEnd = ends.length ? Math.max(...ends) : now

  // ---- F fairness ---------------------------------------------------------------------------------------
  const loads = {}
  let sumL = 0
  for (const p of parts) {
    let L = 0
    for (const it of byP.get(p.id)) L += activeOf(it) * tedium(it) + (it.setupSeconds || 0)
    loads[p.id] = L / 60
    sumL += L / 60
  }
  const availMin = {}
  let shareSum = 0
  for (const p of parts) {
    const avail = p.avail || [[-INF, INF]]
    let a = 0
    for (const [s, e] of avail) a += Math.max(0, Math.min(e, planEnd) - Math.max(s, planStart))
    availMin[p.id] = a / 60
    shareSum += (p.targetShare ?? 1) * availMin[p.id]
  }
  let fair = 0
  const expected = {}
  for (const p of parts) {
    const E = shareSum > 0 ? ((p.targetShare ?? 1) * availMin[p.id] / shareSum) * sumL : sumL / Math.max(1, parts.length)
    expected[p.id] = E
    if (E <= 0) continue
    const rel = loads[p.id] / E
    fair += Math.max(0, rel - 1) ** 2 + Math.max(0, 1 - rel) ** 2
  }

  // ---- I idle (lopsided only; blocked intervals are gaps because they are not in LOAD_KINDS) ---------------
  const maxIdle = policy.maxIdleStretchSeconds ?? 480
  const busyOf = new Map(parts.map((p) => [p.id, mergeIntervals(byP.get(p.id).map((it) => [it.start, it.end]))]))
  let idle = 0
  for (const p of parts) {
    const others = mergeIntervals(parts.filter((q) => q.id !== p.id).flatMap((q) => busyOf.get(q.id)))
    const mine = busyOf.get(p.id)
    const gaps = []
    let cursor = planStart
    for (const [s, e] of mine) { if (s > cursor) gaps.push([cursor, s]); cursor = Math.max(cursor, e) }
    if (planEnd > cursor) gaps.push([cursor, planEnd])
    for (const [s, e] of gaps) {
      const lopsided = overlap(others, s, e)
      if (lopsided > maxIdle) idle += ((lopsided - maxIdle) / 60) ** 2
    }
  }

  // ---- S switching ---------------------------------------------------------------------------------------
  let switches = 0
  let setupMin = 0
  for (const p of parts) {
    const list = byP.get(p.id)
    for (let i = 0; i < list.length; i++) {
      setupMin += (list[i].setupSeconds || 0) / 60
      if (i > 0 && !sameContext(list[i - 1].context, list[i].context)) switches++
    }
  }
  const switchTerm = switches + setupMin

  // ---- N interrupt risk ----------------------------------------------------------------------------------
  const lead = policy.leadSeconds ?? 30
  let interrupt = 0
  for (const p of parts) {
    const list = byP.get(p.id)
    for (let i = 0; i < list.length; i++) {
      const it = list[i]
      if (it.kind !== 'appointment') continue
      const prev = list.slice(0, i).filter((x) => x.end <= it.start + 1e-9).pop()
      if (prev && it.start - prev.end < lead) interrupt++
      const split = list.some((x) => x.kind === 'resume' && x.start >= it.end - 1e-9 && list.some((y) => y !== x && y.taskId === x.taskId && y.end <= it.start + 1e-9))
      if (split) interrupt++
    }
  }
  interrupt += (d.diagnostics || []).filter((x) => x.code === 'NO_APPOINTMENT_HOLDER').length

  // ---- R robustness: missing slack before LF (windows already carry the slack buffer) ------------------
  const slack = policy.slackBufferMinSeconds ?? 120
  let robust = 0
  if (d.runtime) {
    for (const r of d.runtime.values()) {
      if (r.isCleaning || !r.task || r.task.kind === 'sink' || r.end === null || r.end === undefined) continue
      if (!Number.isFinite(r.window?.LF)) continue
      robust += Math.min(slack, Math.max(0, r.end - r.window.LF)) / 60
    }
  }

  // ---- M makespan ----------------------------------------------------------------------------------------
  const span = ends.length ? (planEnd - planStart) / 60 : 0

  // ---- C stability ---------------------------------------------------------------------------------------
  let stable = 0
  const prev = opts.previousPlan
  if (prev && Array.isArray(prev.lanes)) {
    const horizon = policy.stabilityHorizonSeconds ?? 900
    const nowMs = t0 + now * 1000
    const prevItems = new Map()
    for (const lane of prev.lanes) for (const it of lane.items || []) {
      if (!LOAD_KINDS.has(it.kind) || it.kind === 'check') continue
      if (it.status !== 'planned' && it.status !== 'paused') continue
      if (it.start < nowMs || it.start > nowMs + horizon * 1000) continue
      prevItems.set(it.uuid, { participantId: it.participantId, startRel: (it.start - t0) / 1000 })
    }
    for (const it of items) {
      const was = prevItems.get(it.uuid)
      if (!was) continue
      if (was.participantId !== it.participantId || Math.abs(was.startRel - it.start) > 120) stable++
    }
  }

  // ---- lateness and violations ---------------------------------------------------------------------------
  let late = 0
  for (const gd of graph.dishes || []) {
    const dd = (d.dishes || []).find((x) => x.dishId === gd.id)
    const latestRel = (gd.serveTime + (gd.lateTolerance || 0) - t0) / 1000
    if (!dd || dd.plannedServeRel === null || dd.plannedServeRel === undefined) { late += 3600; continue }
    late += Math.max(0, dd.plannedServeRel - latestRel)
  }
  let violations = 0
  if (d.runtime) for (const r of d.runtime.values()) if (r.status === 'pending' && !r.isCleaning) violations++
  else if (d.done === false) violations++
  violations += (d.diagnostics || []).filter((x) => x.code === 'DEADLOCK').length
  violations += opts.extraViolations || 0

  const terms = {
    fair: round(fair), idle: round(idle), switch: round(switchTerm), interrupt, robust: round(robust), span: round(span), stable,
    late: round(late), violations,
  }
  const weighted = {
    fair: w.fair * terms.fair, idle: w.idle * terms.idle, switch: w.switch * terms.switch, interrupt: w.interrupt * terms.interrupt,
    robust: w.robust * terms.robust, span: w.span * terms.span, stable: w.stable * terms.stable,
    late: w.late * terms.late, violations: w.violation * terms.violations,
  }
  const total = round(Object.values(weighted).reduce((a, b) => a + b, 0))
  return { total, terms, weighted, loads, expected }
}

/**
 * Evaluate a Plan (README §6, epoch ms) by rebuilding the per-lane item list in relative seconds.
 * Prefer `objectiveOf` on the dispatch result when it is at hand; this is the convenience for callers that only
 * have the emitted plan.
 */
export function objective(planOrResult, graph, session, policy, opts = {}) {
  if (planOrResult && Array.isArray(planOrResult.items) && planOrResult.participants) return objectiveOf(planOrResult, graph, session, policy, opts)
  const p = planOrResult
  const t0 = p.startTime
  const s = { ...session, t0 }
  const rel = (ms) => (ms - t0) / 1000
  const participants = (session.participants || []).filter((x) => x.role !== 'spectator').map((x) => ({
    id: x.id, role: x.role, targetShare: x.targetShare ?? 1,
    avail: x.availability ? x.availability.map(([a, b]) => [a === null ? -INF : rel(a), b === null ? INF : rel(b)]) : [[-INF, INF]],
  }))
  const items = p.lanes.flatMap((l) => l.items.map((it) => ({ ...it, start: rel(it.start), end: rel(it.end) })))
  const dishes = p.dishes.map((dd) => ({ dishId: dd.dishId, plannedServeRel: dd.plannedServe === null ? null : rel(dd.plannedServe), spread: dd.spread }))
  const d = { items, participants, dishes, diagnostics: p.diagnostics, done: !p.diagnostics.some((x) => x.code === 'INCOMPLETE'), runtime: null }
  return objectiveOf(d, graph, s, policy, { ...opts, now: opts.now ?? rel(p.now ?? t0) })
}

function round(x) { return Math.round(x * 1000) / 1000 }
