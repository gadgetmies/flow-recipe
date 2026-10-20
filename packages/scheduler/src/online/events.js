// Online events (spec §6.0.2, §6.1): apply one event to the state and say whether a re-plan is needed.
// The state is treated as immutable: every path returns a new state object with a new plan / session.

import { normaliseParticipant } from '../planner/policy.js'
import { mergeInventory } from '../inventory.js'
import {
  WORK_KINDS, policyOf, participantOf, allItems, findItem, updateItem, moveItem, renameParticipant, addLane,
  plannedActiveSeconds, unitsOf, shiftItem,
} from './plan-utils.js'

const sec = (ms) => Math.round(ms / 1000)
const lateOrEarly = (deltaMs) => (deltaMs >= 0 ? `${sec(deltaMs)} s late` : `${sec(-deltaMs)} s early`)

function requireItem(state, event) {
  const found = findItem(state.plan, event.uuid)
  if (!found) throw new Error(`applyEvent(${event.type}): unknown item '${event.uuid}'`)
  return found
}

/** Shift the appointment item that follows a work item's timer (its take-out) together with the timer. */
function shiftLinkedAppointment(plan, item, deltaMs) {
  if (!deltaMs || !item.timer || !item.timer.appointmentUuid) return plan
  const found = findItem(plan, item.timer.appointmentUuid)
  if (!found || found.item.status !== 'planned') return plan
  return updateItem(plan, found.item.uuid, (it) => shiftItem(it, deltaMs))
}

/** True when shifting `item` by deltaMs on its lane runs into a fixed (appointment/check) item. */
function crossesFixedItem(lane, item, deltaMs) {
  if (deltaMs <= 0) return false
  const newEnd = item.end + deltaMs
  return lane.items.some((it) => it !== item && it.status === 'planned' && (it.kind === 'appointment' || it.kind === 'check') && it.start >= item.start && it.start < newEnd)
}

function finish(state, event, plan, session, graph, replanNeeded, reason) {
  const next = { ...state, plan, session, graph, events: [...state.events, event] }
  if (replanNeeded) next.lastReason = reason
  return { state: next, replanNeeded, reason }
}

// ---- participants ----------------------------------------------------------------------------------------------

function clipAvailability(avail, at) {
  const windows = avail || [[null, null]]
  const out = []
  for (const [a, b] of windows) {
    if (a !== null && a >= at) continue
    out.push([a, b === null || b > at ? at : b])
  }
  return out
}

function holeAvailability(avail, from, to) {
  const windows = avail || [[null, null]]
  const out = []
  for (const [a, b] of windows) {
    const lo = a === null ? -Infinity : a, hi = b === null ? Infinity : b
    if (hi <= from || lo >= to) { out.push([a, b]); continue }
    if (lo < from) out.push([a, from])
    if (hi > to) out.push([to, b])
  }
  return out
}

/** Distance between a joining participant's profile and a placeholder (speed, role, capabilities). */
function profileDistance(profile, placeholder) {
  const a = normaliseParticipant(profile), b = normaliseParticipant(placeholder)
  let d = Math.abs(a.speed - b.speed) * 10
  if (a.role !== b.role) d += 100
  const ca = a.capabilities ? new Set(a.capabilities) : null, cb = b.capabilities ? new Set(b.capabilities) : null
  if ((ca === null) !== (cb === null)) d += 5
  else if (ca && cb) { for (const c of ca) if (!cb.has(c)) d += 1; for (const c of cb) if (!ca.has(c)) d += 1 }
  return d
}

function joinProfile(event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
  const id = payload.id || event.participantId
  if (!id) throw new Error('applyEvent(participantJoined): participantId or payload.id required')
  const profile = { ...payload, id }
  delete profile.placeholder
  return profile
}

// ---- the event handlers ----------------------------------------------------------------------------------------

