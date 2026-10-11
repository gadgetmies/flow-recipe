// Phase E (spec §5.5): time-stepped forward dispatch with participants, tool instances and cleaning, appliances
// with modes, stations and holding slots, appointments for critical/timed completions, carrier-bound buffers
// (blocking shows up as waiting for a bound instance), chunking of divisible work, switching and fairness costs,
// end-of-session cleaning fillers.
//
// Internal clock: seconds relative to the plan origin. The caller converts to epoch ms.

import { ToolPool, AppliancePool, StationPool } from './resources.js'
import { switchSeconds, assignmentCost } from './cost.js'
import { tightenForHold } from './windows.js'

const INF = Number.POSITIVE_INFINITY
const URGENCY_RANK = { critical: 0, timed: 1, relaxed: 2 }
const APPOINTMENT_MAX_ACTIVE = 180

function byId(a, b) { return a < b ? -1 : a > b ? 1 : 0 }

/**
 * @param {object} graph
 * @param {object} session normalised session (participants normalised, policy merged)
 * @param {object} windows from computeWindows (relative seconds)
 * @param {object} opts { frozen?: { done: [...], running: [...] }, now: relative seconds (default 0), horizon }
 */
export function dispatch(graph, session, windows, opts = {}) {
  const policy = session.policy
  const now0 = opts.now || 0
  const diagnostics = []
  const log = []

  // ---- participants --------------------------------------------------------------------------------------
  const participants = session.participants
    .filter((p) => p.role !== 'spectator')
    .map((p) => ({
      id: p.id, name: p.name, speed: p.speed, caps: p.capabilities ? new Set(p.capabilities) : null, role: p.role,
      targetShare: p.targetShare, maxTimers: p.maxConcurrentTimers, placeholder: !!p.placeholder,
      avail: p.availabilityRel || [[-INF, INF]],
      freeAt: now0, lastContext: null, load: 0, timers: [], blocked: [], items: [], lastItemEnd: now0,
    }))
  if (participants.length === 0) {
    diagnostics.push({ code: 'NO_PARTICIPANTS', message: 'No cooking participants; nothing can be scheduled.' })
    return { items: [], participants, diagnostics, dishes: [], done: false, log }
  }
  const pById = new Map(participants.map((p) => [p.id, p]))

  function availableThrough(p, s, e) {
    return p.avail.some(([a, b]) => a <= s && e <= b)
  }
  function nextAvailabilityEdge(p, t) {
    let best = INF
    for (const [a, b] of p.avail) {
      if (a > t) best = Math.min(best, a)
      if (b > t) best = Math.min(best, b)
    }
    return best
  }

  // ---- resources -----------------------------------------------------------------------------------------
  const neededTypes = new Set()
  for (const t of Object.values(graph.tasks)) {
    for (const tool of t.tools || []) neededTypes.add(tool.type)
    for (const r of t.returnsTools || []) neededTypes.add(r)
  }
  const tools = new ToolPool(session.inventory, neededTypes, diagnostics)
  const appliances = new AppliancePool(session.inventory)
  const stations = new StationPool(session.inventory)
  const cleanSeconds = { rinse: session.inventory.cleaning?.rinseSeconds ?? 20, wash: session.inventory.cleaning?.washSeconds ?? 90 }

  // ---- task runtime state --------------------------------------------------------------------------------
  const succ = new Map()
  const pred = new Map()
  for (const id of graph.order) { succ.set(id, []); pred.set(id, []) }
  for (const e of graph.edges) {
    if (succ.has(e.from) && pred.has(e.to)) { succ.get(e.from).push(e); pred.get(e.to).push(e) }
  }

  /** @type {Map<string, Runtime>} */
  const rt = new Map()
  for (const id of graph.order) {
    const t = graph.tasks[id]
    rt.set(id, {
      id, task: t, status: 'pending', start: null, activeEnd: null, end: null, participant: null,
      chunks: null, fixedStart: null, fixedParticipant: null, waitedFor: null, readySince: null,
      window: windows[id] ? { ...windows[id] } : { ES: 0, LS: INF, LF: INF, r: -INF, anchored: false, duration: 0, slack: INF },
      boundTools: [], appointmentFor: null,
    })
  }
  const extra = [] // generated runtime tasks (cleaning, synthetic appointments)
  let seq = 0

  const items = []

  // ---- frozen prefix (online mode) -----------------------------------------------------------------------
  const frozen = opts.frozen || { done: [], running: [] }
  for (const d of frozen.done || []) {
    const r = rt.get(d.taskId || d.uuid)
    if (!r) continue
    r.status = 'done'; r.start = d.start; r.activeEnd = d.end; r.end = d.end; r.participant = d.participantId
    r.frozenItem = d
  }
  for (const d of frozen.running || []) {
    const r = rt.get(d.taskId || d.uuid)
    if (!r) continue
    const p = pById.get(d.participantId)
    r.status = 'placed'; r.start = d.start; r.participant = d.participantId
    r.activeEnd = now0 + Math.max(0, d.remainingActive || 0)
    r.end = r.activeEnd + (r.task.passive || 0)
    r.frozenItem = d
    if (p) { p.freeAt = Math.max(p.freeAt, r.activeEnd); p.lastContext = contextOf(r.task); p.load += (r.task.active || 0) * (r.task.tedium || 1) }
  }

  function contextOf(task) {
    const c = task.context || {}
    return { dish: c.dish || task.dishId, station: c.station || 'counter', tool: c.tool || null, task: task.id, soil: task.tools?.some((x) => x.soil === 'wash') ? 'wash' : null }
  }

  // ---- fairness bookkeeping ------------------------------------------------------------------------------
  const loads = {}
  const expected = {}
  const totalActive = Object.values(graph.tasks).reduce((s, t) => s + (t.active || 0) * (t.tedium || 1), 0)
  const shareSum = participants.reduce((s, p) => s + p.targetShare, 0) || 1
  for (const p of participants) { loads[p.id] = p.load; expected[p.id] = totalActive * (p.targetShare / shareSum) }

  // ---- helpers -------------------------------------------------------------------------------------------
  function predsSatisfiedAt(r) {
    // returns the time all incoming edges are satisfied, or null if a predecessor is not placed yet
    let ready = -INF
    for (const e of pred.get(r.id) || []) {
      const pr = rt.get(e.from)
      if (!pr || pr.status === 'pending') return null
      if (e.kind === 'fs' || e.kind === 'maxlag') ready = Math.max(ready, pr.end)
      else if (e.kind === 'stream') ready = Math.max(ready, pr.start + (e.lag || 0))
    }
    return ready === -INF ? 0 : ready
  }

  function priorityKey(r) {
    const u = r.task.completion ? URGENCY_RANK[r.task.completion.urgency] ?? 2 : 2
    const anchoredBoost = r.window.anchored ? 0 : 1
    return [r.isCleaning ? 0 : 1, u * 0 + 0, r.window.LS, anchoredBoost, -(r.task.tedium || 1), r.id]
  }
  function cmpKey(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue
      if (typeof a[i] === 'string') return byId(a[i], b[i])
      return a[i] - b[i]
    }
    return 0
  }

  function carrierKey(task, type) {
    return `${task.dishId}:${type}:b${task.batch ? task.batch.index : 0}`
  }

  function requiredToolBindings(r, t) {
    // Returns { ok: bool, bindings: [{instance, mode, soil, type}], missingType, needsCleaning: instance|null }
    const bindings = []
    for (const need of r.task.tools || []) {
      const qty = Math.max(1, need.qty || 1)
      for (let q = 0; q < qty; q++) {
        let inst = null
        // 1. instance bound to an input output id (reserved tool passed along with the result)
        for (const inp of r.task.inputs || []) {
          inst = tools.bound(need.type, inp.ref)
          if (inst && !bindings.some((b) => b.instance === inst)) break
          inst = null
        }
        // 2. carrier bound to this batch
        if (!inst) {
          const c = tools.bound(need.type, carrierKey(r.task, need.type))
          if (c && !bindings.some((b) => b.instance === c)) inst = c
        }
        // 2b. share an instance reserved for an output that feeds the same consumer as our output
        //     (measuring sugar into the bowl that already holds the flour)
        if (!inst) {
          const myOuts = new Set((r.task.outputs || []).map((o) => o.id))
          for (const cand of tools.all(need.type)) {
            if (!cand.binding || bindings.some((b) => b.instance === cand)) continue
            const consumer = [...rt.values()].find((x) => x.status === 'pending' && (x.task.inputs || []).some((i) => i.ref === cand.binding))
            if (consumer && (consumer.task.inputs || []).some((i) => myOuts.has(i.ref)) && consumer.task.dishId === r.task.dishId) { inst = cand; break }
          }
        }
        if (inst && inst.busyUntil > t) return { ok: false, bindings: [], missingType: need.type, needsCleaning: null, waitUntil: inst.busyUntil }
        // 3. free clean instance
        if (!inst) {
          const list = tools.all(need.type).filter((i) => i.binding === null && i.busyUntil <= t && i.state === 'clean' && !bindings.some((b) => b.instance === i))
          inst = list[0] || null
        }
        if (!inst) {
          const dirty = tools.dirtyCandidate(need.type, t)
          return { ok: false, bindings: [], missingType: need.type, needsCleaning: dirty, waitUntil: tools.nextFreeTime(need.type, t) }
        }
        bindings.push({ instance: inst, type: need.type, mode: need.mode || 'active', soil: need.soil || r.task.soil || 'rinse', reserved: need.mode === 'reserved' })
      }
    }
    return { ok: true, bindings }
  }

  function applianceNeed(task) {
    if (task.appliance && appliances.has(task.appliance.type)) return { type: task.appliance.type, mode: task.appliance.mode || null }
    const st = task.context?.station
    if (st === 'hob' && appliances.has('hob')) return { type: 'hob', mode: null }
    return null
  }
  function holdingNeed(task) {
    const st = task.context?.station
    if (st === 'fridge' && stations.has('fridge') && (task.passive || 0) > 0) return 'fridge'
    return null
  }
  function stationNeed(task) {
    const st = task.context?.station
    if (st === 'sink' && stations.has('sink')) return 'sink'
    return null
  }

  function laneBlockOverlap(p, s, e) {
    return p.blocked.find((b) => b.start < e && s < b.end) || null
  }

  function makeCleaningTask(instance, needingTask, t) {
    const level = instance.state === 'wash' ? 'wash' : 'rinse'
    const active = cleanSeconds[level]
    const id = `clean:${instance.id}:${++seq}`
    const task = {
      id, dishId: needingTask ? needingTask.dishId : null, recipeTaskId: null, operation: 'clean',
      title: `Wash ${instance.type}`, instructions: `${level === 'wash' ? 'Wash' : 'Rinse'} the ${instance.type} (${instance.id})${needingTask ? ` so it is ready for ${needingTask.title.toLowerCase()}` : ''}`,
      units: 1, unitStream: null, batch: null, active, passive: 0, timeModel: 'fixed', perUnit: 0,
      attention: 'attended', divisible: 'none', preemptible: 'anywhere', resumeCost: 10, completion: null,
      context: { dish: needingTask ? needingTask.dishId : 'kitchen', station: 'sink', tool: instance.type }, tedium: 1.5, requires: [],
      tools: [], appliance: null, returnsTools: [], hold: INF, outputs: [], inputs: [], kind: 'work',
    }
    const needW = needingTask ? rt.get(needingTask.id).window : null
    const r = {
      id, task, status: 'pending', start: null, activeEnd: null, end: null, participant: null, chunks: null,
      fixedStart: null, fixedParticipant: null, waitedFor: null, readySince: t, isCleaning: true, cleans: instance,
      window: { ES: t, LS: needW && Number.isFinite(needW.LS) ? needW.LS - active : t + 3600, LF: INF, r: -INF, anchored: false, duration: active, slack: INF },
      boundTools: [],
    }
    instance.cleaningScheduled = true
    extra.push(r)
    rt.set(id, r)
    pred.set(id, []); succ.set(id, [])
    return r
  }

  function chooseHolder(r, endTime, dur) {
    let best = null, bestCost = INF
    for (const p of participants) {
      if (p.timers.length >= p.maxTimers) continue
      if (!availableThrough(p, endTime - policy.leadSeconds, endTime + dur)) continue
      if (laneBlockOverlap(p, endTime - policy.leadSeconds, endTime + dur)) continue
      const exp = Math.max(1, expected[p.id])
      let cost = policy.weights.fair * 60 * ((loads[p.id] || 0) - exp) / exp
      cost += 10 * p.timers.length
      const sameDish = p.lastContext && p.lastContext.dish === r.task.dishId
      cost += sameDish ? 0 : 15
      // prefer whoever placed the task (they know the oven) unless overloaded
      if (p.id === r.participant) cost -= 10
      if (cost < bestCost) { bestCost = cost; best = p }
    }
    return best
  }

  function placeAppointment(r) {
    const c = r.task.completion
    if (!c || !(r.task.passive > 0) || c.urgency === 'relaxed') return
    // successor that is the completion follow-up (take-out) when short; otherwise synthetic item
    const fsSucc = (succ.get(r.id) || []).filter((e) => e.kind === 'fs').map((e) => rt.get(e.to)).filter((s) => s && s.status === 'pending')
    const follow = fsSucc.filter((s) => (s.task.active || 0) <= APPOINTMENT_MAX_ACTIVE && (pred.get(s.id) || []).length === 1).sort((a, b) => byId(a.id, b.id))[0] || null
    const dur = follow ? (follow.task.active || c.duration || 30) : (c.duration || 30)
    const holder = chooseHolder(r, r.end, dur)
    if (!holder) {
      diagnostics.push({ code: 'NO_APPOINTMENT_HOLDER', message: `Nobody is free to handle the end of '${r.task.title}'; it will be an interrupt.`, task: r.id })
      return
    }
    holder.timers.push({ firesAt: r.end, taskId: r.id })
    holder.blocked.push({ start: r.end - policy.leadSeconds, end: r.end + dur / holder.speed, uuid: follow ? follow.id : `${r.id}@done` })
    if (follow) {
      follow.fixedStart = r.end
      follow.fixedParticipant = holder.id
      follow.appointmentFor = r.id
      r.appointment = { holder: holder.id, uuid: follow.id, dur }
    } else {
      r.appointment = { holder: holder.id, uuid: `${r.id}@done`, dur, synthetic: true }
    }
    // monitored: periodic checks
    if (r.task.attention === 'monitored' && r.task.checkInterval > 0) {
      for (let k = r.activeEnd + r.task.checkInterval; k < r.end - 1; k += r.task.checkInterval) {
        const d = r.task.checkDuration || 10
        holder.blocked.push({ start: k, end: k + d, uuid: `${r.id}@check${Math.round(k)}` })
        items.push(itemFor({ uuid: `${r.id}@check${Math.round(k)}`, taskId: r.id, kind: 'check', participantId: holder.id, start: k, end: k + d, title: `Check ${r.task.title.toLowerCase()}`, instructions: `Check on ${r.task.title.toLowerCase()}`, task: r.task, window: { earliest: k - r.task.checkInterval / 2, latest: k + r.task.checkInterval / 2 }, urgency: 'timed' }))
      }
    }
    if (r.appointment.synthetic) {
      items.push(itemFor({ uuid: r.appointment.uuid, taskId: r.id, kind: 'appointment', participantId: holder.id, start: r.end, end: r.end + dur / holder.speed, title: `Finish: ${r.task.title}`, instructions: `${r.task.title} is done; take care of it.`, task: r.task, window: { earliest: r.end - (c.early || 0), latest: r.end + (c.late || 60) }, urgency: c.urgency, timer: { title: r.task.title, durationSeconds: r.task.passive, firesAt: r.end } }))
    }
  }

  function itemFor(x) {
    return {
      uuid: x.uuid, taskId: x.taskId, kind: x.kind, participantId: x.participantId, start: x.start, end: x.end,
      status: 'planned', title: x.title, instructions: x.instructions, dishId: x.task ? x.task.dishId : null,
      context: x.task ? { dish: x.task.dishId, station: x.task.context?.station || 'counter', tool: x.task.context?.tool || null } : null,
      units: x.units || null, inputsFrom: [], outputsTo: [], preemptible: x.task ? x.task.preemptible || 'never' : 'never',
      urgency: x.urgency || null, window: x.window || null, timer: x.timer || null, dependencies: x.dependencies || [],
      tools: x.tools || [], passiveUntil: x.passiveUntil || null, setupSeconds: x.setupSeconds || 0, waitedFor: x.waitedFor || null,
    }
  }

  function place(r, p, t, { units = null, chunkIndex = null, chunkOf = null, fixed = false } = {}) {
    const task = r.task
    const setup = fixed ? 0 : switchSeconds(p.lastContext, contextOf(task), policy.switchMatrix)
    const s = fixed ? t : t + setup
    const unitsHere = units ?? task.units
    let active = task.active || 0
    if (units !== null && task.units > 0 && task.timeModel === 'per-unit') active = (task.perUnit || 0) * units
    else if (units !== null && task.units > 0) active = active * (units / task.units)
    const a = active / p.speed
    let activeEnd = s + a
    let end = activeEnd + (task.passive || 0)
    // stream finish-to-finish lag
    for (const e of pred.get(r.id) || []) {
      if (e.kind === 'stream') {
        const pr = rt.get(e.from)
        if (pr && pr.end !== null) {
          const minEnd = pr.activeEnd + (e.ffLag || 0)
          if (activeEnd < minEnd) { activeEnd = minEnd; end = activeEnd + (task.passive || 0) }
        }
      }
    }
    // resources
    const bind = requiredToolBindings(r, t)
    const toolRefs = []
    for (const b of bind.bindings || []) {
      const inst = b.instance
      let binding = null
      if (b.reserved) binding = (task.outputs && task.outputs[0]) ? task.outputs[0].id : null
      const isCarrier = graph.buffers.some((buf) => buf.carrier === b.type && (buf.from === r.id || buf.to === r.id)) || (task.unitStream && task.returnsTools?.includes(b.type)) || (task.batch && task.unitStream)
      if (task.batch && task.unitStream && !binding) binding = carrierKey(task, b.type)
      else if (isCarrier && !binding) binding = carrierKey(task, b.type)
      const until = b.reserved || binding ? end : activeEnd
      tools.acquire(inst, { until, binding })
      r.boundTools.push({ instance: inst, soil: b.soil, binding, reserved: !!binding })
      toolRefs.push({ type: b.type, instanceId: inst.id })
    }
    const an = applianceNeed(task)
    if (an) {
      const slot = appliances.freeSlot(an.type, t, an.mode)
      if (slot) appliances.acquire(an.type, slot, { until: end, holder: r.id, mode: an.mode })
      if (task.operation === 'preheat-oven' && an.mode) r.setsMode = an
    }
    const hn = holdingNeed(task)
    if (hn) { const slot = stations.freeSlot(hn, t); if (slot) stations.acquire(slot, end) }
    const sn = stationNeed(task)
    if (sn) { const slot = stations.freeSlot(sn, t); if (slot) stations.acquire(slot, activeEnd) }

    r.status = 'placed'; r.start = s; r.activeEnd = activeEnd; r.end = end; r.participant = p.id
    p.freeAt = activeEnd
    p.lastContext = contextOf(task)
    p.load += (active * (task.tedium || 1)) + setup
    loads[p.id] = p.load
    p.lastItemEnd = activeEnd

    const uuid = chunkIndex !== null ? `${r.id}/c${chunkIndex}` : r.id
    const item = itemFor({
      uuid, taskId: r.id, kind: r.isCleaning ? 'cleaning' : (fixed && r.appointmentFor ? 'appointment' : 'work'), participantId: p.id, start: s, end: activeEnd,
      title: task.title, instructions: task.instructions, task,
      units: chunkIndex !== null ? { from: chunkOf.from, to: chunkOf.to, of: task.units } : (task.units > 1 && task.unitStream ? { from: 1, to: task.units, of: task.units } : null),
      dependencies: (pred.get(r.id) || []).map((e) => e.from), tools: toolRefs, passiveUntil: task.passive > 0 ? end : null,
      urgency: fixed && r.appointmentFor ? rt.get(r.appointmentFor).task.completion.urgency : null,
      window: fixed && r.appointmentFor ? { earliest: t - (rt.get(r.appointmentFor).task.completion.early || 0), latest: t + (rt.get(r.appointmentFor).task.completion.late || 60) } : null,
      timer: task.passive > 0 && task.completion && task.completion.urgency !== 'relaxed' ? null : null,
      setupSeconds: setup, waitedFor: r.waitedFor,
    })
    if (setup > 0) item.setupSeconds = setup
    item.preemptible = task.preemptible || 'never'
    items.push(item)
    r.item = item
    return item
  }

  function finish(r, t) {
    // release resources at the task's end (called when the clock passes r.end)
    const task = r.task
    for (const b of r.boundTools) {
      if (b.reserved) {
        // keep bound until a consumer takes it over; release when nobody downstream references the type
        const downstreamUses = (succ.get(r.id) || []).some((e) => { const s = rt.get(e.to); return s && (s.task.tools || []).some((x) => x.type === b.instance.type) })
        if (!downstreamUses || (task.returnsTools || []).includes(b.instance.type)) {
          tools.release(b.instance, r.end, b.soil, { unbind: true })
        } else {
          // hand over: rebind to our output id so the consumer finds it
          const out = task.outputs && task.outputs[0] ? task.outputs[0].id : null
          b.instance.binding = out && !(task.batch && task.unitStream) ? out : b.binding
          b.instance.busyUntil = r.end
          b.instance.state = b.soil === 'wash' ? 'wash' : (b.instance.state === 'clean' ? 'rinse' : b.instance.state)
        }
      } else {
        tools.release(b.instance, r.activeEnd, b.soil, { unbind: true })
      }
    }
    for (const type of task.returnsTools || []) {
      for (const inst of tools.all(type)) {
        if (inst.binding === carrierKey(task, type) || (inst.binding && (task.inputs || []).some((i) => i.ref === inst.binding))) tools.release(inst, r.end, task.soil || 'rinse', { unbind: true })
      }
    }
    if (r.setsMode) appliances.setMode(r.setsMode.type, r.setsMode.mode)
    if (r.isCleaning && r.cleans) tools.markCleaned(r.cleans, r.activeEnd)
    r.status = 'done'
    // tighten consumers for freshness
    for (const e of succ.get(r.id) || []) {
      if (e.kind === 'maxlag') {
        const s = rt.get(e.to)
        if (s && s.status === 'pending') s.window = tightenForHold(s.window, r.end, e.hold)
      }
    }
  }

  function releaseDueTasks(t) {
    for (const r of rt.values()) {
      if (r.status === 'placed' && r.end <= t + 1e-9) finish(r, t)
      else if (r.status === 'placed' && r.activeEnd <= t + 1e-9 && !r.activeReleased) {
        r.activeReleased = true
        for (const b of r.boundTools) if (!b.reserved) tools.release(b.instance, r.activeEnd, b.soil, { unbind: true })
      }
    }
  }

  // ---- main loop ------------------------------------------------------------------------------------------
  let t = now0
  let guard = 0
  const maxIter = 20000
  const dishServe = {}

  while (guard++ < maxIter) {
    releaseDueTasks(t)
    const pending = [...rt.values()].filter((r) => r.status === 'pending')
    if (pending.length === 0) break

    // ready set
    const ready = []
    const waitingTimes = []
    for (const r of pending) {
      const pr = predsSatisfiedAt(r)
      if (pr === null) continue
      if (pr > t + 1e-9) { waitingTimes.push(pr); continue }
      if (r.readySince === null) r.readySince = Math.max(pr, t)
      if (r.fixedStart !== null) {
        if (r.fixedStart > t + 1e-9) { waitingTimes.push(r.fixedStart); continue }
      } else if (Number.isFinite(r.window.r) && r.window.r > t + 1e-9) { waitingTimes.push(r.window.r); continue }
      ready.push(r)
    }
    ready.sort((a, b) => cmpKey(priorityKey(a), priorityKey(b)))

    let placedAny = false
    for (const r of ready) {
      const task = r.task
      if (task.kind === 'sink') {
        const earliest = task.serveWindow ? (task.serveWindow.earliest - session.t0) / 1000 : t
        const st = Math.max(t, earliest)
        r.status = 'placed'; r.start = st; r.activeEnd = st; r.end = st; r.participant = null
        dishServe[task.dishId] = st
        placedAny = true
        continue
      }
      // fixed appointment follow-ups
      if (r.fixedStart !== null) {
        const p = pById.get(r.fixedParticipant)
        if (!p) continue
        const bind = requiredToolBindings(r, t)
        if (!bind.ok && bind.needsCleaning) { makeCleaningTask(bind.needsCleaning, task, t); continue }
        if (!bind.ok) { r.waitedFor = { type: bind.missingType, since: r.readySince }; continue }
        place(r, p, Math.max(t, r.fixedStart), { fixed: true })
        placedAny = true
        continue
      }
      // resources other than people
      const an = applianceNeed(task)
      if (an && !appliances.freeSlot(an.type, t, an.mode)) { r.waitedFor = { type: an.type, since: r.readySince }; waitingTimes.push(appliances.nextFreeTime(an.type, t)); continue }
      const hn = holdingNeed(task)
      if (hn && !stations.freeSlot(hn, t)) { r.waitedFor = { type: hn, since: r.readySince }; waitingTimes.push(stations.nextFreeTime(hn, t)); continue }
      const sn = stationNeed(task)
      if (sn && !stations.freeSlot(sn, t)) { r.waitedFor = { type: sn, since: r.readySince }; waitingTimes.push(stations.nextFreeTime(sn, t)); continue }
      const bind = requiredToolBindings(r, t)
      if (!bind.ok) {
        if (bind.needsCleaning && policy.cleaning !== 'never') { makeCleaningTask(bind.needsCleaning, task, t); placedAny = true }
        r.waitedFor = { type: bind.missingType, since: r.readySince }
        if (Number.isFinite(bind.waitUntil)) waitingTimes.push(bind.waitUntil)
        continue
      }
      // candidates
      const cands = []
      for (const p of participants) {
        if (p.freeAt > t + 1e-9) continue
        if (p.role === 'cleaner' && !r.isCleaning && policy.cleaning === 'dedicated' && participants.some((q) => q.role !== 'cleaner')) { /* still allowed, cost penalised */ }
        if (task.requires && task.requires.length && p.caps && !task.requires.every((c) => p.caps.has(c))) continue
        const setup = switchSeconds(p.lastContext, contextOf(task), policy.switchMatrix)
        const a = (task.active || 0) / p.speed
        const s = t + setup
        if (!availableThrough(p, s, s + Math.min(a, policy.minChunkSeconds))) continue
        const block = laneBlockOverlap(p, s, s + a)
        if (block && (task.preemptible === 'never' || !task.preemptible)) {
          if (block.start - s >= policy.minChunkSeconds && a > 0) { /* could do part? not preemptible → no */ }
          continue
        }
        const continuesChain = p.lastContext && p.lastContext.dish === task.dishId && task.unitStream && p.lastContext.station === (task.context?.station || 'counter')
        const cost = assignmentCost({ p, task, setup, loads, expected, policy, isCleaning: !!r.isCleaning, continuesChain })
        cands.push({ p, cost, setup, a, block })
      }
      if (cands.length === 0) continue
      cands.sort((x, y) => x.cost - y.cost || byId(x.p.id, y.p.id))

      // chunking of divisible per-unit work
      const canChunk = task.divisible === 'units' && task.units > 1 && cands.length > 1 && (task.perUnit || 0) > 0
      if (canChunk) {
        const best = cands[0]
        const needParallel = Number.isFinite(r.window.LS) && t + best.a > r.window.LS + 1e-9
        const othersIdle = ready.filter((x) => x !== r && x.status === 'pending').length < cands.length - 1
        const maxChunks = Math.max(1, Math.floor((task.active || 0) / policy.minChunkSeconds))
        let k = 1
        if (needParallel) k = Math.min(cands.length, maxChunks, Math.max(2, Math.ceil(best.a / Math.max(1, r.window.LS - t))))
        else if (othersIdle && maxChunks >= 2) k = Math.min(cands.length, maxChunks, 2)
        if (k > 1) {
          const per = Math.floor(task.units / k)
          let from = 1
          r.chunks = []
          for (let i = 0; i < k; i++) {
            const n = i === k - 1 ? task.units - per * (k - 1) : per
            const c = cands[i]
            const sub = { ...r, id: r.id, boundTools: [] }
            const u = { from, to: from + n - 1 }
            // place each chunk as part of the same runtime; emulate by placing and then merging times
            const saveStart = r.start, saveEnd = r.end, saveActiveEnd = r.activeEnd
            const item = place(r, c.p, t, { units: n, chunkIndex: i + 1, chunkOf: u })
            r.chunks.push({ participant: c.p.id, start: r.start, activeEnd: r.activeEnd, end: r.end, item })
            if (i > 0) {
              r.start = Math.min(saveStart, r.start)
              r.activeEnd = Math.max(saveActiveEnd, r.activeEnd)
              r.end = Math.max(saveEnd, r.end)
            }
            from += n
            void sub
          }
          r.participant = r.chunks[0].participant
          placedAny = true
          if (task.passive > 0) placeAppointment(r)
          continue
        }
      }
      const best = cands[0]
      if (best.block && task.preemptible && task.preemptible !== 'never') {
        // split around the appointment: first part until block.start, remainder after block.end + resume cost
        const firstLen = Math.max(0, best.block.start - (t + best.setup))
        if (firstLen < 30) {
          // not worth starting; wait until after the block
          continue
        }
        const p = best.p
        const total = best.a
        const ratio = Math.min(1, firstLen / total)
        const unitsFirst = task.units > 1 ? Math.max(1, Math.floor(task.units * ratio)) : null
        // first segment
        const item1 = place(r, p, t, unitsFirst !== null ? { units: unitsFirst, chunkIndex: 1, chunkOf: { from: 1, to: unitsFirst } } : {})
        if (unitsFirst === null) { item1.end = best.block.start; r.activeEnd = best.block.start }
        // second segment as a resume item
        const resumeStart = best.block.end + (task.resumeCost || 20)
        const remaining = unitsFirst !== null ? task.units - unitsFirst : null
        const remA = unitsFirst !== null ? (task.perUnit || 0) * remaining / p.speed : total - firstLen
        const item2 = itemFor({ uuid: `${r.id}/c2`, taskId: r.id, kind: 'resume', participantId: p.id, start: resumeStart, end: resumeStart + remA, title: task.title, instructions: task.instructions, task, units: unitsFirst !== null ? { from: unitsFirst + 1, to: task.units, of: task.units } : null, dependencies: (pred.get(r.id) || []).map((e) => e.from) })
        items.push(item2)
        r.activeEnd = resumeStart + remA
        r.end = r.activeEnd + (task.passive || 0)
        p.freeAt = r.activeEnd
        p.load += remA
        loads[p.id] = p.load
        placedAny = true
        if (task.passive > 0) placeAppointment(r)
        continue
      }
      place(r, best.p, t)
      placedAny = true
      if (task.passive > 0) placeAppointment(r)
    }

    // fillers: end-of-session cleaning for idle participants
    if (policy.endOfSessionCleaning && policy.cleaning !== 'deferred') {
      for (const p of participants) {
        if (p.freeAt > t + 1e-9) continue
        if (p.role === 'spectator') continue
        if (policy.cleaning === 'dedicated' && p.role !== 'cleaner' && participants.some((q) => q.role === 'cleaner' && q.freeAt <= t + 1e-9)) continue
        const hasReadyWork = ready.some((r) => r.status === 'pending')
        if (hasReadyWork) continue
        const dirty = tools.dirtyInstances().filter((i) => i.binding === null && i.busyUntil <= t && !i.cleaningScheduled)
        if (dirty.length === 0) continue
        // skip instances that are needed soon (a pending task of that type with LS within 2× the clean time) — cleaning them now is still fine, it makes them clean
        dirty.sort((a, b) => a.dirtySince - b.dirtySince || byId(a.id, b.id))
        const inst = dirty[0]
        const cr = makeCleaningTask(inst, null, t)
        cr.window.LS = t + 3600 * 4
        place(cr, p, t)
        placedAny = true
      }
    }

    // next event time
    let next = INF
    for (const r of rt.values()) {
      if (r.status === 'placed') {
        if (r.activeEnd > t + 1e-9) next = Math.min(next, r.activeEnd)
        if (r.end > t + 1e-9) next = Math.min(next, r.end)
      }
    }
    for (const w of waitingTimes) if (w > t + 1e-9) next = Math.min(next, w)
    for (const p of participants) {
      if (p.freeAt > t + 1e-9) next = Math.min(next, p.freeAt)
      for (const b of p.blocked) { if (b.start > t + 1e-9) next = Math.min(next, b.start); if (b.end > t + 1e-9) next = Math.min(next, b.end) }
      const ae = nextAvailabilityEdge(p, t)
      if (ae > t + 1e-9) next = Math.min(next, ae)
    }
    for (const r of ready) if (r.status === 'pending' && r.waitedFor) {
      const type = r.waitedFor.type
      next = Math.min(next, tools.nextFreeTime(type, t), appliances.nextFreeTime(type, t), stations.nextFreeTime(type, t))
    }
    if (!placedAny && next === INF) {
      const stuck = [...rt.values()].filter((r) => r.status === 'pending').map((r) => r.id)
      diagnostics.push({ code: 'DEADLOCK', message: `Could not schedule ${stuck.length} task(s): ${stuck.slice(0, 5).join(', ')}${stuck.length > 5 ? '…' : ''}. Check tools, capabilities and availability.`, tasks: stuck })
      break
    }
    if (next === INF) {
      // everything placed but some items still pending? loop again to process releases
      if (!placedAny) break
      continue
    }
    if (next > t) t = next
    else if (!placedAny) t = next + 1
  }

  // ---- blocked items --------------------------------------------------------------------------------------
  for (const r of rt.values()) {
    if (r.status === 'done' || r.status === 'placed') {
      if (r.waitedFor && r.item && r.participant) {
        const p = pById.get(r.participant)
        const since = r.waitedFor.since
        const gapStart = Math.max(since, laneEndBefore(p, r.item.start))
        if (r.item.start - gapStart >= 60) {
          items.push(itemFor({ uuid: `${r.id}@blocked`, taskId: r.id, kind: 'blocked', participantId: p.id, start: gapStart, end: r.item.start, title: `Waiting for ${r.waitedFor.type}`, instructions: `Waiting for a free ${r.waitedFor.type} before: ${r.task.title}`, task: r.task }))
        }
      }
    }
  }
  function laneEndBefore(p, before) {
    let e = now0
    for (const it of items) if (it.participantId === p.id && it.kind !== 'blocked' && it.end <= before + 1e-9) e = Math.max(e, it.end)
    return e
  }

  // ---- hand-offs and dependencies -----------------------------------------------------------------------
  const itemByTask = new Map()
  for (const it of items) if (it.kind === 'work' || it.kind === 'appointment' || it.kind === 'resume') { if (!itemByTask.has(it.taskId)) itemByTask.set(it.taskId, it) }
  for (const r of rt.values()) {
    if (!r.item) continue
    for (const e of pred.get(r.id) || []) {
      const pr = rt.get(e.from)
      if (!pr || !pr.task || pr.task.kind === 'sink') continue
      const outs = (pr.task.outputs || []).map((o) => o.id)
      const consumed = (r.task.inputs || []).filter((i) => outs.includes(i.ref)).map((i) => i.ref)
      for (const outputId of consumed) {
        if (pr.participant && pr.participant !== r.participant) {
          r.item.inputsFrom.push({ outputId, participantId: pr.participant, byTime: pr.end })
          if (pr.item) pr.item.outputsTo.push({ outputId, participantId: r.participant, byTime: pr.end })
        }
      }
    }
  }

  const done = [...rt.values()].every((r) => r.status !== 'pending')
  const dishes = graph.dishes.map((d) => {
    const finals = (pred.get(d.sinkId) || []).map((e) => rt.get(e.from)).filter(Boolean)
    const ends = finals.map((f) => f.end).filter((x) => x !== null)
    return { dishId: d.id, plannedServeRel: dishServe[d.id] ?? null, spread: ends.length ? Math.max(...ends) - Math.min(...ends) : 0, lastFinishRel: ends.length ? Math.max(...ends) : null }
  })

  return { items, participants, loads, expected, diagnostics, dishes, done, runtime: rt, log }
}
