// Phase D (spec §5.4): pipeline construction for chains of per-unit stages on one unit stream.
//
//   detectChains(graph)                         → chains (stages = recipe tasks; batch instances count once)
//   sinkRate(chain, graph, session, opts)       → the slowest downstream rate (oven loads, carrier circulation, serve)
//   balanceChain(chain, k, graph, session, policy, opts) → cell / pipeline / hybrid organisation per burst
//   applyChainHints(graph, balances, participantIds)     → { preferAssignments, chunkPlan, stageGroups } for dispatch()
//
// Times are seconds (relative to the plan origin where absolute); rates are units per second.

import { computeWindows } from './windows.js'

const INF = Number.POSITIVE_INFINITY

function stageKey(task) { return `${task.dishId}:${task.recipeTaskId || task.id}` }
function batchIndex(task) { return task.batch ? task.batch.index : 0 }
function byId(a, b) { return a < b ? -1 : a > b ? 1 : 0 }

/**
 * Chains of consecutive per-unit stages linked by streaming edges. Batch instances of one recipe task form one
 * stage; a stage's instances are ordered by batch index and cover consecutive unit ranges of the stream.
 * @param {object} graph Graph (README §5)
 * @returns {Array<Chain>} Chain = { id, dishId, stream, units, stages: [Stage], buffers: [Buffer], sinks: [TaskInstance], firstIds, lastIds }
 *   Stage = { index, key, recipeTaskId, title, perUnit, units, divisible, tools: [{ type, qty, mode }], instances: [id], ranges: { [id]: { from, to } }, batched }
 */
export function detectChains(graph) {
  const tasks = graph.tasks
  const stream = graph.edges.filter((e) => e.kind === 'stream' && tasks[e.from] && tasks[e.to])
  if (!stream.length) return []
  const stages = new Map()
  const stageFor = (id) => {
    const t = tasks[id]
    const key = stageKey(t)
    if (!stages.has(key)) stages.set(key, { key, dishId: t.dishId, recipeTaskId: t.recipeTaskId || t.id, title: t.title, unitStream: t.unitStream, instances: new Set(), succ: new Set(), pred: new Set() })
    stages.get(key).instances.add(id)
    return stages.get(key)
  }
  for (const e of stream) {
    const a = stageFor(e.from), b = stageFor(e.to)
    if (a !== b) { a.succ.add(b.key); b.pred.add(a.key) }
  }
  const finish = (st) => {
    const instances = [...st.instances].sort((x, y) => batchIndex(tasks[x]) - batchIndex(tasks[y]) || byId(x, y))
    const ranges = {}
    let from = 1
    for (const id of instances) { const n = Math.max(1, tasks[id].units || 1); ranges[id] = { from, to: from + n - 1 }; from += n }
    const first = tasks[instances[0]]
    const perUnit = Math.max(...instances.map((id) => tasks[id].perUnit || (tasks[id].timeModel === 'per-unit' && tasks[id].units ? (tasks[id].active || 0) / tasks[id].units : 0)))
    const tools = []
    for (const id of instances) for (const tl of tasks[id].tools || []) if (!tools.some((x) => x.type === tl.type)) tools.push({ type: tl.type, qty: Math.max(1, tl.qty || 1), mode: tl.mode || 'active' })
    return {
      key: st.key, dishId: st.dishId, recipeTaskId: st.recipeTaskId, title: first.title, unitStream: st.unitStream,
      perUnit, units: from - 1, divisible: first.divisible || 'none', tools, instances, ranges, batched: instances.length > 1,
    }
  }
  const chains = []
  const used = new Set()
  const heads = [...stages.values()].filter((s) => s.pred.size === 0).sort((a, b) => byId(a.key, b.key))
  const walk = (head) => {
    const list = [head]
    used.add(head.key)
    let cur = head
    while (cur.succ.size === 1) {
      const next = stages.get([...cur.succ][0])
      if (used.has(next.key) || next.pred.size !== 1) break
      list.push(next); used.add(next.key); cur = next
    }
    return list
  }
  const build = (list) => {
    const stageList = list.map((s, i) => ({ index: i, ...finish(s) }))
    const ids = new Set(stageList.flatMap((s) => s.instances))
    const last = stageList[stageList.length - 1]
    const sinks = []
    for (const e of graph.edges) {
      if (e.kind !== 'fs' || !last.instances.includes(e.from) || ids.has(e.to)) continue
      if (!sinks.some((t) => t.id === e.to)) sinks.push(tasks[e.to])
    }
    sinks.sort((a, b) => batchIndex(a) - batchIndex(b) || byId(a.id, b.id))
    const buffers = graph.buffers.filter((b) => ids.has(b.from) && ids.has(b.to))
    const units = Math.max(...stageList.map((s) => s.units))
    return {
      id: `${stageList[0].dishId}:${stageList[0].unitStream || 'units'}:${stageList[0].recipeTaskId}`,
      dishId: stageList[0].dishId, stream: stageList[0].unitStream || null, units, stages: stageList, buffers, sinks,
      firstIds: stageList[0].instances, lastIds: last.instances,
    }
  }
  for (const h of heads) chains.push(build(walk(h)))
  for (const s of [...stages.values()].sort((a, b) => byId(a.key, b.key))) if (!used.has(s.key)) chains.push(build(walk(s)))
  return chains
}

