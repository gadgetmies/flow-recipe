// Online re-plan (spec §6.2): freeze the past and the present, re-run the planner from `now`, carry the frozen
// items over, and report a per-participant diff against the previous plan (stability, spec §4.2 term C).

import { plan as runPlanner, checkPlan } from '../planner/index.js'
import { WORK_KINDS, policyOf, allItems, remainingSeconds, sortItems } from './plan-utils.js'

const FIELD_START_TOLERANCE_MS = 120_000

function isFrozen(it) {
  return it.status === 'done' || it.status === 'started' || it.status === 'paused'
}

/** Items that stand for a graph task (not synthetic completions or checks). */
function representsTask(it) {
  return (it.kind === 'work' || it.kind === 'resume' || it.kind === 'appointment' || it.kind === 'cleaning') && !/@done$|@check\d+$|@blocked$/.test(it.uuid)
}

/**
 * Build the planner's frozen set and the graph overrides for paused tasks from the current plan.
 * @returns {{ frozen: { done: [], running: [] }, graph: object, paused: Map<taskId, Item[]> }}
 */
export function frozenFromPlan(state, now) {
  const items = allItems(state.plan).filter((it) => representsTask(it) && isFrozen(it))
  const byTask = new Map()
  for (const it of items) { if (!byTask.has(it.taskId)) byTask.set(it.taskId, []); byTask.get(it.taskId).push(it) }
  const frozen = { done: [], running: [] }
  const paused = new Map()
  const tasks = { ...state.graph.tasks }
  for (const [taskId, list] of byTask) {
    const task = state.graph.tasks[taskId]
    const started = list.filter((it) => it.status === 'started')
    const pausedItems = list.filter((it) => it.status === 'paused')
    const done = list.filter((it) => it.status === 'done')
    // planned chunks of a partly done task count as remaining work of the active holder
    const planned = allItems(state.plan).filter((it) => it.taskId === taskId && representsTask(it) && it.status === 'planned')
    if (started.length) {
      const holder = started[0]
      const remaining = started.reduce((s, it) => s + remainingSeconds(state, it, now), 0) + planned.reduce((s, it) => s + (it.end - it.start) / 1000, 0)
      frozen.running.push({ taskId, participantId: holder.participantId, start: Math.min(...list.map((it) => it.actualStart ?? it.start)), remainingActive: remaining })
    } else if (pausedItems.length && task) {
      const pi = pausedItems[0]
      const remainingActive = pi.progress && pi.progress.remainingActive !== undefined ? pi.progress.remainingActive : (pi.end - pi.start) / 1000
      const remainingUnits = pi.progress && pi.progress.done !== null && pi.progress.done !== undefined ? Math.max(1, pi.progress.of - pi.progress.done) : task.units
      const resumeCost = task.resumeCost ?? 20
      tasks[taskId] = { ...task, active: remainingActive + resumeCost, units: remainingUnits, title: task.title, resumeOf: pi.uuid }
      paused.set(taskId, pausedItems)
    } else if (done.length) {
      if (planned.length) {
        // some chunks done, others not started: the rest stays with the first holder as running work
        frozen.running.push({ taskId, participantId: done[0].participantId, start: Math.min(...done.map((it) => it.actualStart ?? it.start)), remainingActive: planned.reduce((s, it) => s + (it.end - it.start) / 1000, 0) })
      } else {
        frozen.done.push({
          taskId, participantId: done[0].participantId,
          start: Math.min(...done.map((it) => it.actualStart ?? it.start)),
          end: Math.max(...done.map((it) => it.passiveUntil ?? it.actualEnd ?? it.end)),
        })
      }
    }
  }
  return { frozen, graph: { ...state.graph, tasks }, paused }
}

/**
 * Pure diff of two plans within a horizon: participant / start (> 2 min) / kind changes, additions and removals
 * of planned items. Returns [{ participantId, changes: [{ uuid, field, from, to, reason }] }] (empty when nothing moved).
 */
export function diffPlans(prev, next, now, horizonSeconds, reason = null) {
  const horizonEnd = now + horizonSeconds * 1000
  const relevant = (it) => WORK_KINDS.has(it.kind) && it.status === 'planned' && it.start <= horizonEnd
  const prevItems = new Map(allItems(prev).filter((it) => WORK_KINDS.has(it.kind)).map((it) => [it.uuid, it]))
  const nextItems = new Map(allItems(next).filter((it) => WORK_KINDS.has(it.kind)).map((it) => [it.uuid, it]))
  const byParticipant = new Map()
  const add = (pid, change) => { if (!byParticipant.has(pid)) byParticipant.set(pid, []); byParticipant.get(pid).push(change) }
  for (const it of nextItems.values()) {
    if (!relevant(it)) continue
    const old = prevItems.get(it.uuid)
    if (!old) { add(it.participantId, { uuid: it.uuid, field: 'added', from: null, to: it.participantId, title: it.title, reason }); continue }
    if (old.status !== 'planned') continue
    if (old.participantId !== it.participantId) {
      const change = { uuid: it.uuid, field: 'participantId', from: old.participantId, to: it.participantId, title: it.title, reason }
      add(it.participantId, change)
      add(old.participantId, change)
    }
    if (Math.abs(old.start - it.start) > FIELD_START_TOLERANCE_MS) add(it.participantId, { uuid: it.uuid, field: 'start', from: old.start, to: it.start, title: it.title, reason })
    if (old.kind !== it.kind) add(it.participantId, { uuid: it.uuid, field: 'kind', from: old.kind, to: it.kind, title: it.title, reason })
  }
  for (const old of prevItems.values()) {
    if (!relevant(old) || nextItems.has(old.uuid)) continue
    add(old.participantId, { uuid: old.uuid, field: 'removed', from: old.participantId, to: null, title: old.title, reason })
  }
  return [...byParticipant.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([participantId, changes]) => ({ participantId, changes }))
}

