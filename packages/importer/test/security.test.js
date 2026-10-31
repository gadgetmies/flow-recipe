// Regression tests for review 1: SSRF guard (address forms, DNS pinning), LLM error bodies, ReDoS, stored XSS,
// check budget, repair-round failures and root ids.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { isPrivateAddress, parseIPv6, createGuardedFetch, assertPublicUrl, SourceError } from '../src/net.js'
import { fetchRecipeSource, parseDuration, extractRecipeSource } from '../src/source.js'
import { createLlmClient, LlmError } from '../src/llm.js'
import { checkRecipeXml, MAX_TASKS } from '../src/check.js'
import { importRecipe } from '../src/import.js'
import { checkWellFormed } from '../src/wellformed.js'
import { parseHtml, htmlToText } from '../src/html.js'
import { fixture, startServer } from './helpers.js'

const GOOD = fixture('cookies.xml')

describe('SSRF guard: address forms', () => {
  test('IPv6 forms embedding private IPv4, NAT64, 6to4, Teredo, site-local and reserved IPv4 ranges', () => {
    const blocked = [
      '::7f00:1', new URL('http://[::127.0.0.1]/').hostname, '::ffff:7f00:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:a00:1',
      '::ffff:0:a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '2002:7f00:1::', '2002:a00:1::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fec0::1', '2001:db8::1', '100::1', 'ff02::1',
      '198.18.0.1', '198.19.255.255', '192.0.0.8', '192.0.2.1', '240.0.0.1', '255.255.255.255', 'not-an-ip', '',
    ]
    for (const ip of blocked) assert.equal(isPrivateAddress(ip), true, ip)
    const allowed = ['2606:4700:4700::1111', '64:ff9b::808:808', '2002:808:808::1', '::ffff:8.8.8.8', '93.184.216.34', '2a00:1450:4001::200e']
    for (const ip of allowed) assert.equal(isPrivateAddress(ip), false, ip)
  })

  test('parseIPv6 expands compressed and dotted forms', () => {
    assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1])
    assert.deepEqual(parseIPv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
    assert.deepEqual(parseIPv6('[2002:7f00:1::]'), [0x2002, 0x7f00, 1, 0, 0, 0, 0, 0])
    assert.equal(parseIPv6('1::2::3'), null)
    assert.equal(parseIPv6('1:2:3'), null)
  })

  test('assertPublicUrl refuses bracketed IPv4-compatible / NAT64 / 6to4 literals', async () => {
    for (const url of ['http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://[fec0::1]/', 'http://198.18.0.1/']) {
      await assert.rejects(assertPublicUrl(url, { allowPrivate: false }), (e) => e.code === 'blocked-address', url)
    }
  })
})

describe('SSRF guard: pinned fetch', () => {
  let server
  before(async () => {
    server = await startServer((req, res) => {
      if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
        return res.end(gzipSync('hello compressed'))
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/' })
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-echo-host': req.headers.host })
      res.end(`${req.method} ${req.url} ${req.headers['content-type'] || ''} ${typeof req.body === 'string' ? req.body : ''}`)
    })
  })
  after(() => server.close())
  const port = () => new URL(server.url).port

  test('DNS rebinding: the address is checked when the socket connects, not only beforehand', async () => {
    // A name that "resolves" to loopback. The URL itself passes the literal check; the connect-time lookup refuses.
    let calls = 0
    const rebinding = (host, opts, cb) => {
      calls++
      cb(null, [{ address: '127.0.0.1', family: 4 }])
    }
    const guarded = createGuardedFetch({ allowPrivate: false, lookup: rebinding })
    await assert.rejects(guarded(`http://rebind.example:${port()}/secret`), (e) => e instanceof SourceError && e.code === 'blocked-address')
    assert.ok(calls >= 1)
  })

  test('the connection goes to the address the lookup returned (pinned), with allowPrivate', async () => {
    const pinned = (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }])
    const guarded = createGuardedFetch({ allowPrivate: true, lookup: pinned })
    const res = await guarded(`http://pinned.example:${port()}/hello`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-echo-host'), `pinned.example:${port()}`)
    assert.match(await res.text(), /^POST \/hello application\/json/)
  })

  test('literal private hosts, redirects (not followed) and gzip bodies', async () => {
    const strict = createGuardedFetch({ allowPrivate: false })
    await assert.rejects(strict(`${server.url}/x`), (e) => e.code === 'blocked-address')
    await assert.rejects(strict('http://[::ffff:7f00:1]/'), (e) => e.code === 'blocked-address')
    const open = createGuardedFetch({ allowPrivate: true })
    const gz = await open(`${server.url}/gzip`)
    assert.equal(await gz.text(), 'hello compressed')
    const redirect = await open(`${server.url}/redirect`)
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), 'http://127.0.0.1:1/')
  })

  test('fetchRecipeSource uses the pinned fetch by default', async () => {
    const saved = process.env.FLOW_IMPORT_ALLOW_PRIVATE
    delete process.env.FLOW_IMPORT_ALLOW_PRIVATE
    try {
      // A lookup that passes the pre-check but the default (pinned) fetch still refuses at connect time.
      const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
      await assert.rejects(fetchRecipeSource(`http://localhost:${port()}/recipe`, { lookup }), (e) => e instanceof SourceError && e.code === 'blocked-address')
    } finally {
      if (saved !== undefined) process.env.FLOW_IMPORT_ALLOW_PRIVATE = saved
    }
  })
})

