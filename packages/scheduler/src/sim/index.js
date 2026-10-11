// Simulation (README §8): simulated participants execute a plan with noisy durations; every start/finish goes through
// the online mode (applyEvent / replan), appointments trigger the interrupt chooser when the holder is busy.

import { createState, applyEvent, replan, dueInterrupts } from '../online/index.js'

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
 * @param {object} cfg { session, catalogue, graph?, seed, speedNoise, lateStartProbability, tick, maxSimHours, verbose }
 * @param {function} onTick optional (now, state, log) → void
 */
export function simulate(cfg, onTick) {
  const { session, catalogue, graph } = cfg
  const seed = cfg.seed ?? 42
  const r = rng(seed)
  const speedNoise = cfg.speedNoise ?? 0.25
  const lateStartProbability = cfg.lateStartProbability ?? 0.1
  const tick = cfg.tick ?? 5000
  const log = []
  const say = (now, msg) => { log.push(`${fmt(now)} ${msg}`); if (cfg.verbose) console.log(`${fmt(now)} ${msg}`) }

  let state = createState(session, catalogue, { graph })
  const draft = state.plan
  const startTime = session.startTime ?? draft.startTime
  let now = startTime
  state = applyEvent(state, { type: 'sessionStarted', at: now }).state
  state = replan(state, now).state
  let replans = 1
  let interrupts = 0
  let eventsCount = 1

  const sims = new Map() // participantId → { current: { uuid, finishAt }, nextStartAt }
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

  while (now - startTime < limitMs) {
    // 1. finishes
    for (const [pid, s] of sims) {
      if (s.current && s.current.finishAt <= now) {
        const uuid = s.current.uuid
        say(now, `${nameOf(pid)} done: ${s.current.title}`)
        s.current = null
        apply({ type: 'taskDone', at: now, participantId: pid, uuid })
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
    // 3. starts
    for (const lane of state.plan.lanes) {
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
    if (onTick) onTick(now, state, log)
    if (itemsDone()) break
    now += tick
  }

  const finalPlan = state.plan
  const metrics = computeMetrics(finalPlan, session, { interrupts, replans, events: eventsCount, simEnd: now })
  return { events: state.events || [], finalPlan, draftPlan: draft, metrics, log }
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

export function fmt(ms) {
  const d = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** Text rendering of a plan's lanes (for the CLI and tests). */
export function renderLanes(plan, { width = 100 } = {}) {
  const t0 = plan.startTime, t1 = plan.endTime || Math.max(...plan.lanes.flatMap((l) => l.items.map((it) => it.end)))
  const span = Math.max(1, t1 - t0)
  const col = (ms) => Math.min(width - 1, Math.max(0, Math.floor(((ms - t0) / span) * width)))
  const lines = []
  lines.push(`${fmt(t0)}${' '.repeat(Math.max(0, width - 10))}${fmt(t1)}`)
  for (const lane of plan.lanes) {
    const row = Array(width).fill(' ')
    for (const it of lane.items) {
      const a = col(it.start), b = Math.max(a, col(it.end) - 1)
      const ch = it.kind === 'appointment' ? '!' : it.kind === 'cleaning' ? '~' : it.kind === 'blocked' ? '.' : it.kind === 'check' ? '?' : it.kind === 'resume' ? '>' : it.status === 'done' ? '#' : '='
      for (let i = a; i <= b; i++) row[i] = ch
      if (it.passiveUntil) { const c = col(it.passiveUntil) - 1; for (let i = b + 1; i <= c && i < width; i++) if (row[i] === ' ') row[i] = '-' }
    }
    lines.push(`${String(lane.participantId).padEnd(10).slice(0, 10)} ${row.join('')}`)
  }
  lines.push('legend: = work  # done  ! appointment  ~ cleaning  . blocked  ? check  > resume  - passive (timer)')
  return lines.join('\n')
}
