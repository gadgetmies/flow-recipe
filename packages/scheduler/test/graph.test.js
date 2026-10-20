import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { buildGraph, expandTasks, propagateQuantities, graphToDot, computeDurations, topologicalOrder } from '../src/graph/index.js'
import { defaultInventory, mergeInventory } from '../src/inventory.js'

const here = dirname(fileURLToPath(import.meta.url))
const load = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'))
const catalogue = load('catalogue.json')
const bunsModel = () => load('buns.model.json')
const tiramisuModel = () => load('tiramisu.model.json')

const SERVE = Date.UTC(2026, 0, 1, 18, 0, 0)

function session(dishes, inventory = defaultInventory()) {
  return { id: 'test', startTime: null, now: SERVE - 3 * 3600_000, dishes, participants: [], inventory, policy: {} }
}
const bunsDish = (overrides = {}) => ({ id: 'buns', recipeId: 'buns', recipe: bunsModel(), scale: 1, serveTime: SERVE, earlyTolerance: 0, lateTolerance: 300_000, ...overrides })
const tiramisuDish = () => ({ id: 'tiramisu', recipeId: 'tiramisu', recipe: tiramisuModel(), scale: 1, serveTime: SERVE + 1800_000, earlyTolerance: 0, lateTolerance: 300_000 })

const edges = (graph, pred) => graph.edges.filter(pred)
const batchesOf = (graph, recipeTaskId, dishId = 'buns') =>
  Object.values(graph.tasks).filter((t) => t.dishId === dishId && t.recipeTaskId === recipeTaskId).sort((a, b) => (a.batch?.index ?? 0) - (b.batch?.index ?? 0))

test('expansion: bake-in-oven → preheat/in/out, split → 64 units from unit-size, fixpoint', () => {
  const tasks = expandTasks(bunsModel().tasks, catalogue, bunsModel())
  const ids = tasks.map((t) => t.id)
  assert.ok(!ids.includes('bake'))
  assert.deepEqual(ids.filter((id) => id.startsWith('bake')), ['bake.preheat', 'bake.in', 'bake.out'])
  const put = tasks.find((t) => t.id === 'bake.in')
  assert.equal(put.operation, 'put-into-oven')
  assert.equal(put.options.duration.number, 15)
  assert.ok(put.inputs.some((i) => i.ref === 'oven-ready-bun'))
  assert.ok(put.inputs.some((i) => i.ref === 'bake.oven'))
  const out = tasks.find((t) => t.id === 'bake.out')
  assert.equal(out.outputs[0].id, 'baked-buns')
  assert.equal(out.inputs[0].ref, 'bake.baking')
  const split = tasks.find((t) => t.id === 'split')
  assert.equal(split.outputs[0].amount, 64)
  // idempotent
  assert.deepEqual(expandTasks(tasks, catalogue, bunsModel()), tasks)
})

test('quantities: stream counts and scale', () => {
  const recipe = bunsModel()
  const tasks = expandTasks(recipe.tasks, catalogue, recipe)
  const q1 = propagateQuantities({ ...recipe, tasks }, 1)
  assert.equal(q1.tasks.split.units, 64)
  assert.equal(q1.tasks.split.unitStream, 'bun')
  assert.equal(q1.tasks.roll.units, 64)
  assert.equal(q1.tasks['bake.in'].units, 64)
  assert.equal(q1.tasks.transfer.units, 64)
  assert.equal(q1.tasks['measure-flour'].units, 1)
  assert.equal(q1.tasks['measure-flour'].unitStream, null)
  assert.equal(q1.tasks.raise.units, 1)
  assert.deepEqual(q1.finalOutputs, ['buns-on-rack'])
  const q2 = propagateQuantities({ ...recipe, tasks }, 1.5)
  assert.equal(q2.tasks.split.units, 96)
  assert.equal(q2.tasks['measure-flour'].units, 1.5)
  assert.equal(q2.tasks['measure-flour'].outputs[0].amount, 1500)
})

