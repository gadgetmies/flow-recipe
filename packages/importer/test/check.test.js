import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkRecipeXml, conversions } from '../src/check.js'
import { checkWellFormed } from '../src/wellformed.js'
import { RECIPES_DIR } from '../src/guide.js'
import { fixture } from './helpers.js'

describe('checkRecipeXml on the built-in recipes', () => {
  const files = readdirSync(RECIPES_DIR).filter((f) => f.endsWith('.xml') && f !== 'operations.xml').sort()
  test('there are built-in recipes', () => assert.ok(files.length >= 5))
  for (const file of files) {
    test(`${file} has no errors and a dry-run plan`, () => {
      const id = file.replace(/\.xml$/, '')
      const r = checkRecipeXml(readFileSync(join(RECIPES_DIR, file), 'utf8'), { id })
      assert.deepEqual(r.errors, [], r.errors.join('\n'))
      assert.equal(r.ok, true)
      assert.equal(r.id, id)
      assert.ok(r.title)
      assert.ok(r.summary.tasks.length > 0)
      assert.ok(r.plan, 'plan ran')
      assert.equal(r.plan.error, undefined)
      assert.ok(r.plan.makespanSeconds > 0)
      assert.ok(r.plan.activeSeconds > 0)
      assert.equal(r.plan.runs.length, 2)
      assert.deepEqual(r.plan.runs.map((x) => x.participants), [1, 3])
    })
  }
})

describe('checkRecipeXml on generated-looking documents', () => {
  test('summary, unit stream chain and final outputs of the cookie fixture', () => {
    const r = checkRecipeXml(fixture('cookies.xml'))
    assert.equal(r.ok, true, r.errors.join('\n'))
    assert.equal(r.title, 'Brown Butter Cookies')
    const butter = r.summary.ingredients.find((i) => i.id === 'butter')
    assert.deepEqual(butter.amounts, [{ number: 1, unit: 'cup', taskId: 'measure-butter' }])
    assert.equal(butter.storage, 'fridge')
    const roll = r.summary.tasks.find((t) => t.id === 'roll-balls')
    assert.equal(roll.unitStream, 'cookie')
    assert.equal(roll.units, 24)
    assert.deepEqual(r.summary.finalOutputs.map((o) => o.id), ['cookies'])
    assert.deepEqual(r.summary.serving, { temperature: 'ambient', hold: null })
    const sheet = r.summary.tools.find((t) => t.id === 'baking-sheet')
    assert.deepEqual(sheet.capacity, { number: 12, unit: 'cookie' })
    assert.equal(sheet.returned, true)
    assert.equal(r.plan.ok, true, r.plan.diagnostics.join('\n'))
    const chain = r.plan.chains.find((c) => c.stream === 'cookie')
    assert.ok(chain, 'a cookie chain is detected')
    assert.deepEqual(chain.stages.slice(0, 2), ['portion-dough', 'roll-balls'])
    if (conversions()) assert.ok(r.unitLint.some((l) => l.taskId === 'measure-butter'), JSON.stringify(r.unitLint))
  })

  test('reference and catalogue errors', () => {
    const xml = fixture('cookies.xml')
      .replace('<input ref="egg-for-dough"/>', '<input ref="egg-for-doug"/>')
      .replace('operation="spherify"', 'operation="roll-into-tiny-balls"')
    const r = checkRecipeXml(xml)
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /unknown input 'egg-for-doug'/.test(e)), r.errors.join('\n'))
    assert.ok(r.errors.some((e) => /unknown operation 'roll-into-tiny-balls'/.test(e)), r.errors.join('\n'))
    assert.equal(r.plan, null, 'no dry run for invalid recipes')
  })

  test('never throws on bad input', () => {
    for (const bad of [null, undefined, 42, '', '   ', 'hello', '<html><body/></html>', '<recipe>', '<recipe><title>x</title><tasks><task/></tasks></recipe>', '<recipe><tasks><batch/></tasks></recipe>', '<?xml version="1.0"?>\n<recipe version="2">\n<title>A &nbsp; B</title>\n</recipe>']) {
      const r = checkRecipeXml(bad)
      assert.equal(r.ok, false, String(bad))
      assert.ok(r.errors.length > 0, String(bad))
    }
    const r = checkRecipeXml('<?xml version="1.0"?>\n<recipe version="2">\n  <title>A &nbsp; B</title>\n</recipe>')
    assert.match(r.errors[0], /line 3, column \d+: Unknown entity '&nbsp;'/)
  })

  test('missing version is a warning, planCheck=false skips the dry run', () => {
    const r = checkRecipeXml(fixture('cookies.xml').replace('version="2" ', ''), { planCheck: false })
    assert.equal(r.ok, true)
    assert.ok(r.warnings.some((w) => /version="2"/.test(w)))
    assert.equal(r.plan, null)
  })
})

describe('checkWellFormed', () => {
  test('well-formed documents pass', () => {
    assert.deepEqual(checkWellFormed('<?xml version="1.0"?><!-- c --><a x="1" y=\'2\'><b/><![CDATA[<x>]]>&amp;&#38;&#x26;</a>'), [])
  })
  test('reports problems with positions', () => {
    const cases = [
      ['<a><b></a>', /does not match <b>/],
      ['<a x=1/>', /must be quoted/],
      ['<a x="1" x="2"/>', /repeated/],
      ['<a>AT&T</a>', /Unescaped '&'/],
      ['<a>1 < 2</a>', /'<' must start a tag/],
      ['<a/><b/>', /Second root/],
      ['<a>', /never closed/],
      ['text', /Text before the root|No root/],
      ['<a></a>tail', /Text after/],
      ['<a><!-- x -- y --></a>', /'--' is not allowed/],
    ]
    for (const [xml, re] of cases) {
      const errors = checkWellFormed(xml)
      assert.ok(errors.length > 0, xml)
      assert.ok(errors.some((e) => re.test(e.message)), `${xml}: ${JSON.stringify(errors)}`)
      assert.ok(errors.every((e) => e.line >= 1 && e.column >= 1))
    }
    assert.equal(checkWellFormed('<a>\n\n<b></c></a>')[0].line, 3)
  })
})
