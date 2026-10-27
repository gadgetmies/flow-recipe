// Regression tests: serving hold on a final output without its own hold, one carrier over several oven rounds,
// returned tools releasing their binding, appointment follow-ups that slipped past their slot, measuring times.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMParser } from '@xmldom/xmldom'
import { planSession, parseRecipe, loadCatalogue, buildGraph, plan, defaultInventory, amountKind, durations } from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(here, '../../server/src/recipes')
const read = (id) => fs.readFileSync(path.join(dir, `${id}.xml`), 'utf8')
const operationsXml = read('operations')
const catalogue = loadCatalogue(operationsXml, { DOMParser })
const SERVE = Date.UTC(2026, 9, 12, 18, 0, 0)
const PITA = fs.readFileSync(path.join(here, 'fixtures', 'pita-stone.xml'), 'utf8')
const unsound = (p) => p.diagnostics.filter((d) => ['INVARIANT', 'DEADLOCK', 'INCOMPLETE'].includes(d.code))

function session(recipes, n, { serve = SERVE, policy = {} } = {}) {
  return {
    id: 't', startTime: null, now: null,
    dishes: Object.entries(recipes).map(([id, recipe]) => ({ id, recipeId: id, recipe, scale: 1, serveTime: serve, lateTolerance: 300000 })),
    participants: ['Ada', 'Bea', 'Cal'].slice(0, n).map((name) => ({ id: name, name })),
    inventory: defaultInventory(),
    policy: { searchIterations: 0, ...policy },
  }
}
const model = (xml) => parseRecipe(xml, { DOMParser })
const items = (p) => p.lanes.flatMap((l) => l.items.map((it) => ({ ...it, lane: l.participantId })))

// tomato soup as an author following only the serving element would write it: hold on <serving>, none on the output
const SOUP_NO_FINAL_HOLD = read('tomato-soup').replace(/<output id="tomato-soup-in-bowl"([^>]*?) hold="10" hold-unit="minutes"/, '<output id="tomato-soup-in-bowl"$1')

test('the serving hold bounds a final output that has no hold of its own', () => {
  assert.ok(!/id="tomato-soup-in-bowl"[^>]*hold=/.test(SOUP_NO_FINAL_HOLD), 'fixture lost its output hold')
  const s = session({ soup: model(SOUP_NO_FINAL_HOLD), tiramisu: model(read('tiramisu')) }, 2)
  const graph = buildGraph(s, catalogue)
  const finalTask = Object.values(graph.tasks).find((t) => t.dishId === 'soup' && t.outputs.some((o) => o.id === 'tomato-soup-in-bowl'))
  assert.equal(finalTask.hold, 600, 'the producer of the final output inherits the 10 min serving hold')
  const p = plan(graph, s)
  assert.deepEqual(unsound(p), [])
  const soupEnd = Math.max(...items(p).filter((it) => it.dishId === 'soup' && it.kind !== 'cleaning').map((it) => it.passiveUntil || it.end))
  assert.ok(soupEnd >= SERVE - 600_000 - 60_000, `soup finished ${(SERVE - soupEnd) / 60000} min before serving`)
  assert.ok(!p.diagnostics.some((d) => d.code === 'EARLY'), JSON.stringify(p.diagnostics))
})

test('a dish that is ready longer than its hold before serving gets an EARLY diagnostic', () => {
  const s = session({ soup: model(SOUP_NO_FINAL_HOLD) }, 1, { serve: SERVE })
  const graph = buildGraph(s, catalogue)
  // drop the release time (as before the fix) and let the last steps float an hour early
  for (const t of Object.values(graph.tasks)) if (t.dishId === 'soup' && t.kind !== 'sink') t.hold = Infinity
  const p = plan(graph, s, { budgetMs: 0 })
  const early = p.diagnostics.find((d) => d.code === 'EARLY')
  const soupEnd = Math.max(...items(p).filter((it) => it.dishId === 'soup' && it.kind !== 'cleaning').map((it) => it.passiveUntil || it.end))
  assert.ok(soupEnd < SERVE - 600_000 - 60_000, `the scenario should finish early: ${(SERVE - soupEnd) / 60000} min`)
  assert.ok(early, `ready ${(SERVE - soupEnd) / 60000} min early without a diagnostic`)
  assert.match(early.message, /min before serving/)
})

