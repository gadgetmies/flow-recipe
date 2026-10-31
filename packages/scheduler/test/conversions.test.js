import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import {
  DENSITIES, findDensity, findDensities, toMetricAmount, roundForKitchen, toCelsiusRounded, inchesToCm, convertInchText,
  metricizeRecipeXml, lintRecipeUnits,
} from '../src/conversions/index.js'
import * as pkg from '../src/index.js'
import { parseRecipe, validateRecipe } from '../src/recipe/index.js'
import { loadCatalogue } from '../src/catalogue/index.js'
import {
  canonicalUnit, isMass, isVolume, toBase, toMetricBase, toCentimeters, isImperial, isImperialMass, isImperialVolume, imperialKey,
} from '../src/units.js'

const here = dirname(fileURLToPath(import.meta.url))
const recipesDir = join(here, '..', '..', 'server', 'src', 'recipes')
const xmlOpts = { DOMParser, XMLSerializer }

const id = (name, props) => (findDensity(name, props) || {}).id || null
const conv = (number, unit, ingredient, precisionScale = false) => toMetricAmount({ number, unit }, { ingredient, precisionScale })

describe('density table', () => {
  test('is broad and well-formed', () => {
    assert.ok(DENSITIES.length >= 150, `only ${DENSITIES.length} entries`)
    const kinds = new Set(['liquid', 'viscous', 'fat', 'powder', 'granular', 'spice', 'leavening', 'produce', 'nut', 'grain', 'dairy', 'other'])
    const ids = new Set()
    for (const e of DENSITIES) {
      assert.ok(!ids.has(e.id), `duplicate id ${e.id}`)
      ids.add(e.id)
      assert.ok(kinds.has(e.kind), `${e.id} kind ${e.kind}`)
      assert.ok(e.gPerMl > 0 && e.gPerMl < 2, `${e.id} gPerMl ${e.gPerMl}`)
      assert.ok(Array.isArray(e.names) && e.names.length > 0)
      assert.equal(typeof e.source, 'string')
      if (e.pieceGrams !== undefined) assert.ok(e.pieceGrams > 0)
    }
    for (const kind of kinds) assert.ok(DENSITIES.some((e) => e.kind === kind), `no ${kind} entries`)
  })

  test('reference values', () => {
    const g = (i) => DENSITIES.find((e) => e.id === i)
    assert.equal(g('flour-all-purpose').gPerMl, 0.53)
    assert.equal(g('water').gPerMl, 1.0)
    assert.equal(g('milk').gPerMl, 1.03)
    assert.equal(g('cream-heavy').gPerMl, 1.0)
    assert.equal(g('oil-vegetable').gPerMl, 0.92)
    assert.equal(g('honey').gPerMl, 1.42)
    assert.equal(g('sugar-granulated').gPerMl, 0.85)
    assert.equal(g('butter').pieceGrams, 113)
    assert.equal(g('egg').pieceGrams, 50)
    assert.equal(g('garlic').pieceGrams, 5)
    assert.equal(g('onion').pieceGrams, 150)
    // Diamond Crystal (default) vs Morton kosher salt.
    assert.ok(g('salt-kosher-morton').gPerMl / g('salt-kosher').gPerMl > 1.5)
    assert.match(g('salt-kosher').note, /Diamond/)
    // 1 tsp of table salt ≈ 6 g, of baking powder ≈ 4 g, of cinnamon ≈ 2.6 g.
    assert.ok(Math.abs(g('salt-table').gPerMl * 5 - 6) < 0.3)
    assert.ok(Math.abs(g('baking-powder').gPerMl * 5 - 4) < 0.3)
    assert.ok(Math.abs(g('cinnamon').gPerMl * 5 - 2.6) < 0.2)
  })
})

