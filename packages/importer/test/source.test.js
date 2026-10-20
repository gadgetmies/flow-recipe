import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractRecipeSource, textSource, fetchRecipeSource, assertPublicUrl, isPrivateAddress, parseDuration, parseYield,
  flattenInstructions, SourceError, USER_AGENT, IMPORTER_USER_AGENT,
} from '../src/source.js'
import { decodeEntities, htmlToText } from '../src/html.js'
import { fixture, startServer } from './helpers.js'

describe('extractRecipeSource', () => {
  test('JSON-LD Recipe: entities, HowToStep, durations, yield array', () => {
    const s = extractRecipeSource(fixture('jsonld.html'), 'https://example.org/cookies')
    assert.equal(s.structured, true)
    assert.equal(s.url, 'https://example.org/cookies')
    assert.equal(s.title, 'Classic Chocolate Chip Cookies & Milk')
    assert.equal(s.yield, '24 cookies')
    assert.equal(s.servings, 24)
    assert.equal(s.ingredients.length, 6)
    assert.equal(s.ingredients[2], '2 ¼ cups all-purpose flour')
    assert.deepEqual(s.times, { prep: 900, cook: 660, total: 5160 })
    assert.equal(s.steps[0], 'Preheat the oven to 375°F (190°C).', 'a name that starts the text is not repeated')
    assert.equal(s.steps[2], 'Mix the dough: Mix in the eggs, then the flour and baking soda. Fold in the chocolate chips.')
    assert.equal(s.description, 'Chewy cookies with "crisp" edges.')
    assert.equal(s.lang, 'en')
    // readable text: article only, no nav/footer/ads/scripts/styles
    assert.match(s.text, /13×18 inch sheet/)
    for (const noise of ['All recipes', 'Copyright', 'BUY NOW', 'dataLayer', 'color: red', 'ad slot']) assert.ok(!s.text.includes(noise), `text contains ${noise}`)
  })

  test('@graph with @type array, HowToSection and HTML in steps; broken JSON-LD elsewhere is tolerated', () => {
    const s = extractRecipeSource(fixture('graph.html'), 'https://example.org/lasagne')
    assert.equal(s.structured, true)
    assert.equal(s.title, 'Lasagne al forno')
    assert.equal(s.servings, 4)
    assert.equal(s.yield, '4')
    assert.deepEqual(s.ingredients, ['500 g jauhelihaa', '1 sipuli', '12 lasagnelevyä', '5 dl maitoa'])
    assert.deepEqual(s.steps, [
      '[Kastike] Ruskista jauheliha ja sipuli.',
      '[Kastike] Hauduta 20 minuuttia.',
      '[Kokoaminen] Kokoa kerroksittain vuokaan.',
      '[Kokoaminen] Paista 200 asteessa 45 min.',
    ])
    assert.deepEqual(s.times, { cook: 2700, total: 5400 })
    assert.equal(s.lang, 'fi')
  })

  test('microdata fallback', () => {
    const s = extractRecipeSource(fixture('microdata.html'), 'https://example.org/pancakes')
    assert.equal(s.structured, true)
    assert.equal(s.title, 'Fluffy Pancakes')
    assert.equal(s.servings, 4)
    assert.equal(s.yield, 'Serves 4 people')
    assert.deepEqual(s.ingredients, ['200 g flour', '3 dl milk', '2 eggs'])
    assert.deepEqual(s.steps, ['Whisk the flour, milk and eggs.', 'Rest the batter for 10 minutes.', 'Fry in a hot pan, 2 minutes per side.'])
    assert.deepEqual(s.times, { prep: 600, cook: 1200 })
  })

  test('plain page: readable text without scripts, styles, nav, sidebar, comments, footer; sections recognised', () => {
    const s = extractRecipeSource(fixture('plain.html'), 'https://example.org/soup')
    assert.equal(s.structured, false)
    assert.equal(s.title, "Grandma's Tomato Soup")
    assert.match(s.text, /^Grandma’s Tomato Soup/)
    assert.match(s.text, /A warming soup for cold days\./)
    assert.match(s.text, /- 1 kg tomatoes\n- 1 onion\n- 5 dl vegetable stock/)
    for (const noise of ['tracking', 'display', 'Menu item', 'Popular posts', 'Great soup', 'comment that', 'Footer text', 'secret hidden']) {
      assert.ok(!s.text.includes(noise), `text contains ${noise}`)
    }
    assert.deepEqual(s.ingredients, ['1 kg tomatoes', '1 onion', '5 dl vegetable stock'])
    assert.equal(s.steps.length, 3)
  })

  test('readable text is limited to 30k characters', () => {
    const html = `<html><body><article><h1>Big</h1>${'<p>word word word word word word word word word</p>'.repeat(2000)}</article></body></html>`
    const s = extractRecipeSource(html)
    assert.ok(s.text.length <= 30010, `length ${s.text.length}`)
  })
})

