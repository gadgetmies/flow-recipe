import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { importRecipe, suggestRecipeId, extractXml, setRootAttributes, ImportError } from '../src/import.js'
import { buildMessages, buildRepairMessage, catalogueSummary, loadGuide, loadOperationsXml, formatSource } from '../src/guide.js'
import { catalogueFor, conversions } from '../src/check.js'
import { extractRecipeSource } from '../src/source.js'
import { fixture, startServer } from './helpers.js'

const GOOD = fixture('cookies.xml')
const BROKEN = GOOD.replace('<input ref="egg-for-dough"/>', '<input ref="egg-for-doug"/>')

describe('suggestRecipeId', () => {
  test('kebab-case, diacritics folded, unique', () => {
    assert.equal(suggestRecipeId('Classic Chocolate Chip Cookies!'), 'classic-chocolate-chip-cookies')
    assert.equal(suggestRecipeId('Crème Brûlée & Friends'), 'creme-brulee-and-friends')
    assert.equal(suggestRecipeId('Äidin karjalanpiirakat'), 'aidin-karjalanpiirakat')
    assert.equal(suggestRecipeId("Grandma's Soup"), 'grandmas-soup')
    assert.equal(suggestRecipeId('Buns', ['buns']), 'buns-2')
    assert.equal(suggestRecipeId('Buns', ['buns', 'buns-2', 'buns-3']), 'buns-4')
    assert.equal(suggestRecipeId(''), 'recipe')
    assert.equal(suggestRecipeId('!!!'), 'recipe')
    assert.equal(suggestRecipeId('7 layer dip'), 'recipe-7-layer-dip')
    const long = suggestRecipeId('A very long recipe title that goes on and on about the wonderful cake we will bake today')
    assert.ok(long.length <= 60 && !long.endsWith('-'), long)
  })
})

describe('LLM output handling', () => {
  test('extractXml from fences, prose and truncated answers', () => {
    assert.equal(extractXml('Here you go:\n```xml\n<?xml version="1.0"?>\n<recipe a="1"></recipe>\n```\nEnjoy!'), '<?xml version="1.0"?>\n<recipe a="1"></recipe>')
    assert.equal(extractXml('Sure. <recipe><title>x</title></recipe> Bye'), '<recipe><title>x</title></recipe>')
    assert.equal(extractXml('<?xml version="1.0"?><recipe><title>cut'), '<?xml version="1.0"?><recipe><title>cut')
    assert.equal(extractXml('I cannot do that.'), null)
  })

  test('setRootAttributes keeps the document and replaces or adds attributes', () => {
    const xml = '<?xml version="1.0"?>\n<recipe id="old" xmlns:x="u">\n<title>T</title></recipe>'
    const out = setRootAttributes(xml, { version: '2', id: 'new-id', ref: 'https://e.org/?a=1&b="2"' })
    assert.equal(out, '<?xml version="1.0"?>\n<recipe id="new-id" xmlns:x="u" version="2" ref="https://e.org/?a=1&amp;b=&quot;2&quot;">\n<title>T</title></recipe>')
  })
})

describe('prompt', () => {
  test('buildMessages: guide, catalogue, units policy, rules and the structured source', () => {
    const source = extractRecipeSource(fixture('jsonld.html'), 'https://example.org/cookies')
    const guide = loadGuide()
    const catalogueText = catalogueSummary(catalogueFor(loadOperationsXml()))
    const { system, messages } = buildMessages({ source, guide, catalogueText, precisionScale: false, servings: 48, notes: 'Use brown butter.' })
    assert.ok(system.includes(guide.trim().slice(0, 200)), 'full guide in the system prompt')
    assert.match(system, /bake-in-oven — Bake \| in 1 → out 1/)
    assert.ok(!/^gather /m.test(catalogueText), 'internal operations are not offered')
    assert.match(system, /NO precision scale/)
    assert.match(system, /exactly ONE complete XML document/)
    assert.match(system, /Unit streams/)
    assert.equal(messages.length, 1)
    const user = messages[0].content
    assert.match(user, /Source URL: https:\/\/example.org\/cookies/)
    assert.match(user, /- 2 ¼ cups all-purpose flour/)
    assert.match(user, /2\. Cream the butter and sugar/)
    assert.match(user, /Times: prep 15 min, cook 11 min, total 1 h 26 min/)
    assert.match(user, /Servings wanted: 48\. The source makes 24; multiply every amount by 2/)
    assert.match(user, /Use brown butter\./)
    assert.match(user, /ref="https:\/\/example.org\/cookies"/)
    const precise = buildMessages({ source, guide: 'G', catalogueText: 'C', precisionScale: true })
    assert.match(precise.system, /HAS a precision scale/)
  })

  test('unstructured sources pass the page text', () => {
    const source = extractRecipeSource(fixture('plain.html'), 'https://example.org/soup')
    const text = formatSource({ ...source, ingredients: [], steps: [] })
    assert.match(text, /no structured recipe data was found/)
    assert.match(text, /- 5 dl vegetable stock/)
  })

  test('repair message lists errors, plan failures and warnings', () => {
    const msg = buildRepairMessage({ errors: ['E1'], warnings: ['W1'], unitLint: [{ level: 'warning', taskId: 't', message: 'cups' }, { level: 'info', taskId: 't', message: 'fyi' }], plan: { ok: false, diagnostics: ['3 cooks: [DEADLOCK] stuck', '[REPAIR_START] meh'] } }, { attempt: 1 })
    assert.match(msg, /complete corrected XML document/)
    assert.match(msg, /- E1/)
    assert.match(msg, /\[DEADLOCK\] stuck/)
    assert.ok(!msg.includes('REPAIR_START'))
    assert.match(msg, /- W1/)
    assert.match(msg, /Task 't': cups/)
    assert.ok(!msg.includes('fyi'))
  })
})