/** Replica bound of a stage from the inventory: min over its tools of floor(count / qty); ∞ when tool-free. */
export function stageCapacity(stage, inventory) {
  let q = INF
  for (const tl of stage.tools || []) {
    const inv = (inventory?.tools || []).find((x) => x.type === tl.type)
    const count = inv ? Math.max(0, Number(inv.count) || 0) : 1
    q = Math.min(q, Math.max(1, Math.floor(count / tl.qty)))
  }
  return q
}

/** Seconds along the finish-to-start path from `fromId` to `toId` (durations of the tasks after `fromId`). */
function pathSeconds(graph, fromId, toId) {
  if (!toId || fromId === toId) return 0
  const succ = new Map()
  for (const e of graph.edges) if (e.kind === 'fs') { if (!succ.has(e.from)) succ.set(e.from, []); succ.get(e.from).push(e.to) }
  const best = new Map([[fromId, 0]])
  const queue = [fromId]
  while (queue.length) {
    const id = queue.shift()
    for (const n of succ.get(id) || []) {
      const t = graph.tasks[n]
      const d = best.get(id) + (t ? (t.active || 0) + (t.passive || 0) : 0)
      if (!best.has(n) || d < best.get(n)) { best.set(n, d); queue.push(n) }
    }
  }
  return best.has(toId) ? best.get(toId) : 0
}

/**
 * The chain's sink rate r* (spec §5.4): the slowest of (a) downstream appliances (`slots × cap` units per load),
 * (b) carrier circulation `C × cap / T_c` and (c) the rate the serve window requires. `T_c` follows the carrier
 * cycle path: fill time at the chain's cycle, the wait for sibling carriers of the same load, the sink's duration
 * and the release path to the task that hands the carrier back.
 * @param {object} chain from detectChains
 * @param {object} graph
 * @param {object} session (inventory used)
 * @param {object} [opts] { cycle: seconds per unit the chain delivers (default Σ per-unit times), windows }
 * @returns {{ rate, binding: 'oven'|'carrier'|null, bufferUnits, bindsChain, oven, carrier, carriers, serve, loads }}
 */
