import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'

import { loadCatalogue, durations, instructionText } from '../src/catalogue/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const xmlPath = resolve(here, '../../server/src/recipes/operations.xml')
const catalogue = loadCatalogue(readFileSync(xmlPath, 'utf8'), { DOMParser })

// Every operation defined in packages/client/src/operations.js, plus the scheduler's own clean and serve.
const CLIENT_OPERATIONS = [
  'measure', 'heat', 'preheat-oven', 'crumble', 'mix', 'incorporate', 'mix-in-steps', 'wait', 'raise', 'batch',
  'fill', 'pour', 'strain', 'express', 'spherify', 'separate', 'grease', 'stir', 'muddle', 'peel', 'soften', 'ball',
  'enjoy', 'decorate', 'cream', 'stack', 'bake-in-microwave', 'place', 'split', 'bake-in-oven', 'put-into-oven',
  'take-out-of-oven', 'brush', 'sprinkle', 'dust', 'slice', 'grate', 'spread', 'transfer', 'beat', 'place-on-sheet',
  'chill', 'spoon', 'cover', 'level', 'add-on-top', 'press', 'line', 'melt', 'fold', 'boil', 'soak', 'whip',
]

test('catalogue has every client operation plus clean and serve', () => {
  for (const name of [...CLIENT_OPERATIONS, 'clean', 'serve']) {
    assert.ok(catalogue[name], `missing operation ${name}`)
    assert.equal(catalogue[name].name, name)
    assert.ok(catalogue[name].title.length > 0)
  }
  assert.equal(catalogue.bake, undefined, 'there is no bake operation')
})

test('parsed attributes', () => {
  const spherify = catalogue.spherify
  assert.equal(spherify.title, 'Roll into balls')
  assert.deepEqual(spherify.time, { model: 'per-unit', active: 0, perUnit: 15, passive: 0, passiveFrom: null, byAmount: null })
  assert.deepEqual(catalogue.measure.time.byAmount, { spoon: 20, count: 15, weigh: 40, pour: 30 })
  assert.equal(spherify.divisible, 'units')
  assert.equal(spherify.minChunk, 180)
  assert.equal(spherify.preemptible, 'units')

  const oven = catalogue['put-into-oven']
  assert.deepEqual(oven.completion, { urgency: 'critical', early: 0, late: 60, duration: 30 })
  assert.equal(oven.attention, 'unattended')
  assert.equal(oven.station, 'oven')
  assert.deepEqual(oven.requires, ['oven'])
  assert.equal(oven.soil, 'none')
  assert.equal(oven.preemptible, 'never')
  assert.equal(oven.time.passiveFrom, 'duration')
  assert.equal(oven.options.duration.required, true)
  assert.equal(oven.options.duration.defaultUnit, 'minutes')

  const measure = catalogue.measure
  assert.equal(measure.time.model, 'sub-linear')
  assert.equal(measure.time.perUnit, 45)
  assert.equal(measure.tedium, 1.2)
  assert.equal(measure.minInputs, 1)
  assert.equal(measure.maxOutputs, 1)
  assert.equal(measure.options.amount.type, 'numeric')

  const boil = catalogue.boil
  assert.equal(boil.attention, 'monitored')
  assert.equal(boil.checkInterval, 120)
  assert.equal(boil.checkDuration, 10)
  assert.equal(boil.station, 'hob')

  assert.equal(catalogue.decorate.divisible, 'team')
  assert.equal(catalogue.decorate.maxPeople, 2)
  assert.equal(catalogue.decorate.speedup, 1.6)
  assert.equal(catalogue.whip.preemptible, 'anywhere')
  assert.equal(catalogue.whip.resumeCost, 20)
  assert.equal(catalogue['bake-in-oven'].expand, 'bake-in-oven')
  assert.equal(catalogue.split.expand, 'split')
  assert.equal(catalogue.mix.checkInterval, null)
  assert.equal(catalogue.mix.expand, null)
  assert.equal(catalogue.clean.station, 'sink')
  assert.equal(catalogue.clean.tedium, 1.5)
  assert.equal(catalogue.clean.minOutputs, 0)
  assert.equal(catalogue.serve.time.active, 0)
  assert.equal(catalogue.chill.station, 'fridge')
  assert.equal(catalogue.wait.maxInputs, 0)
  assert.equal(catalogue.mix.maxInputs, null)
})