function onTaskStarted(state, event, threshold) {
  const { item: orig, lane } = requireItem(state, event)
  let plan = state.plan
  const pid = event.participantId || orig.participantId
  const moved = pid !== orig.participantId
  if (moved) plan = moveItem(plan, orig.uuid, pid)
  const delta = event.at - orig.start
  const patch = (it) => {
    const out = {
      ...shiftItem(it, delta), status: 'started', participantId: pid,
      actualStart: it.status === 'paused' ? it.actualStart ?? event.at : event.at,
      plannedStart: it.plannedStart ?? it.start, plannedEnd: it.plannedEnd ?? it.end,
    }
    if (it.status === 'paused') out.resumedAt = event.at
    return out
  }
  plan = updateItem(plan, orig.uuid, patch)
  plan = shiftLinkedAppointment(plan, orig, delta)
  if (moved) return finish(state, event, plan, state.session, state.graph, true, `'${orig.title}' started by ${pid} instead of ${orig.participantId}`)
  if (Math.abs(delta) > threshold) return finish(state, event, plan, state.session, state.graph, true, `'${orig.title}' started ${lateOrEarly(delta)}`)
  if (crossesFixedItem(lane, orig, delta)) return finish(state, event, plan, state.session, state.graph, true, `'${orig.title}' started ${lateOrEarly(delta)} and runs into an appointment`)
  return finish(state, event, plan, state.session, state.graph, false, `'${orig.title}' started on time`)
}

function onTaskDone(state, event, threshold) {
  const { item: orig } = requireItem(state, event)
  let plan = state.plan
  const pid = event.participantId || orig.participantId
  const moved = pid !== orig.participantId
  if (moved) plan = moveItem(plan, orig.uuid, pid)
  const inferred = orig.status !== 'started' && orig.status !== 'paused'
  const activeMs = plannedActiveSeconds(orig) * 1000
  const delta = event.at - orig.end
  const passiveMs = orig.passiveUntil !== null && orig.passiveUntil !== undefined ? Math.max(0, orig.passiveUntil - orig.end) : 0
  plan = updateItem(plan, orig.uuid, (it) => ({
    ...it, status: 'done', participantId: pid, actualEnd: event.at, end: event.at,
    actualStart: inferred ? event.at - activeMs : it.actualStart ?? it.start,
    start: inferred ? event.at - activeMs : it.start,
    plannedStart: it.plannedStart ?? it.start, plannedEnd: it.plannedEnd ?? it.end,
    passiveUntil: passiveMs > 0 || it.passiveUntil ? event.at + passiveMs : it.passiveUntil,
    timer: it.timer ? { ...it.timer, firesAt: it.timer.firesAt + delta } : it.timer,
    progress: it.progress ? { ...it.progress, done: it.progress.of } : it.progress,
  }))
  plan = shiftLinkedAppointment(plan, orig, delta)
  if (moved) return finish(state, event, plan, state.session, state.graph, true, `'${orig.title}' done by ${pid} instead of ${orig.participantId}`)
  if (Math.abs(delta) > threshold) return finish(state, event, plan, state.session, state.graph, true, `'${orig.title}' done ${lateOrEarly(delta)}`)
  return finish(state, event, plan, state.session, state.graph, false, `'${orig.title}' done on time`)
}