describe('LLM errors from untrusted endpoints', () => {
  let server
  before(async () => {
    server = await startServer((req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('INTERNAL-ONLY SECRET: db_password=hunter2')
    })
  })
  after(() => server.close())

  test('errorDetail: false reports only the status code', async () => {
    const client = createLlmClient({ provider: 'ollama', baseUrl: `${server.url}/v1`, errorDetail: false })
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'hi' }] }), (e) => e instanceof LlmError && /HTTP 500/.test(e.message) && !/hunter2|SECRET/.test(e.message))
    const trusted = createLlmClient({ provider: 'ollama', baseUrl: `${server.url}/v1` })
    await assert.rejects(trusted.complete({ messages: [{ role: 'user', content: 'hi' }] }), (e) => /hunter2/.test(e.message), 'operator endpoints keep the detail')
  })
})

describe('ReDoS and deep nesting', () => {
  test('parseDuration is linear on hostile input and still parses ISO and loose durations', () => {
    const t0 = performance.now()
    for (const n of [10000, 40000, 200000]) {
      assert.equal(parseDuration(`P${'1'.repeat(n)}x`), null)
      assert.equal(parseDuration(`PT${'1'.repeat(n)}`), null)
      assert.equal(parseDuration(`${'1'.repeat(n)} `), null)
    }
    assert.ok(performance.now() - t0 < 200, `took ${performance.now() - t0} ms`)
    assert.equal(parseDuration('PT1H30M'), 5400)
    assert.equal(parseDuration('P1DT2H'), 93600)
    assert.equal(parseDuration('PT90M'), 5400)
    assert.equal(parseDuration('P0DT0H45M0S'), 2700)
    assert.equal(parseDuration('PT1,5H'), 5400)
    assert.equal(parseDuration('P1W'), 604800)
    assert.equal(parseDuration('pt20m'), 1200)
    assert.equal(parseDuration('PT'), null)
    assert.equal(parseDuration('P'), null)
    assert.equal(parseDuration('1 hour 30 minutes'), 5400)
  })

  test('a page with hostile JSON-LD times is extracted quickly', () => {
    const bad = `P${'1'.repeat(40000)}x`
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Recipe', name: 'X', recipeIngredient: ['a'], prepTime: bad, cookTime: bad, totalTime: bad })}</script>`
    const t0 = performance.now()
    const s = extractRecipeSource(html, 'https://e.org/')
    assert.ok(performance.now() - t0 < 500, `took ${performance.now() - t0} ms`)
    assert.deepEqual(s.times, {})
  })

  test('deeply nested HTML and XML do not overflow the stack', () => {
    const n = 20000
    const html = `${'<div>'.repeat(n)}deep text${'</div>'.repeat(n)}`
    assert.match(htmlToText(parseHtml(html)), /deep text/)
    const s = extractRecipeSource(`<html><body>${html}</body></html>`, 'https://e.org/')
    assert.match(s.text, /deep text/)
    const xml = `<recipe>${'<a>'.repeat(n)}${'</a>'.repeat(n)}</recipe>`
    assert.ok(checkWellFormed(xml).some((p) => /nested more than/.test(p.message)))
    const r = checkRecipeXml(xml)
    assert.equal(r.ok, false)
    assert.ok(!r.errors.some((e) => /Maximum call stack/.test(e)), r.errors.join('\n'))
  })
})

