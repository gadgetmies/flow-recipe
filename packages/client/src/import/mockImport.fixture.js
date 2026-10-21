// Fixtures for the import page in `?mock=1` mode: a realistic ImportResult (chocolate chip cookies imported from an
// American page: cups → grams, °F → °C, a 24-cookie unit stream baked per sheet) and its CheckResult.

import { RECIPES_FIXTURE } from '../mocks/session.fixture'

export const RECIPES_FIXTURE_IDS = RECIPES_FIXTURE.map((r) => r.id)

export const MOCK_SOURCE_URL = 'https://example.com/recipes/chewy-chocolate-chip-cookies'

export const MOCK_XML = `<?xml version="1.0" encoding="utf-8" ?>
<recipe version="2" id="chewy-chocolate-chip-cookies" ref="${MOCK_SOURCE_URL}">
    <title>Chewy Chocolate Chip Cookies</title>
    <serving temperature="room" hold="120" hold-unit="minutes"/>
    <ingredients>
        <ingredient id="flour">all-purpose flour</ingredient>
        <ingredient id="baking-soda">baking soda</ingredient>
        <ingredient id="salt">fine salt</ingredient>
        <ingredient id="butter">butter<properties>
                <property name="storage" value="fridge"/>
                <property name="out-of-storage"><numeric-value number="60" unit="minutes"/></property>
            </properties>
        </ingredient>
        <ingredient id="brown-sugar">brown sugar</ingredient>
        <ingredient id="sugar">white sugar</ingredient>
        <ingredient id="egg">egg<properties>
                <property name="storage" value="fridge"/>
            </properties>
        </ingredient>
        <ingredient id="vanilla">vanilla extract</ingredient>
        <ingredient id="chocolate-chips">chocolate chips</ingredient>
    </ingredients>
    <tools>
        <tool id="bowl">bowl</tool>
        <tool id="mixer">hand mixer</tool>
        <tool id="kitchen-scale">kitchen scale</tool>
        <tool id="baking-sheet">baking sheet<properties>
                <property name="capacity"><numeric-value number="12" unit="cookie"/></property>
            </properties>
        </tool>
        <tool id="cooling-rack">cooling rack<properties>
                <property name="capacity"><numeric-value number="24" unit="cookie"/></property>
            </properties>
        </tool>
    </tools>
    <tasks>
        <task operation="measure" id="measure-flour">
            <options>
                <option name="amount">
                    <!-- converted from 2.25 cup (all-purpose flour, 0.53 g/ml) -->
                    <numeric-value number="285" unit="g"/>
                </option>
            </options>
            <tools><tool ref="kitchen-scale" soil="none"/></tools>
            <inputs><input ref="flour"/></inputs>
            <outputs><output id="flour-measured">flour</output></outputs>
        </task>
        <!-- … measure tasks for the other ingredients … -->
        <task operation="beat" id="cream-butter-sugar" title="Cream butter and sugars">
            <tools><tool ref="bowl"/><tool ref="mixer"/></tools>
            <inputs><input ref="butter-measured"/><input ref="brown-sugar-measured"/><input ref="sugar-measured"/></inputs>
            <outputs><output id="creamed">creamed butter</output></outputs>
        </task>
        <task operation="split" id="portion-dough" title="Scoop into balls">
            <options><option name="unit-size"><numeric-value number="40" unit="g"/></option></options>
            <inputs><input ref="dough"/></inputs>
            <outputs><output id="cookie-dough" amount="24" unit="cookie">dough ball</output></outputs>
        </task>
        <task operation="bake-in-oven" id="bake-cookies" requires="oven">
            <options>
                <option name="temperature">
                    <!-- converted from 350 F -->
                    <numeric-value number="175" unit="celsius"/>
                </option>
                <option name="duration"><numeric-value number="11" unit="minutes"/></option>
            </options>
            <tools><tool ref="baking-sheet"/></tools>
            <inputs><input ref="cookie-on-sheet"/></inputs>
            <outputs><output id="baked-cookie" amount="24" unit="cookie">baked cookie</output><output id="sheet-back">baking sheet</output></outputs>
        </task>
        <task operation="cool" id="cool-cookies">
            <tools><tool ref="cooling-rack"/></tools>
            <inputs><input ref="baked-cookie"/></inputs>
            <outputs><output id="cookie" amount="24" unit="cookie" final="true">cookie</output></outputs>
        </task>
    </tasks>
</recipe>
`