export function sinkRate(chain, graph, session, opts = {}) {
  const inv = session.inventory || {}
  const sumU = chain.stages.reduce((a, s) => a + s.perUnit, 0)
  const cycle = opts.cycle ?? sumU
  // (a) appliance sinks
  let oven = null
  const byRecipe = new Map()
  for (const t of chain.sinks || []) { const key = stageKey(t); if (!byRecipe.has(key)) byRecipe.set(key, []); byRecipe.get(key).push(t) }
  for (const [, list] of byRecipe) {
    const t = list[0]
    if (!t.appliance) continue
    const app = (inv.appliances || []).find((a) => a.type === t.appliance.type)
    const total = app ? Math.max(1, Number(app.slots) || 1) : Math.max(1, t.appliance.slots || 1)
    const concurrent = Math.max(1, Math.floor(total / Math.max(1, t.appliance.slots || 1)))
    const duration = (t.active || 0) + (t.passive || 0)
    const unitsPerLoad = Math.max(1, t.units || 1)
    const rate = duration > 0 ? concurrent * unitsPerLoad / duration : INF
    const cand = { type: t.appliance.type, taskId: t.id, recipeTaskId: t.recipeTaskId, concurrent, unitsPerLoad, duration, loads: list.length, rate }
    if (!oven || cand.rate < oven.rate) oven = cand
  }
  // (b) carriers
  const carriers = []
  const seen = new Set()
  for (const b of chain.buffers || []) {
    if (!b.carrier || seen.has(b.carrier)) continue
    seen.add(b.carrier)
    const fromStage = chain.stages.findIndex((s) => s.instances.includes(b.from))
    const onCarrier = chain.stages.slice(Math.max(0, fromStage)).reduce((a, s) => a + s.perUnit, 0)
    const share = sumU > 0 ? onCarrier / sumU : 1
    const cap = Math.max(1, b.capPerCarrier || 1)
    const C = Math.max(1, b.carriers || 1)
    const fill = cap * cycle * share
    const carriersPerLoad = oven ? Math.max(1, Math.ceil(oven.unitsPerLoad / cap)) : 1
    const waitForLoad = (Math.min(carriersPerLoad, C) - 1) * fill
    const sinkDuration = oven ? oven.duration : 0
    const release = b.releaseTask ? pathSeconds(graph, oven ? oven.taskId : b.to, b.releaseTask) : null
    const rest = release === null ? INF : waitForLoad + sinkDuration + release
    const cycleSeconds = fill + rest
    carriers.push({ type: b.carrier, carriers: C, cap, capacity: C * cap, releaseTask: b.releaseTask, fillSeconds: fill, waitSeconds: waitForLoad, sinkSeconds: sinkDuration, releaseSeconds: release, restSeconds: rest, cycleSeconds, rate: Number.isFinite(cycleSeconds) ? C * cap / cycleSeconds : 0 })
  }
  carriers.sort((a, b) => a.rate - b.rate || byId(a.type, b.type))
  const carrier = carriers[0] || null
  // (c) serve window
  let serve = null
  if (opts.windows) {
    const es = Math.min(...chain.firstIds.map((id) => opts.windows[id]?.ES ?? INF))
    const lf = Math.min(...chain.lastIds.map((id) => opts.windows[id]?.LF ?? INF))
    if (Number.isFinite(es) && Number.isFinite(lf) && lf > es) serve = { earliest: es, latest: lf, required: chain.units / (lf - es) }
  }
  let rate = INF, binding = null
  if (oven && oven.rate < rate) { rate = oven.rate; binding = 'oven' }
  if (carrier && carrier.rate < rate) { rate = carrier.rate; binding = 'carrier' }
  const bufferUnits = carrier ? carrier.capacity : INF
  return { rate, binding, bufferUnits, bindsChain: bufferUnits < chain.units, oven, carrier, carriers, serve, loads: oven ? oven.loads : 0, unitsPerLoad: oven ? oven.unitsPerLoad : null, sinkSeconds: oven ? oven.duration : 0, cycle }
}

/**
 * Every (grouping, replication) of the stages for up to `k` people: contiguous stage groups, each replicated
 * `d_g ≤ q_g` times with Σ d_g ≤ k. Cell = one group, pipeline = every group single, hybrid = the rest.
 * @returns {Array<Candidate>} Candidate = { organisation, groups: [[stageIndex]], replicas: [d], workforce, cycle, fillLatency, handoffs, balance, loads: [perPerson seconds per unit] }
 */
export function enumerateCandidates(chain, k, inventory) {
  const m = chain.stages.length
  const u = chain.stages.map((s) => s.perUnit)
  const q = chain.stages.map((s) => stageCapacity(s, inventory))
  const out = []
  const groupings = []
  const rec = (start, acc) => {
    if (start === m) { groupings.push(acc.map((g) => g.slice())); return }
    for (let end = start + 1; end <= m; end++) { acc.push([...Array(end - start).keys()].map((i) => start + i)); rec(end, acc); acc.pop() }
  }
  rec(0, [])
  for (const groups of groupings) {
    if (groups.length > k) continue
    const sums = groups.map((g) => g.reduce((a, i) => a + u[i], 0))
    const caps = groups.map((g) => Math.min(k, ...g.map((i) => q[i])))
    const vec = []
    const recD = (gi, left) => {
      if (gi === groups.length) {
        const replicas = vec.slice()
        const cycle = Math.max(...sums.map((s, i) => s / replicas[i]))
        const perPerson = sums.map((s, i) => s / replicas[i])
        const organisation = groups.length === 1 ? 'cell' : replicas.every((d) => d === 1) ? 'pipeline' : 'hybrid'
        out.push({ organisation, groups: groups.map((g) => g.slice()), replicas, workforce: replicas.reduce((a, b) => a + b, 0), cycle, fillLatency: sums.reduce((a, b) => a + b, 0), handoffs: groups.length - 1, balance: Math.max(...perPerson) - Math.min(...perPerson), loads: perPerson })
        return
      }
      for (let d = 1; d <= Math.min(caps[gi], left - (groups.length - gi - 1)); d++) { vec.push(d); recD(gi + 1, left - d); vec.pop() }
    }
    recD(0, k)
  }
  return out
}

