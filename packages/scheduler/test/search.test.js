import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { buildGraph } from '../src/graph/index.js'
import { defaultInventory, mergeInventory } from '../src/inventory.js'
import { plan, normaliseSession, computeWindows, dispatch, objectiveOf, objective } from '../src/planner/index.js'
import { improve, initialState, neighbour, rng } from '../src/planner/search.js'
import { repair, lateness, RUNGS } from '../src/planner/repair.js'
import { cakeGraph } from './fixtures/cake.graph.js'

const here = dirname(fileURLToPath(import.meta.url))
const load = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'))
const catalogue = load('catalogue.json')
const SERVE = Date.UTC(2026, 9, 11, 18, 0, 0)
const START = SERVE - 4 * 3600_000

function session({ sheets = 4, startTime = START, serve = SERVE, participants = 3, seed = 1, policy = {} } = {}) {
  const inventory = mergeInventory(defaultInventory(), { tools: [{ type: 'baking-sheet', count: sheets }] })
  const dishes = [
    { id: 'buns', recipeId: 'buns', recipe: load('buns.model.json'), scale: 1, serveTime: serve, earlyTolerance: 0, lateTolerance: 300_000 },
    { id: 'tiramisu', recipeId: 'tiramisu', recipe: load('tiramisu.model.json'), scale: 1, serveTime: serve + 20 * 60_000, earlyTolerance: 0, lateTolerance: 300_000 },
  ]
  const ids = ['0', 'p2', 'p3', 'p4'].slice(0, participants)
  return { id: 's', startTime, dishes, participants: ids.map((id) => ({ id, name: id })), inventory, policy: { seed, ...policy } }
}

function prepared(sessionOverrides = {}) {
  const raw = session(sessionOverrides)
  const graph = buildGraph(raw, catalogue)
  const s = normaliseSession(raw)
  s.t0 = raw.startTime
  for (const p of s.participants) p.availabilityRel = null
  const win = computeWindows(graph, raw.startTime, { slackBuffer: 120 })
  return { raw, graph, s, win }
}

const sound = (p) => !p.diagnostics.some((d) => d.code === 'INVARIANT' || d.code === 'DEADLOCK' || d.code === 'INCOMPLETE')

test('objective: terms are finite and ordered as the spec weights them; a late plan pays per second', () => {
  const { graph, s, win } = prepared()
  const d = dispatch(graph, s, win.windows, { now: 0 })
  const o = objectiveOf(d, graph, s, s.policy, { now: 0 })
  assert.ok(Number.isFinite(o.total) && o.total > 0)
  for (const k of ['fair', 'idle', 'switch', 'interrupt', 'robust', 'span', 'stable', 'late', 'violations']) assert.ok(Number.isFinite(o.terms[k]) && o.terms[k] >= 0, k)
  assert.equal(o.terms.late, 0)
  assert.equal(o.terms.violations, 0)
  assert.equal(o.terms.stable, 0)
  assert.ok(o.terms.switch > 0)
  assert.ok(o.terms.span > 200 && o.terms.span < 300, 'makespan in minutes (the tiramisu chill dominates)')
  // the same plan evaluated through the emitted Plan agrees on the deterministic terms
  const p = plan(graph, session(), { budgetMs: 0 })
  const o2 = objective(p, graph, session(), s.policy)
  assert.equal(o2.terms.late, p.report.objective.terms.late)
  assert.equal(o2.terms.switch, p.report.objective.terms.switch)
  // lateness: pretend the buns had to be served an hour earlier
  const late = { ...graph, dishes: graph.dishes.map((x) => (x.id === 'buns' ? { ...x, serveTime: x.serveTime - 3600_000 } : x)) }
  const ol = objectiveOf(d, late, s, s.policy, { now: 0 })
  assert.ok(ol.terms.late >= 3300 && ol.terms.late <= 3600, `late seconds ${ol.terms.late}`)
  assert.ok(ol.total > o.total + 10 * 3000)
  // stability counts moved near-future items against a previous plan
  const prev = plan(graph, session(), { budgetMs: 0 })
  const moved = { ...prev, lanes: prev.lanes.map((l) => ({ ...l, items: l.items.map((it) => ({ ...it, participantId: l.participantId === '0' ? 'p2' : it.participantId })) })) }
  const os = objectiveOf(d, graph, s, s.policy, { now: 0, previousPlan: moved })
  assert.ok(os.terms.stable > 0)
})