const amount = (number, unit, taskId) => ({ number, unit, taskId })

export const MOCK_CONVERSIONS = [
  { taskId: 'measure-flour', ingredientId: 'flour', from: { number: 2.25, unit: 'cup' }, to: { number: 285, unit: 'g' }, method: 'density', note: 'all-purpose flour, 0.53 g/ml' },
  { taskId: 'measure-butter', ingredientId: 'butter', from: { number: 1, unit: 'cup' }, to: { number: 227, unit: 'g' }, method: 'density', note: 'butter, 0.95 g/ml' },
  { taskId: 'measure-brown-sugar', ingredientId: 'brown-sugar', from: { number: 0.75, unit: 'cup' }, to: { number: 165, unit: 'g' }, method: 'density', note: 'brown sugar (packed), 0.93 g/ml' },
  { taskId: 'measure-sugar', ingredientId: 'sugar', from: { number: 0.5, unit: 'cup' }, to: { number: 100, unit: 'g' }, method: 'density', note: 'granulated sugar, 0.85 g/ml' },
  { taskId: 'measure-chocolate-chips', ingredientId: 'chocolate-chips', from: { number: 2, unit: 'cup' }, to: { number: 340, unit: 'g' }, method: 'density', note: 'chocolate chips, 0.72 g/ml' },
  { taskId: 'measure-baking-soda', ingredientId: 'baking-soda', from: { number: 1, unit: 'teaspoon' }, to: { number: 1, unit: 'tsp' }, method: 'spoon', note: 'small amount kept as a metric spoon' },
  { taskId: 'bake-cookies', ingredientId: null, from: { number: 350, unit: 'F' }, to: { number: 175, unit: 'celsius' }, method: 'metric', note: null },
]

/** With a precision scale the small amounts are weighed too. */
export const MOCK_PRECISION_CONVERSIONS = MOCK_CONVERSIONS.map((c) =>
  c.taskId === 'measure-baking-soda' ? { ...c, to: { number: 4.6, unit: 'g' }, note: 'baking soda, 0.92 g/ml' } : c
)