// Operations added for recipes imported from the web (RECIPE.spec.md lists them for the LLM).
const WEB_OPERATIONS = [
  'chop', 'dice', 'mince', 'cut', 'zest', 'juice', 'crush', 'sift', 'rinse', 'drain', 'season', 'knead', 'blend',
  'mash', 'toss', 'fry', 'saute', 'sear', 'toast', 'simmer', 'cook', 'steam', 'roast', 'rest', 'cool', 'marinate',
  'freeze', 'roll-out', 'shape', 'scoop', 'pipe', 'glaze', 'assemble', 'garnish', 'plate',
]

test('web recipe operations', () => {
  for (const name of WEB_OPERATIONS) {
    const op = catalogue[name]
    assert.ok(op, `missing operation ${name}`)
    assert.ok(op.title.length > 0)
    if (op.options.duration) {
      assert.equal(op.options.duration.required, true, `${name} needs its duration`)
      assert.equal(op.time.passiveFrom, 'duration')
      assert.equal(op.time.passive, 0, `${name}: the passive part comes from the duration option only`)
    }
  }
  for (const name of ['chop', 'dice', 'mince', 'cut']) assert.deepEqual(catalogue[name].requires, ['knife'])
  for (const name of ['fry', 'saute', 'sear', 'toast', 'simmer', 'cook']) {
    assert.equal(catalogue[name].attention, 'monitored')
    assert.equal(catalogue[name].station, 'hob')
    assert.deepEqual(catalogue[name].requires, ['hot-pan'])
  }
  assert.equal(catalogue.fry.completion.urgency, 'critical')
  assert.equal(catalogue.simmer.checkInterval, 600, "a stir every 10 min (review 1 P3-8: 20 checks for one stew)")
  assert.equal(catalogue.roast.expand, 'bake-in-oven')
  assert.deepEqual(catalogue.roast.requires, ['oven'])
  assert.equal(catalogue.rinse.station, 'sink')
  assert.equal(catalogue.marinate.station, 'fridge')
  assert.equal(catalogue.shape.divisible, 'units')
  assert.equal(catalogue.scoop.time.model, 'per-unit')

  const fry = { operation: 'fry', options: { duration: { number: 4, unit: 'minutes' } } }
  assert.deepEqual(durations(catalogue.fry, fry, 4), { active: 30 + 10 * 4, passive: 240 })
  const rest = { operation: 'rest', options: { duration: { number: 10 } } }
  assert.deepEqual(durations(catalogue.rest, rest, 1), { active: 0, passive: 600 })
})

test('loader defaults', () => {
  const xml = `<operations>
    <operation name="a"><title>A</title><timeline active="10"/></operation>
    <operation name="b"><title>B</title><timeline model="per-unit" active="0" per-unit="4" passive="30"/></operation>
    <operation name="c" attention="monitored"><title>C</title><timeline active="5" passive-from="duration"/></operation>
  </operations>`
  const cat = loadCatalogue(xml, { DOMParser })
  assert.equal(cat.a.attention, 'attended')
  assert.equal(cat.a.divisible, 'none')
  assert.equal(cat.a.preemptible, 'never')
  assert.deepEqual(cat.a.completion, { urgency: 'relaxed', early: 0, late: 300, duration: 30 })
  assert.equal(cat.a.soil, 'rinse')
  assert.equal(cat.a.station, 'counter')
  assert.equal(cat.a.tedium, 1)
  assert.equal(cat.a.minChunk, 180)
  assert.equal(cat.a.resumeCost, 20)
  assert.deepEqual(cat.a.requires, [])
  assert.deepEqual(cat.a.options, {})
  assert.equal(cat.b.attention, 'unattended')
  assert.equal(cat.b.divisible, 'units')
  assert.equal(cat.b.preemptible, 'units')
  assert.equal(cat.c.attention, 'monitored')
  assert.equal(cat.c.checkInterval, 120)
  assert.equal(cat.c.checkDuration, 10)
})