test('timing: README §3 formulas', () => {
  const op = (time) => ({ time })
  assert.deepEqual(computeDurations(op({ model: 'per-unit', active: 0, perUnit: 15 }), {}, 64), { active: 960, passive: 0, perUnit: 15, timeModel: 'per-unit' })
  assert.equal(computeDurations(op({ model: 'sub-linear', active: 20, perUnit: 40 }), {}, 4).active, 100)
  assert.equal(computeDurations(op({ model: 'fixed', active: 30, passiveFrom: 'duration' }), { options: { duration: { number: 15, unit: 'minutes' } } }, 1).passive, 900)
  assert.equal(computeDurations(op({ model: 'fixed', active: 20, passiveFrom: 'formula:preheat' }), { options: { temperature: { number: 225, unit: 'celsius' } } }, 1).passive, 1640)
  assert.equal(computeDurations(op({ model: 'fixed', active: 30, passiveFrom: 'formula:heat' }), { options: { temperature: { number: 37, unit: 'celsius' } } }, 1).passive, 135)
})

test('buns at scale 1 with the default inventory reproduces spec §8', () => {
  const graph = buildGraph(session([bunsDish()]), catalogue)
  assert.deepEqual(graph.diagnostics, [])

  // 4 sheet batches of 16 on place, brush and sprinkle
  for (const id of ['place', 'brush', 'sprinkle']) {
    const b = batchesOf(graph, id)
    assert.equal(b.length, 4, id)
    assert.deepEqual(b.map((t) => t.units), [16, 16, 16, 16])
    assert.deepEqual(b.map((t) => t.batch), [1, 2, 3, 4].map((index) => ({ index, of: 4 })))
    assert.deepEqual(b.map((t) => t.id), [1, 2, 3, 4].map((i) => `buns:${id}#b${i}`))
  }
  assert.match(graph.tasks['buns:place#b2'].instructions, /\(sheet 2 of 4\)$/)
  assert.equal(graph.tasks['buns:roll'].units, 64)
  assert.equal(graph.tasks['buns:roll'].active, 64 * 15)
  assert.equal(graph.tasks['buns:roll'].unitStream, 'bun')

  // 2 bake rounds of 32 in a 2-slot oven at 225c; round 1 consumes sheets 1–2
  const rounds = batchesOf(graph, 'bake.in')
  assert.equal(rounds.length, 2)
  assert.deepEqual(rounds.map((t) => t.units), [32, 32])
  assert.deepEqual(rounds[0].appliance, { type: 'oven', slots: 2, mode: '225c' })
  assert.equal(rounds[0].passive, 900)
  assert.equal(rounds[0].completion.urgency, 'critical')
  assert.equal(rounds[0].tools[0].type, 'baking-sheet')
  const intoRound1 = edges(graph, (e) => e.to === 'buns:bake.in#b1' && e.kind === 'fs').map((e) => e.from).sort()
  assert.deepEqual(intoRound1, ['buns:bake.preheat', 'buns:sprinkle#b1', 'buns:sprinkle#b2'])
  const intoRound2 = edges(graph, (e) => e.to === 'buns:bake.in#b2' && e.kind === 'fs').map((e) => e.from).sort()
  assert.deepEqual(intoRound2, ['buns:bake.preheat', 'buns:sprinkle#b3', 'buns:sprinkle#b4'])
  assert.equal(graph.tasks['buns:bake.preheat'].passive, (225 - 20) * 8)
  assert.equal(graph.tasks['buns:bake.preheat'].appliance.mode, '225c')
  assert.deepEqual(edges(graph, (e) => e.to === 'buns:bake.out#b2').map((e) => e.from), ['buns:bake.in#b2'])
  assert.deepEqual(edges(graph, (e) => e.to === 'buns:transfer#b1' && e.kind === 'fs').map((e) => e.from), ['buns:bake.out#b1'])
  assert.ok(edges(graph, (e) => e.to === 'buns:transfer#b1' && e.kind === 'maxlag').some((e) => e.hold === 600), 'baked buns carry a 10 min hold into the transfer')
  assert.deepEqual(graph.tasks['buns:transfer#b1'].returnsTools, ['baking-sheet'])

  // join: durations summed, instructions concatenated
  const join = graph.tasks['buns:yeast-milk']
  assert.equal(join.active, 30 + 60)
  assert.match(join.instructions, /Crumble/)
  assert.match(join.instructions, /milk/)

  // streaming chain roll → place → brush → sprinkle on unit stream 'bun'
  const stream = (from, to) => edges(graph, (e) => e.from === from && e.to === to && e.kind === 'stream')[0]
  const rollPlace = stream('buns:roll', 'buns:place#b1')
  assert.ok(rollPlace)
  assert.equal(rollPlace.unitStream, 'bun')
  assert.equal(rollPlace.lag, 15 + 10)
  assert.equal(rollPlace.ffLag, 5)
  const placeBrush = stream('buns:place#b1', 'buns:brush#b1')
  assert.ok(placeBrush)
  assert.equal(placeBrush.lag, 5 + 10)
  assert.ok(stream('buns:brush#b3', 'buns:sprinkle#b3'))
  assert.equal(stream('buns:brush#b1', 'buns:sprinkle#b2'), undefined)
  assert.equal(edges(graph, (e) => e.from === 'buns:sprinkle#b1' && e.kind === 'stream').length, 0, 'put-into-oven is not per-unit')

  // buffer on the sheet, released by the matching transfer round
  const buffer = graph.buffers.find((b) => b.from === 'buns:place#b1')
  assert.deepEqual(buffer, { from: 'buns:place#b1', to: 'buns:brush#b1', carrier: 'baking-sheet', capPerCarrier: 16, carriers: 4, capacity: 64, releaseTask: 'buns:transfer#b1', station: null })
  assert.equal(graph.buffers.find((b) => b.from === 'buns:place#b3').releaseTask, 'buns:transfer#b2')
  assert.equal(graph.buffers.find((b) => b.from === 'buns:brush#b1').carrier, 'baking-sheet', 'carrier inherited along the stream')
  const counterBuffer = graph.buffers.find((b) => b.from === 'buns:roll')
  assert.equal(counterBuffer.carrier, null)
  assert.equal(counterBuffer.station, 'counter')

  // maxlag from raise (hold 15 min) to split
  const raiseLag = edges(graph, (e) => e.from === 'buns:raise' && e.kind === 'maxlag')
  assert.equal(raiseLag.length, 1)
  assert.equal(raiseLag[0].to, 'buns:split')
  assert.equal(raiseLag[0].hold, 900)
  assert.equal(graph.tasks['buns:raise'].hold, 900)
  assert.equal(graph.tasks['buns:raise'].passive, 1200)
  assert.equal(graph.tasks['buns:raise'].completion.urgency, 'timed')
  assert.equal(graph.tasks['buns:split'].hold, Infinity)

  // sink
  const sink = graph.tasks['buns:sink']
  assert.equal(sink.kind, 'sink')
  assert.equal(sink.active, 0)
  assert.equal(sink.hold, 600)
  assert.deepEqual(sink.serveWindow, { earliest: SERVE, latest: SERVE + 300_000 })
  assert.deepEqual(sink.inputs.map((i) => i.ref), ['buns-on-rack'])
  const toSink = edges(graph, (e) => e.to === 'buns:sink')
  assert.deepEqual(toSink.filter((e) => e.kind === 'fs').map((e) => e.from).sort(), ['buns:transfer#b1', 'buns:transfer#b2'])
  assert.deepEqual(toSink.filter((e) => e.kind === 'maxlag').map((e) => e.hold), [600, 600])
  assert.deepEqual(graph.dishes, [{ id: 'buns', recipeId: 'buns', title: 'Buns', serveTime: SERVE, earlyTolerance: 0, lateTolerance: 300_000, temperature: 'hot', hold: 600, sinkId: 'buns:sink' }])

  // context, tools and appliance mapping
  assert.deepEqual(graph.tasks['buns:brush#b1'].context, { dish: 'buns', station: 'counter', tool: 'pastry-brush' })
  assert.deepEqual(graph.tasks['buns:brush#b1'].tools, [{ type: 'pastry-brush', qty: 1, mode: 'active', soil: 'wash' }])
  assert.deepEqual(graph.tasks['buns:line-sheets'].tools, [{ type: 'baking-sheet', qty: 4, mode: 'active', soil: 'none' }])
  assert.deepEqual(graph.tasks['buns:heat-milk'].appliance, { type: 'microwave', slots: 1, mode: null })
  assert.equal(graph.tasks['buns:measure-flour'].units, 1)
  assert.equal(graph.tasks['buns:measure-flour'].timeModel, 'sub-linear')

  // topological order covers every task and respects every edge
  assert.equal(graph.order.length, Object.keys(graph.tasks).length)
  const pos = new Map(graph.order.map((id, i) => [id, i]))
  for (const e of graph.edges) assert.ok(pos.get(e.from) < pos.get(e.to), `${e.from} before ${e.to}`)
  assert.equal(graph.order[graph.order.length - 1], 'buns:sink')
})

