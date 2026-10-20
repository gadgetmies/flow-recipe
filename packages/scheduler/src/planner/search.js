// Phase F (spec §5.6): bounded local search over the dispatcher's inputs. Representation = priority offsets per
// task (seconds added to LS in the ready-sort key), assignment preferences (task / chunk / appointment → participant),
// explicit chunk plans and the chain organisation choice (Phase D candidate rank, workforce ± 1). Phase E is
// deterministic given these, so simulated annealing with a seeded PRNG explores them inside a wall-clock budget.

import { dispatch } from './dispatch.js'
import { objectiveOf } from './objective.js'
import { rechooseBursts, applyChainHints } from './pipeline.js'

/** Deterministic PRNG (mulberry32), same as sim/index.js. */
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

const WORK = new Set(['work', 'resume'])
const SHIFTS = [120, 300, 600, 1200]

function byId(a, b) { return a < b ? -1 : a > b ? 1 : 0 }
function pick(r, list) { return list.length ? list[Math.floor(r() * list.length) % list.length] : undefined }
function cloneState(s) {
  return {
    useHints: s.useHints,
    priorityOffsets: { ...s.priorityOffsets },
    preferAssignments: { ...s.preferAssignments },
    chunkPlan: { ...s.chunkPlan },
    chainChoice: Object.fromEntries(Object.entries(s.chainChoice).map(([k, v]) => [k, { ...v }])),
  }
}

/**
 * Dispatcher options for a search state: base options (frozen prefix, stability preferences) + Phase D hints
 * for the chosen chain organisations + the search's own overrides.
 * @param {object} graph
 * @param {object} state { useHints, priorityOffsets, preferAssignments, chunkPlan, chainChoice }
 * @param {object} base { dispatchOpts, balances, participantIds }
 */
export function optsFor(graph, state, base) {
  const out = { ...(base.dispatchOpts || {}) }
  let prefer = { ...(base.dispatchOpts?.preferAssignments || {}) }
  let chunkPlan = {}
  if (state.useHints && base.balances && base.balances.length) {
    const hints = applyChainHints(graph, base.balances.map((b) => rechooseBursts(b, state.chainChoice[b.chainId] || {})), base.participantIds)
    prefer = { ...prefer, ...hints.preferAssignments }
    chunkPlan = { ...hints.chunkPlan }
  }
  out.preferAssignments = { ...prefer, ...state.preferAssignments }
  out.chunkPlan = { ...chunkPlan, ...state.chunkPlan }
  out.priorityOffsets = { ...state.priorityOffsets }
  return out
}

/** Initial (empty) search state. */
export function initialState(useHints = false) {
  return { useHints, priorityOffsets: {}, preferAssignments: {}, chunkPlan: {}, chainChoice: {} }
}

function descendantsMap(graph) {
  const succ = new Map()
  for (const e of graph.edges) { if (!succ.has(e.from)) succ.set(e.from, []); succ.get(e.from).push(e.to) }
  const memo = new Map()
  const visit = (id) => {
    if (memo.has(id)) return memo.get(id)
    const set = new Set()
    memo.set(id, set)
    for (const n of succ.get(id) || []) { set.add(n); for (const x of visit(n)) set.add(x) }
    return set
  }
  for (const id of graph.order) visit(id)
  return memo
}

/**
 * One random neighbour of `state` (spec §5.6 moves 1–7), or null when the chosen move does not apply.
 * `ctx` carries what the moves look at: the current dispatch result, graph, windows, cooks, chains, PRNG.
 */
