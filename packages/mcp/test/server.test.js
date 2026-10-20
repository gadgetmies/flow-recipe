import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.resolve(here, '../src/index.js')
const BUNS = fs.readFileSync(path.resolve(here, '../../server/src/recipes/buns.xml'), 'utf-8')

const EXPECTED_TOOLS = [
  'get_authoring_guide',
  'list_operations',
  'fetch_recipe_source',
  'convert_amount',
  'lookup_density',
  'convert_recipe_units',
  'check_recipe',
  'list_recipes',
  'get_recipe',
  'upload_recipe',
  'import_recipe_with_server_llm',
]

async function connect(env = {}) {
  const baseEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !k.startsWith('FLOW_')) baseEnv[k] = v
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...baseEnv, ...env },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'flow-recipe-mcp-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

function text(result) {
  return result.content.map(c => c.text).join('\n')
}

function json(result) {
  return JSON.parse(text(result))
}

/** A tiny fake flow-recipe server that records requests. */
function startFakeServer() {
  const requests = []
  let jobPolls = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }
      requests.push(record)
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'POST' && req.url === '/api/recipes') {
        if (record.body.id === 'taken' && !record.body.overwrite) return send(409, { error: 'Recipe id exists' })
        return send(201, { id: record.body.id || 'generated-id', title: 'Buns', check: { ok: true, errors: [], warnings: [] } })
      }
      if (req.method === 'GET' && req.url === '/api/recipes') return send(200, [{ id: 'buns', title: 'Buns', source: 'builtin' }])
      if (req.method === 'GET' && req.url === '/api/recipes/buns') {
        res.writeHead(200, { 'Content-Type': 'application/xml' })
        return res.end(BUNS)
      }
      if (req.method === 'POST' && req.url === '/api/import') return send(202, { jobId: 'job-1' })
      if (req.method === 'GET' && req.url === '/api/import/job-1') {
        jobPolls++
        if (jobPolls < 3) return send(200, { id: 'job-1', status: 'running', stage: 'generating', attempts: 1 })
        return send(200, {
          id: 'job-1',
          status: 'done',
          stage: 'done',
          attempts: 1,
          result: { id: 'buns-2', xml: BUNS, check: { ok: true, errors: [], warnings: [], plan: null }, conversions: [], attempts: 1 },
        })
      }
      if (req.method === 'GET' && req.url === '/recipe.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return res.end(`<!doctype html><html><head><title>Pancakes</title>
<script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Recipe',
          name: 'Pancakes',
          recipeYield: '4 servings',
          recipeIngredient: ['1 cup all-purpose flour', '1 cup milk', '1 egg'],
          recipeInstructions: [{ '@type': 'HowToStep', text: 'Whisk everything.' }, { '@type': 'HowToStep', text: 'Fry.' }],
          totalTime: 'PT20M',
        })}</script></head><body><h1>Pancakes</h1></body></html>`)
      }
      send(404, { error: 'not found' })
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

describe('flow-recipe MCP server (no external dependencies)', () => {
  let client
  before(async () => {
    client = await connect({ FLOW_RECIPE_SERVER: 'http://127.0.0.1:9' })
  })
  after(async () => {
    await client?.close()
  })

  test('lists every tool with an input schema, and the prompt', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    for (const name of EXPECTED_TOOLS) assert.ok(names.includes(name), `missing tool ${name}`)
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object')
      assert.ok(tool.description.length > 20)
    }
    const upload = tools.find(t => t.name === 'upload_recipe')
    assert.deepEqual(upload.inputSchema.required, ['xml'])
    const { prompts } = await client.listPrompts()
    assert.ok(prompts.some(p => p.name === 'create_recipe_from_url'))
    const prompt = await client.getPrompt({ name: 'create_recipe_from_url', arguments: { url: 'https://example.com/r' } })
    assert.match(prompt.messages[0].content.text, /check_recipe/)
  })

  test('validates arguments', async () => {
    const result = await client.callTool({ name: 'convert_amount', arguments: { amount: 'lots', unit: 'cup' } })
    assert.equal(result.isError, true)
    assert.match(text(result), /Cannot read the amount/)
  })

  test('reports an unreachable server with an actionable hint', async () => {
    const result = await client.callTool({ name: 'list_recipes', arguments: {} })
    assert.equal(result.isError, true)
    const body = json(result)
    assert.match(body.error, /Could not reach/)
    assert.match(body.hint, /FLOW_RECIPES_DIR/)
  })
})

describe('flow-recipe MCP server with the importer', () => {
  let client
  let fake
  let tmp
  before(async () => {
    fake = await startFakeServer()
    client = await connect({ FLOW_RECIPE_SERVER: fake.url, FLOW_UPLOAD_TOKEN: 'secret-token', FLOW_IMPORT_POLL_MS: '20', FLOW_IMPORT_ALLOW_PRIVATE: '1' })
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-recipe-mcp-'))
  })
  after(async () => {
    await client?.close()
    fake?.server.close()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('convert_amount turns a cup of flour into grams', async () => {
    const result = await client.callTool({
      name: 'convert_amount',
      arguments: { amount: '1', unit: 'cup', ingredient: 'all-purpose flour' },
    })
    assert.ok(!result.isError, text(result))
    const body = json(result)
    assert.equal(body.unit, 'g')
    assert.ok(body.number > 100 && body.number < 150, `got ${body.number}`)
    assert.equal(body.method, 'density')
  })

  test('convert_amount keeps a small amount of salt in spoons without a precision scale, grams with one', async () => {
    const spoons = json(await client.callTool({ name: 'convert_amount', arguments: { amount: '1/2', unit: 'tsp', ingredient: 'salt' } }))
    assert.equal(spoons.unit, 'tsp')
    const grams = json(
      await client.callTool({ name: 'convert_amount', arguments: { amount: 0.5, unit: 'tsp', ingredient: 'salt', precisionScale: true } })
    )
    assert.equal(grams.unit, 'g')
  })

  test('lookup_density finds sugar', async () => {
    const result = await client.callTool({ name: 'lookup_density', arguments: { ingredient: 'brown sugar' } })
    assert.ok(!result.isError, text(result))
    const body = json(result)
    assert.ok(body.match, 'expected a match')
    assert.equal(typeof body.match.gPerMl, 'number')
    assert.ok(body.match.gramsPerCup > 100)
  })

  test('get_authoring_guide returns the guide, the rules and the catalogue', async () => {
    const result = await client.callTool({ name: 'get_authoring_guide', arguments: { precisionScale: true } })
    assert.ok(!result.isError, text(result))
    const body = text(result)
    assert.ok(body.length > 2000)
    assert.match(body, /Measurement rules/)
    assert.match(body, /PRECISION SCALE/)
    assert.match(body, /Operation catalogue/)
  })

  test('list_operations filters the catalogue', async () => {
    const result = await client.callTool({ name: 'list_operations', arguments: { filter: 'bake' } })
    assert.ok(!result.isError, text(result))
    assert.match(text(result), /bake/)
    const none = await client.callTool({ name: 'list_operations', arguments: { filter: 'zzz-no-such-op' } })
    assert.equal(none.isError, true)
  })

  test('check_recipe accepts a built-in recipe and runs the dry-run plan', async () => {
    const result = await client.callTool({ name: 'check_recipe', arguments: { xml: BUNS } })
    assert.ok(!result.isError, text(result))
    const body = json(result)
    assert.equal(body.ok, true, JSON.stringify(body.errors))
    assert.deepEqual(body.errors, [])
    assert.ok(body.plan, 'expected a dry-run plan')
    assert.match(body.verdict, /No errors/)
    assert.ok(body.summary.ingredients.length > 0)
  })

  test('check_recipe reports errors for a broken recipe', async () => {
    const result = await client.callTool({ name: 'check_recipe', arguments: { xml: '<recipe version="2"><title>Oops</title><tasks><task' } })
    const body = json(result)
    assert.equal(body.ok, false)
    assert.ok(body.errors.length > 0)
  })

  test('convert_recipe_units returns XML', async () => {
    const result = await client.callTool({ name: 'convert_recipe_units', arguments: { xml: BUNS } })
    assert.ok(!result.isError, text(result))
    const body = json(result)
    assert.match(body.xml, /<recipe/)
    assert.ok(Array.isArray(body.changes))
    const broken = await client.callTool({ name: 'convert_recipe_units', arguments: { xml: '<recipe><title>x' } })
    assert.equal(broken.isError, true)
  })

  test('fetch_recipe_source extracts JSON-LD', async () => {
    const result = await client.callTool({ name: 'fetch_recipe_source', arguments: { url: `${fake.url}/recipe.html` } })
    assert.ok(!result.isError, text(result))
    const body = json(result)
    assert.equal(body.title, 'Pancakes')
    assert.equal(body.structured, true)
    assert.equal(body.ingredients.length, 3)
  })

  test('upload_recipe refuses a recipe with errors and does not POST', async () => {
    const before = fake.requests.length
    const result = await client.callTool({ name: 'upload_recipe', arguments: { xml: '<recipe version="2"><title>Broken' } })
    assert.equal(result.isError, true)
    const body = json(result)
    assert.match(body.error, /Not uploaded/)
    assert.ok(body.errors.length > 0)
    assert.equal(fake.requests.filter(r => r.method === 'POST').length, fake.requests.slice(0, before).filter(r => r.method === 'POST').length)
  })

  test('upload_recipe checks, then POSTs with the bearer token', async () => {
    const result = await client.callTool({ name: 'upload_recipe', arguments: { xml: BUNS, id: 'my-buns' } })
    assert.ok(!result.isError, text(result))
    const body = json(result)
    assert.equal(body.saved, 'server')
    assert.equal(body.id, 'my-buns')
    const post = fake.requests.find(r => r.method === 'POST' && r.url === '/api/recipes')
    assert.ok(post, 'expected a POST')
    assert.equal(post.headers.authorization, 'Bearer secret-token')
    assert.equal(post.body.id, 'my-buns')
    assert.equal(post.body.xml, BUNS)
  })

  test('upload_recipe surfaces a 409 with a hint', async () => {
    const result = await client.callTool({ name: 'upload_recipe', arguments: { xml: BUNS, id: 'taken' } })
    assert.equal(result.isError, true)
    const body = json(result)
    assert.equal(body.status, 409)
    assert.match(body.hint, /overwrite/)
  })

  test('list_recipes and get_recipe read from the server', async () => {
    const list = json(await client.callTool({ name: 'list_recipes', arguments: {} }))
    assert.equal(list[0].id, 'buns')
    const xml = text(await client.callTool({ name: 'get_recipe', arguments: { id: 'buns' } }))
    assert.match(xml, /<recipe/)
  })

  test('import_recipe_with_server_llm polls the job', async () => {
    const result = await client.callTool({ name: 'import_recipe_with_server_llm', arguments: { url: 'https://example.com/buns' } })
    assert.ok(!result.isError, text(result))
    const body = json(result)
    assert.equal(body.id, 'buns-2')
    assert.match(body.xml, /<recipe/)
    const post = fake.requests.find(r => r.url === '/api/import')
    assert.equal(post.headers.authorization, 'Bearer secret-token')
  })

  test('upload_recipe writes to FLOW_RECIPES_DIR when set', async () => {
    const local = await connect({ FLOW_RECIPES_DIR: tmp, FLOW_RECIPE_SERVER: 'http://127.0.0.1:9' })
    try {
      const result = await local.callTool({ name: 'upload_recipe', arguments: { xml: BUNS, id: 'local-buns' } })
      assert.ok(!result.isError, text(result))
      const body = json(result)
      assert.equal(body.saved, 'local')
      const file = path.join(tmp, 'local-buns.xml')
      assert.equal(fs.readFileSync(file, 'utf-8').trim(), BUNS.trim())

      const again = await local.callTool({ name: 'upload_recipe', arguments: { xml: BUNS, id: 'local-buns' } })
      assert.equal(again.isError, true)
      assert.match(json(again).hint, /overwrite/)
      const overwrite = await local.callTool({ name: 'upload_recipe', arguments: { xml: BUNS, id: 'local-buns', overwrite: true } })
      assert.ok(!overwrite.isError, text(overwrite))

      const derived = json(await local.callTool({ name: 'upload_recipe', arguments: { xml: BUNS } }))
      assert.equal(derived.id, 'buns')

      const list = json(await local.callTool({ name: 'list_recipes', arguments: {} }))
      assert.deepEqual(list.local.map(r => r.id).sort(), ['buns', 'local-buns'])
      assert.equal(list.server, null)
      const xml = text(await local.callTool({ name: 'get_recipe', arguments: { id: 'local-buns' } }))
      assert.match(xml, /<recipe/)
    } finally {
      await local.close()
    }
  })
})