test('two dishes in one session: disjoint id prefixes, two sinks, cold hold', () => {
  const graph = buildGraph(session([bunsDish(), tiramisuDish()]), catalogue)
  const ids = Object.keys(graph.tasks)
  assert.ok(ids.every((id) => id.startsWith('buns:') || id.startsWith('tiramisu:')))
  assert.ok(ids.some((id) => id.startsWith('tiramisu:')))
  const sinks = Object.values(graph.tasks).filter((t) => t.kind === 'sink').map((t) => t.id).sort()
  assert.deepEqual(sinks, ['buns:sink', 'tiramisu:sink'])
  assert.deepEqual(graph.dishes.map((d) => [d.id, d.temperature, d.hold]), [['buns', 'hot', 600], ['tiramisu', 'cold', 1200]])
  assert.equal(graph.tasks['tiramisu:sink'].hold, 1200)
  assert.ok(graph.edges.every((e) => e.from.split(':')[0] === e.to.split(':')[0]), 'no cross-dish edges')
  assert.equal(graph.tasks['tiramisu:chill'].passive, 4 * 3600)
  assert.equal(graph.tasks['tiramisu:chill'].context.station, 'fridge')
  assert.equal(graph.tasks['tiramisu:soak'].units, 24)
  assert.ok(graph.edges.some((e) => e.from === 'tiramisu:soak' && e.to === 'tiramisu:layer' && e.kind === 'stream' && e.unitStream === 'ladyfinger'))
  assert.ok(graph.edges.some((e) => e.from === 'tiramisu:whip' && e.kind === 'maxlag' && e.hold === 1800))
  const pos = new Map(graph.order.map((id, i) => [id, i]))
  for (const e of graph.edges) assert.ok(pos.get(e.from) < pos.get(e.to))
  assert.deepEqual(graph.diagnostics, [])
})

