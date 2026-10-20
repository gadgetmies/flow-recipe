import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { buildGraph } from '../src/graph/index.js'
import { defaultInventory, mergeInventory } from '../src/inventory.js'
import { plan, normaliseSession, computeWindows, dispatch } from '../src/planner/index.js'
import { detectChains, sinkRate, balanceChain, enumerateCandidates, simulateChain, applyChainHints, rechooseBursts } from '../src/planner/pipeline.js'

const here = dirname(fileURLToPath(import.meta.url))
const load = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'))
const catalogue = load('catalogue.json')
const SERVE = Date.UTC(2026, 9, 11, 18, 0, 0)
const START = SERVE - 4 * 3600_000

function session(sheets = 4, { participants = 3, tiramisu = true, startTime = START } = {}) {
  const inventory = mergeInventory(defaultInventory(), { tools: [{ type: 'baking-sheet', count: sheets }] })
  const dishes = [{ id: 'buns', recipeId: 'buns', recipe: load('buns.model.json'), scale: 1, serveTime: SERVE, earlyTolerance: 0, lateTolerance: 300_000 }]
  if (tiramisu) dishes.push({ id: 'tiramisu', recipeId: 'tiramisu', recipe: load('tiramisu.model.json'), scale: 1, serveTime: SERVE + 20 * 60_000, earlyTolerance: 0, lateTolerance: 300_000 })
  const ids = ['0', 'p2', 'p3', 'p4'].slice(0, participants)
  return { id: 's', startTime, dishes, participants: ids.map((id) => ({ id, name: id })), inventory, policy: { seed: 1 } }
}

function prepared(sheets) {
  const raw = session(sheets)
  const graph = buildGraph(raw, catalogue)
  const s = normaliseSession(raw)
  s.t0 = START
  for (const p of s.participants) p.availabilityRel = null
  const win = computeWindows(graph, START, { slackBuffer: 120 })
  return { graph, s, win }
}

const bunsChain = (graph) => detectChains(graph).find((c) => c.stream === 'bun')
const HOUR3 = 3 * 3600 // 17:00 relative to START

test('detectChains: buns roll → place → brush → sprinkle is one chain of 4 stages on stream bun; batches count once', () => {
  const { graph } = prepared(4)
  const chains = detectChains(graph)
  const chain = bunsChain(graph)
  assert.ok(chain, 'buns chain found')
  assert.equal(chain.stages.length, 4)
  assert.deepEqual(chain.stages.map((st) => st.recipeTaskId), ['roll', 'place', 'brush', 'sprinkle'])
  assert.deepEqual(chain.stages.map((st) => st.instances.length), [1, 4, 4, 4])
  assert.equal(chain.units, 64)
  assert.deepEqual(chain.stages.map((st) => st.perUnit), [15, 5, 5, 5])
  assert.deepEqual(chain.stages[1].ranges['buns:place#b3'], { from: 33, to: 48 })
  assert.deepEqual(chain.sinks.map((t) => t.id), ['buns:bake.in#b1', 'buns:bake.in#b2'])
  assert.equal(chain.buffers.filter((b) => b.carrier === 'baking-sheet').length, 8)
  // the tiramisu ladyfinger stream is its own chain
  const lady = chains.find((c) => c.stream === 'ladyfinger')
  assert.ok(lady)
  assert.deepEqual(lady.stages.map((st) => st.recipeTaskId), ['soak', 'layer'])
})

test('enumerateCandidates: cell / pipeline / hybrid with the single pastry brush bounding brush replicas', () => {
  const { graph, s } = prepared(4)
  const chain = bunsChain(graph)
  const cands = enumerateCandidates(chain, 3, s.inventory)
  const cell3 = cands.find((c) => c.organisation === 'cell' && c.workforce === 3)
  assert.equal(cell3, undefined, 'a three-person cell is infeasible with one brush')
  const cell1 = cands.find((c) => c.organisation === 'cell' && c.workforce === 1)
  assert.ok(cell1 && cell1.cycle === 30)
  const hybrid = cands.find((c) => c.organisation === 'hybrid' && JSON.stringify(c.groups) === '[[0,1],[2,3]]' && JSON.stringify(c.replicas) === '[2,1]')
  assert.ok(hybrid, 'A,B = roll+place, C = brush+sprinkle exists')
  assert.equal(hybrid.cycle, 10)
  assert.equal(hybrid.balance, 0)
  assert.equal(hybrid.handoffs, 1)
  const pipeline = cands.find((c) => c.organisation === 'pipeline' && JSON.stringify(c.groups) === '[[0],[1,2],[3]]')
  assert.ok(pipeline && pipeline.cycle === 15)
  for (const c of cands) for (let gi = 0; gi < c.groups.length; gi++) if (c.groups[gi].includes(2)) assert.equal(c.replicas[gi], 1, 'brush is never replicated')
  const sim = simulateChain(chain, hybrid)
  assert.ok(Math.abs(sim.finish - (63 * 10 + 30)) < 1e-9)
})

