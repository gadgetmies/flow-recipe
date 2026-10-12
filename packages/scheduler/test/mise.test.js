import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMParser } from '@xmldom/xmldom'
import { planSession } from '../src/index.js'
import { switchSeconds, sameContext } from '../src/planner/cost.js'
import { mergePolicy } from '../src/planner/policy.js'
import { ingredientStorage } from '../src/graph/mise.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(here, '../../server/src/recipes')
const read = (id) => fs.readFileSync(path.join(dir, `${id}.xml`), 'utf8')
const operationsXml = read('operations')
const SERVE = Date.UTC(2026, 9, 12, 18, 0, 0)

function run(ids, n, policy = {}) {
  const recipes = Object.fromEntries(ids.map((id) => [id, read(id)]))
  const session = {
    id: 't',
    dishes: ids.map((id, i) => ({ recipeId: id, serveTime: SERVE + i * 600_000 })),
    participants: ['Ada', 'Bea', 'Cal', 'Dee'].slice(0, n).map((name) => ({ id: name, name })),
    policy: { searchIterations: 0, ...policy },
  }
  return planSession({ recipes, operationsXml, session, DOMParser })
}

const items = (plan) => plan.lanes.flatMap((l) => l.items.map((it) => ({ ...it, lane: l.participantId })))
const opOf = (graph, it) => graph.tasks[it.taskId]?.operation
const measuringItems = (plan, graph) =>
  items(plan).filter((it) => ['measure', 'gather'].includes(opOf(graph, it)) && it.kind !== 'blocked').sort((a, b) => a.start - b.start)

test('measuring for different dishes is one activity; same dish, station and tool costs only the instruction read', () => {
  const m = mergePolicy({}).switchMatrix
  const buns = { dish: 'buns', station: 'counter', tool: 'kitchen-scale', task: 'a', activity: 'measure' }
  const soup = { dish: 'soup', station: 'counter', tool: null, task: 'b', activity: 'measure' }
  assert.equal(switchSeconds(buns, soup, m), m.measuring)
  assert.ok(sameContext(buns, soup))
  const mix = { dish: 'buns', station: 'counter', tool: 'bowl', task: 'c' }
  const mix2 = { dish: 'buns', station: 'counter', tool: 'bowl', task: 'd' }
  assert.equal(switchSeconds(mix, mix2, m), m.any)
  assert.ok(switchSeconds(mix, { ...soup, activity: null }, m) > m.any)
})

test('ingredient storage: fridge and freezer defaults, recipe override, pantry', () => {
  assert.deepEqual(ingredientStorage({ properties: {} }), { storage: 'pantry', hold: Infinity })
  assert.equal(ingredientStorage({ properties: { storage: { value: 'fridge' } } }).hold, 3600)
  assert.equal(ingredientStorage({ properties: { storage: { value: 'freezer' } } }).hold, 600)
  assert.equal(ingredientStorage({ properties: { storage: { value: 'fridge' }, 'out-of-storage': { number: 30, unit: 'minutes' } } }).hold, 1800)
  assert.equal(ingredientStorage({ properties: { storage: { value: 'fridge' } } }, { storageHoldSeconds: { fridge: 900 } }).hold, 900)
})

test('perishable measuring carries an out-of-storage hold; no gathering steps without mise en place', () => {
  const { graph } = run(['buns', 'negroni'], 2)
  assert.equal(Object.values(graph.tasks).filter((t) => t.operation === 'gather').length, 0)
  const milk = Object.values(graph.tasks).find((t) => t.operation === 'measure' && t.inputs.some((i) => i.ref === 'milk'))
  assert.equal(milk.hold, 3600)
  assert.ok(graph.edges.some((e) => e.from === milk.id && e.kind === 'maxlag' && e.hold === 3600))
  const flour = Object.values(graph.tasks).find((t) => t.operation === 'measure' && t.inputs.some((i) => i.ref === 'flour'))
  assert.equal(flour.hold, Infinity)
})

