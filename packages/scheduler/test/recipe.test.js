import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMParser } from '@xmldom/xmldom'
import { parseRecipe, validateRecipe, checkReferences } from '../src/recipe/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const recipesDir = join(here, '..', '..', 'server', 'src', 'recipes')

const catalogue = {
  measure: { name: 'measure', minInputs: 1, maxInputs: 1, minOutputs: 1, maxOutputs: 1, options: { amount: { required: true, type: 'numeric', defaultUnit: null } } },
  mix: { name: 'mix', minInputs: 1, maxInputs: null, minOutputs: 1, maxOutputs: null, options: {} },
  crumble: { name: 'crumble', minInputs: 1, maxInputs: 1, minOutputs: 1, maxOutputs: null, options: {} },
  incorporate: { name: 'incorporate', minInputs: 2, maxInputs: null, minOutputs: 1, maxOutputs: null, options: {} },
  roll: { name: 'roll', minInputs: 1, maxInputs: 1, minOutputs: 1, maxOutputs: null, options: {} },
  'bake-in-oven': {
    name: 'bake-in-oven', minInputs: 1, maxInputs: 1, minOutputs: 1, maxOutputs: 1,
    options: { temperature: { required: true, type: 'numeric', defaultUnit: null }, duration: { required: true, type: 'numeric', defaultUnit: 'minutes' } },
  },
  raise: { name: 'raise', minInputs: 1, maxInputs: 1, minOutputs: 1, maxOutputs: null, options: { duration: { required: true, type: 'numeric', defaultUnit: 'seconds' } } },
  note: { name: 'note', minInputs: 0, maxInputs: null, minOutputs: 0, maxOutputs: null, options: { label: { required: false, type: 'text', defaultUnit: null } } },
}

const parse = (xml, opts = {}) => parseRecipe(xml, { DOMParser, ...opts })

const bunsXml = `<?xml version="1.0" encoding="UTF-8"?>
<recipe id="buns" ref="https://example.org/buns">
  <title>Buns</title>
  <serving temperature="hot" hold="10"/>
  <ingredients>
    <ingredient id="milk">milk<properties><property name="fat"><numeric-value number="3.5" unit="percent"/></property></properties></ingredient>
    <ingredient id="yeast">fresh yeast</ingredient>
    <ingredient id="flour">wheat flour</ingredient>
  </ingredients>
  <tools>
    <tool id="bowl">large bowl<properties><property name="capacity"><numeric-value number="4" unit="liters"/></property></properties></tool>
    <tool id="sheet" type="baking-sheet">baking sheet<properties><property name="capacity"><numeric-value number="16" unit="bun"/></property><property name="material" value="steel"/></properties></tool>
    <tool id="oven">oven</tool>
  </tools>
  <tasks>
    <task operation="measure" id="measure-milk" requires="scale">
      <options><option name="amount"><numeric-value number="5" unit="deciliters"/></option></options>
      <inputs><input ref="milk"/></inputs>
      <tools><tool ref="bowl" reserved="true" soil="wash"/></tools>
      <outputs><output id="measured-milk" hold="30" hold-unit="minutes">milk</output></outputs>
    </task>
    <join>
      <task operation="crumble">
        <inputs><input ref="yeast"/></inputs>
        <outputs><output id="crumbled-yeast">crumbled yeast</output></outputs>
      </task>
      <task operation="incorporate">
        <inputs><input ref="measured-milk"/><input ref="crumbled-yeast"/></inputs>
        <tools><tool ref="bowl" qty="1"/></tools>
        <outputs><output id="milk-yeast" volume="2.5" volume-unit="liters">milk and yeast</output></outputs>
      </task>
    </join>
    <task operation="mix">
      <inputs><input ref="milk-yeast"/><input ref="flour" amount="900"/></inputs>
      <tools><tool ref="bowl" reserved="true"/></tools>
      <outputs><output id="dough" volume="3">dough</output></outputs>
    </task>
    <task operation="roll" id="roll">
      <instructions>
        Roll the <input ref="dough" amount="1"/> into
        <output id="dough-sphere" amount="32" unit="bun" hold="20">buns</output> and place them on a <tool ref="sheet" qty="2"/>.
        Each weighs about <option name="weight"><numeric-value number="50" unit="g"/></option>.
      </instructions>
    </task>
    <task operation="bake-in-oven">
      <options>
        <option name="temperature"><numeric-value number="225" unit="celcius"/></option>
        <option name="duration"><numeric-value number="12" unit="minutes"/></option>
      </options>
      <input ref="dough-sphere"/>
      <tool ref="oven"/>
      <outputs>
        <output id="buns" amount="32" unit="bun" final="true">buns</output>
        <tool ref="sheet"/>
      </outputs>
    </task>
  </tasks>
</recipe>`