describe('findDensity', () => {
  test('robust name matching', () => {
    assert.equal(id('2 cups all-purpose flour, sifted'), 'flour-all-purpose')
    assert.equal(id('All Purpose Flour'), 'flour-all-purpose')
    assert.equal(id('plain flour'), 'flour-all-purpose')
    assert.equal(id('flour'), 'flour-all-purpose')
    assert.equal(id('packed light brown sugar'), 'sugar-light-brown')
    assert.equal(id('1 cup firmly packed dark brown sugar'), 'sugar-dark-brown')
    assert.equal(id('unsalted butter, softened'), 'butter')
    assert.equal(id('kosher salt'), 'salt-kosher')
    assert.equal(id('Morton kosher salt'), 'salt-kosher-morton')
    assert.equal(id('salt'), 'salt-table')
    assert.equal(id('ground cinnamon'), 'cinnamon')
    assert.equal(id('baking soda'), 'baking-soda')
    assert.equal(id('bicarbonate of soda'), 'baking-soda')
    assert.equal(id('fresh parsley, chopped'), 'parsley')
    assert.equal(id('1 ½ cups confectioners’ sugar'), 'sugar-powdered')
    assert.equal(id('icing sugar'), 'sugar-powdered')
    assert.equal(id('Self-Raising Flour'), 'flour-self-rising')
  })

  test('longest alias and head noun win', () => {
    assert.equal(id('peanut butter'), 'peanut-butter')
    assert.equal(id('buttermilk'), 'buttermilk')
    assert.equal(id('cream cheese, softened'), 'cream-cheese')
    assert.equal(id('sour cream'), 'sour-cream')
    assert.equal(id('cream of tartar'), 'cream-of-tartar')
    assert.equal(id('coconut milk'), 'coconut-milk')
    assert.equal(id('almond flour'), 'flour-almond')
    assert.equal(id('garlic powder'), 'garlic-powder')
    assert.equal(id('onion powder'), 'onion-powder')
    assert.equal(id('lemon juice'), 'juice-lemon')
    assert.equal(id('lemon zest'), 'citrus-zest')
    assert.equal(id('orange bitters'), 'bitters')
    assert.equal(id('red pepper flakes'), 'chili-flakes')
    assert.equal(id('freshly ground black pepper'), 'pepper-black')
    assert.equal(id('cherry tomatoes, halved'), 'tomato-cherry')
    assert.equal(id('red wine vinegar'), 'vinegar')
    assert.equal(id('cinnamon plum quark'), 'quark')
    assert.equal(id('semi-sweet chocolate chips'), 'chocolate-chips')
  })

  test('plurals, alternatives, parentheses and countables', () => {
    assert.equal(id('3 large eggs'), 'egg')
    assert.equal(id('egg yolks'), 'egg-yolk')
    assert.equal(id('2 cloves garlic, minced'), 'garlic')
    assert.equal(id('garlic cloves'), 'garlic')
    assert.equal(id('blueberries'), 'blueberries')
    assert.equal(id('tomatoes'), 'tomato')
    assert.equal(id('white or dark rum'), 'spirit')
    assert.equal(id('butter or margarine'), 'butter')
    assert.equal(id('1 (14 oz) can coconut milk'), 'coconut-milk')
    assert.equal(id('jalapeño'), 'chili-fresh')
    assert.equal(id('gelatin sheets'), 'gelatin-sheet')
    assert.equal(id('cookies'), null)
    assert.equal(id(''), null)
    assert.equal(findDensity(null), null)
  })

  test('properties and ids', () => {
    assert.equal(id('cinnamon', { type: { value: 'ground' } }), 'cinnamon')
    assert.equal(id('kosher salt', { brand: { value: 'Morton' } }), 'salt-kosher-morton')
    assert.equal(id('salt', { storage: { value: 'fridge' } }), 'salt-table')
    assert.equal(id('flour-all-purpose'), 'flour-all-purpose')
    const many = findDensities('peanut butter')
    assert.equal(many[0].id, 'peanut-butter')
    assert.ok(many.some((e) => e.id === 'butter'))
  })
})