export function neighbour(state, ctx) {
  const { r, graph, result, windows, cooks, balances, descendants } = ctx
  const s = cloneState(state)
  const move = 1 + Math.floor(r() * 7)
  const laneItems = (pid) => result.items.filter((it) => it.participantId === pid && WORK.has(it.kind) && graph.tasks[it.taskId] && !it.urgency).sort((a, b) => a.start - b.start)
  const loadOf = (pid) => result.loads?.[pid] || 0
  switch (move) {
    case 1: { // swap preferred participant between the most and least loaded cooks
      if (cooks.length < 2) return null
      const sorted = cooks.slice().sort((a, b) => loadOf(b) - loadOf(a) || byId(a, b))
      const heavy = sorted[0], light = sorted[sorted.length - 1]
      const it = pick(r, laneItems(heavy))
      if (!it) return null
      s.preferAssignments[it.taskId] = light
      const back = pick(r, laneItems(light))
      if (back && r() < 0.5) s.preferAssignments[back.taskId] = heavy
      return s
    }
    case 2: { // shift a floating task's priority
      const floating = graph.order.filter((id) => graph.tasks[id].kind !== 'sink' && windows[id] && !windows[id].anchored && Number.isFinite(windows[id].LS))
      const id = pick(r, floating)
      if (!id) return null
      const shift = pick(r, SHIFTS) * (r() < 0.5 ? -1 : 1)
      s.priorityOffsets[id] = (s.priorityOffsets[id] || 0) + shift
      return s
    }
    case 3: { // re-chunk a divisible task
      const divisible = graph.order.filter((id) => { const t = graph.tasks[id]; return t.divisible === 'units' && t.units > 1 && (t.perUnit || 0) > 0 })
      const id = pick(r, divisible)
      if (!id) return null
      const t = graph.tasks[id]
      const current = result.items.filter((it) => it.taskId === id && WORK.has(it.kind)).length || 1
      const options = [1, 2, 3].filter((k) => k !== current && k <= Math.max(1, cooks.length))
      const k = pick(r, options)
      if (!k) return null
      const per = Math.floor(t.units / k)
      const ranges = []
      let from = 1
      for (let i = 0; i < k; i++) { const n = i === k - 1 ? t.units - from + 1 : per; if (n > 0) ranges.push({ from, to: from + n - 1 }); from += n }
      s.chunkPlan[id] = ranges
      return s
    }
    case 4: { // chain organisation: next candidate rank
      const b = pick(r, balances || [])
      if (!b) return null
      const cur = s.chainChoice[b.chainId] || { rank: 0, workforceDelta: 0 }
      const n = Math.min(5, Math.max(...b.perBurst.map((x) => x.ranked.length)))
      s.chainChoice[b.chainId] = { ...cur, rank: (cur.rank + 1) % Math.max(1, n) }
      s.useHints = true
      return s
    }
    case 5: { // appointment holder
      const appts = [...(result.runtime?.values() || [])].filter((x) => x.appointment && x.appointment.holder)
      const a = pick(r, appts)
      if (!a || cooks.length < 2) return null
      const others = cooks.filter((p) => p !== a.appointment.holder)
      s.preferAssignments[a.appointment.uuid] = pick(r, others)
      return s
    }
    case 6: { // swap two adjacent lane items with no precedence between them
      const pid = pick(r, cooks)
      const list = laneItems(pid)
      if (list.length < 2) return null
      const i = Math.floor(r() * (list.length - 1))
      const a = list[i], b = list[i + 1]
      if (a.taskId === b.taskId || descendants.get(a.taskId)?.has(b.taskId)) return null
      const keyA = (windows[a.taskId]?.LS ?? 0) + (s.priorityOffsets[a.taskId] || 0)
      const keyB = (windows[b.taskId]?.LS ?? 0) + (s.priorityOffsets[b.taskId] || 0)
      if (!Number.isFinite(keyA) || !Number.isFinite(keyB)) return null
      s.priorityOffsets[b.taskId] = (s.priorityOffsets[b.taskId] || 0) - Math.max(60, keyB - keyA + 60)
      return s
    }
    case 7: { // chain workforce ± 1 (remove a replica when its lanes show blocked time, else add one)
      const b = pick(r, balances || [])
      if (!b) return null
      const ids = new Set(b.hints.chain.stages.flatMap((st) => st.instances))
      const blocked = result.items.some((it) => it.kind === 'blocked' && ids.has(it.taskId))
      const cur = s.chainChoice[b.chainId] || { rank: 0, workforceDelta: 0 }
      const delta = blocked ? -1 : r() < 0.5 ? -1 : 1
      const next = Math.max(1 - b.k, Math.min(b.k - 1, cur.workforceDelta + delta))
      if (next === cur.workforceDelta) return null
      s.chainChoice[b.chainId] = { ...cur, workforceDelta: next }
      s.useHints = true
      return s
    }
    default: return null
  }
}

/**
 * Simulated annealing over dispatcher inputs within a wall-clock budget.
 * @param {object} graph
 * @param {object} session normalised session (with t0, availabilityRel)
 * @param {object} windows from computeWindows
 * @param {object} initial { dispatchOpts (frozen, now, preferAssignments), balances: balanceChain results, participantIds, state?: search state }
 * @param {object} policy merged policy (seed, weights, searchBudgetMs)
 * @param {object} [opts] { budgetMs (default policy.searchBudgetMs), seed (default policy.seed), maxIterations, previousPlan, now }
 * @returns {{ opts: object, state: object, result: object, objective: object, iterations: number, improved: boolean, ms: number, initial: object }}
 */
export function improve(graph, session, windows, initial, policy, opts = {}) {
  const budgetMs = opts.budgetMs ?? policy.searchBudgetMs ?? 0
  const seed = opts.seed ?? policy.seed ?? 1
  const maxIterations = opts.maxIterations ?? Infinity
  const r = rng(seed)
  const base = { dispatchOpts: initial.dispatchOpts || {}, balances: initial.balances || [], participantIds: initial.participantIds || [] }
  const cooks = session.participants.filter((p) => p.role !== 'spectator').map((p) => p.id)
  const evalOpts = { previousPlan: opts.previousPlan, now: opts.now ?? base.dispatchOpts.now ?? 0 }
  const evaluate = (state) => {
    const o = optsFor(graph, state, base)
    const result = dispatch(graph, session, windows, o)
    const objective = objectiveOf(result, graph, session, policy, evalOpts)
    return { state, opts: o, result, objective }
  }
  const t0 = performance.now()
  let cur = evaluate(initial.state || initialState(false))
  const first = cur
  let best = cur
  const T0 = Math.max(1, 0.05 * Math.abs(cur.objective.total))
  const descendants = descendantsMap(graph)
  let iterations = 0
  while (iterations < maxIterations) {
    const elapsed = performance.now() - t0
    if (budgetMs <= 0 || elapsed >= budgetMs) break
    iterations++
    const frac = Math.min(1, elapsed / budgetMs)
    const T = T0 * Math.pow(0.01, frac)
    const next = neighbour(cur.state, { r, graph, result: cur.result, windows, cooks, balances: base.balances, descendants })
    if (!next) continue
    const cand = evaluate(next)
    const delta = cand.objective.total - cur.objective.total
    if (delta <= 0 || r() < Math.exp(-delta / T)) {
      cur = cand
      if (cand.objective.total < best.objective.total - 1e-9) best = cand
    }
  }
  return { opts: best.opts, state: best.state, result: best.result, objective: best.objective, iterations, improved: best.objective.total < first.objective.total - 1e-9, ms: Math.round(performance.now() - t0), initial: first }
}