test('sinkRate: 4 sheets hold the whole batch (not binding); 2 sheets make the carrier cycle the bound', () => {
  const four = prepared(4)
  const r4 = sinkRate(bunsChain(four.graph), four.graph, four.s, { cycle: 10, windows: four.win.windows })
  assert.equal(r4.bindsChain, false)
  assert.equal(r4.bufferUnits, 64)
  assert.ok(r4.oven && Math.abs(r4.oven.rate - 32 / 930) < 1e-9, 'oven: 2 slots × 16 per 15.5 min bake')
  assert.ok(r4.carrier && r4.carrier.releaseTask === 'buns:transfer#b1')
  const two = prepared(2)
  const r2 = sinkRate(bunsChain(two.graph), two.graph, two.s, { cycle: 10, windows: two.win.windows })
  assert.equal(r2.binding, 'carrier')
  assert.equal(r2.bindsChain, true)
  assert.equal(r2.bufferUnits, 32)
  assert.ok(r2.rate < 1 / 10, `carrier rate ${r2.rate * 60}/min is below the three-person rate of 6/min`)
  assert.ok(r2.carrier.cycleSeconds > 15 * 60 && r2.carrier.cycleSeconds < 25 * 60, `carrier cycle ≈ 18–22 min, got ${r2.carrier.cycleSeconds / 60}`)
})

test('balanceChain, 4 sheets: the hybrid wins, brush unreplicated, 64 units in ≈ 10.7 min', () => {
  const { graph, s, win } = prepared(4)
  const chain = bunsChain(graph)
  // a tight window so that every hand is needed: the first oven load (32 buns) must be ready 6 min after the
  // chain starts, the second one a bake later (one person: 16 min; two in a pipeline: 8.25 min; the hybrid: 5.7 min)
  const b = balanceChain(chain, 3, graph, s, s.policy, { windows: win.windows, start: HOUR3, deadline: HOUR3 + 6 * 60 + 930 })
  assert.equal(b.organisation, 'hybrid')
  assert.deepEqual(b.groups, [[0, 1], [2, 3]])
  assert.deepEqual(b.replicas, [2, 1])
  assert.equal(b.workforce, 3)
  assert.ok(b.finish >= 10 * 60 && b.finish <= 11.5 * 60, `finish ≈ 10.7 min, got ${(b.finish / 60).toFixed(2)}`)
  assert.equal(b.sink.bindsChain, false)
  assert.equal(b.perBurst.length, 1)
  // the full-workforce ranking is the same hybrid even with a slack window
  const relaxed = balanceChain(chain, 3, graph, s, s.policy, { windows: win.windows, start: HOUR3 })
  assert.equal(relaxed.candidates[0].organisation, 'hybrid')
  assert.deepEqual(relaxed.candidates[0].replicas, [2, 1])
  assert.ok(relaxed.candidates[0].feasible)
  // with 40 min of slack one person suffices for the (single) burst and two are returned to the dispatcher
  assert.equal(relaxed.perBurst[0].workforce, 1)
  assert.equal(relaxed.perBurst[0].organisation, 'cell')
})

test('balanceChain, 2 sheets: the carrier rate bounds the chain, first burst gets one person, the critical burst all three', () => {
  const { graph, s, win } = prepared(2)
  const chain = bunsChain(graph)
  const b = balanceChain(chain, 3, graph, s, s.policy, { windows: win.windows, start: HOUR3 })
  assert.equal(b.sink.binding, 'carrier')
  assert.equal(b.sink.bindsChain, true)
  assert.equal(b.perBurst.length, 2)
  assert.deepEqual(b.perBurst[0].units, { from: 1, to: 32 })
  assert.deepEqual(b.perBurst[1].units, { from: 33, to: 64 })
  assert.equal(b.perBurst[0].workforce, 1, 'the first burst has slack: one person in cell mode')
  assert.equal(b.perBurst[0].organisation, 'cell')
  assert.ok(b.perBurst[0].slack > 0)
  assert.equal(b.perBurst[1].workforce, 3, 'the second burst is on the critical path: everyone')
  assert.ok(b.perBurst[1].start > b.perBurst[0].finish + 15 * 60, 'the second burst waits for the sheets to come back from the oven')
  assert.equal(b.workforce, 3)
  // blocked time is included in the whole-chain effective cycle
  const top = b.candidates[0]
  assert.ok(top.blocked > 0 && top.cycleEffective > top.cycle)
})

