// Planner entry: Phases C–H (spec §5). plan(graph, session, options) → Plan (README §6).

import { mergePolicy, normaliseParticipant } from './policy.js'
import { computeWindows } from './windows.js'
import { dispatch } from './dispatch.js'
import { laneReports, fairnessIndex, shoppingList } from './report.js'
import { checkPlan } from './check.js'

export { mergePolicy, normaliseParticipant, computeWindows, dispatch, checkPlan, shoppingList }

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
 * @param {object} options { previousPlan, frozen, now, mode, status, budgetMs, preferAssignments }
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

  const dispatchOpts = { frozen, now: 0, preferAssignments: options.preferAssignments }
  let d = dispatch(graph, s, win.windows, dispatchOpts)
  // Repair ladder, rung 1 (spec §5.7): a late dish may be rescued by letting floating work start earlier.
  const lateness = (res) => res.dishes.reduce((a, x) => {
    const gd = graph.dishes.find((g) => g.id === x.dishId)
    if (!gd || x.plannedServeRel === null || x.plannedServeRel === undefined) return a + 3600
    return a + Math.max(0, x.plannedServeRel - (gd.serveTime + (gd.lateTolerance || 0) - t0) / 1000)
  }, 0)
  let bestLate = lateness(d)
  const repairs = []
  if (bestLate > 0 && !policy.miseEnPlace) {
    for (const factor of [3, Infinity]) {
      const wider = { ...s, policy: { ...policy, floatWindowSeconds: factor === Infinity ? 1e9 : policy.floatWindowSeconds * factor } }
      const alt = dispatch(graph, wider, win.windows, dispatchOpts)
      const altLate = lateness(alt)
      if (altLate < bestLate - 1e-9) {
        d = alt; bestLate = altLate
        repairs.push({ code: 'REPAIR_FLOAT', message: `Floating preparation was allowed to start ${factor === Infinity ? 'any time' : `${factor}× earlier`} to reduce lateness.` })
      }
      if (bestLate <= 0) break
    }
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
    },
    shoppingList: shoppingList(s),
  }
  const violations = diagnostics.some((x) => x.code === 'NO_PARTICIPANTS') ? [] : checkPlan(result, graph, { minPassive: policy.minAppointmentPassiveSeconds })
  if (violations.length) result.diagnostics.push({ code: 'INVARIANT', message: violations.slice(0, 5).join('; '), count: violations.length })
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