test('improve: seeded moves are deterministic for a fixed iteration count and never return a worse plan', () => {
  const { graph, s, win } = prepared()
  const run = () => improve(graph, s, win.windows, { dispatchOpts: { now: 0 }, balances: [], participantIds: ['0', 'p2', 'p3'], state: initialState(false) }, s.policy, { budgetMs: 10_000, maxIterations: 12, seed: 1 })
  const a = run(), b = run()
  assert.equal(a.iterations, 12)
  assert.equal(a.objective.total, b.objective.total)
  assert.deepEqual(a.result.items.map((it) => [it.uuid, it.participantId, it.start]), b.result.items.map((it) => [it.uuid, it.participantId, it.start]))
  assert.ok(a.objective.total <= a.initial.objective.total)
  assert.equal(a.improved, a.objective.total < a.initial.objective.total)
  // the wall-clock budget stops the loop
  const t = performance.now()
  const c = improve(graph, s, win.windows, { dispatchOpts: { now: 0 }, balances: [], participantIds: ['0', 'p2', 'p3'] }, s.policy, { budgetMs: 40, seed: 2 })
  assert.ok(performance.now() - t < 400, 'stopped within the budget plus one evaluation')
  assert.ok(c.iterations >= 1)
  // budget 0 = no moves at all
  const z = improve(graph, s, win.windows, { dispatchOpts: { now: 0 } }, s.policy, { budgetMs: 0, seed: 1 })
  assert.equal(z.iterations, 0)
  assert.equal(z.improved, false)
})

test('neighbour: every move kind yields a state the dispatcher accepts', () => {
  const { graph, s, win } = prepared({ sheets: 2 })
  const result = dispatch(graph, s, win.windows, { now: 0 })
  const r = rng(3)
  const cooks = ['0', 'p2', 'p3']
  const descendants = new Map()
  let produced = 0
  for (let i = 0; i < 40; i++) {
    const n = neighbour(initialState(false), { r, graph, result, windows: win.windows, cooks, balances: [], descendants })
    if (!n) continue
    produced++
    const d = dispatch(graph, s, win.windows, { now: 0, preferAssignments: n.preferAssignments, chunkPlan: n.chunkPlan, priorityOffsets: n.priorityOffsets })
    assert.ok(d.done)
  }
  assert.ok(produced > 10)
})

test('plan() with the search (300 ms, seed 1) is never worse than without it and stays sound', () => {
  for (const sheets of [4, 2]) {
    const g = buildGraph(session({ sheets }), catalogue)
    const noSearch = plan(g, session({ sheets }), { budgetMs: 0 })
    const searched = plan(g, session({ sheets }), { budgetMs: 300 })
    assert.ok(sound(noSearch), JSON.stringify(noSearch.diagnostics))
    assert.ok(sound(searched), JSON.stringify(searched.diagnostics))
    assert.ok(searched.report.objective.total <= noSearch.report.objective.total + 1e-9, `${sheets} sheets: ${searched.report.objective.total} ≤ ${noSearch.report.objective.total}`)
    assert.ok(searched.report.search.iterations > 0)
    assert.equal(searched.report.search.budgetMs, 300)
    assert.equal(searched.report.search.improved, searched.report.objective.total < noSearch.report.objective.total)
    assert.ok(searched.report.planningMs < 2000)
    assert.equal(searched.dishes.find((d) => d.dishId === 'buns').late, 0)
    // policy.searchBudgetMs = 0 skips the search too
    const skipped = plan(g, session({ sheets, policy: { searchBudgetMs: 0 } }))
    assert.equal(skipped.report.search.iterations, 0)
    assert.equal(skipped.report.objective.total, noSearch.report.objective.total)
  }
})