describe('value helpers', () => {
  test('ISO 8601 durations and loose durations', () => {
    assert.equal(parseDuration('PT15M'), 900)
    assert.equal(parseDuration('PT1H30M'), 5400)
    assert.equal(parseDuration('P0DT0H45M0S'), 2700)
    assert.equal(parseDuration('P1DT2H'), 93600)
    assert.equal(parseDuration('PT90M'), 5400)
    assert.equal(parseDuration('PT0.5H'), 1800)
    assert.equal(parseDuration('1 hour 15 minutes'), 4500)
    assert.equal(parseDuration(''), null)
    assert.equal(parseDuration('soon'), null)
    assert.equal(parseDuration(null), null)
  })

  test('recipeYield variants', () => {
    assert.deepEqual(parseYield(['4', '4 servings']), { yield: '4 servings', servings: 4 })
    assert.deepEqual(parseYield(6), { yield: '6', servings: 6 })
    assert.deepEqual(parseYield('Makes 24 cookies'), { yield: 'Makes 24 cookies', servings: 24 })
    assert.deepEqual(parseYield(null), { yield: null, servings: null })
  })

  test('recipeInstructions as string, string array, nested sections and ItemList', () => {
    assert.deepEqual(flattenInstructions('1. Mix.\n2. Bake.'), ['Mix.', 'Bake.'])
    assert.deepEqual(flattenInstructions('<ol><li>Mix &amp; stir.</li><li>Bake.</li></ol>'), ['Mix & stir.', 'Bake.'])
    assert.deepEqual(flattenInstructions(['Step 1: Mix.', 'Bake.']), ['Mix.', 'Bake.'])
    assert.deepEqual(
      flattenInstructions([{ '@type': 'HowToSection', name: 'Dough', itemListElement: [{ '@type': 'HowToStep', text: 'Knead.' }, { '@type': 'HowToSection', name: 'Inner', itemListElement: ['Rest.'] }] }]),
      ['[Dough] Knead.', '[Inner] Rest.']
    )
    assert.deepEqual(flattenInstructions({ '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: { '@type': 'HowToStep', text: 'Serve.' } }] }), ['Serve.'])
  })

  test('HTML entities', () => {
    assert.equal(decodeEntities('a &amp; b &#8211; c &#x2014; &frac12; &nbsp;x &unknown;'), 'a & b – c — ½  x &unknown;')
    assert.equal(htmlToText('<p>a<br>b</p><ul><li>x</li><li>y</li></ul>'), 'a\nb\n- x\n- y')
  })

  test('textSource for pasted text', () => {
    const s = textSource('Pea soup\nServes 4\nPrep time: 10 min\n\nIngredients:\n- 500 g peas\n- 1 l stock\n\nInstructions\n1. Boil the peas.\n2. Blend.\n\nNotes\nKeeps 3 days.')
    assert.equal(s.title, 'Pea soup')
    assert.equal(s.servings, 4)
    assert.deepEqual(s.ingredients, ['500 g peas', '1 l stock'])
    assert.deepEqual(s.steps, ['Boil the peas.', 'Blend.'])
    assert.deepEqual(s.times, { prep: 600 })
    assert.equal(s.structured, false)
  })
})

describe('SSRF guard', () => {
  test('private and loopback addresses', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '[::1]', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '100.64.0.1']) {
      assert.equal(isPrivateAddress(ip), true, ip)
    }
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111', '1.1.1.1']) assert.equal(isPrivateAddress(ip), false, ip)
  })

  test('assertPublicUrl rejects bad schemes, credentials and private hosts', async () => {
    const lookup = async (host) => (host === 'evil.example' ? [{ address: '10.1.2.3', family: 4 }] : [{ address: '93.184.216.34', family: 4 }])
    await assert.rejects(assertPublicUrl('file:///etc/passwd', { lookup, allowPrivate: false }), (e) => e.code === 'invalid-url')
    await assert.rejects(assertPublicUrl('ftp://example.org/', { lookup, allowPrivate: false }), (e) => e.code === 'invalid-url')
    await assert.rejects(assertPublicUrl('not a url', { lookup, allowPrivate: false }), (e) => e.code === 'invalid-url')
    await assert.rejects(assertPublicUrl('http://user:pw@example.org/', { lookup, allowPrivate: false }), (e) => e.code === 'invalid-url')
    await assert.rejects(assertPublicUrl('http://evil.example/r', { lookup, allowPrivate: false }), (e) => e.code === 'blocked-address' && /10\.1\.2\.3/.test(e.message))
    await assert.rejects(assertPublicUrl('http://127.0.0.1:8080/', { lookup, allowPrivate: false }), (e) => e.code === 'blocked-address')
    await assert.rejects(assertPublicUrl('http://[::1]/', { lookup, allowPrivate: false }), (e) => e.code === 'blocked-address')
    const ok = await assertPublicUrl('https://good.example/recipe', { lookup, allowPrivate: false })
    assert.equal(ok.hostname, 'good.example')
    assert.equal((await assertPublicUrl('http://127.0.0.1/', { lookup, allowPrivate: true })).hostname, '127.0.0.1')
  })

  test('localhost is refused by a real DNS lookup unless FLOW_IMPORT_ALLOW_PRIVATE=1', async () => {
    const saved = process.env.FLOW_IMPORT_ALLOW_PRIVATE
    delete process.env.FLOW_IMPORT_ALLOW_PRIVATE
    try {
      await assert.rejects(fetchRecipeSource('http://localhost:9/recipe'), (e) => e instanceof SourceError && e.code === 'blocked-address')
    } finally {
      if (saved !== undefined) process.env.FLOW_IMPORT_ALLOW_PRIVATE = saved
    }
  })
})