/**
 * Unit-by-unit simulation of a candidate against the binding carrier buffer (spec §5.4 (b)): units enter at the
 * candidate's cycle, a unit past the buffer waits for the carrier that held the unit `B` before it to come back.
 * @returns {{ finish, blocked, cycleEffective, exits: number[] }} seconds from the chain start; exits[i] = exit of unit i+1
 */
export function simulateChain(chain, cand, { units = chain.units, buffer = null } = {}) {
  const N = Math.max(1, units)
  const c = cand.cycle
  const L = cand.fillLatency
  const exits = new Array(N)
  let blocked = 0
  let prev = -c
  const bound = buffer && Number.isFinite(buffer.capacity) && buffer.capacity < N ? buffer : null
  for (let i = 0; i < N; i++) {
    let t = prev + c
    if (bound) {
      const ci = Math.floor(i / bound.cap)
      if (ci >= bound.carriers) {
        const lastOnPrev = (ci - bound.carriers + 1) * bound.cap - 1
        const avail = exits[lastOnPrev] + bound.restSeconds // the carrier comes back `rest` after its last unit left the chain
        if (avail > t) { blocked += avail - t; t = avail }
      }
    }
    exits[i] = t + L
    prev = t
  }
  const finish = exits[N - 1]
  return { finish, blocked, cycleEffective: finish / N, exits }
}

/** `deadline` is for the last unit; earlier sink loads inside the simulated range must leave in time for the later ones. */
function feasibleFor(cand, sim, start, deadline, sink) {
  if (!Number.isFinite(deadline)) return true
  if (start + sim.finish > deadline + 1e-6) return false
  if (sink && sink.unitsPerLoad && sink.sinkSeconds > 0) {
    const N = sim.exits.length
    const perLoad = sink.unitsPerLoad
    const loadsTotal = Math.ceil(N / perLoad)
    for (let i = perLoad; i <= N; i += perLoad) {
      const loadsAfter = loadsTotal - Math.ceil(i / perLoad)
      if (start + sim.exits[i - 1] > deadline - loadsAfter * sink.sinkSeconds + 1e-6) return false
    }
  }
  return true
}

function rankCandidates(list) {
  return list.slice().sort((a, b) => (b.feasible - a.feasible) || (a.cycleEffective - b.cycleEffective) || (a.workforce - b.workforce) || (a.balance - b.balance) || (a.handoffs - b.handoffs) || (a.fillLatency - b.fillLatency) || byId(a.organisation, b.organisation) || byId(JSON.stringify(a.groups), JSON.stringify(b.groups)))
}

/**
 * Choose the organisation of a chain for `k` participants (spec §5.4). Candidates are scored in the spec's
 * order: finish inside the window (incl. the sequential sink loads), effective cycle (simulated against the
 * binding buffer), workforce (replicas are removed while the window still holds), balance, hand-offs, fill
 * latency. Buffers make the chain bursty: the workforce is sized per burst of `B` units.
 * @param {object} chain from detectChains
 * @param {number} k participants the dispatcher expects to have free
 * @param {object} graph
 * @param {object} session normalised or raw session (inventory, t0/now/startTime)
 * @param {object} policy merged policy
 * @param {object} [opts] { windows, start: chain start (relative s), deadline: latest finish of the last stage (relative s) }
 * @returns {object} { chainId, units, k, organisation, groups, replicas, workforce, cycle, finish, fillLatency, handoffs,
 *   balance, candidates: ranked [Candidate+{feasible,finish,blocked,cycleEffective}], sink, perBurst: [Burst], hints }
 *   Burst = { index, units: {from,to}, start, deadline, finish, slack, workforce, organisation, groups, replicas, candidate }
 */