function onTaskPaused(state, event) {
  const { item: orig } = requireItem(state, event)
  const task = state.graph.tasks[orig.taskId]
  const p = participantOf(state.session, orig.participantId)
  const speed = p && p.speed > 0 ? p.speed : 1
  const unitsDone = event.units ?? (event.payload && event.payload.units) ?? null
  const of = unitsOf(state, orig)
  const remainingUnits = unitsDone !== null && unitsDone !== undefined ? Math.max(0, of - unitsDone) : null
  const since = orig.resumedAt ?? orig.actualStart ?? orig.start
  const elapsed = Math.max(0, (event.at - since) / 1000)
  const remainingActive = remainingUnits !== null && task && task.perUnit > 0
    ? remainingUnits * task.perUnit / speed
    : Math.max(0, plannedActiveSeconds(orig) - elapsed)
  const resumeCost = task && task.resumeCost !== undefined && task.resumeCost !== null ? task.resumeCost : 20
  const start = event.at + resumeCost * 1000
  const end = start + Math.round(remainingActive * 1000)
  const passiveMs = orig.passiveUntil !== null && orig.passiveUntil !== undefined ? Math.max(0, orig.passiveUntil - orig.end) : 0
  const plan = updateItem(state.plan, orig.uuid, (it) => ({
    ...it, status: 'paused', kind: 'resume', pausedAt: event.at, actualStart: it.actualStart ?? since,
    plannedStart: it.plannedStart ?? it.start, plannedEnd: it.plannedEnd ?? it.end,
    progress: { done: unitsDone ?? null, of, remainingActive },
    units: it.units && remainingUnits !== null ? { from: it.units.from + (unitsDone || 0), to: it.units.to, of: it.units.of } : it.units,
    start, end,
    passiveUntil: passiveMs > 0 ? end + passiveMs : it.passiveUntil,
    timer: it.timer ? { ...it.timer, firesAt: end + passiveMs } : it.timer,
    instructions: remainingUnits !== null ? `Resume: ${remainingUnits} of ${of} left. ${it.instructions || ''}`.trim() : `Resume: ${it.instructions || it.title}`,
  }))
  return finish(state, event, plan, state.session, state.graph, true, `'${orig.title}' paused${remainingUnits !== null ? ` with ${remainingUnits} unit(s) left` : ''}`)
}

function onTaskProgress(state, event, threshold) {
  const { item: orig } = requireItem(state, event)
  const task = state.graph.tasks[orig.taskId]
  const p = participantOf(state.session, orig.participantId)
  const speed = p && p.speed > 0 ? p.speed : 1
  const done = event.units ?? (event.payload && event.payload.units) ?? null
  const of = unitsOf(state, orig)
  if (done === null || done === undefined) return finish(state, event, state.plan, state.session, state.graph, false, 'progress without units')
  let projectedEnd = orig.end
  if (task && task.perUnit > 0 && orig.status === 'started') projectedEnd = event.at + Math.round(Math.max(0, of - done) * task.perUnit / speed * 1000)
  const delta = projectedEnd - orig.end
  const plan = updateItem(state.plan, orig.uuid, (it) => ({
    ...it, progress: { ...(it.progress || {}), done, of, at: event.at },
    end: projectedEnd,
    passiveUntil: it.passiveUntil !== null && it.passiveUntil !== undefined ? it.passiveUntil + delta : it.passiveUntil,
    timer: it.timer ? { ...it.timer, firesAt: it.timer.firesAt + delta } : it.timer,
  }))
  if (Math.abs(delta) > threshold) return finish(state, event, shiftLinkedAppointment(plan, orig, delta), state.session, state.graph, true, `'${orig.title}' is running ${lateOrEarly(delta)} (${done}/${of} units)`)
  return finish(state, event, plan, state.session, state.graph, false, `'${orig.title}' progress ${done}/${of}`)
}

function onAppointmentAcknowledged(state, event) {
  const { item: orig } = requireItem(state, event)
  const pid = event.participantId || orig.participantId
  let plan = state.plan
  const moved = pid !== orig.participantId
  if (moved) plan = moveItem(plan, orig.uuid, pid)
  plan = updateItem(plan, orig.uuid, { acknowledgedAt: event.at, acknowledgedBy: pid, participantId: pid })
  if (moved) {
    // the timer of the work item behind this appointment now belongs to the new holder
    for (const it of allItems(plan)) {
      if (it.timer && it.timer.appointmentUuid === orig.uuid) plan = updateItem(plan, it.uuid, (x) => ({ ...x, timer: { ...x.timer, holder: pid } }))
    }
    return finish(state, event, plan, state.session, state.graph, true, `'${orig.title}' taken over by ${pid}`)
  }
  return finish(state, event, plan, state.session, state.graph, false, `'${orig.title}' acknowledged`)
}