test('plan() with a fixed iteration cap is deterministic for a seed', () => {
  const g = buildGraph(session(), catalogue)
  const strip = (p) => p.lanes.map((l) => l.items.map((it) => [it.uuid, it.participantId, it.start, it.end]))
  const a = plan(g, session(), { budgetMs: 10_000, maxIterations: 8 })
  const b = plan(g, session(), { budgetMs: 10_000, maxIterations: 8 })
  assert.equal(a.report.search.iterations, 8)
  assert.deepEqual(strip(a), strip(b))
  assert.equal(a.report.objective.total, b.report.objective.total)
})

test('repair ladder: an impossible serve time yields REPAIR_DELAY with a positive delta and no exception', () => {
  const now = START
  const g = buildGraph(session({ startTime: now, serve: now + 20 * 60_000 }), catalogue)
  const p = plan(g, session({ startTime: now, serve: now + 20 * 60_000 }), { budgetMs: 0 })
  const codes = p.diagnostics.map((d) => d.code)
  assert.ok(codes.includes('CRITICAL_PATH'), codes.join(','))
  const delay = p.diagnostics.filter((d) => d.code === 'REPAIR_DELAY')
  assert.ok(delay.length >= 1, codes.join(','))
  const bunsDelay = delay.find((d) => d.dish === 'buns')
  assert.ok(bunsDelay && bunsDelay.delta > 0)
  assert.ok(bunsDelay.proposedServeTime > now + 20 * 60_000)
  const start = p.diagnostics.find((d) => d.code === 'REPAIR_START')
  assert.ok(start && start.delta > 0 && start.participants === 3)
  // the serve times were not changed silently
  assert.equal(p.dishes.find((d) => d.dishId === 'buns').serveTarget, now + 20 * 60_000)
  assert.ok(p.dishes.find((d) => d.dishId === 'buns').late > 0)
  for (const d of p.diagnostics) assert.ok(d.code !== 'REPAIR_ERROR', d.message)
  // every rung that changed the schedule is listed before the proposals, in ladder order
  const applied = codes.filter((c) => RUNGS.includes(c))
  assert.deepEqual(applied, applied.slice().sort((x, y) => RUNGS.indexOf(x) - RUNGS.indexOf(y)))
})

test('repair(): the ladder is a no-op proposal list for an on-time plan and REPAIR_HOLDING uses a matching holding resource', () => {
  const { graph, s, win } = prepared()
  const result = dispatch(graph, s, win.windows, { now: 0 })
  assert.equal(lateness(result, graph, s.t0), 0)
  const rep = repair({ graph, session: s, windows: win.windows, dispatchOpts: { now: 0 }, result, policy: s.policy, slack: 120, balances: [], participantIds: ['0', 'p2', 'p3'] })
  assert.equal(rep.applied.length, 0)
  assert.ok(!rep.diagnostics.some((d) => d.code === 'REPAIR_DELAY' || d.code === 'REPAIR_START'))
  // the cake (hot) with a warming drawer: a late cake is given to the drawer when that helps, never to the fridge
  const serve = SERVE
  const cake = cakeGraph(serve)
  const raw = { id: 'c', startTime: serve - 20 * 60_000, dishes: [{ id: 'cake', recipeId: 'cake', recipe: null, scale: 1, serveTime: serve }], participants: [{ id: '0', name: 'Host' }], inventory: mergeInventory(defaultInventory(), { holding: [{ type: 'warming-drawer', slots: 1, keeps: 'hot', maxHold: 3600 }] }), policy: { seed: 1 } }
  const p = plan(cake, raw, { budgetMs: 0 })
  const codes = p.diagnostics.map((d) => d.code)
  assert.ok(codes.includes('REPAIR_DELAY'), codes.join(','))
  const holding = p.diagnostics.find((d) => d.code === 'REPAIR_HOLDING')
  if (holding) assert.equal(holding.holding[0].type, 'warming-drawer')
})