describe('fetchRecipeSource against a local server', () => {
  let server
  let saved
  before(async () => {
    saved = process.env.FLOW_IMPORT_ALLOW_PRIVATE
    process.env.FLOW_IMPORT_ALLOW_PRIVATE = '1'
    server = await startServer(async (req, res) => {
      if (req.url === '/recipe') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(fixture('jsonld.html'))
      } else if (req.url === '/latin1') {
        res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' })
        res.end(Buffer.from('<html><body><article><h1>Crème brûlée</h1><p>Ingredients: sugar</p></article></body></html>', 'latin1'))
      } else if (req.url === '/moved') {
        res.writeHead(301, { location: '/recipe' })
        res.end()
      } else if (req.url === '/picky') {
        // a bot filter that refuses clients claiming to be a browser
        if (/Chrome/.test(req.headers['user-agent'] || '')) {
          res.writeHead(403, { 'content-type': 'text/html' })
          res.end('<h1>Just a moment...</h1>')
        } else {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(fixture('jsonld.html'))
        }
      } else if (req.url === '/forbidden') {
        res.writeHead(403, { 'content-type': 'text/html' })
        res.end('no')
      } else if (req.url === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('Toast\n\nIngredients\n- 2 slices bread\n\nMethod\n- Toast the bread.')
      } else if (req.url === '/image') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(Buffer.alloc(10))
      } else if (req.url === '/slow') {
        await new Promise((r) => setTimeout(r, 1500))
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html></html>')
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<html><head><title>Big page</title></head><body><article><h1>Big</h1>${'<p>filler text here</p>'.repeat(20000)}</article></body></html>`)
      } else {
        res.writeHead(404, { 'content-type': 'text/html' })
        res.end('<h1>Not found</h1>')
      }
    })
  })
  after(async () => {
    await server.close()
    if (saved === undefined) delete process.env.FLOW_IMPORT_ALLOW_PRIVATE
    else process.env.FLOW_IMPORT_ALLOW_PRIVATE = saved
  })

  test('fetches HTML with a browser-like User-Agent', async () => {
    const s = await fetchRecipeSource(`${server.url}/recipe`)
    assert.equal(s.title, 'Classic Chocolate Chip Cookies & Milk')
    assert.equal(s.structured, true)
    const req = server.requests.find((r) => r.url === '/recipe')
    assert.equal(req.headers['user-agent'], USER_AGENT)
    assert.match(req.headers.accept, /text\/html/)
    assert.equal(req.headers['sec-fetch-mode'], 'navigate')
    assert.match(req.headers['accept-language'], /en-US/)
    assert.match(req.headers['accept-encoding'], /gzip/)
    assert.notEqual(String(req.headers.connection || '').toLowerCase(), 'close', 'no Connection: close quirk')
  })

  test('a 403 is retried once with plain headers', async () => {
    const s = await fetchRecipeSource(`${server.url}/picky`)
    assert.equal(s.title, 'Classic Chocolate Chip Cookies & Milk')
    const agents = server.requests.filter((r) => r.url === '/picky').map((r) => r.headers['user-agent'])
    assert.deepEqual(agents, [USER_AGENT, IMPORTER_USER_AGENT])
    await assert.rejects(fetchRecipeSource(`${server.url}/forbidden`), (e) => e.status === 403 && /paste the recipe text/.test(e.message))
    assert.equal(server.requests.filter((r) => r.url === '/forbidden').length, 2, 'exactly one retry')
  })

  test('decodes the declared charset', async () => {
    const s = await fetchRecipeSource(`${server.url}/latin1`)
    assert.match(s.text, /Crème brûlée/)
  })

  test('follows redirects and reports the final URL', async () => {
    const s = await fetchRecipeSource(`${server.url}/moved`)
    assert.equal(s.url, `${server.url}/recipe`)
    assert.equal(s.ingredients.length, 6)
  })

  test('plain text responses become a text source', async () => {
    const s = await fetchRecipeSource(`${server.url}/text`)
    assert.deepEqual(s.ingredients, ['2 slices bread'])
  })

  test('non-200, non-HTML and timeouts give readable errors', async () => {
    await assert.rejects(fetchRecipeSource(`${server.url}/missing`), (e) => e.code === 'http-status' && e.status === 404 && /HTTP 404/.test(e.message))
    await assert.rejects(fetchRecipeSource(`${server.url}/image`), (e) => e.code === 'not-html' && /image\/png/.test(e.message))
    await assert.rejects(fetchRecipeSource(`${server.url}/slow`, { timeoutMs: 200 }), (e) => e.code === 'timeout')
  })

  test('cancellation through an AbortSignal', async () => {
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 50)
    await assert.rejects(fetchRecipeSource(`${server.url}/slow`, { signal: ctl.signal }), (e) => e.code === 'aborted')
  })

  test('size limit truncates the download', async () => {
    const s = await fetchRecipeSource(`${server.url}/big`, { maxBytes: 20000 })
    assert.equal(s.truncated, true)
    assert.equal(s.title, 'Big page')
  })
})

describe('ingredient lines', () => {
  test('zero amounts from a CMS ("0 kg kananmunaa") are dropped, the ingredient kept', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Recipe', name: 'Korvapuustit', recipeIngredient: ['0 kg kananmunaa', '0.5 dl maitoa', '50 g hiivaa'] })}</script>`
    assert.deepEqual(extractRecipeSource(html, 'https://example.fi/r').ingredients, ['kananmunaa', '0.5 dl maitoa', '50 g hiivaa'])
  })
})
