import { test } from 'node:test'
import assert from 'node:assert/strict'

import { simulate, createSimulation } from '../src/sim/index.js'
import { defaultInventory } from '../src/inventory.js'
import { cakeGraph } from './fixtures/cake.graph.js'

const SERVE = Date.UTC(2026, 9, 11, 18, 0, 0)

function cakeConfig(seed = 7) {
  const session = {
    id: 's',
    startTime: null,
    now: null,
    dishes: [{ id: 'cake', recipeId: 'cake', recipe: null, scale: 1, serveTime: SERVE }],
    participants: [
      { id: '0', name: 'Host' },
      { id: 'p2', name: 'Bea' },
    ],
    inventory: defaultInventory(),
    // zero search budgets: the plan is then a deterministic dispatch, independent of machine speed
    policy: { seed, searchBudgetMs: 0, replanBudgetMs: 0 },
  }
  return { session, catalogue: null, graph: cakeGraph(SERVE), seed, speedNoise: 0.25, lateStartProbability: 0.1 }
}

test('createSimulation advanced in small steps agrees with simulate (seed 7, cake fixture)', () => {
  const whole = simulate(cakeConfig())

  const sim = createSimulation(cakeConfig())
  assert.equal(sim.now, sim.startTime)
  assert.equal(sim.done, false)
  assert.equal(sim.tick, 5000)
  let steps = 0
  while (!sim.done) {
    const r = sim.step(1234) // deliberately not a multiple of the tick
    assert.ok(r.state.plan.lanes.length > 0)
    assert.ok(++steps < 100_000, 'the stepwise simulation terminates')
  }
  assert.deepEqual(sim.metrics, whole.metrics)
  assert.deepEqual(sim.log, whole.log)
  // the plan itself: lanes and dishes (plan.report carries wall-clock search statistics, computedAt is Date.now())
  assert.deepEqual(sim.result().finalPlan.lanes, whole.finalPlan.lanes)
  assert.deepEqual(sim.result().finalPlan.dishes, whole.finalPlan.dishes)
  assert.equal(sim.result().events.length, whole.events.length)
  assert.equal(sim.entries.length, sim.log.length)
  assert.ok(sim.entries.every((e, i) => sim.log[i].endsWith(e.text) && Number.isFinite(e.at)))
  assert.ok(sim.metrics.events > 1 && sim.metrics.replans >= 1)

  // once done, further steps are no-ops
  const again = sim.step(60_000)
  assert.equal(again.done, true)
  assert.deepEqual(again.metrics, whole.metrics)

  // the same seed yields the same run; run() equals the stepped run too
  assert.deepEqual(createSimulation(cakeConfig()).run().metrics, whole.metrics)
  assert.notDeepEqual(simulate(cakeConfig(8)).log, whole.log)
})
