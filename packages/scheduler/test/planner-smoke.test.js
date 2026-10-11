import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plan } from '../src/planner/index.js'
import { defaultInventory } from '../src/inventory.js'

import { cakeGraph as graphFixture } from './fixtures/cake.graph.js'

test('plans a small cake graph for two participants with an oven appointment', () => {
  const serve = Date.UTC(2026, 9, 11, 18, 0, 0)
  const graph = graphFixture(serve)
  const session = {
    id: 's', startTime: null, now: null,
    dishes: [{ id: 'cake', recipeId: 'cake', recipe: null, scale: 1, serveTime: serve }],
    participants: [{ id: '0', name: 'Host' }, { id: 'p2', name: 'Bea' }],
    inventory: defaultInventory(), policy: {},
  }
  const p = plan(graph, session)
  assert.equal(p.mode, 'offline')
  assert.equal(p.lanes.length, 2)
  const all = p.lanes.flatMap((l) => l.items)
  const bake = all.find((it) => it.taskId === 'cake:bake' && it.kind === 'work')
  const takeOut = all.find((it) => it.taskId === 'cake:take-out')
  assert.ok(bake, 'bake placed')
  assert.ok(takeOut, 'take-out placed')
  assert.equal(takeOut.kind, 'appointment')
  assert.equal(takeOut.start, bake.passiveUntil)
  assert.ok(bake.timer && bake.timer.firesAt === bake.passiveUntil, 'bake carries a timer')
  const cakeDish = p.dishes[0]
  assert.ok(cakeDish.plannedServe <= serve + 300000, `served in window: ${new Date(cakeDish.plannedServe).toISOString()}`)
  assert.ok(!p.diagnostics.some((d) => d.code === 'INVARIANT' || d.code === 'DEADLOCK'), JSON.stringify(p.diagnostics))
  // start time is derived and before serve
  assert.ok(p.startTime < serve)
  // every task present
  for (const id of Object.keys(graph.tasks)) if (graph.tasks[id].kind !== 'sink') assert.ok(all.some((it) => it.taskId === id), `item for ${id}`)
})

test('bowl shortage inserts a cleaning task', () => {
  const serve = Date.UTC(2026, 9, 11, 18, 0, 0)
  const graph = graphFixture(serve)
  const inv = defaultInventory()
  inv.tools.find((t) => t.type === 'bowl').count = 1
  const session = { id: 's', dishes: [{ id: 'cake', recipeId: 'cake', recipe: null, scale: 1, serveTime: serve }], participants: [{ id: '0', name: 'Host' }], inventory: inv, policy: {} }
  const p = plan(graph, session)
  const all = p.lanes.flatMap((l) => l.items)
  assert.ok(all.some((it) => it.kind === 'cleaning'), 'cleaning item present: ' + all.map((i) => i.uuid).join(','))
  assert.ok(!p.diagnostics.some((d) => d.code === 'DEADLOCK'), JSON.stringify(p.diagnostics))
})
