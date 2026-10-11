// Small pure helpers over Plan / Session shapes (README §4, §6) shared by the online modules. Every function that
// returns a plan returns a new object; lanes and items are copied, never mutated in place.

import { mergePolicy, normaliseParticipant } from '../planner/policy.js'

/** Item kinds that represent something a participant actually does. */
export const WORK_KINDS = new Set(['work', 'resume', 'appointment', 'cleaning', 'check', 'setup'])

/** Statuses that freeze an item (the past and the present, spec §6.2). */
export const FROZEN_STATUSES = new Set(['done', 'started', 'paused'])

export function policyOf(session) {
  return mergePolicy(session.policy)
}

export function participantOf(session, id) {
  const p = (session.participants || []).find((x) => x.id === id)
  return p ? normaliseParticipant(p) : null
}

export function allItems(plan) {
  return plan.lanes.flatMap((l) => l.items)
}

/** Find an item by uuid, falling back to the (first not-done) item of a task id. Returns { item, lane } or null. */
export function findItem(plan, uuid) {
  if (!uuid) return null
  for (const lane of plan.lanes) for (const item of lane.items) if (item.uuid === uuid) return { item, lane }
  let fallback = null
  for (const lane of plan.lanes) for (const item of lane.items) {
    if (item.taskId !== uuid || !WORK_KINDS.has(item.kind)) continue
    if (item.status !== 'done') return { item, lane }
    if (!fallback) fallback = { item, lane }
  }
  return fallback
}

export function sortItems(items) {
  return items.slice().sort((a, b) => a.start - b.start || (a.kind === 'blocked' ? -1 : 1))
}

function emptyLane(participantId) {
  return { participantId, items: [], report: { load: 0, expectedLoad: 0, switches: 0, longestLopsidedIdle: 0, timersHeld: 0 } }
}

/** Replace one item: `patch` is an object merged over the item or a function item → item. */
export function updateItem(plan, uuid, patch) {
  const lanes = plan.lanes.map((lane) => {
    if (!lane.items.some((it) => it.uuid === uuid)) return lane
    return { ...lane, items: sortItems(lane.items.map((it) => (it.uuid === uuid ? (typeof patch === 'function' ? patch(it) : { ...it, ...patch }) : it))) }
  })
  return { ...plan, lanes }
}

/** Move an item to another participant's lane (creating the lane when needed). */
export function moveItem(plan, uuid, toParticipantId) {
  const found = findItem(plan, uuid)
  if (!found || found.lane.participantId === toParticipantId) return plan
  const moved = { ...found.item, participantId: toParticipantId }
  let placed = false
  const lanes = plan.lanes.map((lane) => {
    if (lane.participantId === found.lane.participantId) return { ...lane, items: lane.items.filter((it) => it.uuid !== uuid) }
    if (lane.participantId === toParticipantId) { placed = true; return { ...lane, items: sortItems([...lane.items, moved]) } }
    return lane
  })
  if (!placed) lanes.push({ ...emptyLane(toParticipantId), items: [moved] })
  return { ...plan, lanes }
}

/** Rename a participant everywhere in a plan (placeholder reconciliation, spec §6.0.3). */
export function renameParticipant(plan, from, to) {
  const ren = (id) => (id === from ? to : id)
  const lanes = plan.lanes.map((lane) => ({
    ...lane,
    participantId: ren(lane.participantId),
    items: lane.items.map((it) => ({
      ...it,
      participantId: ren(it.participantId),
      inputsFrom: (it.inputsFrom || []).map((x) => ({ ...x, participantId: ren(x.participantId) })),
      outputsTo: (it.outputsTo || []).map((x) => ({ ...x, participantId: ren(x.participantId) })),
      timer: it.timer ? { ...it.timer, holder: ren(it.timer.holder) } : it.timer,
    })),
  }))
  const loads = plan.report && plan.report.loads ? Object.fromEntries(Object.entries(plan.report.loads).map(([k, v]) => [ren(k), v])) : undefined
  const diff = plan.diff ? plan.diff.map((d) => ({ ...d, participantId: ren(d.participantId) })) : plan.diff
  return { ...plan, lanes, diff, report: plan.report ? { ...plan.report, loads } : plan.report }
}

export function addLane(plan, participantId) {
  if (plan.lanes.some((l) => l.participantId === participantId)) return plan
  return { ...plan, lanes: [...plan.lanes, emptyLane(participantId)] }
}

/** The item a participant is actually working on at `now`: the latest-started, not-done item of the lane. */
export function currentItem(lane, now) {
  if (!lane) return null
  const started = lane.items.filter((it) => it.status === 'started' && WORK_KINDS.has(it.kind) && (it.actualStart ?? it.start) <= now)
  if (started.length === 0) return null
  return started.sort((a, b) => (b.actualStart ?? b.start) - (a.actualStart ?? a.start))[0]
}

/** Planned active seconds of an item (start/end are kept consistent with the actuals, so this survives shifts). */
export function plannedActiveSeconds(item) {
  return Math.max(0, (item.end - item.start) / 1000)
}

/**
 * Remaining active seconds of a started item at `now` (spec §6.0.2): reported progress × perUnit when known,
 * otherwise planned active − elapsed, never negative.
 */
export function remainingSeconds(state, item, now) {
  const task = state.graph.tasks[item.taskId]
  const p = participantOf(state.session, item.participantId)
  const speed = p && p.speed > 0 ? p.speed : 1
  const prog = item.progress
  if (prog && prog.done !== null && prog.done !== undefined && prog.of > 0 && task && task.perUnit > 0) {
    return Math.max(0, (prog.of - prog.done) * task.perUnit / speed)
  }
  const since = item.resumedAt ?? item.actualStart ?? item.start
  const elapsed = Math.max(0, (now - since) / 1000)
  return Math.max(0, plannedActiveSeconds(item) - elapsed)
}

/** Epoch ms when a started (or planned) item is expected to end. */
export function projectedEnd(state, item, now) {
  if (item.status === 'started') return now + remainingSeconds(state, item, now) * 1000
  return item.end
}

/** Number of units an item covers. */
export function unitsOf(state, item) {
  if (item.units) return item.units.to - item.units.from + 1
  const task = state.graph.tasks[item.taskId]
  return task ? task.units || 1 : 1
}

/** Shift every time field of an item by `deltaMs`. */
export function shiftItem(item, deltaMs) {
  if (!deltaMs) return item
  return {
    ...item,
    start: item.start + deltaMs,
    end: item.end + deltaMs,
    passiveUntil: item.passiveUntil !== null && item.passiveUntil !== undefined ? item.passiveUntil + deltaMs : item.passiveUntil,
    window: item.window ? { earliest: item.window.earliest + deltaMs, latest: item.window.latest + deltaMs } : item.window,
    timer: item.timer ? { ...item.timer, firesAt: item.timer.firesAt + deltaMs } : item.timer,
  }
}