describe('toMetricAmount', () => {
  test('volume of solids → grams', () => {
    let r = conv(1, 'cup', 'all-purpose flour')
    assert.equal(r.method, 'density')
    assert.equal(r.unit, 'g')
    assert.equal(r.number, 125, 'US cup: matches the 125 g per cup note')
    assert.equal(r.density.id, 'flour-all-purpose')
    assert.deepEqual(r.from, { number: 1, unit: 'cup' })
    assert.deepEqual([conv(1, 'cup', 'granulated sugar').number, conv(1, 'cup', 'granulated sugar').unit], [201, 'g'])
    assert.equal(conv(0.5, 'cup', 'unsalted butter').number, 114)
    assert.equal(conv(1, 'cup', 'honey').number, 335, '336 g per cup, rounded to 5 g')
    r = conv(2, 'dl', 'sugar')
    assert.deepEqual([r.number, r.unit, r.method], [170, 'g', 'density'])
    r = conv(1, 'tbsp', 'olive oil')
    assert.deepEqual([r.number, r.unit], [14, 'g'])
    r = conv(9, 'cups', 'flour')
    assert.deepEqual([r.number, r.unit], [1.13, 'kg'])
  })

  test('thin liquids stay in ml / l', () => {
    assert.deepEqual(pick(conv(1, 'cup', 'milk')), [240, 'ml', 'metric'])
    assert.deepEqual(pick(conv(0.333, 'cup', 'heavy cream')), [80, 'ml', 'metric'])
    assert.deepEqual(pick(conv(1, 'quart', 'chicken stock')), [950, 'ml', 'metric'])
    assert.deepEqual(pick(conv(1, 'gallon', 'water')), [3.8, 'l', 'metric'])
    assert.deepEqual(pick(conv(2, 'fl oz', 'lime juice')), [60, 'ml', 'metric'])
    assert.deepEqual(pick(conv(2, 'dl', 'milk')), [2, 'dl', 'unchanged'])
    assert.deepEqual(pick(conv(2, 'tbsp', 'milk')), [2, 'tbsp', 'unchanged'])
  })

  test('oz of a liquid is a fluid ounce, oz of a solid is mass', () => {
    assert.deepEqual(pick(conv(1, 'oz', 'white or dark rum')), [30, 'ml', 'metric'])
    assert.deepEqual(pick(conv(1.5, 'oz', 'sweet vermouth')), [45, 'ml', 'metric'])
    assert.deepEqual(pick(conv(8, 'oz', 'cream cheese')), [227, 'g', 'metric'])
    assert.deepEqual(pick(conv(1, 'lb', 'ground beef')), [455, 'g', 'metric'])
    assert.deepEqual(pick(conv(3, 'lbs', 'potatoes')), [1.36, 'kg', 'metric'])
    assert.deepEqual(pick(conv(4, 'ounces', null)), [113, 'g', 'metric'])
  })

  test('small spices, salt and leavening stay metric spoons', () => {
    assert.deepEqual(pick(conv(1, 'tsp', 'salt')), [1, 'tsp', 'spoon'])
    assert.deepEqual(pick(conv(1, 'tbsp', 'kosher salt')), [1, 'tbsp', 'spoon'])
    assert.deepEqual(pick(conv(0.5, 'tsp', 'baking soda')), [0.5, 'tsp', 'spoon'])
    assert.deepEqual(pick(conv(1, 'tsp', 'vanilla extract')), [1, 'tsp', 'spoon'])
    // A sixteenth of a cup is one tablespoon; 1/48 cup one teaspoon.
    assert.deepEqual(pick(conv(1 / 16, 'cup', 'ground cinnamon')), [1, 'tbsp', 'spoon'])
    assert.deepEqual(pick(conv(0.5, 'fl oz', 'vanilla extract')), [1, 'tbsp', 'spoon'], 'half a fluid ounce is one US tablespoon')
    // Larger amounts are weighed.
    assert.deepEqual(pick(conv(0.25, 'cup', 'ground cinnamon')), [31, 'g', 'density'])
    assert.deepEqual(pick(conv(2, 'tbsp', 'table salt')), [36, 'g', 'density'])
  })

  test('precision scale weighs small amounts to 0.1 g', () => {
    assert.deepEqual(pick(conv(1, 'tsp', 'salt', true)), [6, 'g', 'density'])
    assert.deepEqual(pick(conv(0.25, 'tsp', 'baking soda', true)), [1.5, 'g', 'density'])
    assert.deepEqual(pick(conv(1, 'tsp', 'ground cinnamon', true)), [2.6, 'g', 'density'])
    assert.deepEqual(pick(conv(1, 'tsp', 'vanilla extract', true)), [4.4, 'g', 'density'])
    assert.deepEqual(pick(conv(1, 'pinch', 'salt', true)), [0.3, 'g', 'metric'])
    assert.deepEqual(pick(conv(1, 'pinch', 'salt')), [1, 'pinch', 'count'])
  })

  test('countables and unknowns', () => {
    assert.deepEqual(pick(conv(3, null, 'eggs')), [3, null, 'count'])
    assert.deepEqual(pick(conv(2, 'pieces', 'onion')), [2, 'pieces', 'count'])
    assert.deepEqual(pick(conv(2, 'cloves', 'garlic')), [2, 'cloves', 'count'])
    assert.deepEqual(pick(conv(2, 'sheets', 'gelatin')), [2, 'sheets', 'count'])
    assert.deepEqual(pick(conv(1, 'stick', 'butter')), [113, 'g', 'metric'])
    assert.deepEqual(pick(conv(2, 'sticks', 'cinnamon stick')), [2, 'sticks', 'count'])
    let r = conv(1, 'cup', 'unobtainium')
    assert.deepEqual(pick(r), [240, 'ml', 'metric'])
    assert.match(r.note, /no density known/)
    r = conv(2, 'dl', 'unobtainium')
    assert.deepEqual(pick(r), [2, 'dl', 'unchanged'])
    assert.deepEqual(pick(conv(150, 'g', 'flour')), [150, 'g', 'unchanged'])
    assert.deepEqual(pick(conv(5, 'cm', 'cucumber')), [5, 'cm', 'unchanged'])
    assert.deepEqual(pick(conv(2, 'in', 'ginger')), [5, 'cm', 'metric'])
    r = conv(1, 'smidgen', 'salt')
    assert.deepEqual(pick(r), [1, 'smidgen', 'unchanged'])
    assert.match(r.note, /unknown unit/)
  })

  test('accepts US unit spellings', () => {
    assert.equal(conv(2, 'T', 'sugar').number, 26)
    assert.deepEqual(pick(conv(1, 't', 'salt')), [1, 'tsp', 'spoon'])
    assert.deepEqual(pick(conv(2, 'Fl. Oz.', 'milk')), [60, 'ml', 'metric'])
    assert.deepEqual(pick(conv(1, 'Cups', 'flour')), [125, 'g', 'density'])
  })

  test('converting a converted amount changes nothing', () => {
    const cases = [[1, 'cup', 'flour'], [3, 'lb', 'potatoes'], [1, 'oz', 'rum'], [1, 'gallon', 'water'], [0.5, 'fl oz', 'vanilla extract'], [1, 'tsp', 'salt']]
    for (const precisionScale of [false, true]) {
      for (const [n, u, ing] of cases) {
        const a = conv(n, u, ing, precisionScale)
        const b = conv(a.number, a.unit, ing, precisionScale)
        assert.deepEqual([b.number, b.unit], [a.number, a.unit], `${n} ${u} ${ing} ${precisionScale}`)
      }
    }
  })
})

function pick(r) {
  return [r.number, r.unit, r.method]
}

