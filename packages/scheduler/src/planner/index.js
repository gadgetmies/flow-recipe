// Planner entry: Phases C–H (spec §5). plan(graph, session, options) → Plan (README §6).

import { mergePolicy, normaliseParticipant } from './policy.js'
import { computeWindows } from './windows.js'
import { dispatch } from './dispatch.js'
import { laneReports, fairnessIndex, shoppingList } from './report.js'
import { checkPlan } from './check.js'
import { objectiveOf, objective } from './objective.js'
import { detectChains, balanceChain, applyChainHints, sinkRate } from './pipeline.js'
import { improve, initialState } from './search.js'
import { repair, lateness as latenessOf } from './repair.js'

export { mergePolicy, normaliseParticipant, computeWindows, dispatch, checkPlan, shoppingList, objective, objectiveOf, detectChains, balanceChain, applyChainHints, sinkRate, improve, repair }

const INF = Number.POSITIVE_INFINITY

/** Normalise a Session (README §4): policy defaults, participant defaults, origin. */
export function normaliseSession(session) {
  const policy = mergePolicy(session.policy)
  const participants = (session.participants || []).map(normaliseParticipant)
  const inventory = session.inventory || { tools: [], appliances: [], stations: [], holding: [], cleaning: {} }
  return { ...session, policy, participants, inventory }
}

function slackSeconds(graph, policy) {
  const total = Object.values(graph.tasks).reduce((s, t) => s + (t.active || 0), 0)
  return Math.max(policy.slackBufferMinSeconds, policy.slackBufferFraction * total / Math.max(1, Object.keys(graph.tasks).length))
}

/**
 * @param {object} graph Graph from buildGraph
 * @param {object} session Session
 * @param {object} options { previousPlan, frozen, now, mode, status, budgetMs, maxIterations, preferAssignments }
 *   budgetMs: Phase F wall-clock budget (default policy.searchBudgetMs offline / replanBudgetMs online; 0 skips the search)
 *   maxIterations: Phase F move cap (default policy.searchIterations / replanIterations)
 *   frozen: { done: [{ taskId, participantId, start, end }], running: [{ taskId, participantId, start, remainingActive }] }
 *     (epoch ms; `end` of a done task = after its passive phase; remainingActive in seconds)
 *   preferAssignments: { [uuid|taskId]: participantId } the previous plan had within the stability horizon
 */
