// Simulation (README §8): simulated participants execute a plan with noisy durations; every start/finish goes through
// the online mode (applyEvent / replan), appointments trigger the interrupt chooser when the holder is busy.
//
// `createSimulation` holds the loop state and advances it one tick at a time (the browser demo drives it from an
// animation frame); `simulate` runs the same loop to completion.

import { createState, applyEvent, replan, dueInterrupts } from '../online/index.js'
import { fmt } from './render.js'

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gauss(r) {
  const u = Math.max(1e-9, r()), v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const WORK_KINDS = new Set(['work', 'cleaning', 'resume', 'appointment', 'check'])

/**
 * Create a stepwise simulation. The session is started (sessionStarted + first online re-plan) immediately; ticks are
 * processed by `step(ms)` / `run()`.
 *
 * @param {object} cfg { session, catalogue, graph?, seed, speedNoise, lateStartProbability, tick, maxSimHours, verbose }
 * @param {function} [onTick] optional (now, state, log) → void, called after every processed tick
 * @returns {{
 *   step: (ms: number) => { now, clock, state, log, entries, done, metrics },   // advance the clock by `ms`; processes every tick it passes
 *   run: () => { now, clock, state, log, entries, done, metrics },             // process ticks until done
 *   result: () => { events, finalPlan, draftPlan, metrics, log },              // the `simulate` result shape for the current state
 *   state, now, clock, log, entries, done, metrics, counters, tick, startTime, draftPlan   // getters
 * }}
 * `now` is the next tick to process (ticks are at startTime + k·tick), `clock` the continuous time the caller advanced
 * to; `entries` are the log lines as { at, text }.
 */
export function createSimulation(cfg, onTick = cfg.onTick) {
  const { session, catalogue, graph } = cfg
  const seed = cfg.seed ?? 42
  const r = rng(seed)
  const speedNoise = cfg.speedNoise ?? 0.25
  const lateStartProbability = cfg.lateStartProbability ?? 0.1
  const tick = cfg.tick ?? 5000
  const log = []
  const entries = [] // { at, text } — the same lines with their simulated time (the browser formats the clock itself)
  const say = (now, msg) => {
    log.push(`${fmt(now)} ${msg}`)
    entries.push({ at: now, text: msg })
    if (cfg.verbose) console.log(`${fmt(now)} ${msg}`)
  }

  let state = createState(session, catalogue, { graph })
  const draft = state.plan
  const startTime = session.startTime ?? draft.startTime
  let now = startTime
  state = applyEvent(state, { type: 'sessionStarted', at: now }).state
  state = replan(state, now).state
  let replans = 1
  let interrupts = 0
  let eventsCount = 1
  let done = false
  let clock = startTime // the caller's continuous clock; the tick at `now` is processed once the clock passes it

  const sims = new Map() // participantId → { current: { uuid, title, finishAt, unitsDone }, delayUntil }
  for (const lane of state.plan.lanes) sims.set(lane.participantId, { current: null, delayUntil: 0, paused: null })

  const itemsDone = () => state.plan.lanes.every((l) => l.items.filter((it) => WORK_KINDS.has(it.kind)).every((it) => it.status === 'done'))
  const depsDone = (item) => {
    const all = new Map()
    for (const l of state.plan.lanes) for (const it of l.items) all.set(it.taskId, it)
    return (item.dependencies || []).every((taskId) => {
      const dep = [...all.values()].filter((x) => x.taskId === taskId && WORK_KINDS.has(x.kind))
      if (dep.length === 0) return true
      // a predecessor with a passive phase is "done" for us only when its passive phase has elapsed
      return dep.every((d) => d.status === 'done' && (!d.passiveUntil || (d.actualEnd || d.end) + ((d.passiveUntil - d.end) || 0) <= now))
    })
  }

  const apply = (ev) => {
    eventsCount++
    const res = applyEvent(state, ev)
    state = res.state
    if (res.replanNeeded) {
      const rp = replan(state, now)
      state = rp.state
      replans++
      say(now, `replan: ${res.reason || 'drift'}; ${rp.diff ? rp.diff.reduce((a, d) => a + d.changes.length, 0) : 0} change(s)`)
    }
  }

  const limitMs = (cfg.maxSimHours ?? 8) * 3600 * 1000
  const nameOf = (pid) => (session.participants.find((p) => p.id === pid) || {}).name || pid

  /** Process the tick at `now` (finishes, interrupts, starts). */
  const processTick = () => {
    // 1. finishes
    for (const [pid, s] of sims) {
      if (s.current && s.current.finishAt <= now) {
        const uuid = s.current.uuid
        say(now, `${nameOf(pid)} done: ${s.current.title}`)
        s.current = null
        if (state.plan.lanes.some((l) => l.items.some((it) => it.uuid === uuid))) apply({ type: 'taskDone', at: now, participantId: pid, uuid })
      }
    }
    // 2. interrupts
    for (const due of dueInterrupts(state, now)) {
      const target = due.target
      if (!target || !target.participantId) continue
      const s = sims.get(target.participantId)
      if (!s) continue
      if (target.preempts && s.current && s.current.uuid === target.preempts) {
        say(now, `INTERRUPT ${nameOf(target.participantId)}: pause '${s.current.title}' for '${due.item.title}'`)
        interrupts++
        apply({ type: 'taskPaused', at: now, participantId: target.participantId, uuid: s.current.uuid, units: s.current.unitsDone(now) })
        s.current = null
      }
      if (!s.current) {
        const holder = sims.get(due.item.participantId)
        if (holder && holder !== s) { /* the holder keeps their item; the target takes the appointment */ }
        apply({ type: 'appointmentAcknowledged', at: now, participantId: target.participantId, uuid: due.item.uuid })
        apply({ type: 'taskStarted', at: now, participantId: target.participantId, uuid: due.item.uuid })
        const dur = Math.max(5000, (due.item.end - due.item.start))
        s.current = { uuid: due.item.uuid, title: due.item.title, finishAt: now + dur, unitsDone: () => null }
        say(now, `${nameOf(target.participantId)} handles appointment: ${due.item.title}`)
      }
    }
    // 3. starts (re-read the lane after every event: an apply() may have re-planned)
    for (const laneId of state.plan.lanes.map((l) => l.participantId)) {
      const lane = state.plan.lanes.find((l) => l.participantId === laneId)
      if (!lane) continue
      const s = sims.get(lane.participantId)
      if (!s) { sims.set(lane.participantId, { current: null, delayUntil: 0 }); continue }
      if (s.current || s.delayUntil > now) continue
      const next = lane.items
        .filter((it) => WORK_KINDS.has(it.kind) && it.status !== 'done' && it.status !== 'started')
        .sort((a, b) => a.start - b.start)[0]
      if (!next) continue
      if (next.start > now) continue
      if (!depsDone(next)) continue
      if (next.kind === 'appointment' && next.window && next.window.earliest > now) continue
      if (r() < lateStartProbability) { s.delayUntil = now + (60 + Math.floor(r() * 120)) * 1000; say(now, `${nameOf(lane.participantId)} dawdles before: ${next.title}`); continue }
      const plannedActive = Math.max(1000, next.end - next.start)
      const noise = Math.max(0.4, 1 + speedNoise * gauss(r))
      const dur = Math.round(plannedActive * noise)
      apply({ type: 'taskStarted', at: now, participantId: lane.participantId, uuid: next.uuid })
      const units = next.units ? next.units.to - next.units.from + 1 : null
      const startedAt = now
      s.current = { uuid: next.uuid, title: next.title, finishAt: now + dur, unitsDone: (t) => (units ? Math.min(units, Math.floor(units * (t - startedAt) / dur)) : null) }
      say(now, `${nameOf(lane.participantId)} starts: ${next.title} (${Math.round(dur / 60000)} min)`)
    }
  }

  /**
   * One iteration of the simulation loop: process the tick at `now`, then either stop (every item done or the time
   * limit reached) or advance `now` by one tick. Returns false once the simulation is done.
   */
  const runTick = () => {
    if (done) return false
    if (now - startTime >= limitMs) { done = true; return false }
    processTick()
    if (onTick) onTick(now, state, log)
    if (itemsDone()) { done = true; return false }
    now += tick
    return true
  }

  const metrics = () => computeMetrics(state.plan, session, { interrupts, replans, events: eventsCount, simEnd: now })
  const snapshot = () => ({ now, clock, state, log, entries, done, metrics: metrics() })

  const sim = {
    /** Advance the caller's clock by `ms` and process every tick it passes (one tick per `tick` ms). */
    step(ms) {
      clock += Math.max(0, ms || 0)
      while (!done && now < clock) if (!runTick()) break
      return snapshot()
    },
    /** Process ticks until the simulation is done. */
    run() {
      while (runTick()) { /* keep going */ }
      clock = now
      return snapshot()
    },
    /** The `simulate` result shape for the current state. */
    result() {
      return { events: state.events || [], finalPlan: state.plan, draftPlan: draft, metrics: metrics(), log }
    },
    get state() { return state },
    get now() { return now },
    get clock() { return clock },
    get done() { return done },
    get log() { return log },
    get entries() { return entries },
    get metrics() { return metrics() },
    get counters() { return { replans, interrupts, events: eventsCount } },
    tick,
    startTime,
    draftPlan: draft,
  }
  return sim
}

/**
 * Run a whole simulation synchronously.
 * @param {object} cfg { session, catalogue, graph?, seed, speedNoise, lateStartProbability, tick, maxSimHours, verbose }
 * @param {function} onTick optional (now, state, log) → void
 */
export function simulate(cfg, onTick) {
  const sim = createSimulation(cfg, onTick)
  sim.run()
  return sim.result()
}

export function computeMetrics(plan, session, extra = {}) {
  const lateness = {}
  for (const d of plan.dishes || []) {
    const finals = plan.lanes.flatMap((l) => l.items).filter((it) => it.dishId === d.dishId && WORK_KINDS.has(it.kind))
    const last = finals.length ? Math.max(...finals.map((it) => it.actualEnd || it.end)) : null
    lateness[d.dishId] = last === null ? null : Math.round((last - d.serveTarget) / 1000)
  }
  const blockedSeconds = plan.lanes.flatMap((l) => l.items).filter((it) => it.kind === 'blocked').reduce((a, it) => a + (it.end - it.start) / 1000, 0)
  const idleLopsided = Math.max(0, ...plan.lanes.map((l) => (l.report && l.report.longestLopsidedIdle) || 0))
  return { lateness, interrupts: extra.interrupts || 0, replans: extra.replans || 0, events: extra.events || 0, fairness: plan.report ? plan.report.fairness : null, blockedSeconds: Math.round(blockedSeconds), idleLopsided, simEnd: extra.simEnd || null }
}

export { fmt, renderLanes } from './render.js'