describe('rounding helpers', () => {
  test('roundForKitchen', () => {
    assert.equal(roundForKitchen(3.27), 3)
    assert.equal(roundForKitchen(3.27, { precisionScale: true }), 3.3)
    assert.equal(roundForKitchen(0.2), 0.5)
    assert.equal(roundForKitchen(0.04, { precisionScale: true }), 0.1)
    assert.equal(roundForKitchen(127.2), 127)
    assert.equal(roundForKitchen(453.6), 455)
    assert.equal(roundForKitchen(1361), 1360)
    for (let g = 0.05; g < 3000; g = g * 1.07 + 0.01) {
      for (const precisionScale of [false, true]) {
        const r = roundForKitchen(g, { precisionScale })
        assert.equal(roundForKitchen(r, { precisionScale }), r, `not idempotent at ${g}`)
      }
    }
  })

  test('temperatures and lengths', () => {
    assert.equal(toCelsiusRounded(350), 175)
    assert.equal(toCelsiusRounded(425), 220)
    assert.equal(toCelsiusRounded(212), 100)
    assert.equal(toCelsiusRounded(32), 0)
    assert.equal(inchesToCm(9), 23)
    assert.equal(inchesToCm(13), 33)
    assert.equal(inchesToCm(1), 2.5)
    assert.equal(convertInchText('9x13 inch'), '23x33 cm')
    assert.equal(convertInchText('9-inch'), '23 cm')
    assert.equal(convertInchText('8 x 8 in.'), '20.5x20.5 cm')
    assert.equal(convertInchText('large'), null)
  })
})

describe('units.js additions', () => {
  test('existing behaviour is unchanged', () => {
    assert.equal(isMass('oz'), false)
    assert.equal(isVolume('fl oz'), false)
    assert.equal(canonicalUnit('oz'), 'oz')
    assert.equal(canonicalUnit('cups'), 'cup')
    assert.equal(toBase({ number: 1, unit: 'oz' }), null)
    assert.deepEqual(toBase({ number: 1, unit: 'cup' }), { number: 240, unit: 'ml' })
  })

  test('imperial helpers', () => {
    assert.equal(imperialKey('Fl. Oz.'), 'fl oz')
    assert.ok(isImperialMass('lbs'))
    assert.ok(isImperialVolume('quarts'))
    assert.ok(isImperial('fahrenheit') && isImperial('in') && isImperial('cup'))
    assert.ok(!isImperial('g') && !isImperial('dl') && !isImperial('tsp'))
    assert.ok(Math.abs(toMetricBase({ number: 1, unit: 'lb' }).number - 453.59) < 0.01)
    assert.ok(Math.abs(toMetricBase({ number: 1, unit: 'pint' }).number - 473.18) < 0.01)
    assert.deepEqual(toMetricBase({ number: 2, unit: 'dl' }), { number: 200, unit: 'ml' })
    assert.equal(toCentimeters({ number: 2, unit: 'inches' }), 5.08)
    assert.equal(toCentimeters({ number: 2, unit: 'g' }), null)
  })

  test('package index re-exports conversions and keeps formatAmount', () => {
    assert.equal(pkg.metricizeRecipeXml, metricizeRecipeXml)
    assert.equal(pkg.findDensity, findDensity)
    assert.equal(pkg.DENSITIES, DENSITIES)
    assert.equal(typeof pkg.formatAmount, 'function')
  })
})

const usRecipe = `<?xml version="1.0" encoding="UTF-8"?>
<recipe id="us-cookies" version="2">
  <title>US cookies</title>
  <ingredients>
    <ingredient id="flour">all-purpose flour, sifted</ingredient>
    <ingredient id="sugar">packed light brown sugar</ingredient>
    <ingredient id="butter">unsalted butter, softened</ingredient>
    <ingredient id="salt">kosher salt</ingredient>
    <ingredient id="cinnamon">cinnamon<properties><property name="type" value="ground"/></properties></ingredient>
    <ingredient id="milk">milk</ingredient>
    <ingredient id="eggs">eggs</ingredient>
    <ingredient id="mystery">mystery powder</ingredient>
  </ingredients>
  <tools>
    <tool id="pan">baking pan<properties>
        <property name="size" value="9x13 inch"/>
        <property name="diameter"><numeric-value number="9" unit="in"/></property>
      </properties>
    </tool>
    <tool id="pot">pot<properties><property name="capacity"><numeric-value number="4" unit="quarts"/></property></properties></tool>
  </tools>
  <tasks>
    <task operation="measure" id="m-flour">
      <options>
        <option name="amount">
          <numeric-value number="2.25" unit="cups"/>
        </option>
      </options>
      <inputs><input ref="flour"/></inputs>
      <outputs><output id="flour-m">flour</output></outputs>
    </task>
    <task operation="measure" id="m-sugar">
      <options><option name="amount"><numeric-value number="0.75" unit="cup"/></option></options>
      <inputs><input ref="sugar"/></inputs>
      <outputs><output id="sugar-m">sugar</output></outputs>
    </task>
    <task operation="measure" id="m-butter">
      <options><option name="amount"><numeric-value number="1" unit="stick"/></option></options>
      <inputs><input ref="butter"/></inputs>
      <outputs><output id="butter-m">butter</output></outputs>
    </task>
    <task operation="measure" id="m-salt">
      <options><option name="amount"><numeric-value number="1" unit="tsp"/></option></options>
      <inputs><input ref="salt"/></inputs>
      <outputs><output id="salt-m">salt</output></outputs>
    </task>
    <task operation="measure" id="m-cinnamon">
      <options><option name="amount"><numeric-value number="2" unit="tsp"/></option></options>
      <inputs><input ref="cinnamon"/></inputs>
      <outputs><output id="cinnamon-m">cinnamon</output></outputs>
    </task>
    <task operation="measure" id="m-milk">
      <options><option name="amount"><numeric-value number="0.5" unit="cup"/></option></options>
      <inputs><input ref="milk"/></inputs>
      <outputs><output id="milk-m">milk</output></outputs>
    </task>
    <task operation="measure" id="m-eggs">
      <options><option name="amount"><numeric-value number="2"/></option></options>
      <inputs><input ref="eggs"/></inputs>
      <outputs><output id="eggs-m">eggs</output></outputs>
    </task>
    <task operation="measure" id="m-mystery">
      <options><option name="amount"><numeric-value number="0.5" unit="cup"/></option></options>
      <inputs><input ref="mystery"/></inputs>
      <outputs><output id="mystery-m">mystery</output></outputs>
    </task>
    <join id="j">
      <task operation="mix" id="mix">
        <inputs><input ref="flour-m"/><input ref="sugar-m"/><input ref="butter-m"/><input ref="salt-m"/><input ref="cinnamon-m"/><input ref="milk-m"/><input ref="eggs-m"/><input ref="mystery-m"/></inputs>
        <outputs><output id="dough" volume="6" volume-unit="cups">dough</output></outputs>
      </task>
      <task operation="bake-in-oven" id="bake">
        <options>
          <option name="temperature"><numeric-value number="350" unit="fahrenheit"/></option>
          <option name="duration"><numeric-value number="12" unit="minutes"/></option>
        </options>
        <inputs><input ref="dough"/></inputs>
        <tools><tool ref="pan"/></tools>
        <outputs><output id="cookies" final="true">cookies</output></outputs>
      </task>
    </join>
  </tasks>
</recipe>
`