export function plan(graph, session, options = {}) {
  const t0wall = Date.now()
  const s = normaliseSession(session)
  const policy = s.policy
  const mode = options.mode || (s.startTime && options.frozen ? 'online' : 'offline')

  // origin: online = now; offline = startTime, else derived from the windows
  let t0 = options.now ?? s.now ?? s.startTime ?? null
  const derivedStart = t0 === null
  const slack = slackSeconds(graph, policy)
  let win
  if (t0 === null) {
    const earliestServe = Math.min(...graph.dishes.map((d) => d.serveTime))
    const probe = earliestServe - 6 * 3600 * 1000
    win = computeWindows(graph, probe, { slackBuffer: slack })
    const suggested = probe + (win.suggestedStart - slack) * 1000
    t0 = Math.floor(suggested / 1000) * 1000
  }
  const frozen = options.frozen ? relFrozen(options.frozen, t0) : undefined
  win = computeWindows(graph, t0, { slackBuffer: slack, frozen: frozen ? frozenWindows(frozen, graph) : undefined })
  s.t0 = t0

  // availability relative seconds
  for (const p of s.participants) {
    p.availabilityRel = p.availability ? p.availability.map(([a, b]) => [a === null ? -INF : (a - t0) / 1000, b === null ? INF : (b - t0) / 1000]) : null
  }

  // ---- Phase E: first forward dispatch -------------------------------------------------------------------
  const dispatchOpts0 = { frozen, now: 0, preferAssignments: options.preferAssignments }
  const evaluate = (res, g = graph, extra = {}) => objectiveOf(res, g, s, policy, { previousPlan: options.previousPlan, now: 0, ...extra })
  let d = dispatch(graph, s, win.windows, dispatchOpts0)
  let obj = evaluate(d)
  let dispatchOpts = dispatchOpts0
  let planGraph = graph

  // ---- Phase D: pipeline construction → hints for a second dispatch (kept when the objective improves) ------
  const cooks = s.participants.filter((p) => p.role !== 'spectator')
  const participantIds = cooks.map((p) => p.id).sort((a, b) => (d.loads[a] || 0) - (d.loads[b] || 0) || (a < b ? -1 : a > b ? 1 : 0))
  const balances = []
  let useHints = false
  if (cooks.length) {
    for (const chain of detectChains(graph)) {
      const started = chain.firstIds.map((id) => d.runtime.get(id)).filter((r) => r && r.start !== null && r.start !== undefined)
      const start = started.length ? Math.min(...started.map((r) => r.start)) : undefined
      balances.push(balanceChain(chain, cooks.length, graph, s, policy, { windows: win.windows, start }))
    }
    if (balances.length) {
      const hints = applyChainHints(graph, balances, participantIds)
      const optsD = { ...dispatchOpts0, preferAssignments: { ...(options.preferAssignments || {}), ...hints.preferAssignments }, chunkPlan: hints.chunkPlan }
      const dD = dispatch(graph, s, win.windows, optsD)
      const objD = evaluate(dD)
      if (objD.total < obj.total - 1e-9) { d = dD; obj = objD; dispatchOpts = optsD; useHints = true }
    }
  }

  // ---- Phase F: bounded improvement search (budgetMs 0 skips it) --------------------------------------------
  // The plan body stays deterministic for a seed: `report.search` carries the iteration count (deterministic when
  // the iteration cap is reached before the wall-clock budget); the elapsed time is part of report.planningMs.
  const budgetMs = options.budgetMs ?? (mode === 'online' ? policy.replanBudgetMs : policy.searchBudgetMs) ?? 0
  const maxIterations = options.maxIterations ?? (mode === 'online' ? policy.replanIterations : policy.searchIterations) ?? Infinity
  let search = { iterations: 0, improved: false, budgetMs, ms: 0 }
  if (budgetMs > 0 && maxIterations > 0 && cooks.length) {
    const r = improve(graph, s, win.windows, { dispatchOpts: dispatchOpts0, balances, participantIds, state: initialState(useHints) }, policy, { budgetMs, maxIterations, seed: policy.seed, previousPlan: options.previousPlan, now: 0 })
    search = { iterations: r.iterations, improved: r.objective.total < obj.total - 1e-9, budgetMs }
    if (search.improved) { d = r.result; obj = r.objective; dispatchOpts = r.opts }
  }

  // ---- Phase G: repair ladder, only when a dish is still late or the critical path does not fit -------------
  const repairs = []
  if (cooks.length && (latenessOf(d, graph, t0) > 0 || win.criticalPathInfeasible)) {
    const rep = repair({ graph, session: s, windows: win.windows, dispatchOpts, result: d, policy, slack, frozenWindows: frozen ? frozenWindows(frozen, graph) : undefined, balances, participantIds, criticalPathInfeasible: win.criticalPathInfeasible, criticalShortfall: Math.max(0, -(win.suggestedStart || 0)) })
    d = rep.result
    planGraph = rep.graph || graph
    repairs.push(...rep.diagnostics)
    obj = evaluate(d, planGraph)
  }

  const diagnostics = [...(graph.diagnostics || []), ...d.diagnostics, ...repairs]
  if (win.criticalPathInfeasible) {
    diagnostics.push({ code: 'CRITICAL_PATH', message: 'Even with unlimited people the dishes cannot all finish on time from this start. Start earlier or move a serve time.' })
  }

  // lanes
  const ms = (sec) => t0 + Math.round(sec * 1000)
  const lanes = s.participants.filter((p) => p.role !== 'spectator').map((p) => ({ participantId: p.id, items: [], report: null }))
  const laneById = new Map(lanes.map((l) => [l.participantId, l]))
  const itemsMs = d.items.map((it) => ({
    ...it,
    start: ms(it.start), end: ms(it.end),
    passiveUntil: it.passiveUntil !== null && it.passiveUntil !== undefined ? ms(it.passiveUntil) : null,
    window: it.window ? { earliest: ms(it.window.earliest), latest: ms(it.window.latest) } : null,
    timer: it.timer ? { ...it.timer, firesAt: ms(it.timer.firesAt) } : null,
    inputsFrom: it.inputsFrom.map((x) => ({ ...x, byTime: ms(x.byTime) })),
    outputsTo: it.outputsTo.map((x) => ({ ...x, byTime: ms(x.byTime) })),
  }))
  // timers for passive work items whose appointment follow-up exists
  for (const it of itemsMs) {
    if (it.kind === 'work' && it.passiveUntil) {
      const r = d.runtime.get(it.taskId)
      if (r && r.appointment) {
        const holder = laneById.get(r.appointment.holder)
        it.timer = { title: it.title, durationSeconds: r.task.passive, firesAt: ms(r.end), holder: r.appointment.holder, appointmentUuid: r.appointment.uuid }
        void holder
      }
    }
  }
  for (const it of itemsMs) {
    const lane = laneById.get(it.participantId)
    if (lane) lane.items.push(it)
  }
  for (const lane of lanes) lane.items.sort((a, b) => a.start - b.start || (a.kind === 'blocked' ? -1 : 1))

  const reports = laneReports(d.items, d.participants, d.loads, d.expected, policy)
  for (const lane of lanes) lane.report = reports[lane.participantId] || { load: 0, expectedLoad: 0, switches: 0, longestLopsidedIdle: 0, timersHeld: 0 }

  // dishes
  const dishes = graph.dishes.map((gd) => {
    const dd = d.dishes.find((x) => x.dishId === gd.id) || {}
    const plannedServe = dd.plannedServeRel !== null && dd.plannedServeRel !== undefined ? ms(dd.plannedServeRel) : null
    const late = plannedServe !== null ? Math.max(0, (plannedServe - (gd.serveTime + (gd.lateTolerance || 0))) / 1000) : null
    const hold = Number.isFinite(gd.hold) ? gd.hold : null
    if (plannedServe !== null && late > 0) diagnostics.push({ code: 'LATE', message: `${gd.title} is planned ${Math.round(late / 60)} min after its serve window.`, dish: gd.id, delta: late })
    if (hold !== null && dd.spread > hold) diagnostics.push({ code: 'SPREAD', message: `${gd.title}: portions finish ${Math.round(dd.spread / 60)} min apart, more than the ${Math.round(hold / 60)} min hold.`, dish: gd.id, delta: dd.spread - hold })
    return { dishId: gd.id, title: gd.title, serveTarget: gd.serveTime, plannedServe, spread: Math.round(dd.spread || 0), holdUsed: hold, late: late === null ? null : Math.round(late) }
  })
  if (!d.done && !diagnostics.some((x) => x.code === 'NO_PARTICIPANTS')) diagnostics.push({ code: 'INCOMPLETE', message: 'Some tasks could not be scheduled.' })

  const allEnds = itemsMs.map((it) => it.passiveUntil || it.end)
  const endTime = allEnds.length ? Math.max(...allEnds) : t0
  const result = {
    mode, status: options.status || (mode === 'online' ? 'running' : 'draft'),
    seed: policy.seed, computedAt: Date.now(), now: options.now ?? s.now ?? t0, startTime: t0, endTime,
    diagnostics, diff: null, lanes, dishes,
    report: {
      fairness: fairnessIndex(d.loads, d.expected),
      loads: Object.fromEntries(Object.keys(d.expected).map((id) => [id, { load: Math.round(d.loads[id] || 0), expected: Math.round(d.expected[id] || 0) }])),
      switches: Object.values(reports).reduce((a, r) => a + r.switches, 0),
      interruptsRisk: diagnostics.filter((x) => x.code === 'NO_APPOINTMENT_HOLDER').length,
      makespan: Math.round((endTime - t0) / 1000),
      planningMs: Date.now() - t0wall,
      objective: { total: obj.total, terms: obj.terms, weighted: obj.weighted },
      search: { ...search, hintsApplied: useHints },
      chains: balances.map((b) => ({ chainId: b.chainId, dishId: b.dishId, stream: b.stream, units: b.units, organisation: b.organisation, groups: b.groups, replicas: b.replicas, workforce: b.workforce, cycle: b.cycle, sink: { binding: b.sink.binding, rate: Number.isFinite(b.sink.rate) ? b.sink.rate : null, bufferUnits: Number.isFinite(b.sink.bufferUnits) ? b.sink.bufferUnits : null, bindsChain: b.sink.bindsChain }, perBurst: b.perBurst.map((x) => ({ units: x.units, workforce: x.workforce, organisation: x.organisation, slack: Math.round(x.slack) })) })),
    },
    shoppingList: shoppingList(s),
  }
  const violations = diagnostics.some((x) => x.code === 'NO_PARTICIPANTS') ? [] : checkPlan(result, planGraph, { minPassive: policy.minAppointmentPassiveSeconds })
  if (violations.length) {
    result.diagnostics.push({ code: 'INVARIANT', message: violations.slice(0, 5).join('; '), count: violations.length })
    const o = evaluate(d, planGraph, { extraViolations: violations.length })
    result.report.objective = { total: o.total, terms: o.terms, weighted: o.weighted }
  }
  result.report.planningMs = Date.now() - t0wall
  // A derived start (nobody fixed it) is only a proposal: when a dish would be late, start earlier instead of serving
  // late. This matters most with mise en place, where all measuring comes before the cooking (spec §5.7 rung 6).
  if (derivedStart && !options.frozen && !options._startRetry) {
    const worst = (p) => Math.max(0, ...p.dishes.map((x) => (x.late === null || x.late === undefined ? 0 : x.late)))
    const late = worst(result)
    if (late > 0) {
      let best = result
      let shift = Math.ceil(late / 60) * 60 + 60
      for (let i = 0; i < 3 && worst(best) > 0; i++) {
        const earlier = plan(graph, { ...session, startTime: t0 - shift * 1000 }, { ...options, _startRetry: true })
        if (worst(earlier) < worst(best)) best = earlier
        shift += Math.ceil(worst(earlier) / 60) * 60 + 60
      }
      if (best !== result) {
        best.diagnostics = best.diagnostics.filter((x) => x.code !== 'REPAIR_START')
        best.diagnostics.push({ code: 'START_EARLIER', message: `Start at ${new Date(best.startTime).toISOString().slice(11, 16)} UTC, ${Math.round((t0 - best.startTime) / 60000)} min earlier than the minimum, so ${worst(best) > 0 ? 'lateness is reduced' : 'every dish is on time'}.`, delta: Math.round((t0 - best.startTime) / 1000) })
        best.status = result.status
        return best
      }
    }
  }
  return result
}

/** Frozen tasks as { [taskId]: { start, end } } (relative seconds) for computeWindows' forward pass. */
function frozenWindows(frozen, graph) {
  const out = {}
  for (const d of frozen.done) if (graph.tasks[d.taskId]) out[d.taskId] = { start: d.start, end: d.end }
  for (const d of frozen.running) {
    const t = graph.tasks[d.taskId]
    if (t) out[d.taskId] = { start: d.start, end: Math.max(0, d.remainingActive || 0) + (t.passive || 0) }
  }
  return out
}

function relFrozen(frozen, t0) {
  const rel = (x) => (x - t0) / 1000
  return {
    done: (frozen.done || []).map((d) => ({ ...d, start: rel(d.start), end: rel(d.end) })),
    running: (frozen.running || []).map((d) => ({ ...d, start: rel(d.start), remainingActive: d.remainingActive })),
  }
}
