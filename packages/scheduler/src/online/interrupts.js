// Interrupts (spec §6.3): who should handle an appointment whose holder is busy, and which appointments are due.

import { switchSeconds } from '../planner/cost.js'
import { policyOf, participantOf, allItems, findItem, currentItem, projectedEnd } from './plan-utils.js'

const INF = Number.POSITIVE_INFINITY
const LAMBDA_TIMER = 10

function contextOf(item) {
  if (!item) return null
  const c = item.context || {}
  return { dish: c.dish || item.dishId, station: c.station || 'counter', tool: c.tool || null, task: item.taskId, soil: null }
}

function laneOf(plan, participantId) {
  return plan.lanes.find((l) => l.participantId === participantId) || null
}

function availableAt(p, now) {
  if (!p.availability) return true
  return p.availability.some(([a, b]) => (a === null || a <= now) && (b === null || now < b))
}

/** Live timers held by a participant: work items whose passive phase is running (status done, passiveUntil > now). */
export function liveTimers(lane, now) {
  if (!lane) return 0
  return lane.items.filter((it) => it.timer && (it.kind === 'work' || it.kind === 'resume') && it.status === 'done' && it.passiveUntil > now).length
}

function windowOpen(appointment) {
  if (appointment.window && appointment.window.earliest !== undefined) return appointment.window.earliest
  if (appointment.timer && appointment.timer.firesAt) return appointment.timer.firesAt
  return appointment.start
}

/** Cost of preempting `item` (spec §6.3): free 0, units → resumeCost + time to the next unit boundary, anywhere → resumeCost, never → ∞. */
export function preemptionCost(state, item, now) {
  if (!item) return 0
  if (item.urgency === 'critical') return INF
  const task = state.graph.tasks[item.taskId]
  const resumeCost = task && task.resumeCost !== undefined && task.resumeCost !== null ? task.resumeCost : 20
  const mode = item.preemptible || (task && task.preemptible) || 'never'
  if (mode === 'anywhere') return resumeCost
  if (mode === 'units') {
    const p = participantOf(state.session, item.participantId)
    const speed = p && p.speed > 0 ? p.speed : 1
    const perUnit = task && task.perUnit > 0 ? task.perUnit / speed : 0
    if (perUnit <= 0) return resumeCost
    const elapsed = Math.max(0, (now - (item.resumedAt ?? item.actualStart ?? item.start)) / 1000)
    const toBoundary = perUnit - (elapsed % perUnit)
    return resumeCost + (toBoundary >= perUnit - 1e-9 ? 0 : toBoundary)
  }
  return INF
}

/**
 * Choose who handles an appointment (spec §6.3).
 * @param {object} state
 * @param {object|string} appointment an appointment item (kind 'appointment', or a work item with a timer) or its uuid
 * @param {number} now epoch ms
 * @returns {{ participantId: string|null, cost: number, preempts: string|null, broadcast?: boolean }|null}
 */
export function chooseInterruptTarget(state, appointment, now) {
  const appt = typeof appointment === 'string' ? (findItem(state.plan, appointment) || {}).item : appointment
  if (!appt) return null
  const policy = policyOf(state.session)
  const open = windowOpen(appt)
  const holderId = appt.kind === 'appointment' ? appt.participantId : (appt.timer && appt.timer.holder) || appt.participantId
  if (holderId) {
    const cur = currentItem(laneOf(state.plan, holderId), now)
    if (!cur || cur.uuid === appt.uuid || projectedEnd(state, cur, now) <= open) return { participantId: holderId, cost: 0, preempts: null }
  }
  const target = contextOf(appt)
  let best = null
  for (const raw of state.session.participants || []) {
    const p = participantOf(state.session, raw.id)
    if (!p || p.role === 'spectator' || p.placeholder || p.leftAt || !availableAt(p, now)) continue
    const lane = laneOf(state.plan, p.id)
    const cur = currentItem(lane, now)
    let cost = switchSeconds(contextOf(cur), target, policy.switchMatrix)
    cost += preemptionCost(state, cur, now)
    cost += LAMBDA_TIMER * liveTimers(lane, now)
    cost += 0 // walking time: stations are within reach in a home kitchen
    const cand = { participantId: p.id, cost, preempts: cur && cur.uuid !== appt.uuid ? cur.uuid : null }
    if (!best || cand.cost < best.cost || (cand.cost === best.cost && cand.participantId < best.participantId)) best = cand
  }
  if (!best || best.cost === INF) return { participantId: null, cost: INF, preempts: null, broadcast: true }
  return best
}

/**
 * Appointments whose window opens within lead + reaction time and whose holder is busy on an item that does not end
 * before the window (or that have no holder). The server polls this.
 * @returns {Array<{ item, uuid, opensAt, holder, target }>}
 */
export function dueInterrupts(state, now) {
  const policy = policyOf(state.session)
  const lookahead = (policy.leadSeconds + policy.reactionSeconds) * 1000
  const items = allItems(state.plan)
  const uuids = new Set(items.map((it) => it.uuid))
  const out = []
  const consider = (item, holderId, open) => {
    if (open > now + lookahead) return
    if ((item.window ? item.window.latest : item.end) + 30 * 60 * 1000 < now) return
    if (holderId) {
      const cur = currentItem(laneOf(state.plan, holderId), now)
      if (!cur || cur.uuid === item.uuid || projectedEnd(state, cur, now) <= open) return
    }
    out.push({ item, uuid: item.uuid, opensAt: open, holder: holderId || null, target: chooseInterruptTarget(state, item, now) })
  }
  for (const it of items) {
    if (it.kind === 'appointment') {
      if (it.status !== 'planned' || it.acknowledgedAt) continue
      consider(it, it.participantId, windowOpen(it))
    } else if ((it.kind === 'work' || it.kind === 'resume') && it.timer && it.status === 'done') {
      if (it.timer.appointmentUuid && uuids.has(it.timer.appointmentUuid)) continue // the appointment item covers it
      if (it.timer.handledAt) continue
      consider(it, it.timer.holder || null, it.timer.firesAt)
    }
  }
  return out.sort((a, b) => a.opensAt - b.opensAt || (a.uuid < b.uuid ? -1 : 1))
}