function onTimerFired(state, event) {
  const found = findItem(state.plan, event.uuid)
  if (!found) return finish(state, event, state.plan, state.session, state.graph, false, `timer '${event.uuid}' fired (no item)`)
  let plan = state.plan
  const it = found.item
  if (it.timer) {
    plan = updateItem(plan, it.uuid, (x) => ({ ...x, timer: { ...x.timer, fired: true, firedAt: event.at } }))
    if (it.timer.appointmentUuid) {
      const appt = findItem(plan, it.timer.appointmentUuid)
      if (appt) plan = updateItem(plan, appt.item.uuid, { timerFiredAt: event.at })
    }
  } else {
    plan = updateItem(plan, it.uuid, { timerFiredAt: event.at })
  }
  return finish(state, event, plan, state.session, state.graph, false, `timer for '${it.title}' fired`)
}

function onSessionStarted(state, event, threshold) {
  const session = {
    ...state.session, startTime: event.at, now: event.at,
    participants: (state.session.participants || []).filter((p) => !p.placeholder),
  }
  const dropped = (state.session.participants || []).filter((p) => p.placeholder).map((p) => p.id)
  const plan = { ...state.plan, status: 'running', mode: 'online', lanes: state.plan.lanes.filter((l) => !dropped.includes(l.participantId)) }
  const delta = event.at - (state.plan.startTime ?? event.at)
  let reason = 'session started'
  if (Math.abs(delta) > threshold) reason += ` ${lateOrEarly(delta)}`
  if (dropped.length) reason += `; placeholder lane(s) removed: ${dropped.join(', ')}`
  return finish(state, event, plan, session, state.graph, true, reason)
}

function onParticipantJoined(state, event) {
  const profile = joinProfile(event)
  const participants = state.session.participants || []
  const existing = participants.find((p) => p.id === profile.id)
  if (existing) {
    if (!existing.leftAt) return finish(state, event, state.plan, state.session, state.graph, false, `${profile.id} is already in the session`)
    const avail = [...(existing.availability || []), [event.at, null]]
    const session = { ...state.session, participants: participants.map((p) => (p === existing ? { ...p, ...profile, availability: avail, leftAt: null } : p)) }
    return finish(state, event, addLane(state.plan, profile.id), session, state.graph, true, `${profile.id} rejoined`)
  }
  const placeholders = participants.filter((p) => p.placeholder)
  if (placeholders.length) {
    const best = placeholders.map((ph) => ({ ph, d: profileDistance(profile, ph) })).sort((a, b) => a.d - b.d || (a.ph.id < b.ph.id ? -1 : 1))[0].ph
    const merged = { ...best, ...profile, placeholder: false }
    const session = { ...state.session, participants: participants.map((p) => (p === best ? merged : p)) }
    const plan = renameParticipant(state.plan, best.id, profile.id)
    const a = normaliseParticipant(merged), b = normaliseParticipant(best)
    const same = a.speed === b.speed && a.role === b.role
    return finish(state, event, plan, session, state.graph, !same, same ? `${profile.id} took over placeholder lane ${best.id}` : `${profile.id} took over placeholder lane ${best.id} with a different profile`)
  }
  const session = { ...state.session, participants: [...participants, profile] }
  return finish(state, event, addLane(state.plan, profile.id), session, state.graph, true, `${profile.id} joined`)
}

function onParticipantLeft(state, event) {
  const participants = state.session.participants || []
  const p = participants.find((x) => x.id === event.participantId)
  if (!p) throw new Error(`applyEvent(participantLeft): unknown participant '${event.participantId}'`)
  const session = { ...state.session, participants: participants.map((x) => (x === p ? { ...x, availability: clipAvailability(x.availability, event.at), leftAt: event.at } : x)) }
  return finish(state, event, state.plan, session, state.graph, true, `${p.id} left`)
}