function amountOf(model, taskId) {
  const tasks = model.tasks.flatMap((t) => t.steps || [t])
  return tasks.find((t) => t.id === taskId).options
}

describe('metricizeRecipeXml', () => {
  test('converts amounts, temperatures, lengths, capacities and output volumes', () => {
    const r = metricizeRecipeXml(usRecipe, xmlOpts)
    const m = parseRecipe(r.xml, { DOMParser })
    assert.deepEqual(amountOf(m, 'm-flour').amount, { number: 280, unit: 'g' })
    assert.deepEqual(amountOf(m, 'm-sugar').amount, { number: 160, unit: 'g' })
    assert.deepEqual(amountOf(m, 'm-butter').amount, { number: 113, unit: 'g' })
    assert.deepEqual(amountOf(m, 'm-salt').amount, { number: 1, unit: 'tsp' })
    assert.deepEqual(amountOf(m, 'm-cinnamon').amount, { number: 2, unit: 'tsp' })
    assert.deepEqual(amountOf(m, 'm-milk').amount, { number: 120, unit: 'ml' })
    assert.deepEqual(amountOf(m, 'm-eggs').amount, { number: 2 })
    assert.deepEqual(amountOf(m, 'm-mystery').amount, { number: 120, unit: 'ml' })
    assert.deepEqual(amountOf(m, 'bake').temperature, { number: 175, unit: 'celsius' })
    assert.deepEqual(amountOf(m, 'bake').duration, { number: 12, unit: 'minutes' })
    const pan = m.tools.find((t) => t.id === 'pan')
    assert.equal(pan.properties.size.value, '23x33 cm')
    assert.deepEqual([pan.properties.diameter.number, pan.properties.diameter.unit], [23, 'cm'])
    const pot = m.tools.find((t) => t.id === 'pot')
    assert.deepEqual(pot.capacity, { number: 3.79, unit: 'l' })
    const dough = m.tasks[m.tasks.length - 1].steps[0].outputs[0]
    assert.deepEqual(dough.volume, { number: 1.42, unit: 'l' })

    assert.ok(r.xml.includes('<!-- converted from 2.25 cups (all-purpose flour, sifted, 0.53 g/ml) -->'))
    assert.ok(r.xml.includes('<!-- converted from 350 fahrenheit -->'))
    assert.ok(r.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<recipe'))
    assert.ok(r.xml.endsWith('</recipe>\n'))
    assert.ok(r.warnings.some((w) => /mystery powder/.test(w)))

    const flour = r.changes.find((c) => c.taskId === 'm-flour')
    assert.deepEqual(flour, { taskId: 'm-flour', ingredientId: 'flour', from: { number: 2.25, unit: 'cups' }, to: { number: 280, unit: 'g' }, method: 'density', note: flour.note })
    assert.ok(r.changes.some((c) => c.taskId === 'bake' && c.to.unit === 'celsius'))
    assert.ok(!r.changes.some((c) => c.taskId === 'm-salt' || c.taskId === 'm-eggs'))
  })

  test('precision scale weighs spices', () => {
    const r = metricizeRecipeXml(usRecipe, { ...xmlOpts, precisionScale: true })
    const m = parseRecipe(r.xml, { DOMParser })
    assert.deepEqual(amountOf(m, 'm-salt').amount, { number: 2.8, unit: 'g' })
    assert.deepEqual(amountOf(m, 'm-cinnamon').amount, { number: 5.2, unit: 'g' })
  })

  test('is idempotent', () => {
    for (const precisionScale of [false, true]) {
      const once = metricizeRecipeXml(usRecipe, { ...xmlOpts, precisionScale })
      const twice = metricizeRecipeXml(once.xml, { ...xmlOpts, precisionScale })
      assert.equal(twice.xml, once.xml)
      assert.deepEqual(twice.changes, [])
    }
  })

  test('returns the input untouched when there is nothing to convert', () => {
    const xml = '<?xml version="1.0" ?>\n<recipe id="x">\n  <title>X</title>\n  <tasks/>\n</recipe>'
    const r = metricizeRecipeXml(xml, xmlOpts)
    assert.equal(r.xml, xml)
    assert.deepEqual(r.changes, [])
  })

  test('needs constructors and well-formed XML', () => {
    assert.throws(() => metricizeRecipeXml(usRecipe, {}), /DOMParser/)
    assert.throws(() => metricizeRecipeXml(usRecipe, { DOMParser }), /XMLSerializer/)
    assert.throws(() => metricizeRecipeXml('not xml at all', xmlOpts), /could not be parsed/)
  })

  test('conversions source uses no Node-only APIs', () => {
    const src = readFileSync(join(here, '..', 'src', 'conversions', 'metricize.js'), 'utf8')
    assert.ok(!/from 'node:|require\(|process\.|Buffer/.test(src))
    for (const f of ['convert.js', 'match.js', 'densities.js', 'lint.js', 'index.js']) {
      assert.ok(!/from 'node:|require\(|process\.|Buffer/.test(readFileSync(join(here, '..', 'src', 'conversions', f), 'utf8')), f)
    }
  })

  test('every built-in recipe still parses and validates after conversion', () => {
    const catalogue = loadCatalogue(readFileSync(join(recipesDir, 'operations.xml'), 'utf8'), { DOMParser })
    const files = readdirSync(recipesDir).filter((f) => f.endsWith('.xml') && f !== 'operations.xml')
    assert.ok(files.length > 0)
    for (const file of files) {
      const xml = readFileSync(join(recipesDir, file), 'utf8')
      const recipeId = file.replace(/\.xml$/, '')
      const before = validateRecipe(parseRecipe(xml, { DOMParser, id: recipeId }), catalogue)
      for (const precisionScale of [false, true]) {
        const r = metricizeRecipeXml(xml, { ...xmlOpts, precisionScale })
        const model = parseRecipe(r.xml, { DOMParser, id: recipeId })
        const after = validateRecipe(model, catalogue)
        assert.equal(after.valid, before.valid, `${file}: ${after.errors.join('; ')}`)
        assert.ok(after.warnings.length <= before.warnings.length, `${file} gained warnings: ${after.warnings.join('; ')}`)
        const again = metricizeRecipeXml(r.xml, { ...xmlOpts, precisionScale })
        assert.equal(again.xml, r.xml, `${file} not idempotent`)
        const lint = lintRecipeUnits(model, { precisionScale })
        assert.ok(!lint.some((l) => /non-metric/.test(l.message)), `${file}: ${lint.map((l) => l.message).join('; ')}`)
      }
    }
  })

  test('negroni: ounces of spirits become 30 ml', () => {
    const xml = readFileSync(join(recipesDir, 'negroni.xml'), 'utf8')
    const r = metricizeRecipeXml(xml, xmlOpts)
    const m = parseRecipe(r.xml, { DOMParser, id: 'negroni' })
    for (const t of ['measure-rum', 'measure-campari', 'measure-vermouth']) assert.deepEqual(amountOf(m, t).amount, { number: 30, unit: 'ml' })
    assert.deepEqual(amountOf(m, 'measure-bitters').amount, { number: 2, unit: 'dashes' })
    assert.equal(r.changes.length, 3)
    assert.ok(r.xml.includes('<!-- converted from 1 oz (Campari) -->'))
  })
})

describe('lintRecipeUnits', () => {
  test('flags non-metric units and solids by volume', () => {
    const m = parseRecipe(usRecipe, { DOMParser })
    const lint = lintRecipeUnits(m)
    const at = (taskId) => lint.filter((l) => l.taskId === taskId)
    assert.ok(at('m-flour').some((l) => l.level === 'warning' && /non-metric/.test(l.message)))
    assert.ok(at('bake').some((l) => l.level === 'warning' && /temperature/.test(l.message)))
    assert.ok(lint.some((l) => /Tool 'pan'/.test(l.message) && /inches/.test(l.message)))
    assert.ok(lint.some((l) => /Tool 'pot'/.test(l.message)))
    assert.ok(at('mix').some((l) => /Output 'dough' volume/.test(l.message)))
    assert.equal(at('m-salt').length, 0)
    assert.equal(at('m-eggs').length, 0)
  })

  test('clean after conversion, spoons > 2 tbsp and dl of solids are flagged', () => {
    const converted = parseRecipe(metricizeRecipeXml(usRecipe, xmlOpts).xml, { DOMParser })
    const lint = lintRecipeUnits(converted)
    assert.ok(!lint.some((l) => l.level === 'warning' && l.taskId !== 'm-mystery'), JSON.stringify(lint))

    const xml = usRecipe
      .replace('<numeric-value number="2.25" unit="cups"/>', '<numeric-value number="3" unit="dl"/>')
      .replace('<numeric-value number="0.75" unit="cup"/>', '<numeric-value number="4" unit="tbsp"/>')
    const l2 = lintRecipeUnits(parseRecipe(xml, { DOMParser }))
    assert.ok(l2.some((l) => l.taskId === 'm-flour' && l.level === 'warning' && /measured by volume/.test(l.message)))
    assert.ok(l2.some((l) => l.taskId === 'm-sugar' && l.level === 'warning' && /more than 2 tbsp/.test(l.message)))
  })

  test('precision scale suggests weighing spoons of spices', () => {
    const m = parseRecipe(metricizeRecipeXml(usRecipe, xmlOpts).xml, { DOMParser })
    assert.ok(!lintRecipeUnits(m).some((l) => l.taskId === 'm-salt'))
    assert.ok(lintRecipeUnits(m, { precisionScale: true }).some((l) => l.taskId === 'm-salt' && l.level === 'info' && /precision scale/.test(l.message)))
  })
})

describe('review 1 regressions: unit spellings, US cup, lint of leftovers', () => {
  test('every spelling an LLM may copy converts like the canonical unit', () => {
    const same = (a, b, ing) => {
      const x = conv(1, a, ing)
      const y = conv(1, b, ing)
      assert.deepEqual([x.number, x.unit], [y.number, y.unit], `${a} vs ${b} (${ing})`)
    }
    for (const u of ['T', 'Tb', 'Tbs', 'TBS', 'Tbsp', 'tbs', 'tbsp.', 'Tbsp.', 'tbsps', 'tablespoons', 'Tablespoon']) same(u, 'tbsp', 'soy sauce')
    for (const u of ['t', 'ts', 'tsps', 'tsp.', 'teaspoons', 'Teaspoon']) same(u, 'tsp', 'table salt')
    for (const u of ['c', 'c.', 'C', 'cups', 'Cup']) same(u, 'cup', 'all-purpose flour')
    for (const u of ['fl. oz', 'fl oz.', 'Fl. Oz.', 'fluid ounces', 'floz']) same(u, 'fl oz', 'milk')
    for (const u of ['lb.', 'lbs', 'Pounds']) same(u, 'lb', 'potatoes')
    for (const u of ['ounces', 'oz.', 'Ounce']) same(u, 'oz', 'cream cheese')
    for (const u of ['g.', 'gr', 'gr.', 'grams', 'Grams', 'gramme']) same(u, 'g', 'flour')
    for (const u of ['ml.', 'mL', 'mls', 'millilitres']) same(u, 'ml', 'milk')
    for (const u of ['sticks', 'Stick']) same(u, 'stick', 'butter')
  })

  test('kept amounts are written with the canonical unit', () => {
    assert.deepEqual(pick(conv(1, 'T', 'soy sauce')), [1, 'tbsp', 'unchanged'])
    assert.deepEqual(pick(conv(1, 'Tbs', 'salt')), [1, 'tbsp', 'spoon'])
    assert.deepEqual(pick(conv(0.5, 'tsps', 'baking soda')), [0.5, 'tsp', 'spoon'])
    assert.deepEqual(pick(conv(200, 'grams', 'flour')), [200, 'g', 'unchanged'])
    assert.deepEqual(pick(conv(3, 'large', 'eggs')), [3, 'pieces', 'count'])
    assert.deepEqual(pick(conv(1, 'medium', 'onion')), [1, 'pieces', 'count'])
  })

  test('a converted cup agrees with the density note (US cup, 236.6 ml)', () => {
    const grams = (note) => Number(/(\d+) g per cup/.exec(note)[1])
    for (const name of ['all-purpose flour', 'granulated sugar', 'packed brown sugar', 'powdered sugar', 'honey']) {
      const r = conv(1, 'cup', name)
      const expected = grams(r.density.note)
      assert.ok(Math.abs(r.number - expected) <= Math.max(2, expected * 0.015), `${name}: ${r.number} g vs note ${r.density.note}`)
    }
  })

  test('metricize canonicalises T / t / Tbs and the lint flags anything left unconverted', () => {
    const xml = usRecipe
      .replace('<numeric-value number="1" unit="tsp"/>', '<numeric-value number="1" unit="Tbs"/>')
      .replace('<numeric-value number="2" unit="tsp"/>', '<numeric-value number="2" unit="t"/>')
    const r = metricizeRecipeXml(xml, xmlOpts)
    const m = parseRecipe(r.xml, { DOMParser })
    assert.deepEqual(amountOf(m, 'm-salt').amount, { number: 1, unit: 'tbsp' })
    assert.deepEqual(amountOf(m, 'm-cinnamon').amount, { number: 2, unit: 'tsp' })
    assert.ok(r.xml.includes('<!-- converted from 1 Tbs (kosher salt) -->'), r.xml)
    assert.equal(metricizeRecipeXml(r.xml, xmlOpts).changes.length, 0, 'idempotent')

    // Left as is (not converted): the parser lower-cases T to t, which the lint reports as ambiguous; unknown units
    // and US units are flagged too.
    const raw = usRecipe
      .replace('<numeric-value number="1" unit="tsp"/>', '<numeric-value number="1" unit="T"/>')
      .replace('<numeric-value number="2" unit="tsp"/>', '<numeric-value number="2" unit="smidgen"/>')
      .replace('<numeric-value number="1" unit="stick"/>', '<numeric-value number="1" unit="sticks"/>')
    const lint = lintRecipeUnits(parseRecipe(raw, { DOMParser }))
    const at = (taskId) => lint.filter((l) => l.taskId === taskId && l.level === 'warning').map((l) => l.message).join('\n')
    assert.match(at('m-salt'), /ambiguous/)
    assert.match(at('m-cinnamon'), /'smidgen'.*not recognised/)
    assert.match(at('m-butter'), /non-metric/)
    const spelled = usRecipe.replace('<numeric-value number="1" unit="tsp"/>', '<numeric-value number="1" unit="tbs"/>')
    assert.match(lintRecipeUnits(parseRecipe(spelled, { DOMParser })).filter((l) => l.taskId === 'm-salt').map((l) => l.message).join('\n'), /should be written 'tbsp'/)
  })
})

describe('review 1 regressions: ingredient matching', () => {
  test('compound names and parenthetical qualifiers', () => {
    assert.equal(findDensity('vanilla ice cream'), null)
    assert.equal(findDensity('water chestnuts'), null)
    assert.equal(findDensity('kosher salt (Morton)').id, 'salt-kosher-morton')
    assert.equal(findDensity('brown sugar (packed)').id, 'sugar-brown')
    assert.equal(findDensity('2 cups (250 g) flour').id, 'flour-all-purpose')
  })
})

describe('review 1 flow: Nordic and European units, herbs and amounts too light to weigh', () => {
  test('Finnish, Swedish, Norwegian, German and French spoons are metric spoons', () => {
    assert.deepEqual([conv(1, 'tl', 'kaneli').number, conv(1, 'tl', 'kaneli').unit], [1, 'tsp'])
    assert.deepEqual([conv(2, 'TL', 'salt').number, conv(2, 'TL', 'salt').unit], [2, 'tsp'])
    assert.equal(conv(1, 'rkl', 'vehnäjauho').unit, 'tbsp', '8 g of flour is too light for a kitchen scale')
    assert.deepEqual([conv(2, 'rkl', 'vehnäjauho').number, conv(2, 'rkl', 'vehnäjauho').unit], [16, 'g'])
    assert.equal(conv(1, 'msk', 'salt').unit, 'tbsp')
    assert.equal(conv(1, 'EL', 'salt').unit, 'tbsp')
    assert.equal(conv(1, 'c.à.s', 'salt').unit, 'tbsp')
    assert.deepEqual([conv(2, 'krm', 'salt').number, conv(2, 'krm', 'salt').unit], [0.5, 'tsp'], 'krm is 1 ml')
    assert.equal(conv(3, 'dl', 'vehnäjauho').unit, 'g')
    assert.deepEqual([conv(2, 'kpl', 'kananmuna').number, conv(2, 'kpl', 'kananmuna').unit], [2, 'pieces'])
    assert.equal(conv(1, 'Prise', 'salt').unit, 'pinch')
    assert.equal(conv(1, 'prk', 'kerma').unit, 'jar')
    assert.equal(conv(2, 'cans', 'tomatoes').unit, 'cans', 'English count words stay as written')
  })

  test('the lint asks for the canonical spoon spelling and for package sizes', () => {
    const xml = `<recipe version="2" id="x"><title>X</title><ingredients><ingredient id="kaneli">kaneli</ingredient><ingredient id="kerma">kerma</ingredient></ingredients><tools/><tasks>
      <task id="m1" operation="measure"><options><option name="amount"><numeric-value number="1" unit="tl"/></option></options><inputs><input ref="kaneli"/></inputs><outputs><output id="o1">a</output></outputs></task>
      <task id="m2" operation="measure"><options><option name="amount"><numeric-value number="1" unit="prk"/></option></options><inputs><input ref="kerma"/></inputs><outputs><output id="o2">b</output></outputs></task>
    </tasks></recipe>`
    const lint = lintRecipeUnits(parseRecipe(xml, { DOMParser }))
    assert.ok(lint.some((l) => l.taskId === 'm1' && l.level === 'warning' && /should be written 'tsp'/.test(l.message)), JSON.stringify(lint))
    assert.ok(lint.some((l) => l.taskId === 'm2' && l.level === 'info' && /package/.test(l.message)), JSON.stringify(lint))
    const converted = metricizeRecipeXml(xml, xmlOpts)
    assert.match(converted.xml, /number="1" unit="tsp"/)
  })

  test('fresh herbs and other amounts too light for a 1 g scale stay spoons without a precision scale', () => {
    assert.deepEqual([conv(1, 'tsp', 'fresh parsley').number, conv(1, 'tsp', 'fresh parsley').unit], [1, 'tsp'])
    assert.equal(conv(2, 'tbsp', 'chopped fresh dill').unit, 'tbsp')
    assert.equal(conv(1, 'cup', 'fresh parsley').unit, 'g', 'a cup of parsley is weighed')
    assert.deepEqual([conv(2, 'tsp', 'cornstarch').number, conv(2, 'tsp', 'cornstarch').unit], [2, 'tsp'])
    assert.equal(conv(1, 'tbsp', 'butter').unit, 'g', '14 g of butter is still weighed')
    assert.equal(conv(1, 'tsp', 'fresh parsley', true).unit, 'g', 'a precision scale weighs it')
  })
})