test('inventory with 2 sheets → buffer capacity 32', () => {
  const inventory = mergeInventory(defaultInventory(), { tools: [{ type: 'baking-sheet', count: 2 }] })
  const graph = buildGraph(session([bunsDish()], inventory), catalogue)
  const buffer = graph.buffers.find((b) => b.from === 'buns:place#b1')
  assert.equal(buffer.carriers, 2)
  assert.equal(buffer.capacity, 32)
  assert.equal(batchesOf(graph, 'place').length, 4, 'batches follow the capacity per sheet, not the sheet count')
})

test('a recipe capacity in another unit than the inventory one is kept (cookies on a bun sheet)', () => {
  const inventory = mergeInventory(defaultInventory(), { tools: [{ type: 'baking-sheet', count: 4, capacity: { number: 12, unit: 'cookie' } }] })
  const graph = buildGraph(session([bunsDish()], inventory), catalogue)
  assert.equal(batchesOf(graph, 'place').length, 4, 'the recipe sheet holds 16 buns')
  assert.ok(!graph.diagnostics.some((d) => d.code === 'NO_CAPACITY'))
})

test('the recipe capacity wins over the inventory in the same unit (17 buns of this size fit a sheet)', () => {
  const recipe = bunsModel()
  const sheet = recipe.tools.find((t) => t.id === 'baking-sheet')
  sheet.capacity = { number: 20, unit: 'bun' }
  const graph = buildGraph(session([bunsDish({ recipe })]), catalogue)
  assert.equal(graph.buffers.find((b) => b.from === 'buns:place#b1').capPerCarrier, 20, 'not the inventory default of 16')
  // without a recipe capacity the kitchen default applies
  delete sheet.capacity
  const fallback = buildGraph(session([bunsDish({ recipe })]), catalogue)
  assert.equal(fallback.buffers.find((b) => b.from === 'buns:place#b1').capPerCarrier, 16)
})