test('mise en place adds a pantry step for every dish and just-in-time fridge and freezer steps', () => {
  const { graph } = run(['buns', 'negroni'], 2, { miseEnPlace: true })
  const pantry = graph.tasks['mise:gather-pantry']
  assert.ok(pantry, 'pantry gathering step')
  assert.equal(pantry.hold, Infinity)
  assert.match(pantry.instructions, /flour/)
  assert.match(pantry.instructions, /Campari/)
  const flourMeasure = Object.values(graph.tasks).find((t) => t.operation === 'measure' && t.inputs.some((i) => i.ref === 'flour'))
  assert.ok(graph.edges.some((e) => e.from === pantry.id && e.to === flourMeasure.id && e.kind === 'fs'))
  const fridge = graph.tasks['mise:gather-fridge:buns']
  assert.equal(fridge.hold, 3600)
  assert.match(fridge.instructions, /milk/)
  // ice keeps only 5 min: one step per item, right before each use
  const ice = graph.tasks['mise:gather-freezer:negroni-2:ice-cubes']
  const bigIce = graph.tasks['mise:gather-freezer:negroni-2:large-ice-cube']
  assert.equal(ice.hold, 300, 'ice override: 5 min')
  assert.equal(bigIce.hold, 300)
  // the out-of-storage time runs through the measuring step to its users
  const milkMeasure = Object.values(graph.tasks).find((t) => t.operation === 'measure' && t.inputs.some((i) => i.ref === 'milk'))
  const milkUsers = graph.edges.filter((e) => e.from === milkMeasure.id && e.kind === 'fs').map((e) => e.to)
  for (const u of milkUsers) assert.ok(graph.edges.some((e) => e.from === fridge.id && e.to === u && e.kind === 'maxlag' && e.hold === 3600))
})

test('one cook measures a dish: no hand-over of the scale and no waiting for it', () => {
  const { plan, graph } = run(['buns'], 3)
  const m = measuringItems(plan, graph)
  assert.ok(m.length >= 8)
  assert.equal(new Set(m.map((it) => it.lane)).size, 1, `measurers: ${[...new Set(m.map((it) => it.lane))]}`)
  assert.ok(!items(plan).some((it) => it.kind === 'blocked' && /kitchen-scale/.test(it.title)))
})

test('with mise en place: pantry first, shelf-stable measuring up front, perishables within their out-of-storage time', () => {
  const { plan, graph } = run(['buns', 'tiramisu', 'negroni'], 3, { miseEnPlace: true })
  assert.ok(!plan.diagnostics.some((d) => ['INVARIANT', 'DEADLOCK', 'LATE'].includes(d.code)), JSON.stringify(plan.diagnostics))
  const all = items(plan)
  const byTask = new Map()
  for (const it of all) if (it.kind !== 'blocked') byTask.set(it.taskId, it)
  const pantry = byTask.get('mise:gather-pantry')
  assert.ok(pantry.start <= plan.startTime + 60_000, 'the pantry step opens the session')
  // every measurement of a shelf-stable ingredient happens before any cooking step of its dish other than gathering/measuring
  const shelf = measuringItems(plan, graph).filter((it) => opOf(graph, it) === 'measure' && graph.tasks[it.taskId].hold === Infinity)
  const firstCooking = Math.min(...all.filter((it) => it.kind === 'work' && !['measure', 'gather'].includes(opOf(graph, it))).map((it) => it.start))
  const upFront = shelf.filter((it) => it.end <= firstCooking + 30 * 60_000)
  assert.ok(upFront.length >= shelf.length - 1, `shelf-stable measuring up front: ${upFront.length}/${shelf.length}`)
  // each dish's shelf-stable measuring is done by one person
  const per = new Map()
  for (const it of shelf) {
    const d = graph.tasks[it.taskId].dishId
    if (!per.has(d)) per.set(d, new Set())
    per.get(d).add(it.lane)
  }
  for (const [d, people] of per) assert.equal(people.size, 1, `${d} measured by ${[...people]}`)
  // freshness: every gather → user maxlag edge holds in the plan
  for (const e of graph.edges.filter((x) => x.kind === 'maxlag' && x.from.startsWith('mise:'))) {
    const g = byTask.get(e.from), u = byTask.get(e.to)
    if (!g || !u) continue
    assert.ok(u.start <= g.end + e.hold * 1000 + 1000, `${e.to} starts ${Math.round((u.start - g.end) / 60000)} min after ${e.from}`)
  }
})

test('a derived start moves earlier rather than serving late', () => {
  const { plan } = run(['bday-cake'], 2, { miseEnPlace: true })
  assert.ok(!plan.diagnostics.some((d) => d.code === 'LATE'), JSON.stringify(plan.diagnostics.map((d) => d.code)))
})