test('one baking stone bakes several oven rounds: one carrier per round, returned round by round', () => {
  const recipe = model(PITA)
  const s = session({ pita: recipe }, 1)
  const graph = buildGraph(s, catalogue)
  const rounds = Object.values(graph.tasks).filter((t) => /^pita:bake-pitas\.in#b\d$/.test(t.id))
  assert.equal(rounds.length, 4, 'one stone holding 2 pitas → 4 rounds for 8 pitas')
  assert.ok(rounds.every((t) => t.units === 2))
  const wraps = Object.values(graph.tasks).filter((t) => /^pita:wrap-pitas#b\d$/.test(t.id))
  assert.equal(wraps.length, 4, 'the task that returns the stone works round by round')
  for (const k of [1, 2, 3, 4]) {
    assert.ok(graph.edges.some((e) => e.from === `pita:bake-pitas.out#b${k}` && e.to === `pita:wrap-pitas#b${k}`), `round ${k} feeds its own wrap`)
  }
  for (const n of [1, 2, 3]) {
    const p = plan(buildGraph(session({ pita: recipe }, n), catalogue), session({ pita: recipe }, n))
    assert.deepEqual(unsound(p), [], `${n} cook(s)`)
    assert.ok(p.dishes[0].plannedServe !== null, `${n} cook(s): planned`)
    // the stone is never in two rounds at once
    const bakes = items(p).filter((it) => /bake-pitas\.in#/.test(it.taskId) && it.kind === 'work').sort((a, b) => a.start - b.start)
    for (let i = 1; i < bakes.length; i++) assert.ok(bakes[i].start >= bakes[i - 1].passiveUntil, `${n} cook(s): round ${i + 1} starts after round ${i} is out`)
  }
})

test('the stone not returned is still a deadlock (the check turns it into an error)', () => {
  const xml = PITA.replace('final="true">warm pita bread</output><tool ref="baking-stone"/>', 'final="true">warm pita bread</output>')
  assert.notEqual(xml, PITA)
  const s = session({ pita: model(xml) }, 1)
  const p = plan(buildGraph(s, catalogue), s, { budgetMs: 0 })
  assert.ok(p.diagnostics.some((d) => d.code === 'DEADLOCK' && /no free baking-stone/.test(d.message)), JSON.stringify(p.diagnostics))
})

test('a returned bowl drops the binding of the food it held (bday cake, 1 cook, no search)', () => {
  const s = session({ 'bday-cake': model(read('bday-cake')) }, 1, { serve: SERVE })
  const p = plan(buildGraph(s, catalogue), s, { budgetMs: 0 })
  assert.deepEqual(unsound(p), [])
  assert.ok(p.dishes[0].plannedServe !== null)
})

test('an appointment follow-up that slipped never overlaps a resumed task of its holder', () => {
  // bday cake planned as soon as possible with one cook: turn-out#b1 is split around turn-out#b2's slot
  const recipe = model(read('bday-cake'))
  for (const minutes of [40, 60, 90, 240]) {
    const s = session({ 'bday-cake': recipe }, 1, { serve: SERVE + minutes * 60_000 })
    s.now = SERVE
    const p = plan(buildGraph(s, catalogue), s, { budgetMs: 0 })
    assert.ok(!p.diagnostics.some((d) => d.code === 'INVARIANT'), `${minutes} min: ${JSON.stringify(unsound(p))}`)
  }
})

test('measuring time depends on the kind of amount', () => {
  assert.equal(amountKind({ number: 1, unit: 'tsp' }), 'spoon')
  assert.equal(amountKind({ number: 0.5, unit: 'tbsp' }), 'spoon')
  assert.equal(amountKind({ number: 1, unit: 'pinch' }), 'spoon')
  assert.equal(amountKind({ number: 10, unit: 'ml' }), 'spoon')
  assert.equal(amountKind({ number: 250, unit: 'ml' }), 'pour')
  assert.equal(amountKind({ number: 3, unit: 'dl' }), 'pour')
  assert.equal(amountKind({ number: 125, unit: 'g' }), 'weigh')
  assert.equal(amountKind({ number: 3, unit: 'pieces' }), 'count')
  assert.equal(amountKind({ number: 2, unit: 'cloves' }), 'count')
  assert.equal(amountKind(null), null)
  const op = catalogue.measure
  const secs = (number, unit) => durations(op, { options: { amount: { number, unit } } }, 1).active
  assert.equal(secs(1, 'tsp'), 20)
  assert.equal(secs(2, 'pieces'), 15)
  assert.equal(secs(360, 'g'), 40)
  assert.equal(secs(4, 'dl'), 30)
  assert.equal(secs(1, 'handful'), op.time.perUnit)
  // a spice rub of seven spoons is a few minutes of measuring, not seven
  const recipes = { negroni: read('negroni') }
  const { graph } = planSession({ recipes, operationsXml, session: { id: 's', dishes: [{ recipeId: 'negroni', serveTime: SERVE }], participants: [{ id: '0', name: 'A' }], policy: { searchIterations: 0 } }, DOMParser })
  for (const t of Object.values(graph.tasks)) if (t.operation === 'measure') assert.ok(t.active <= 45, `${t.id}: ${t.active} s`)
})