/**
 * Re-plan from `now` with a frozen prefix (README §7).
 * @param {object} state
 * @param {number} now epoch ms
 * @returns {{ state: object, plan: object, diff: Array }}
 */
export function replan(state, now) {
  const policy = policyOf(state.session)
  const prev = state.plan
  const { frozen, graph, paused } = frozenFromPlan(state, now)
  const carried = allItems(prev).filter((it) => it.status === 'done' || it.status === 'started')

  // stability: who had what within the horizon
  const horizonEnd = now + policy.stabilityHorizonSeconds * 1000
  const preferAssignments = {}
  for (const it of allItems(prev)) {
    if (!WORK_KINDS.has(it.kind) || it.start > horizonEnd || (it.status !== 'planned' && it.status !== 'paused')) continue
    preferAssignments[it.uuid] = it.participantId
    if (preferAssignments[it.taskId] === undefined) preferAssignments[it.taskId] = it.participantId
  }

  const session = { ...state.session, now }
  const next = runPlanner(graph, session, { previousPlan: prev, frozen, now, mode: 'online', status: 'running', preferAssignments })
  next.startTime = state.session.startTime ?? next.startTime

  // paused tasks come back as resume items under their old uuid, with their actuals
  for (const lane of next.lanes) {
    lane.items = lane.items.map((it) => {
      const list = paused.get(it.taskId)
      if (!list || !(it.kind === 'work' || it.kind === 'resume')) return it
      const pi = list[0]
      const siblings = allItems(next).filter((x) => x.taskId === it.taskId && (x.kind === 'work' || x.kind === 'resume'))
      const uuid = siblings.length === 1 ? pi.uuid : it.uuid
      // pi.units already holds the remaining range (set when it was paused); a re-chunked task offsets from it
      const offset = pi.units ? pi.units.from - 1 : 0
      const units = siblings.length === 1 ? pi.units : (it.units && pi.units ? { from: it.units.from + offset, to: it.units.to + offset, of: pi.units.of } : it.units)
      return {
        ...it, uuid, kind: 'resume', status: 'paused', actualStart: pi.actualStart, pausedAt: pi.pausedAt, progress: pi.progress,
        plannedStart: pi.plannedStart ?? pi.start, plannedEnd: pi.plannedEnd ?? pi.end, instructions: pi.instructions, units,
      }
    })
  }
  const placedPaused = new Set(allItems(next).filter((it) => it.status === 'paused').map((it) => it.taskId))
  for (const [taskId, list] of paused) if (!placedPaused.has(taskId)) carried.push(...list) // planner could not place it: keep as is

  // carry the frozen items over (the planner only emits new work)
  const laneById = new Map(next.lanes.map((l) => [l.participantId, l]))
  const nextUuids = new Set(allItems(next).map((it) => it.uuid))
  const appointmentHolder = new Map(allItems(next).filter((it) => it.kind === 'appointment').map((it) => [it.uuid, it.participantId]))
  for (const it of carried) {
    if (nextUuids.has(it.uuid)) continue
    let item = it
    if (item.timer && item.timer.appointmentUuid && appointmentHolder.has(item.timer.appointmentUuid)) {
      item = { ...item, timer: { ...item.timer, holder: appointmentHolder.get(item.timer.appointmentUuid) } }
    }
    let lane = laneById.get(item.participantId)
    if (!lane) { lane = { participantId: item.participantId, items: [], report: { load: 0, expectedLoad: 0, switches: 0, longestLopsidedIdle: 0, timersHeld: 0 } }; next.lanes.push(lane); laneById.set(item.participantId, lane) }
    lane.items.push(item)
  }
  for (const lane of next.lanes) lane.items = sortItems(lane.items)
  const ends = allItems(next).map((it) => it.passiveUntil || it.end)
  if (ends.length) next.endTime = Math.max(...ends)

  // the planner checked its invariants before the frozen items were back in the lanes; check the whole plan.
  // Tool usage of done items is history (two late starts may really have shared a bowl) and is not re-checked.
  next.diagnostics = next.diagnostics.filter((d) => d.code !== 'INVARIANT')
  const checkable = { ...next, lanes: next.lanes.map((l) => ({ ...l, items: l.items.map((it) => (it.status === 'done' ? { ...it, tools: [] } : it)) })) }
  const violations = checkPlan(checkable, state.graph, { minPassive: policy.minAppointmentPassiveSeconds })
  if (violations.length) next.diagnostics.push({ code: 'INVARIANT', message: violations.slice(0, 5).join('; '), count: violations.length })

  const diff = diffPlans(prev, next, now, policy.stabilityHorizonSeconds, state.lastReason)
  next.diff = diff
  const frozenMap = Object.fromEntries(allItems(next).filter(isFrozen).map((it) => [it.uuid, it]))
  return { state: { ...state, plan: next, frozen: frozenMap }, plan: next, diff }
}
