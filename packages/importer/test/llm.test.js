import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createLlmClient, llmConfigFromEnv, describeLlmConfig, LlmError } from '../src/llm.js'
import { startServer } from './helpers.js'

describe('LLM clients against a local server', () => {
  let server
  before(async () => {
    server = await startServer(async (req, res, entry) => {
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(body))
      }
      if (req.url === '/v1/messages') {
        if (req.headers['x-api-key'] !== 'good-key') return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
        const body = JSON.parse(entry.body)
        if (body.messages[0].content === 'slow') {
          await new Promise((r) => setTimeout(r, 1000))
        }
        if (body.messages[0].content === 'refuse') return json(200, { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'nope' } })
        if (body.messages[0].content === 'busy') return json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
        return json(200, { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '<recipe/>' }, { type: 'text', text: ' tail' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } })
      }
      if (req.url === '/v1/chat/completions') {
        if (req.headers.authorization !== 'Bearer sk-good') return json(401, { error: { message: 'Incorrect API key provided' } })
        return json(200, { choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'length' }] })
      }
      json(404, { error: { message: 'no route' } })
    })
  })
  after(() => server.close())

  test('anthropic: request shape and text extraction', async () => {
    const client = createLlmClient({ provider: 'anthropic', apiKey: 'good-key', baseUrl: server.url, model: 'claude-test' })
    const out = await client.complete({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], maxTokens: 123, temperature: 0.2 })
    assert.equal(out, '<recipe/> tail')
    assert.equal(client.lastStopReason, 'end_turn')
    const req = server.requests.at(-1)
    assert.equal(req.headers['anthropic-version'], '2023-06-01')
    const body = JSON.parse(req.body)
    assert.equal(body.model, 'claude-test')
    assert.equal(body.max_tokens, 123)
    assert.equal(body.system[0].text, 'SYS')
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
    assert.equal(body.temperature, undefined, 'current Claude models reject non-default temperature')
  })

  test('anthropic: 401 → API key rejected, 529 → overloaded, refusal', async () => {
    const bad = createLlmClient({ provider: 'anthropic', apiKey: 'wrong', baseUrl: server.url })
    await assert.rejects(bad.complete({ messages: [{ role: 'user', content: 'hi' }] }), (e) => e instanceof LlmError && e.code === 'auth' && /API key rejected/.test(e.message) && /invalid x-api-key/.test(e.message))
    const client = createLlmClient({ provider: 'anthropic', apiKey: 'good-key', baseUrl: server.url })
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'busy' }] }), (e) => e.code === 'overloaded')
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'refuse' }] }), (e) => e.code === 'refusal' && /nope/.test(e.message))
  })

  test('timeouts and cancellation', async () => {
    const client = createLlmClient({ provider: 'anthropic', apiKey: 'good-key', baseUrl: server.url, timeoutMs: 100 })
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'slow' }] }), (e) => e.code === 'timeout' && /timed out/.test(e.message))
    const slowOk = createLlmClient({ provider: 'anthropic', apiKey: 'good-key', baseUrl: server.url })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 50)
    await assert.rejects(slowOk.complete({ messages: [{ role: 'user', content: 'slow' }], signal: ctl.signal }), (e) => e.code === 'aborted')
    ctl.abort()
    await assert.rejects(slowOk.complete({ messages: [{ role: 'user', content: 'hi' }], signal: ctl.signal }), (e) => e.code === 'aborted')
  })

  test('openai-compatible: bearer key, system message, finish_reason length', async () => {
    const client = createLlmClient({ provider: 'openai-compatible', apiKey: 'sk-good', baseUrl: `${server.url}/v1/`, model: 'm' })
    const out = await client.complete({ system: 'S', messages: [{ role: 'user', content: 'x' }], maxTokens: 50 })
    assert.equal(out, 'hello')
    assert.equal(client.lastStopReason, 'max_tokens')
    const body = JSON.parse(server.requests.at(-1).body)
    assert.deepEqual(body.messages[0], { role: 'system', content: 'S' })
    assert.equal(body.max_tokens, 50)
    const bad = createLlmClient({ provider: 'openai-compatible', apiKey: 'sk-bad', baseUrl: `${server.url}/v1` })
    await assert.rejects(bad.complete({ messages: [{ role: 'user', content: 'x' }] }), /API key rejected.*Incorrect API key/)
  })

  test('unreachable host gives a network error', async () => {
    const client = createLlmClient({ provider: 'ollama', baseUrl: 'http://127.0.0.1:1/v1' })
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'network')
  })
})

describe('configuration', () => {
  test('defaults and validation', () => {
    assert.equal(createLlmClient({ provider: 'anthropic', apiKey: 'k' }).model, 'claude-sonnet-5-5')
    assert.equal(createLlmClient({ provider: 'openai', apiKey: 'k' }).model, 'gpt-4o')
    const ollama = createLlmClient({ provider: 'ollama' })
    assert.equal(ollama.model, 'llama3.1')
    assert.equal(ollama.baseUrl, 'http://localhost:11434/v1')
    assert.throws(() => createLlmClient({ provider: 'anthropic' }), /No API key/)
    assert.throws(() => createLlmClient({ provider: 'nope' }), /Unknown LLM provider/)
  })

  test('mock provider: string, array and function responses', async () => {
    assert.equal(await createLlmClient({ provider: 'mock', mockResponse: 'a' }).complete({ messages: [] }), 'a')
    const seq = createLlmClient({ provider: 'mock', mockResponse: ['1', '2'] })
    assert.deepEqual([await seq.complete({}), await seq.complete({}), await seq.complete({})], ['1', '2', '2'])
    const fn = createLlmClient({ provider: 'mock', mockResponse: (messages) => `n=${messages.length}` })
    assert.equal(await fn.complete({ messages: [{ role: 'user', content: 'x' }] }), 'n=1')
  })

  test('llmConfigFromEnv', () => {
    assert.equal(llmConfigFromEnv({}), null)
    assert.deepEqual(llmConfigFromEnv({ ANTHROPIC_API_KEY: 'a' }), { provider: 'anthropic', apiKey: 'a' })
    assert.deepEqual(llmConfigFromEnv({ OPENAI_API_KEY: 'o' }), { provider: 'openai', apiKey: 'o' })
    assert.deepEqual(llmConfigFromEnv({ FLOW_LLM_PROVIDER: 'anthropic', FLOW_LLM_API_KEY: 'f', ANTHROPIC_API_KEY: 'a', FLOW_LLM_MODEL: 'm' }), { provider: 'anthropic', model: 'm', apiKey: 'f' })
    assert.deepEqual(llmConfigFromEnv({ FLOW_LLM_PROVIDER: 'ollama', FLOW_LLM_BASE_URL: 'http://gpu:11434/v1' }), { provider: 'ollama', baseUrl: 'http://gpu:11434/v1' })
    assert.equal(llmConfigFromEnv({ FLOW_LLM_PROVIDER: 'openai' }), null, 'openai without a key is not configured')
  })

  test('describeLlmConfig never returns the key', () => {
    const d = describeLlmConfig({ provider: 'anthropic', apiKey: 'secret-key' })
    assert.deepEqual(d, { provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com', hasKey: true })
    assert.ok(!JSON.stringify(d).includes('secret'))
    const fromClient = describeLlmConfig(createLlmClient({ provider: 'openai', apiKey: 'secret-key', model: 'gpt-x' }))
    assert.deepEqual(fromClient, { provider: 'openai', model: 'gpt-x', baseUrl: 'https://api.openai.com/v1', hasKey: true })
    assert.equal(describeLlmConfig(null), null)
  })
})