export function makeMockCheck({ precisionScale = false, id = 'chewy-chocolate-chip-cookies', title = 'Chewy Chocolate Chip Cookies' } = {}) {
  return {
    ok: true,
    id,
    title,
    errors: [],
    warnings: ['The source gives no oven rack position; the scheduler assumes one sheet per oven slot.'],
    unitLint: [{ level: 'info', taskId: 'measure-salt', message: 'Salt ½ tsp kept as a spoon measure (under 10 g).' }],
    summary: {
      ingredients: [
        { id: 'flour', name: 'all-purpose flour', amounts: [amount(285, 'g', 'measure-flour')] },
        { id: 'baking-soda', name: 'baking soda', amounts: [precisionScale ? amount(4.6, 'g', 'measure-baking-soda') : amount(1, 'tsp', 'measure-baking-soda')] },
        { id: 'salt', name: 'fine salt', amounts: [precisionScale ? amount(3, 'g', 'measure-salt') : amount(0.5, 'tsp', 'measure-salt')] },
        { id: 'butter', name: 'butter', amounts: [amount(227, 'g', 'measure-butter')] },
        { id: 'brown-sugar', name: 'brown sugar', amounts: [amount(165, 'g', 'measure-brown-sugar')] },
        { id: 'sugar', name: 'white sugar', amounts: [amount(100, 'g', 'measure-sugar')] },
        { id: 'egg', name: 'egg', amounts: [amount(2, 'pieces', 'measure-egg')] },
        { id: 'vanilla', name: 'vanilla extract', amounts: [amount(2, 'tsp', 'measure-vanilla')] },
        { id: 'chocolate-chips', name: 'chocolate chips', amounts: [amount(340, 'g', 'measure-chocolate-chips')] },
      ],
      tasks: [
        { id: 'measure-flour', operation: 'measure', title: 'Measure: flour', units: null, unitStream: null },
        { id: 'measure-butter', operation: 'measure', title: 'Measure: butter', units: null, unitStream: null },
        { id: 'measure-brown-sugar', operation: 'measure', title: 'Measure: brown sugar', units: null, unitStream: null },
        { id: 'measure-sugar', operation: 'measure', title: 'Measure: sugar', units: null, unitStream: null },
        { id: 'measure-chocolate-chips', operation: 'measure', title: 'Measure: chocolate chips', units: null, unitStream: null },
        { id: 'soften-butter', operation: 'rest', title: 'Let the butter soften', units: 1, unitStream: null },
        { id: 'whisk-dry', operation: 'whisk', title: 'Whisk flour, soda and salt', units: 1, unitStream: null },
        { id: 'cream-butter-sugar', operation: 'beat', title: 'Cream butter and sugars', units: 1, unitStream: null },
        { id: 'beat-in-eggs', operation: 'incorporate', title: 'Beat in eggs and vanilla', units: 1, unitStream: null },
        { id: 'mix-in-flour', operation: 'mix-in-steps', title: 'Mix in the dry ingredients', units: 1, unitStream: null },
        { id: 'fold-chips', operation: 'fold', title: 'Fold in the chocolate chips', units: 1, unitStream: null },
        { id: 'line-sheets', operation: 'line', title: 'Line the baking sheets', units: 2, unitStream: 'sheet' },
        { id: 'portion-dough', operation: 'split', title: 'Scoop into 40 g balls', units: 24, unitStream: 'cookie' },
        { id: 'place-on-sheet', operation: 'place-on-sheet', title: 'Place on the sheets', units: 24, unitStream: 'cookie' },
        { id: 'bake-cookies', operation: 'bake-in-oven', title: 'Bake at 175 °C for 11 min', units: 24, unitStream: 'cookie' },
        { id: 'cool-cookies', operation: 'cool', title: 'Cool on the rack', units: 24, unitStream: 'cookie' },
      ],
      tools: [
        { id: 'baking-sheet', name: 'baking sheet', capacity: { number: 12, unit: 'cookie' } },
        { id: 'cooling-rack', name: 'cooling rack', capacity: { number: 24, unit: 'cookie' } },
        { id: 'mixer', name: 'hand mixer', capacity: null },
      ],
      serving: { temperature: 'room', hold: 7200 },
      finalOutputs: [{ id: 'cookie', name: 'cookie', amount: 24, unit: 'cookie' }],
    },
    plan: {
      ok: true,
      makespanSeconds: 3960,
      activeSeconds: 2280,
      tasks: 38,
      runs: [
        { participants: 1, makespanSeconds: 3960 },
        { participants: 3, makespanSeconds: 2640 },
      ],
      chains: [{ stages: ['portion-dough', 'place-on-sheet', 'bake-cookies', 'cool-cookies'], units: 24, unit: 'cookie', organisation: 'pipeline' }],
      diagnostics: ['The oven is the bottleneck: 2 sheets bake one after the other.'],
    },
  }
}

export function makeMockResult({ precisionScale = false, url = MOCK_SOURCE_URL, attempts = 2 } = {}) {
  return {
    id: 'chewy-chocolate-chip-cookies',
    xml: MOCK_XML,
    check: makeMockCheck({ precisionScale }),
    conversions: precisionScale ? MOCK_PRECISION_CONVERSIONS : MOCK_CONVERSIONS,
    source: { url, title: 'The Best Chewy Chocolate Chip Cookies', structured: true, times: { prep: 1200, cook: 1320, total: 4500 } },
    attempts,
    llm: { provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: null, hasKey: true },
  }
}

/** Recipes imported earlier on the simulated server. */
export const MOCK_IMPORTED_RECIPES = [
  { id: 'beef-stew', title: 'Beef stew', serving: { temperature: 'hot', hold: 1800 }, source: 'imported', sourceUrl: 'https://www.recipetineats.com/beef-stew/' },
  { id: 'beef-stew-2', title: 'Beef stew', serving: { temperature: 'hot', hold: 1800 }, source: 'imported', sourceUrl: 'https://www.bbcgoodfood.com/recipes/beef-stew' },
  { id: 'korvapuustit', title: 'Korvapuustit', serving: null, source: 'imported', sourceUrl: null },
]