export function balanceChain(chain, k, graph, session, policy, opts = {}) {
  const kk = Math.max(1, Math.floor(k) || 1)
  const inventory = session.inventory || {}
  let windows = opts.windows || null
  if (!windows) {
    const t0 = session.t0 ?? session.now ?? session.startTime ?? (Math.min(...graph.dishes.map((d) => d.serveTime)) - 6 * 3600 * 1000)
    windows = computeWindows(graph, t0, { slackBuffer: policy?.slackBufferMinSeconds || 0 }).windows
  }
  const esOf = (ids) => Math.max(0, Math.max(...ids.map((id) => windows[id]?.ES ?? 0)))
  const lfOf = (ids) => Math.min(...ids.map((id) => windows[id]?.LF ?? INF))
  const start = opts.start ?? esOf(chain.firstIds)
  const deadline = opts.deadline ?? lfOf(chain.lastIds)
  const N = chain.units

  const raw = enumerateCandidates(chain, kk, inventory)
  const peopleCycle = Math.min(...raw.map((c) => c.cycle))
  const sink = sinkRate(chain, graph, session, { cycle: peopleCycle, windows })
  const buffer = sink.bindsChain ? sink.carrier : null
  const candidates = rankCandidates(raw.map((c) => {
    const sim = simulateChain(chain, c, { units: N, buffer })
    return { ...c, finish: sim.finish, blocked: sim.blocked, cycleEffective: sim.cycleEffective, feasible: feasibleFor(c, sim, start, deadline, sink) }
  }))

  // bursts
  const B = sink.bindsChain ? Math.max(1, sink.bufferUnits) : N
  const nb = Math.ceil(N / B)
  const perBurst = []
  let cursorStart = start
  for (let j = 0; j < nb; j++) {
    const from = j * B + 1, to = Math.min(N, (j + 1) * B)
    const lastInstances = chain.stages[chain.stages.length - 1].instances.filter((id) => { const r = chain.stages[chain.stages.length - 1].ranges[id]; return r.from <= to && r.to >= from })
    const unitsAfter = N - to
    const loadsAfter = sink.unitsPerLoad ? Math.ceil(unitsAfter / sink.unitsPerLoad) : 0
    const burstDeadline = (opts.deadline !== undefined ? opts.deadline : lfOf(lastInstances.length ? lastInstances : chain.lastIds)) - loadsAfter * sink.sinkSeconds
    const burstStart = cursorStart
    const scored = rankCandidates(raw.map((c) => {
      const sim = simulateChain(chain, c, { units: to - from + 1, buffer: null })
      return { ...c, finish: sim.finish, blocked: 0, cycleEffective: sim.cycleEffective, feasible: feasibleFor(c, sim, burstStart, burstDeadline, sink) }
    }))
    let chosen = scored[0]
    if (Number.isFinite(burstDeadline) && chosen.feasible) {
      for (let kp = chosen.workforce - 1; kp >= 1; kp--) {
        const smaller = scored.find((c) => c.workforce === kp && c.feasible)
        if (!smaller) break
        chosen = smaller
      }
    }
    const finishAbs = burstStart + chosen.finish
    perBurst.push({ index: j, units: { from, to }, start: burstStart, deadline: burstDeadline, finish: finishAbs, slack: burstDeadline - finishAbs, workforce: chosen.workforce, organisation: chosen.organisation, groups: chosen.groups, replicas: chosen.replicas, cycle: chosen.cycle, feasible: chosen.feasible, candidate: chosen, ranked: scored })
    cursorStart = finishAbs + (sink.carrier && Number.isFinite(sink.carrier.restSeconds) ? sink.carrier.restSeconds : 0)
  }
  const critical = perBurst.reduce((a, b) => (b.slack < a.slack ? b : a), perBurst[0])
  const top = critical.candidate
  return {
    chainId: chain.id, dishId: chain.dishId, stream: chain.stream, units: N, k: kk, start, deadline,
    organisation: top.organisation, groups: top.groups, replicas: top.replicas, cycle: top.cycle, finish: top.finish, fillLatency: top.fillLatency, handoffs: top.handoffs, balance: top.balance,
    workforce: Math.max(...perBurst.map((b) => b.workforce)),
    candidates, sink, perBurst,
    hints: { chainId: chain.id, chain, bursts: perBurst.map((b) => ({ index: b.index, units: b.units, groups: b.groups, replicas: b.replicas, workforce: b.workforce })) },
  }
}

/**
 * Re-derive the per-burst choice of a balanceChain result for a Phase F move: `rank` picks the rank-th candidate
 * of each burst's ranked list, `workforceDelta` the best candidate with the burst's workforce ± delta.
 */
export function rechooseBursts(balance, { rank = 0, workforceDelta = 0 } = {}) {
  const bursts = balance.perBurst.map((b) => {
    let cand = b.candidate
    if (rank > 0) cand = b.ranked[Math.min(rank, b.ranked.length - 1)] || cand
    if (workforceDelta !== 0) {
      const target = Math.max(1, Math.min(balance.k, b.workforce + workforceDelta))
      cand = b.ranked.find((c) => c.workforce === target) || cand
    }
    return { index: b.index, units: b.units, groups: cand.groups, replicas: cand.replicas, workforce: cand.workforce }
  })
  return { ...balance.hints, bursts }
}