describe('parseRecipe', () => {
  const model = parse(bunsXml)

  test('recipe header: id attribute, title, ref, serving in seconds', () => {
    assert.equal(model.id, 'buns')
    assert.equal(model.title, 'Buns')
    assert.equal(model.ref, 'https://example.org/buns')
    assert.deepEqual(model.serving, { temperature: 'hot', hold: 600 })
  })

  test('id falls back to the option, then kebab-case of the title', () => {
    const xml = '<recipe><title>Simple Butter Sandwich</title><ingredients/><tools/><tasks/></recipe>'
    assert.equal(parse(xml, { id: 'given' }).id, 'given')
    assert.equal(parse(xml).id, 'simple-butter-sandwich')
  })

  test('serving is null when absent', () => {
    assert.equal(parse('<recipe><title>X</title><ingredients/><tools/><tasks/></recipe>').serving, null)
  })

  test('mixed content: ingredient and tool names come from direct text nodes only', () => {
    assert.deepEqual(model.ingredients[0], { id: 'milk', name: 'milk', properties: { fat: { number: 3.5, unit: 'percent' } } })
    assert.deepEqual(model.ingredients[1], { id: 'yeast', name: 'fresh yeast', properties: {} })
    assert.deepEqual(model.tools[0], {
      id: 'bowl', name: 'large bowl', type: 'bowl', capacity: { number: 4, unit: 'l' }, properties: { capacity: { number: 4, unit: 'l' } },
    })
    assert.equal(model.tools[1].type, 'baking-sheet')
    assert.deepEqual(model.tools[1].capacity, { number: 16, unit: 'bun' })
    assert.deepEqual(model.tools[1].properties.material, { value: 'steel' })
    assert.deepEqual(model.tools[2], { id: 'oven', name: 'oven', type: 'oven', capacity: null, properties: {} })
  })

  test('plain task: options, inputs, tools, outputs, requires, generated ids', () => {
    const t = model.tasks[0]
    assert.equal(t.id, 'measure-milk')
    assert.equal(t.operation, 'measure')
    assert.deepEqual(t.options, { amount: { number: 5, unit: 'dl' } })
    assert.deepEqual(t.inputs, [{ ref: 'milk', amount: null, text: null }])
    assert.deepEqual(t.tools, [{ ref: 'bowl', reserved: true, amount: 1, soil: 'wash', qty: 1 }])
    assert.deepEqual(t.outputs, [{ id: 'measured-milk', name: 'milk', amount: null, unit: null, hold: 1800, volume: null, final: false }])
    assert.deepEqual(t.returnsTools, [])
    assert.equal(t.instructions, null)
    assert.deepEqual(t.requires, ['scale'])
    assert.equal(t.steps, undefined)

    assert.equal(model.tasks[2].id, 'buns:t5')
    assert.deepEqual(model.tasks[2].inputs, [{ ref: 'milk-yeast', amount: null, text: null }, { ref: 'flour', amount: 900, text: null }])
    assert.deepEqual(model.tasks[2].outputs[0].volume, { number: 3, unit: 'l' })
    assert.deepEqual(model.tasks[2].requires, [])
  })

  test('join: flattened steps, inputs not produced inside, outputs not consumed inside, tools union', () => {
    const j = model.tasks[1]
    assert.equal(j.operation, 'join')
    assert.equal(j.id, 'buns:join2')
    assert.equal(j.steps.length, 2)
    assert.deepEqual(j.steps.map((s) => s.id), ['buns:t3', 'buns:t4'])
    assert.deepEqual(j.inputs.map((i) => i.ref), ['yeast', 'measured-milk'])
    assert.deepEqual(j.outputs.map((o) => o.id), ['milk-yeast'])
    assert.deepEqual(j.outputs[0].volume, { number: 2.5, unit: 'l' })
    assert.deepEqual(j.tools, [{ ref: 'bowl', reserved: false, amount: 1, soil: null, qty: 1 }])
    assert.deepEqual(j.options, {})
    assert.equal(j.instructions, null)
  })

  test('join keeps its id attribute', () => {
    const xml = `<recipe id="r"><title>R</title><ingredients><ingredient id="a">a</ingredient></ingredients><tools/><tasks>
      <join id="prep"><task operation="mix"><input ref="a"/><output id="b"/></task><task operation="mix"><input ref="b"/><output id="c"/></task></join>
    </tasks></recipe>`
    assert.equal(parse(xml).tasks[0].id, 'prep')
  })

  test('instructions: ordered items, collapsed whitespace, refs merged into inputs/tools/outputs/options', () => {
    const t = model.tasks[3]
    assert.equal(t.id, 'roll')
    assert.deepEqual(t.instructions, [
      { text: 'Roll the' },
      { input: 'dough', amount: 1 },
      { text: 'into' },
      { output: 'dough-sphere' },
      { text: 'and place them on a' },
      { tool: 'sheet' },
      { text: '. Each weighs about' },
      { option: 'weight' },
      { text: '.' },
    ])
    assert.deepEqual(t.inputs, [{ ref: 'dough', amount: 1, text: null }])
    assert.deepEqual(t.tools, [{ ref: 'sheet', reserved: false, amount: 1, soil: null, qty: 2 }])
    assert.deepEqual(t.outputs, [{ id: 'dough-sphere', name: 'buns', amount: 32, unit: 'bun', hold: 1200, volume: null, final: false }])
    assert.deepEqual(t.options, { weight: { number: 50, unit: 'g' } })
  })

  test('container inputs come before instruction refs and are deduped by ref keeping the amount', () => {
    const xml = `<recipe id="r"><title>R</title>
      <ingredients><ingredient id="a">a</ingredient><ingredient id="b">b</ingredient></ingredients>
      <tools><tool id="k">knife</tool></tools>
      <tasks><task operation="mix">
        <instructions>Mix <input ref="b" amount="2"/> with <input ref="a"/> using the <tool ref="k" reserved="true"/></instructions>
        <inputs><input ref="a"/></inputs>
        <tool ref="k"/>
        <input ref="b"/>
        <outputs><output id="c">c</output></outputs>
      </task></tasks></recipe>`
    const t = parse(xml).tasks[0]
    assert.deepEqual(t.inputs, [{ ref: 'a', amount: null, text: null }, { ref: 'b', amount: 2, text: null }])
    assert.deepEqual(t.tools, [{ ref: 'k', reserved: true, amount: 1, soil: null, qty: 1 }])
  })

  test('task-level input/tool, tools in <outputs> become returnsTools, canonical temperature unit, final', () => {
    const t = model.tasks[4]
    assert.equal(t.id, 'buns:t7', 'explicit-id tasks still occupy their document position')
    assert.deepEqual(t.options, { temperature: { number: 225, unit: 'celsius' }, duration: { number: 12, unit: 'minutes' } })
    assert.deepEqual(t.inputs, [{ ref: 'dough-sphere', amount: null, text: null }])
    assert.deepEqual(t.tools, [{ ref: 'oven', reserved: false, amount: 1, soil: null, qty: 1 }])
    assert.deepEqual(t.outputs, [{ id: 'buns', name: 'buns', amount: 32, unit: 'bun', hold: null, volume: null, final: true }])
    assert.deepEqual(t.returnsTools, [{ ref: 'sheet', name: null }])
  })

  test('options with text-content or no value become { text }', () => {
    const xml = `<recipe id="r"><title>R</title><ingredients/><tools/><tasks><task operation="note">
      <options><option name="label"><text-content> keep  warm </text-content></option><option name="flag"/></options>
      <output id="o"/>
    </task></tasks></recipe>`
    assert.deepEqual(parse(xml).tasks[0].options, { label: { text: 'keep warm' }, flag: { text: '' } })
  })

  test('hold-unit defaults to minutes and accepts seconds/hours', () => {
    const xml = `<recipe id="r"><title>R</title><ingredients/><tools/><tasks><task operation="note">
      <output id="a" hold="90" hold-unit="seconds"/><output id="b" hold="2" hold-unit="hours"/><output id="c" hold="1"/>
    </task></tasks></recipe>`
    assert.deepEqual(parse(xml).tasks[0].outputs.map((o) => o.hold), [90, 7200, 60])
  })

  test('legacy <batch> throws an error naming the task', () => {
    const xml = `<recipe id="r"><title>R</title><ingredients><ingredient id="a">a</ingredient></ingredients><tools/><tasks>
      <batch id="per-bun"><tasks><task operation="roll" id="roll-one"><input ref="a"/><output id="b"/></task></tasks></batch>
    </tasks></recipe>`
    assert.throws(() => parse(xml), (e) => /batch/.test(e.message) && /per-bun/.test(e.message) && /roll-one/.test(e.message) && /not supported/.test(e.message))
  })

  test('legacy <task operation="batch"> with nested <tasks> throws an error naming the task', () => {
    const xml = `<recipe id="r"><title>R</title><ingredients><ingredient id="a">a</ingredient></ingredients><tools/><tasks>
      <task operation="batch" id="per-bun"><inputs><input ref="a"/></inputs><tasks><task operation="roll" id="roll-one"><input ref="a"/><output id="b"/></task></tasks></task>
    </tasks></recipe>`
    assert.throws(() => parse(xml), (e) => /batch/.test(e.message) && /per-bun/.test(e.message) && /roll-one/.test(e.message) && /not supported/.test(e.message))
  })

  test('rejects non-recipe documents', () => {
    assert.throws(() => parse('<operations/>'), /Expected a <recipe>/)
  })
})