function onParticipantPaused(state, event) {
  const participants = state.session.participants || []
  const p = participants.find((x) => x.id === event.participantId)
  if (!p) throw new Error(`applyEvent(participantPaused): unknown participant '${event.participantId}'`)
  const payload = event.payload || {}
  const duration = payload.durationSeconds ?? payload.duration ?? event.units ?? 300
  const session = { ...state.session, participants: participants.map((x) => (x === p ? { ...x, availability: holeAvailability(x.availability, event.at, event.at + duration * 1000) } : x)) }
  return finish(state, event, state.plan, session, state.graph, true, `${p.id} paused for ${Math.round(duration / 60)} min`)
}

function onDeadlineChanged(state, event) {
  const payload = event.payload || {}
  const dishId = payload.dishId || payload.dish
  const serveTime = payload.serveTime ?? payload.at
  const dish = (state.session.dishes || []).find((d) => d.id === dishId)
  if (!dish || !(serveTime > 0)) throw new Error(`applyEvent(deadlineChanged): unknown dish '${dishId}' or serve time`)
  const delta = serveTime - dish.serveTime
  const session = { ...state.session, dishes: state.session.dishes.map((d) => (d === dish ? { ...d, serveTime } : d)) }
  const tasks = {}
  for (const [id, t] of Object.entries(state.graph.tasks)) {
    tasks[id] = t.kind === 'sink' && t.dishId === dishId && t.serveWindow ? { ...t, serveWindow: { earliest: t.serveWindow.earliest + delta, latest: t.serveWindow.latest + delta } } : t
  }
  const graph = { ...state.graph, tasks, dishes: state.graph.dishes.map((d) => (d.id === dishId ? { ...d, serveTime: d.serveTime + delta } : d)) }
  return finish(state, event, state.plan, session, graph, true, `serve time of ${dishId} moved ${lateOrEarly(delta)}`)
}

function onResourceChanged(state, event) {
  const payload = event.payload || {}
  const inventory = payload.inventory ? mergeInventory(state.session.inventory || { tools: [], appliances: [], stations: [], holding: [], cleaning: {} }, payload.inventory) : state.session.inventory
  const session = { ...state.session, inventory }
  return finish(state, event, state.plan, session, state.graph, true, payload.reason || 'resources changed')
}

/**
 * Apply an event (README §7 Event) and decide whether a re-plan is needed (spec §6.0.2 table).
 * @param {object} state State from createState / replan
 * @param {object} event { type, at, participantId?, uuid?, units?, payload? }
 * @returns {{ state: object, replanNeeded: boolean, reason: string }}
 */
export function applyEvent(state, event) {
  if (!event || typeof event.type !== 'string') throw new Error('applyEvent: event.type required')
  if (!(event.at > 0)) throw new Error(`applyEvent(${event.type}): event.at (epoch ms) required`)
  const threshold = policyOf(state.session).replanThresholdSeconds * 1000
  switch (event.type) {
    case 'taskStarted': return onTaskStarted(state, event, threshold)
    case 'taskDone': return onTaskDone(state, event, threshold)
    case 'taskPaused': return onTaskPaused(state, event)
    case 'taskProgress': return onTaskProgress(state, event, threshold)
    case 'appointmentAcknowledged': return onAppointmentAcknowledged(state, event)
    case 'timerFired': return onTimerFired(state, event)
    case 'sessionStarted': return onSessionStarted(state, event, threshold)
    case 'participantJoined': return onParticipantJoined(state, event)
    case 'participantLeft': return onParticipantLeft(state, event)
    case 'participantPaused': return onParticipantPaused(state, event)
    case 'deadlineChanged': return onDeadlineChanged(state, event)
    case 'resourceChanged': return onResourceChanged(state, event)
    default: throw new Error(`applyEvent: unknown event type '${event.type}'`)
  }
}