/**
 * Turn chain hints into dispatcher options (spec §5.4 "materialised as chunked tasks ... handed to Phase E").
 * Replicas of a group own batch instances round-robin and matching unit slices of unbatched stages; owners are
 * the least loaded participants so far (deterministic in the given order).
 * @param {object} graph
 * @param {Array<object>} hints balanceChain results, their `.hints`, or rechooseBursts outputs
 * @param {Array<string>} participantIds cooks the dispatcher may use, in preference order
 * @returns {{ preferAssignments: Object<string,string>, chunkPlan: Object<string, Array<{from,to,participantId}>>, stageGroups: Object<string, string[]> }}
 */
export function applyChainHints(graph, hints, participantIds) {
  const preferAssignments = {}
  const chunkPlan = {}
  const stageGroups = {}
  const pids = (participantIds || []).slice()
  if (!pids.length) return { preferAssignments, chunkPlan, stageGroups }
  const load = Object.fromEntries(pids.map((p) => [p, 0]))
  const own = (pid, id) => { if (!stageGroups[pid]) stageGroups[pid] = []; if (!stageGroups[pid].includes(id)) stageGroups[pid].push(id) }
  for (const h0 of hints || []) {
    const h = h0.hints || h0
    const chain = h.chain
    if (!chain) continue
    const batchedStage = chain.stages.find((s) => s.batched) || null
    for (const burst of h.bursts || []) {
      const taken = new Set()
      for (let gi = 0; gi < burst.groups.length; gi++) {
        const g = burst.groups[gi]
        const d = burst.replicas[gi]
        const groupSeconds = g.reduce((a, si) => a + chain.stages[si].perUnit, 0) * (burst.units.to - burst.units.from + 1)
        const owners = []
        const pool = pids.filter((p) => !taken.has(p)).sort((a, b) => load[a] - load[b] || pids.indexOf(a) - pids.indexOf(b))
        for (let r = 0; r < d; r++) { const p = pool[r % pool.length]; owners.push(p); taken.add(p); load[p] += groupSeconds / d }
        for (const si of g) {
          const stage = chain.stages[si]
          const inBurst = stage.instances.filter((id) => { const r = stage.ranges[id]; return r.from <= burst.units.to && r.to >= burst.units.from })
          if (stage.batched) {
            inBurst.forEach((id, i) => { const o = owners[i % owners.length]; preferAssignments[id] = o; chunkPlan[id] = [{ from: 1, to: stage.ranges[id].to - stage.ranges[id].from + 1, participantId: o }]; own(o, id) })
          } else {
            const id = inBurst[0]
            if (!id) continue
            const base = stage.ranges[id].from - 1
            const slices = []
            if (batchedStage) {
              const ranges = batchedStage.instances.map((x) => batchedStage.ranges[x]).filter((r) => r.from <= burst.units.to && r.to >= burst.units.from)
              ranges.forEach((r, i) => slices.push({ from: Math.max(r.from, burst.units.from), to: Math.min(r.to, burst.units.to), participantId: owners[i % owners.length] }))
            } else {
              const n = burst.units.to - burst.units.from + 1
              const per = Math.floor(n / owners.length)
              let from = burst.units.from
              owners.forEach((o, i) => { const cnt = i === owners.length - 1 ? burst.units.to - from + 1 : per; if (cnt > 0) slices.push({ from, to: from + cnt - 1, participantId: o }); from += cnt })
            }
            if (!chunkPlan[id]) chunkPlan[id] = []
            for (const s of slices) chunkPlan[id].push({ from: s.from - base, to: s.to - base, participantId: s.participantId })
            for (const o of owners) own(o, id)
          }
        }
      }
    }
  }
  // merge adjacent slices with the same owner; single slices become plain preferences
  for (const [id, list] of Object.entries(chunkPlan)) {
    list.sort((a, b) => a.from - b.from)
    const merged = []
    for (const s of list) { const last = merged[merged.length - 1]; if (last && last.participantId === s.participantId && last.to + 1 >= s.from) last.to = Math.max(last.to, s.to); else merged.push({ ...s }) }
    chunkPlan[id] = merged
    if (merged.length === 1 && !preferAssignments[id]) preferAssignments[id] = merged[0].participantId
  }
  return { preferAssignments, chunkPlan, stageGroups }
}