test('durations: time models', () => {
  const task = { operation: 'measure', options: { amount: { number: 500, unit: 'grams' } } }
  // measuring by the kind of amount: weighing 40 s (sub-linear in units)
  assert.deepEqual(durations(catalogue.measure, task, 1), { active: 40, passive: 0 })
  assert.deepEqual(durations(catalogue.measure, task, 4), { active: 80, passive: 0 })
  const spoon = { operation: 'measure', options: { amount: { number: 1, unit: 'tsp' } } }
  assert.deepEqual(durations(catalogue.measure, spoon, 1), { active: 20, passive: 0 })
  assert.deepEqual(durations(catalogue.measure, { operation: 'measure', options: {} }, 1), { active: 45, passive: 0 })
  assert.deepEqual(durations(catalogue.spherify, { operation: 'spherify', options: {} }, 64), { active: 960, passive: 0 })
  assert.deepEqual(durations(catalogue.split, { operation: 'split', options: {} }, 64), { active: 30 + 3 * 64, passive: 0 })
  assert.deepEqual(durations(catalogue.enjoy, { operation: 'enjoy', options: {} }, 10), { active: 180, passive: 0 })
  assert.deepEqual(durations('boil', { operation: 'boil', options: {} }, 1, catalogue), { active: 30, passive: 200 })
})

test('durations: passive from options', () => {
  const chill = { operation: 'chill', options: { duration: { number: 4, unit: 'hours' } } }
  assert.deepEqual(durations(catalogue.chill, chill, 1), { active: 30, passive: 4 * 3600 })
  const chillDefaultUnit = { operation: 'chill', options: { duration: { number: 2 } } }
  assert.equal(durations(catalogue.chill, chillDefaultUnit, 1).passive, 2 * 3600)

  const heat = { operation: 'heat', options: { temperature: { number: 30, unit: 'celsius' } } }
  assert.deepEqual(durations(catalogue.heat, heat, 1), { active: 30, passive: 100 })
  const heatF = { operation: 'heat', options: { temperature: { number: 212, unit: 'fahrenheit' } } }
  assert.equal(durations(catalogue.heat, heatF, 1).passive, 450)
  const heatByDuration = { operation: 'heat', options: { duration: { number: 2, unit: 'minutes' } } }
  assert.equal(durations(catalogue.heat, heatByDuration, 1).passive, 120)

  const preheat = { operation: 'preheat-oven', options: { temperature: { number: 250, unit: 'celcius' } } }
  assert.deepEqual(durations(catalogue['preheat-oven'], preheat, 1), { active: 30, passive: 1840 })

  const bake = { operation: 'put-into-oven', options: { duration: { number: 15, unit: 'minutes' } } }
  assert.deepEqual(durations(catalogue['put-into-oven'], bake, 2), { active: 30, passive: 900 })

  const soakNoOption = { operation: 'soak', options: {} }
  assert.equal(durations(catalogue.soak, soakNoOption, 1).passive, 120)
  const soak = { operation: 'soak', options: { duration: { number: 5, unit: 'seconds' } } }
  assert.equal(durations(catalogue.soak, soak, 1).passive, 5)
})

