// Remote MCP connector (/mcp/:secret, Streamable HTTP, stateless) and the "Import with Claude" handoff
// (/api/import/claude). Every server runs on its own temporary SQLite file (FLOW_DB_PATH).

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'src', 'index.js');
const RECIPES_DIR = path.join(__dirname, '..', 'src', 'recipes');
const TIMEOUT_MS = 20000;
const SANDWICH_XML = fs.readFileSync(path.join(RECIPES_DIR, 'sandwich.xml'), 'utf-8');
const SECRET = 'test-connector-secret-0123456789abcdef';
const hasImporter = fs.existsSync(path.join(__dirname, '..', '..', 'importer', 'src', 'index.js'));
const hasMcp = fs.existsSync(path.join(__dirname, '..', '..', 'mcp', 'src', 'server.js'));
const needsMcp = hasImporter && hasMcp ? {} : { skip: '@flow-recipe/mcp or @flow-recipe/importer not present' };

function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-recipe-mcp-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const env = { ...process.env, PORT: '0', FLOW_DB_PATH: dbPath, NODE_ENV: 'test', FLOW_CHECK_RATE_LIMIT: '1000' };
  for (const key of Object.keys(env)) {
    if (/^(FLOW_LLM_|FLOW_UPLOAD_TOKEN|FLOW_MCP_SECRET|FLOW_IMPORT_ALLOW_PRIVATE|FLOW_TRUST_PROXY)/.test(key)) delete env[key];
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/Server running on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${output}`));
    });
  });
  return {
    dbPath,
    ready,
    output: () => output,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }).then(() => fs.rmSync(dir, { recursive: true, force: true })),
  };
}

async function request(method, url, data, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (data !== undefined) {
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
    init.body = typeof data === 'string' ? data : JSON.stringify(data);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch (error) {
    // not JSON
  }
  return { status: res.status, body, headers: res.headers };
}

async function connect(url) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'flow-recipe-server-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function json(result) {
  return JSON.parse(result.content.map((c) => c.text).join('\n'));
}

function startFixtureServer() {
  const page = `<!doctype html><html><head><title>Simple Butter Sandwich</title>
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Simple Butter Sandwich',
    recipeYield: '1 sandwich',
    recipeIngredient: ['2 slices bread', '1 tbsp butter'],
    recipeInstructions: [{ '@type': 'HowToStep', text: 'Spread the butter on the bread.' }],
    totalTime: 'PT5M',
  })}</script></head><body><h1>Simple Butter Sandwich</h1></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/sandwich.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('server: connector disabled without FLOW_MCP_SECRET', async (t) => {
  const server = startServer();
  t.after(() => server.stop());
  const base = await server.ready;

  let res = await request('GET', `${base}/api/llm`);
  assert.deepStrictEqual(res.body.claude, { connector: false });
  res = await request('POST', `${base}/mcp/${SECRET}`, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.strictEqual(res.status, 404);
  res = await request('POST', `${base}/api/import/claude`, { url: 'https://example.com/recipe' });
  assert.strictEqual(res.status, 503);
  assert.match(res.body.error, /not configured/);
  res = await request('GET', `${base}/api/import/claude`, undefined, { Authorization: `Bearer ${SECRET}` });
  assert.strictEqual(res.status, 404);
  assert.match(server.output(), /connector disabled/);
});

test('server: a too short FLOW_MCP_SECRET keeps the connector disabled', async (t) => {
  const server = startServer({ FLOW_MCP_SECRET: 'short-secret' });
  t.after(() => server.stop());
  const base = await server.ready;
  const res = await request('POST', `${base}/mcp/short-secret`, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual((await request('GET', `${base}/api/llm`)).body.claude, { connector: false });
  assert.match(server.output(), /shorter than 24 characters/);
});

test('server: remote MCP connector and the Claude handoff', needsMcp, async (t) => {
  const server = startServer({ FLOW_MCP_SECRET: SECRET, FLOW_IMPORT_ALLOW_PRIVATE: '1' });
  const fixtures = await startFixtureServer();
  t.after(async () => {
    await fixtures.close();
    await server.stop();
  });
  const base = await server.ready;
  const mcpUrl = `${base}/mcp/${SECRET}`;
  let client;
  t.after(() => client && client.close());

  await t.test('startup log shows the URL shape, never the secret', async () => {
    assert.match(server.output(), /\/mcp\/<FLOW_MCP_SECRET>/);
    assert.ok(!server.output().includes(SECRET));
  });

  await t.test('GET /api/llm reports the connector', async () => {
    const res = await request('GET', `${base}/api/llm`);
    assert.deepStrictEqual(res.body.claude, { connector: true });
  });

  await t.test('a wrong secret is 404 for every method, also with a malformed body', async () => {
    for (const method of ['POST', 'GET', 'DELETE']) {
      const res = await request(method, `${base}/mcp/${SECRET.slice(0, -1)}x`, method === 'POST' ? { jsonrpc: '2.0', id: 1, method: 'ping' } : undefined);
      assert.strictEqual(res.status, 404, method);
    }
    const res = await request('POST', `${base}/mcp/wrong-secret-wrong-secret-wrong`, '{"jsonrpc": ');
    assert.strictEqual(res.status, 404);
  });

  await t.test('protocol errors are JSON-RPC errors', async () => {
    let res = await request('POST', mcpUrl, '{"jsonrpc": ');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.jsonrpc, '2.0');
    assert.strictEqual(res.body.error.code, -32700);
    res = await request('GET', mcpUrl, undefined, { Accept: 'text/event-stream' });
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.body.error.code, -32000);
    res = await request('DELETE', mcpUrl);
    assert.strictEqual(res.status, 405);
    const accept = { Accept: 'application/json, text/event-stream' };
    res = await request('POST', mcpUrl, { jsonrpc: '2.0', id: 7, method: 'no/such/method' }, accept);
    assert.strictEqual(res.body.jsonrpc, '2.0');
    assert.strictEqual(res.body.id, 7);
    assert.strictEqual(res.body.error.code, -32601);
    res = await request('POST', mcpUrl, { hello: 'world' }, accept);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.jsonrpc, '2.0');
    assert.ok(res.body.error);
    // Stateless: a request without a prior initialize on this connection still works.
    res = await request('POST', mcpUrl, { jsonrpc: '2.0', id: 8, method: 'tools/list' }, accept);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.result.tools.length >= 10);
    res = await request('POST', mcpUrl, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Accept: 'text/html' });
    assert.strictEqual(res.status, 406);
    assert.strictEqual(res.body.jsonrpc, '2.0');
  });

  await t.test('initialize, tools/list and tools/call over Streamable HTTP', async () => {
    client = await connect(mcpUrl);
    assert.match(client.getInstructions(), /get_pending_import/);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ['get_authoring_guide', 'fetch_recipe_source', 'convert_recipe_units', 'check_recipe', 'list_recipes', 'get_recipe',
      'upload_recipe', 'list_pending_imports', 'get_pending_import', 'submit_import']) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
    assert.ok(!names.includes('import_recipe_with_server_llm'), 'no server-LLM tool in remote mode');

    const list = json(await client.callTool({ name: 'list_recipes', arguments: {} }));
    assert.ok(list.some((r) => r.id === 'buns'));
    const xml = await client.callTool({ name: 'get_recipe', arguments: { id: 'sandwich' } });
    assert.match(xml.content[0].text, /<recipe/);
    const missing = await client.callTool({ name: 'get_recipe', arguments: { id: 'nope' } });
    assert.strictEqual(missing.isError, true);
    const check = json(await client.callTool({ name: 'check_recipe', arguments: { xml: SANDWICH_XML } }));
    assert.strictEqual(check.ok, true, JSON.stringify(check.errors));
    const unknown = await client.callTool({ name: 'no_such_tool', arguments: {} });
    assert.strictEqual(unknown.isError, true);
    assert.match(unknown.content[0].text, /no_such_tool/);
    const invalid = await client.callTool({ name: 'check_recipe', arguments: {} });
    assert.strictEqual(invalid.isError, true, 'invalid arguments are reported, not thrown');
  });

  await t.test('every request gets a fresh stateless server (second client works too)', async () => {
    const other = await connect(mcpUrl);
    try {
      const { tools } = await other.listTools();
      assert.ok(tools.length >= 10);
    } finally {
      await other.close();
    }
  });

  await t.test('upload_recipe saves directly in remote mode', async () => {
    const result = json(await client.callTool({ name: 'upload_recipe', arguments: { xml: SANDWICH_XML, id: 'chat-sandwich' } }));
    assert.strictEqual(result.saved, 'server');
    assert.strictEqual(result.id, 'chat-sandwich');
    assert.match(result.startSession, /\/\?recipe=chat-sandwich$/);
    const res = await request('GET', `${base}/api/recipes`);
    assert.ok(res.body.some((r) => r.id === 'chat-sandwich' && r.source === 'imported'));
    const again = await client.callTool({ name: 'upload_recipe', arguments: { xml: SANDWICH_XML, id: 'chat-sandwich' } });
    assert.strictEqual(again.isError, true);
    assert.match(json(again).hint, /overwrite/);
  });

  await t.test('POST /api/import/claude validates like POST /api/import', async () => {
    let res = await request('POST', `${base}/api/import/claude`, {});
    assert.strictEqual(res.status, 400);
    res = await request('POST', `${base}/api/import/claude`, { url: 'ftp://example.com/x' });
    assert.strictEqual(res.status, 400);
    res = await request('POST', `${base}/api/import/claude`, { text: 'x'.repeat(1024 * 1024 + 1) });
    assert.strictEqual(res.status, 413);
    res = await request('GET', `${base}/api/import/claude/00000000-0000-0000-0000-000000000000`);
    assert.strictEqual(res.status, 404);
  });

  await t.test('full handoff: request → get_pending_import → submit_import → ready → save → saved', async () => {
    const url = `${fixtures.url}/sandwich.html`;
    let res = await request('POST', `${base}/api/import/claude`, { url, precisionScale: true, servings: 2, notes: 'no crusts' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const { requestId, prompt, claudeUrl } = res.body;
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.strictEqual(prompt, `Use the Flow Recipe connector to import recipe request ${requestId} (${url}).`);
    assert.strictEqual(claudeUrl, `https://claude.ai/new?q=${encodeURIComponent(prompt)}`);

    res = await request('GET', `${base}/api/import/claude/${requestId}`);
    assert.strictEqual(res.body.status, 'pending');
    assert.strictEqual(res.body.url, url);
    assert.ok(!('result' in res.body));

    const pending = json(await client.callTool({ name: 'list_pending_imports', arguments: {} }));
    assert.ok(pending.requests.some((r) => r.id === requestId && r.status === 'pending' && r.url === url));

    const claimed = json(await client.callTool({ name: 'get_pending_import', arguments: { id: requestId } }));
    assert.strictEqual(claimed.id, requestId);
    assert.strictEqual(claimed.precisionScale, true);
    assert.strictEqual(claimed.servings, 2);
    assert.strictEqual(claimed.notes, 'no crusts');
    assert.strictEqual(claimed.source.title, 'Simple Butter Sandwich');
    assert.deepStrictEqual(claimed.source.ingredients, ['2 slices bread', '1 tbsp butter']);
    assert.match(claimed.next, /submit_import/);
    res = await request('GET', `${base}/api/import/claude/${requestId}`);
    assert.strictEqual(res.body.status, 'claimed');

    // A draft with errors is not handed to the app.
    const broken = json(await client.callTool({ name: 'submit_import', arguments: { id: requestId, xml: '<recipe version="2"><title>x</title>' } }));
    assert.strictEqual(broken.ready, false);
    assert.ok(broken.check.errors.length > 0);
    res = await request('GET', `${base}/api/import/claude/${requestId}`);
    assert.strictEqual(res.body.status, 'claimed');
    assert.ok(!('result' in res.body));

    const submitted = json(await client.callTool({ name: 'submit_import', arguments: { id: requestId, xml: SANDWICH_XML } }));
    assert.strictEqual(submitted.ready, true, JSON.stringify(submitted.check.errors));
    assert.strictEqual(submitted.status, 'ready');
    assert.match(submitted.next, /back to the Flow Recipe app/);

    res = await request('GET', `${base}/api/import/claude/${requestId}`);
    assert.strictEqual(res.body.status, 'ready');
    const { result } = res.body;
    assert.ok(result, 'ready request carries the ImportResult');
    assert.strictEqual(result.check.ok, true);
    assert.deepStrictEqual(result.llm, { provider: 'claude-connector' });
    assert.strictEqual(result.source.url, url);
    assert.strictEqual(result.source.title, 'Simple Butter Sandwich');
    assert.strictEqual(result.attempts, 2);
    assert.ok(Array.isArray(result.conversions));
    assert.notStrictEqual(result.id, 'sandwich', 'the built-in id is taken, a free one is suggested');
    assert.match(result.xml, new RegExp(`<recipe\\b[^>]*\\sid="${result.id}"`));
    assert.match(result.xml, new RegExp(`\\sref="${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.ok(res.body.updatedAt >= res.body.createdAt);

    // A later draft with errors keeps the ready one.
    const worse = json(await client.callTool({ name: 'submit_import', arguments: { id: requestId, xml: '<recipe/>' } }));
    assert.strictEqual(worse.ready, false);
    res = await request('GET', `${base}/api/import/claude/${requestId}`);
    assert.strictEqual(res.body.status, 'ready');
    assert.strictEqual(res.body.result.xml, result.xml);

    res = await request('POST', `${base}/api/recipes`, { xml: result.xml, id: result.id, importRequestId: requestId });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    res = await request('GET', `${base}/api/import/claude/${requestId}`);
    assert.strictEqual(res.body.status, 'saved');
    assert.strictEqual(res.body.recipeId, result.id);

    const late = await client.callTool({ name: 'submit_import', arguments: { id: requestId, xml: SANDWICH_XML } });
    assert.strictEqual(late.isError, true);
    assert.match(json(late).error, /already saved/);
    const after = json(await client.callTool({ name: 'list_pending_imports', arguments: {} }));
    assert.ok(!after.requests.some((r) => r.id === requestId));
  });

  await t.test('pasted text requests never fetch the ref', async () => {
    const res = await request('POST', `${base}/api/import/claude`, { text: 'Toast\n\n1 slice bread\n\nToast it.', ref: 'http://127.0.0.1:9/never' });
    assert.strictEqual(res.status, 201);
    assert.match(res.body.prompt, /\(http:\/\/127\.0\.0\.1:9\/never\)/);
    const claimed = json(await client.callTool({ name: 'get_pending_import', arguments: { id: res.body.requestId } }));
    assert.match(claimed.text, /Toast it/);
    assert.ok(claimed.source && /Toast it/.test(claimed.source.text));
  });

  await t.test('a source that cannot be fetched is reported with a hint', async () => {
    const res = await request('POST', `${base}/api/import/claude`, { url: `${fixtures.url}/missing.html` });
    const result = await client.callTool({ name: 'get_pending_import', arguments: { id: res.body.requestId } });
    assert.strictEqual(result.isError, true);
    const body = json(result);
    assert.match(body.hint, /paste the recipe text/);
    assert.strictEqual(body.request.id, res.body.requestId);
  });

  await t.test('cancel', async () => {
    let res = await request('POST', `${base}/api/import/claude`, { url: 'https://example.com/cancel-me' });
    const id = res.body.requestId;
    res = await request('DELETE', `${base}/api/import/claude/${id}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'cancelled');
    const result = await client.callTool({ name: 'get_pending_import', arguments: { id } });
    assert.strictEqual(result.isError, true);
    assert.match(json(result).error, /cancelled/);
    res = await request('DELETE', `${base}/api/import/claude/00000000-0000-0000-0000-000000000000`);
    assert.strictEqual(res.status, 404);
  });

  await t.test('requests expire after 24 h', async () => {
    let res = await request('POST', `${base}/api/import/claude`, { url: 'https://example.com/old' });
    const id = res.body.requestId;
    const Database = require('better-sqlite3');
    const db = new Database(server.dbPath);
    try {
      db.prepare('UPDATE import_requests SET created_at = ? WHERE id = ?').run(Date.now() - 25 * 60 * 60 * 1000, id);
    } finally {
      db.close();
    }
    res = await request('GET', `${base}/api/import/claude/${id}`);
    assert.strictEqual(res.body.status, 'expired');
    const pending = json(await client.callTool({ name: 'list_pending_imports', arguments: {} }));
    assert.ok(!pending.requests.some((r) => r.id === id));
    const result = await client.callTool({ name: 'submit_import', arguments: { id, xml: SANDWICH_XML } });
    assert.strictEqual(result.isError, true);
    assert.match(json(result).error, /expired/);
  });

  await t.test('agent REST endpoints (stdio MCP server) need the connector secret', async () => {
    let res = await request('GET', `${base}/api/import/claude`);
    assert.strictEqual(res.status, 401);
    res = await request('GET', `${base}/api/import/claude`, undefined, { Authorization: 'Bearer wrong' });
    assert.strictEqual(res.status, 401);
    res = await request('GET', `${base}/api/import/claude`, undefined, { Authorization: `Bearer ${SECRET}` });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    res = await request('POST', `${base}/api/import/claude/00000000-0000-0000-0000-000000000000/claim`, {}, { Authorization: `Bearer ${SECRET}` });
    assert.strictEqual(res.status, 404);
    assert.ok(res.body.hint);
  });
});

test('server: Claude handoff requests follow the upload token rule', needsMcp, async (t) => {
  const server = startServer({ FLOW_MCP_SECRET: SECRET, FLOW_UPLOAD_TOKEN: 'upload-token' });
  t.after(() => server.stop());
  const base = await server.ready;
  let res = await request('POST', `${base}/api/import/claude`, { url: 'https://example.com/r' });
  assert.strictEqual(res.status, 401);
  res = await request('POST', `${base}/api/import/claude`, { url: 'https://example.com/r' }, { Authorization: 'Bearer upload-token' });
  assert.strictEqual(res.status, 201);
  const id = res.body.requestId;
  res = await request('GET', `${base}/api/import/claude/${id}`);
  assert.strictEqual(res.status, 200, 'polling stays open');
  res = await request('DELETE', `${base}/api/import/claude/${id}`);
  assert.strictEqual(res.status, 401);
  res = await request('DELETE', `${base}/api/import/claude/${id}`, undefined, { Authorization: 'Bearer upload-token' });
  assert.strictEqual(res.body.status, 'cancelled');
});