describe('parseRecipe on the server recipes', () => {
  // These files are v2 recipes maintained elsewhere; only assert structure that survives wording edits.
  const shapes = ['text', 'input', 'tool', 'output', 'option']
  const load = (file) => parse(readFileSync(join(recipesDir, file), 'utf8'), { id: file.replace(/\.xml$/, '') })

  const checkStructure = (model) => {
    const { errors } = checkReferences(model)
    assert.deepEqual(errors, [])
    const leaf = model.tasks.flatMap((t) => t.steps || [t])
    assert.ok(leaf.length > 0)
    for (const task of leaf) {
      assert.ok(task.operation)
      assert.ok(task.id.length > 0)
      assert.ok(Array.isArray(task.requires))
      if (task.instructions === null) continue
      for (const item of task.instructions) {
        const keys = Object.keys(item).filter((k) => k !== 'amount')
        assert.equal(keys.length, 1)
        assert.ok(shapes.includes(keys[0]), `unexpected instruction item ${JSON.stringify(item)}`)
        if (item.input) assert.ok(task.inputs.some((i) => i.ref === item.input), `instruction input ${item.input} merged into inputs`)
        if (item.tool) assert.ok(task.tools.some((t) => t.ref === item.tool), `instruction tool ${item.tool} merged into tools`)
        if (item.output) assert.ok(task.outputs.some((o) => o.id === item.output))
        if (item.option) assert.ok(item.option in task.options)
        if (item.text) assert.ok(!/\s\s/.test(item.text), 'whitespace collapsed')
      }
    }
  }

  test('tiramisu.xml', () => {
    const model = load('tiramisu.xml')
    assert.equal(model.id, 'tiramisu')
    assert.match(model.title, /Tiramisu/)
    assert.ok(model.ingredients.some((i) => i.id === 'ladyfingers' && i.name === 'ladyfingers'))
    assert.ok(model.tools.some((t) => t.id === 'mixing-bowl' && t.name === 'bowl'))
    const measure = model.tasks.find((t) => t.operation === 'measure')
    assert.equal(measure.options.amount.number, 250)
    assert.equal(measure.options.amount.unit, 'g')
    const soak = model.tasks.find((t) => t.operation === 'soak')
    assert.ok(Array.isArray(soak.instructions))
    assert.ok(soak.inputs.some((i) => i.ref === 'ladyfingers' && i.amount === 10), 'amount from the instructions ref is kept')
    assert.ok(soak.tools.some((t) => t.ref === 'plate'))
    assert.equal(soak.tools.filter((t) => t.ref === 'plate').length, 1, 'repeated <tool ref="plate"/> deduped')
    checkStructure(model)
  })

  test('sandwich.xml', () => {
    const model = load('sandwich.xml')
    assert.equal(model.id, 'sandwich')
    assert.equal(model.title, 'Simple Butter Sandwich')
    const split = model.tasks.find((t) => t.operation === 'split')
    assert.deepEqual(split.options, { parts: { number: 2 } })
    const place = model.tasks.find((t) => t.operation === 'place')
    assert.ok(Array.isArray(place.instructions))
    assert.deepEqual(place.instructions.filter((i) => !i.text), [{ input: 'buttered-slice' }, { tool: 'plate' }])
    assert.deepEqual(place.inputs.map((i) => i.ref), ['buttered-slice'])
    assert.deepEqual(place.tools.map((t) => t.ref), ['plate'])
    checkStructure(model)
  })
})