test('applyChainHints materialises bursts as chunk plans and stage ownership that dispatch() honours', () => {
  const { graph, s, win } = prepared(2)
  const chain = bunsChain(graph)
  const b = balanceChain(chain, 3, graph, s, s.policy, { windows: win.windows, start: HOUR3 })
  const hints = applyChainHints(graph, [b], ['0', 'p2', 'p3'])
  const roll = hints.chunkPlan['buns:roll']
  assert.ok(Array.isArray(roll) && roll.length >= 2, 'roll is split per burst / replica')
  assert.equal(roll[0].from, 1)
  assert.equal(roll[roll.length - 1].to, 64)
  for (let i = 1; i < roll.length; i++) assert.equal(roll[i].from, roll[i - 1].to + 1)
  // burst 1 (sheets 1–2) is one person's cell: the same owner for place/brush/sprinkle b1 and b2 and roll 1–32
  const owner = hints.preferAssignments['buns:place#b1']
  for (const id of ['buns:place#b2', 'buns:brush#b1', 'buns:brush#b2', 'buns:sprinkle#b1', 'buns:sprinkle#b2']) assert.equal(hints.preferAssignments[id], owner)
  assert.equal(roll[0].participantId, owner)
  assert.ok(hints.stageGroups[owner].includes('buns:brush#b1'))
  // burst 2 is the hybrid: brush+sprinkle of b3/b4 share one owner, roll/place slices go to the other two
  assert.equal(hints.preferAssignments['buns:brush#b3'], hints.preferAssignments['buns:sprinkle#b4'])
  assert.notEqual(hints.preferAssignments['buns:place#b3'], hints.preferAssignments['buns:brush#b3'])
  // dispatch honours the chunk plan: roll is split exactly as planned
  const d = dispatch(graph, s, win.windows, { now: 0, preferAssignments: hints.preferAssignments, chunkPlan: hints.chunkPlan })
  const rollItems = d.items.filter((it) => it.taskId === 'buns:roll' && it.kind === 'work').sort((a, b) => a.units.from - b.units.from)
  assert.equal(rollItems.length, roll.length)
  assert.deepEqual(rollItems.map((it) => [it.units.from, it.units.to]), roll.map((c) => [c.from, c.to]))
  assert.deepEqual(rollItems.map((it) => it.participantId), roll.map((c) => c.participantId))
  assert.ok(d.done)
  // a single-range plan disables the greedy split
  const d1 = dispatch(graph, s, win.windows, { now: 0, chunkPlan: { 'buns:roll': [{ from: 1, to: 64 }] } })
  assert.equal(d1.items.filter((it) => it.taskId === 'buns:roll' && it.kind === 'work').length, 1)
  // rechooseBursts re-derives a different choice for Phase F
  const alt = rechooseBursts(b, { workforceDelta: 1 })
  assert.equal(alt.bursts[0].workforce, 2)
})

test('priorityOffsets reorder the ready set deterministically', () => {
  const { graph, s, win } = prepared(4)
  const base = dispatch(graph, s, win.windows, { now: 0 })
  const first = (d, id) => d.items.find((it) => it.taskId === id && it.kind === 'work')
  const a = first(base, 'tiramisu:measure-coffee')
  const shifted = dispatch(graph, s, win.windows, { now: 0, priorityOffsets: { 'tiramisu:measure-coffee': 3600 } })
  const b = first(shifted, 'tiramisu:measure-coffee')
  assert.ok(a && b)
  assert.ok(b.start >= a.start, 'a later priority never starts the task earlier')
  const again = dispatch(graph, s, win.windows, { now: 0, priorityOffsets: { 'tiramisu:measure-coffee': 3600 } })
  assert.deepEqual(again.items.map((it) => [it.uuid, it.participantId, it.start]), shifted.items.map((it) => [it.uuid, it.participantId, it.start]))
})

test('plan() reports the chain analysis and stays sound with and without hints (no search)', () => {
  for (const sheets of [4, 2]) {
    const p = plan(buildGraph(session(sheets), catalogue), session(sheets), { budgetMs: 0 })
    assert.ok(!p.diagnostics.some((d) => d.code === 'INVARIANT' || d.code === 'DEADLOCK' || d.code === 'INCOMPLETE'), JSON.stringify(p.diagnostics))
    assert.equal(p.dishes.find((d) => d.dishId === 'buns').late, 0)
    assert.ok(p.report.objective && Number.isFinite(p.report.objective.total))
    assert.deepEqual(p.report.search, { iterations: 0, improved: false, budgetMs: 0, ms: 0, hintsApplied: p.report.search.hintsApplied })
    const chain = p.report.chains.find((c) => c.stream === 'bun')
    assert.ok(chain)
    assert.equal(chain.sink.bindsChain, sheets === 2)
    if (sheets === 2) assert.equal(chain.perBurst[0].workforce, 1)
  }
})