describe('importRecipe with the mock LLM', () => {
  let server
  let saved
  before(async () => {
    saved = process.env.FLOW_IMPORT_ALLOW_PRIVATE
    process.env.FLOW_IMPORT_ALLOW_PRIVATE = '1'
    server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(fixture('jsonld.html'))
    })
  })
  after(async () => {
    await server.close()
    if (saved === undefined) delete process.env.FLOW_IMPORT_ALLOW_PRIVATE
    else process.env.FLOW_IMPORT_ALLOW_PRIVATE = saved
  })

  test('end to end: fetch, generate, convert, check, repair once, done', async () => {
    const calls = []
    const llm = {
      provider: 'mock',
      mockResponse: (messages, { system }) => {
        calls.push({ messages: messages.map((m) => ({ ...m })), system })
        return calls.length === 1 ? `Here is the recipe:\n\n\`\`\`xml\n${BROKEN}\n\`\`\`` : GOOD
      },
    }
    const stages = []
    const result = await importRecipe({ url: `${server.url}/cookies`, llm, onProgress: (stage, detail) => stages.push([stage, detail.attempt || null]), existingIds: ['brown-butter-cookies'] })

    assert.deepEqual(stages.map((s) => s[0]), ['fetching', 'generating', 'converting', 'checking', 'repairing', 'converting', 'checking', 'done'])
    assert.equal(result.attempts, 2)
    assert.equal(calls.length, 2)
    // the repair round continues the same conversation and names the error
    assert.equal(calls[1].messages.length, 3)
    assert.equal(calls[1].messages[1].role, 'assistant')
    assert.match(calls[1].messages[2].content, /unknown input 'egg-for-doug'/)
    assert.match(calls[0].system, /AUTHORING GUIDE/)
    assert.match(calls[0].messages[0].content, /Classic Chocolate Chip Cookies/)

    assert.equal(result.check.ok, true, result.check.errors.join('\n'))
    assert.equal(result.id, 'brown-butter-cookies-2')
    assert.match(result.xml, /<recipe version="2" id="brown-butter-cookies-2"[^>]* ref="http:\/\/127\.0\.0\.1:\d+\/cookies"/)
    assert.equal(result.check.id, 'brown-butter-cookies-2')
    assert.ok(result.check.plan && result.check.plan.ok)
    assert.deepEqual(result.source, { url: `${server.url}/cookies`, title: 'Classic Chocolate Chip Cookies & Milk', structured: true })
    assert.deepEqual(result.llm, { provider: 'mock', model: 'mock', baseUrl: null, hasKey: false })
    assert.deepEqual(result.history.map((h) => h.errors > 0), [true, false])
    if (conversions()) {
      const butter = result.conversions.find((c) => c.taskId === 'measure-butter')
      assert.ok(butter, JSON.stringify(result.conversions))
      assert.equal(butter.to.unit, 'g')
      assert.match(result.xml, /converted from 1 cup/)
      assert.ok(!/unit="cup"/.test(result.xml))
    } else {
      assert.ok(result.check.warnings.some((w) => /Unit conversion is unavailable/.test(w)))
    }
  })

  test('gives up after maxRepairs and returns the best attempt', async () => {
    let n = 0
    const llm = { provider: 'mock', mockResponse: () => (++n === 1 ? BROKEN : 'Sorry, I cannot help with that.') }
    const result = await importRecipe({ text: 'Cookies\nIngredients\n- butter\nMethod\n- bake', llm, maxRepairs: 1 })
    assert.equal(result.attempts, 2)
    assert.equal(result.check.ok, false)
    assert.ok(result.check.errors.some((e) => /egg-for-doug/.test(e)), 'the better first attempt is kept')
    assert.match(result.xml, /Brown Butter Cookies/)
  })

  test('an answer without XML is fed back as an error', async () => {
    const seen = []
    const llm = { provider: 'mock', mockResponse: (messages) => { seen.push(messages.length); return seen.length === 1 ? 'I think this is a nice recipe.' : GOOD } }
    const result = await importRecipe({ source: extractRecipeSource(fixture('microdata.html'), 'https://example.org/p'), llm })
    assert.equal(result.check.ok, true)
    assert.equal(result.attempts, 2)
    assert.equal(result.id, 'brown-butter-cookies')
    assert.match(result.xml, /ref="https:\/\/example.org\/p"/)
  })

  test('input validation and cancellation', async () => {
    await assert.rejects(importRecipe({ url: 'x', llm: null }), (e) => e instanceof ImportError && e.code === 'config')
    await assert.rejects(importRecipe({ llm: { provider: 'mock', mockResponse: GOOD } }), (e) => e.code === 'input')
    const ctl = new AbortController()
    ctl.abort()
    await assert.rejects(importRecipe({ text: 'x', llm: { provider: 'mock', mockResponse: GOOD }, signal: ctl.signal }), (e) => e.code === 'aborted')
    const saved2 = process.env.FLOW_IMPORT_ALLOW_PRIVATE
    delete process.env.FLOW_IMPORT_ALLOW_PRIVATE
    try {
      await assert.rejects(importRecipe({ url: `${server.url}/x`, llm: { provider: 'mock', mockResponse: GOOD } }), (e) => e.code === 'blocked-address')
    } finally {
      process.env.FLOW_IMPORT_ALLOW_PRIVATE = saved2
    }
  })
})