describe('validateRecipe', () => {
  test('the buns fixture is valid against the catalogue', () => {
    const result = validateRecipe(parse(bunsXml), catalogue)
    assert.deepEqual(result.errors, [])
    assert.equal(result.valid, true)
    assert.ok(result.warnings.some((w) => /option 'weight'/.test(w)))
  })

  test('duplicate ids are errors', () => {
    const xml = `<recipe id="r"><title>R</title>
      <ingredients><ingredient id="a">a</ingredient><ingredient id="a">again</ingredient></ingredients>
      <tools><tool id="t">t</tool></tools>
      <tasks><task operation="mix" id="t"><input ref="a"/><output id="a"/></task></tasks></recipe>`
    const result = validateRecipe(parse(xml), catalogue)
    assert.equal(result.valid, false)
    assert.equal(result.errors.filter((e) => /Duplicate id 'a'/.test(e)).length, 2)
    assert.ok(result.errors.some((e) => /Duplicate id 't'/.test(e)))
  })

  test('unresolved and out-of-order references are errors', () => {
    const xml = `<recipe id="r"><title>R</title><ingredients><ingredient id="a">a</ingredient></ingredients><tools/>
      <tasks>
        <task operation="mix"><input ref="later"/><tool ref="ghost"/><output id="x"/><outputs><tool ref="phantom"/></outputs></task>
        <task operation="mix"><input ref="nothing"/><output id="later"/></task>
      </tasks></recipe>`
    const { errors } = checkReferences(parse(xml))
    assert.ok(errors.some((e) => /consumes 'later' before task 'r:t2' produces it/.test(e)))
    assert.ok(errors.some((e) => /unknown tool 'ghost'/.test(e)))
    assert.ok(errors.some((e) => /returns unknown tool 'phantom'/.test(e)))
    assert.ok(errors.some((e) => /unknown input 'nothing'/.test(e)))
  })

  test('unknown operation, missing required option and wrong option type are errors', () => {
    const xml = `<recipe id="r"><title>R</title><ingredients><ingredient id="a">a</ingredient></ingredients><tools/>
      <tasks>
        <task operation="fly"><input ref="a"/><output id="b"/></task>
        <task operation="bake-in-oven"><options><option name="temperature"><text-content>hot</text-content></option></options><input ref="b"/><output id="c"/></task>
      </tasks></recipe>`
    const { errors, valid } = validateRecipe(parse(xml), catalogue)
    assert.equal(valid, false)
    assert.ok(errors.some((e) => /unknown operation 'fly'/.test(e)))
    assert.ok(errors.some((e) => /missing required option 'duration'/.test(e)))
    assert.ok(errors.some((e) => /option 'temperature' must be numeric/.test(e)))
  })

  test('unrecognised units and unit stream mismatches are warnings, not errors', () => {
    const xml = `<recipe id="r"><title>R</title><ingredients><ingredient id="a">a</ingredient></ingredients><tools/>
      <tasks>
        <task operation="raise"><options><option name="duration"><numeric-value number="1" unit="fortnight"/></option></options><input ref="a"/><output id="b" unit="bun"/></task>
        <task operation="roll"><input ref="b"/><output id="c" unit="loaf"/></task>
        <task operation="roll"><input ref="c"/><output id="d" unit="loaf"/></task>
      </tasks></recipe>`
    const result = validateRecipe(parse(xml), catalogue)
    assert.deepEqual(result.errors, [])
    assert.ok(result.warnings.some((w) => /unrecognised unit 'fortnight'/.test(w)))
    assert.equal(result.warnings.filter((w) => /unit 'bun' but produces unit\(s\) 'loaf'/.test(w)).length, 1)
  })

  test('a recipe whose outputs are all consumed has no final output', () => {
    const xml = `<recipe id="r"><title>R</title><ingredients><ingredient id="a">a</ingredient></ingredients><tools/>
      <tasks><task operation="mix"><input ref="a"/><output id="b"/></task><task operation="mix"><input ref="b"/></task></tasks></recipe>`
    const { errors } = checkReferences(parse(xml))
    assert.ok(errors.some((e) => /No final output/.test(e)))
  })

  test('join steps are checked individually; refs inside the join resolve to earlier steps', () => {
    const result = validateRecipe(parse(bunsXml), catalogue)
    assert.deepEqual(result.errors, [])
  })
})

describe('DOM compatibility', () => {
  test('works with @xmldom/xmldom DOMParser (missing attributes, comments, CDATA)', () => {
    const xml = `<recipe id="r"><title>R</title><ingredients><ingredient id="a"><![CDATA[cold milk]]></ingredient></ingredients><tools/>
      <tasks><task operation="mix"><!-- comment --><instructions>Stir <!-- c --> the <input ref="a"/></instructions><output id="b"/></task></tasks></recipe>`
    const model = parseRecipe(xml, { DOMParser })
    assert.equal(model.ref, null)
    assert.equal(model.ingredients[0].name, 'cold milk')
    assert.deepEqual(model.tasks[0].instructions, [{ text: 'Stir' }, { text: 'the' }, { input: 'a' }])
    assert.equal(model.tasks[0].outputs[0].name, null)
  })
})