test('policy hold applies when the recipe gives none; ambient is unbounded', () => {
  const recipe = bunsModel()
  recipe.serving = { temperature: 'hot', hold: null }
  const hot = buildGraph({ ...session([bunsDish({ recipe })]), policy: { hotHoldSeconds: 420 } }, catalogue)
  assert.equal(hot.tasks['buns:sink'].hold, 420)
  recipe.serving = null
  const ambient = buildGraph(session([bunsDish({ recipe })]), catalogue)
  assert.equal(ambient.tasks['buns:sink'].hold, Infinity)
  assert.deepEqual(ambient.edges.filter((e) => e.to === 'buns:sink' && e.kind === 'maxlag').map((e) => e.hold), [600, 600], 'the output hold still bounds the lag')
})

test('diagnostics: unknown tool, carrier never returned, cycle', () => {
  const recipe = bunsModel()
  recipe.tasks.find((t) => t.id === 'transfer').returnsTools = []
  recipe.tasks.find((t) => t.id === 'brush').tools.push({ ref: 'silicone-brush', reserved: false, amount: 1, soil: null, qty: 1 })
  const graph = buildGraph(session([bunsDish({ recipe })]), catalogue)
  const codes = graph.diagnostics.map((d) => d.code)
  assert.ok(codes.includes('TOOL_NOT_IN_INVENTORY'))
  assert.ok(codes.includes('CARRIER_NEVER_RETURNED'))
  assert.equal(graph.buffers.find((b) => b.from === 'buns:place#b1').releaseTask, null)
  assert.equal(graph.buffers.find((b) => b.from === 'buns:place#b1').carriers, 4)

  const cyclic = bunsModel()
  cyclic.tasks.find((t) => t.id === 'measure-milk').inputs.push({ ref: 'warm-milk', amount: null, text: null })
  assert.throws(() => buildGraph(session([bunsDish({ recipe: cyclic })]), catalogue), /Cycle .*measure-milk/)
  assert.throws(() => topologicalOrder({ tasks: { a: {}, b: {} }, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }), /Cycle in task graph: a → b → a/)
})

test('graphToDot renders every task and edge', () => {
  const graph = buildGraph(session([bunsDish(), tiramisuDish()]), catalogue)
  const dot = graphToDot(graph)
  assert.match(dot, /^digraph G \{/)
  assert.ok(dot.includes('"buns:bake.in#b1"'))
  assert.ok(dot.includes('"buns:roll" -> "buns:place#b1"'))
  assert.ok(dot.includes('baking-sheet ×4 (64)'))
  assert.ok(dot.trim().endsWith('}'))
})