// Hand-written RecipeModel fixture (README §2).
const recipe = {
  id: 'fixture',
  title: 'Fixture',
  ref: null,
  serving: null,
  ingredients: [
    { id: 'flour', name: 'white bread flour', properties: {} },
    { id: 'sugar', name: 'sugar', properties: {} },
    { id: 'egg', name: 'egg', properties: {} },
    { id: 'ice-cubes', name: 'ice cubes', properties: {} },
  ],
  tools: [
    { id: 'bowl', name: 'bowl', type: 'bowl', capacity: null, properties: {} },
    { id: 'whisk', name: 'whisk', type: 'whisk', capacity: null, properties: {} },
    { id: 'mixing-glass', name: 'mixing glass', type: 'mixing-glass', capacity: null, properties: {} },
    { id: 'kitchen-scale', name: 'kitchen scale', type: 'kitchen-scale', capacity: null, properties: {} },
  ],
  tasks: [],
}
recipe.tasks = [
  {
    id: 'measure-flour',
    operation: 'measure',
    options: { amount: { number: 900, unit: 'grams' } },
    inputs: [{ ref: 'flour', amount: null, text: null }],
    tools: [
      { ref: 'bowl', reserved: true, amount: 1, soil: null, qty: 1 },
      { ref: 'kitchen-scale', reserved: false, amount: 1, soil: null, qty: 1 },
    ],
    outputs: [{ id: 'flour-for-dough', name: 'flour', amount: null, unit: null, hold: null, volume: null, final: false }],
    returnsTools: [],
    instructions: null,
    requires: [],
  },
  {
    id: 'measure-sugar',
    operation: 'measure',
    options: { amount: { number: 2, unit: 'deciliters' } },
    inputs: [{ ref: 'sugar', amount: null, text: null }],
    tools: [],
    outputs: [{ id: 'sugar-for-dough', name: 'sugar', amount: null, unit: null, hold: null, volume: null, final: false }],
    returnsTools: [],
    instructions: null,
    requires: [],
  },
  {
    id: 'mix-dough',
    operation: 'mix',
    options: {},
    inputs: [
      { ref: 'flour-for-dough', amount: null, text: null },
      { ref: 'sugar-for-dough', amount: null, text: null },
      { ref: 'egg', amount: 2, text: null },
    ],
    tools: [
      { ref: 'whisk', reserved: false, amount: 1, soil: null, qty: 1 },
      { ref: 'bowl', reserved: true, amount: 1, soil: null, qty: 1 },
    ],
    outputs: [{ id: 'dough', name: 'dough', amount: null, unit: null, hold: null, volume: null, final: false }],
    returnsTools: [],
    instructions: null,
    requires: [],
  },
  {
    id: 'fill-glass',
    operation: 'fill',
    options: {},
    inputs: [{ ref: 'ice-cubes', amount: null, text: null }],
    tools: [{ ref: 'mixing-glass', reserved: false, amount: 1, soil: null, qty: 1 }],
    outputs: [{ id: 'filled-glass', name: 'mixing glass with ice', amount: null, unit: null, hold: null, volume: null, final: false }],
    returnsTools: [],
    instructions: [
      { text: 'Fill the' },
      { tool: 'mixing-glass' },
      { text: 'with' },
      { input: 'ice-cubes', amount: 4 },
      { text: 'and chill for' },
      { option: 'duration' },
      { text: '.' },
    ],
    requires: [],
  },
  {
    id: 'chill-dough',
    operation: 'chill',
    options: { duration: { number: 1, unit: 'hours' } },
    inputs: [{ ref: 'dough', amount: null, text: null }],
    tools: [],
    outputs: [{ id: 'chilled-dough', name: 'chilled dough', amount: null, unit: null, hold: null, volume: null, final: true }],
    returnsTools: [],
    instructions: null,
    requires: [],
  },
]
recipe.tasks[3].options = { duration: { number: 30, unit: 'seconds' } }

const byId = (id) => recipe.tasks.find((t) => t.id === id)

test('instruction text from templates', () => {
  assert.equal(instructionText(byId('measure-flour'), recipe, catalogue), 'Measure 900 g white bread flour into bowl using kitchen scale')
  assert.equal(instructionText(byId('measure-sugar'), recipe, catalogue), 'Measure 2 dl sugar')
  assert.equal(instructionText(byId('mix-dough'), recipe, catalogue), 'Mix flour, sugar & 2 egg with whisk in bowl')
  assert.equal(instructionText(byId('chill-dough'), recipe, catalogue), 'Chill dough for 1 hour')
  assert.equal(instructionText(byId('chill-dough'), recipe, catalogue, { batch: { index: 2, of: 4 } }), 'Chill dough for 1 hour (batch 2 of 4)')
})

test('instruction text from <instructions> mixed content', () => {
  assert.equal(instructionText(byId('fill-glass'), recipe, catalogue), 'Fill the mixing glass with 4 ice cubes and chill for 30 seconds.')
})

test('instruction text for a join and for unresolved refs', () => {
  const join = {
    id: 'fixture:join1',
    operation: 'join',
    options: {},
    inputs: [],
    tools: [],
    outputs: [],
    returnsTools: [],
    instructions: null,
    requires: [],
    steps: [
      { id: 's1', operation: 'crumble', options: {}, inputs: [{ ref: 'yeast-50g', amount: null, text: null }], tools: [], outputs: [{ id: 'crumbled-yeast', name: 'crumbled yeast' }], returnsTools: [], instructions: null, requires: [] },
      { id: 's2', operation: 'incorporate', options: {}, inputs: [{ ref: 'warm-milk', amount: null, text: null }, { ref: 'crumbled-yeast', amount: null, text: null }], tools: [], outputs: [{ id: 'milk+yeast', name: 'milk and yeast' }], returnsTools: [], instructions: null, requires: [] },
    ],
  }
  const model = { ...recipe, tasks: [...recipe.tasks, join] }
  assert.equal(instructionText(join, model, catalogue), 'Crumble yeast-50g. Incorporate crumbled yeast into warm-milk')
  assert.equal(instructionText({ operation: 'nonsense', inputs: [{ ref: 'x' }] }, {}, catalogue), 'nonsense x')
  assert.equal(instructionText({ operation: 'whip', inputs: [] }, null, null), 'Whip')
})