describe('checkRecipeXml: vocabulary (stored XSS) and budget', () => {
  test('foreign namespaces, scripts, stylesheets and unknown elements are errors', () => {
    const cases = [
      GOOD.replace('</title>', '</title><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script>'),
      GOOD.replace('</title>', '</title><script>alert(1)</script>'),
      GOOD.replace('</title>', '</title><svg:svg xmlns:svg="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
      GOOD.replace(/<recipe\b/, '<recipe xmlns="http://www.w3.org/1999/xhtml"'),
      GOOD.replace(/(<\?xml[^?]*\?>)/, '$1<?xml-stylesheet type="text/xsl" href="https://evil.example/x.xsl"?>'),
      GOOD.replace('</title>', '</title><?php echo 1 ?>'),
      GOOD.replace(/<title>/, '<title xmlns:x="urn:x" x:onclick="1">'),
      GOOD.replace('</title>', '</title><notes>free text</notes>'),
    ]
    for (const xml of cases) {
      assert.notEqual(xml, GOOD)
      const r = checkRecipeXml(xml, { planCheck: false })
      assert.equal(r.ok, false, xml.slice(0, 300))
      assert.ok(r.errors.some((e) => /not part of the recipe format|not allowed|namespace/.test(e)), r.errors.join('\n'))
    }
    assert.equal(checkRecipeXml(GOOD, { planCheck: false }).ok, true, 'xmlns:xsi and xsi:* stay allowed')
  })

  test('too many tasks are refused before the dry run', () => {
    const many = Array.from({ length: MAX_TASKS + 1 }, (_, i) => `<task operation="measure" id="m${i}"><inputs><input ref="flour"/></inputs><outputs><output id="o${i}" final="true">f</output></outputs><options><option name="amount"><numeric-value number="1" unit="g"/></option></options></task>`).join('')
    const xml = `<recipe version="2" id="big"><title>Big</title><ingredients><ingredient id="flour">flour</ingredient></ingredients><tools/><tasks>${many}</tasks></recipe>`
    const t0 = performance.now()
    const r = checkRecipeXml(xml)
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /at most/.test(e)), r.errors.join('\n'))
    assert.equal(r.plan, null)
    assert.ok(performance.now() - t0 < 1500, `took ${performance.now() - t0} ms`)
  })
})

describe('importRecipe: repair failures and ids', () => {
  const BROKEN = GOOD.replace('<input ref="egg-for-dough"/>', '<input ref="egg-for-doug"/>')

  test('a failing repair round keeps the earlier attempt', async () => {
    let call = 0
    const llm = {
      provider: 'mock',
      mockResponse: () => {
        call++
        if (call === 1) return BROKEN
        throw new LlmError('overloaded', 'Anthropic is overloaded or unavailable (HTTP 529), try again shortly')
      },
    }
    const result = await importRecipe({ text: 'Cookies\nIngredients\n- flour', llm, maxRepairs: 2 })
    assert.equal(result.attempts, 1)
    assert.ok(result.xml.includes('<recipe'))
    assert.ok(result.check.errors.some((e) => /egg-for-doug/.test(e)))
    assert.ok(result.check.warnings.some((w) => /Repair round 1 failed: .*overloaded/.test(w)), result.check.warnings.join('\n'))
  })

  test('a failure on the first call still throws', async () => {
    const llm = { provider: 'mock', mockResponse: () => { throw new LlmError('auth', 'API key rejected') } }
    await assert.rejects(importRecipe({ text: 'Cookies', llm }), (e) => e.code === 'auth')
  })

  test('the root id is unique among existingIds and equals result.id', async () => {
    const result = await importRecipe({ text: 'Cookies', llm: { provider: 'mock', mockResponse: GOOD }, existingIds: ['brown-butter-cookies', 'buns'] })
    const rootId = /<recipe\b[^>]*\sid="([^"]+)"/.exec(result.xml)[1]
    assert.equal(rootId, result.id)
    assert.equal(result.check.id, result.id)
    assert.equal(result.id, 'brown-butter-cookies-2')
  })
})
