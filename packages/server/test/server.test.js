const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const SERVER = path.join(__dirname, '..', 'src', 'index.js');
const TIMEOUT_MS = 10000;

function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-recipe-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: '0', FLOW_DB_PATH: dbPath, NODE_ENV: 'test', FLOW_INTERRUPT_CHECK_MS: '500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/Server running on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(parseInt(match[1], 10));
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
    child,
    dbPath,
    dir,
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

function waitFor(socket, event, predicate = () => true, label = event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for '${label}'`));
    }, TIMEOUT_MS);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

function connect(url) {
  const socket = io(url, { transports: ['websocket'], forceNew: true });
  return waitFor(socket, 'connect').then(() => socket);
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  return { status: res.status, body };
}

async function postJson(url, data) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const body = await res.json();
  return { status: res.status, body };
}

function assertSessionView(session) {
  assert.ok(session && typeof session === 'object', 'session is an object');
  assert.strictEqual(typeof session.id, 'string');
  assert.ok(['draft', 'running', 'done'].includes(session.status), `status ${session.status}`);
  assert.ok(Array.isArray(session.dishes));
  assert.ok(Array.isArray(session.participants));
  assert.ok(session.inventory && Array.isArray(session.inventory.tools), 'inventory.tools');
  assert.ok(session.policy && typeof session.policy.replanDebounceSeconds === 'number', 'policy');
  for (const dish of session.dishes) {
    for (const key of ['id', 'recipeId', 'title', 'scale', 'serveTime', 'earlyTolerance', 'lateTolerance']) {
      assert.ok(key in dish, `dish.${key}`);
    }
  }
  for (const p of session.participants) {
    for (const key of ['id', 'name', 'isSpectator', 'connected', 'placeholder', 'profile']) {
      assert.ok(key in p, `participant.${key}`);
    }
    for (const key of ['speed', 'capabilities', 'role', 'targetShare', 'maxConcurrentTimers']) {
      assert.ok(key in p.profile, `profile.${key}`);
    }
  }
}

function assertPlanShape(plan, status) {
  if (plan === null) return; // scheduler not implemented yet
  assert.ok(['offline', 'online'].includes(plan.mode), `plan.mode ${plan.mode}`);
  if (status) assert.strictEqual(plan.status, status);
  assert.ok(Array.isArray(plan.lanes), 'plan.lanes');
  assert.ok(Array.isArray(plan.dishes), 'plan.dishes');
  assert.ok(Array.isArray(plan.diagnostics), 'plan.diagnostics');
  for (const lane of plan.lanes) {
    assert.strictEqual(typeof lane.participantId, 'string');
    assert.ok(Array.isArray(lane.items));
  }
}

test('server: sessions, joins, settings, start and events', async (t) => {
  const server = startServer();
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.disconnect();
    await server.stop();
  });

  const port = await server.ready;
  const url = `http://127.0.0.1:${port}`;

  await t.test('GET /api/recipes lists recipes with title and serving', async () => {
    const { status, body } = await getJson(`${url}/api/recipes`);
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body) && body.length > 0);
    assert.ok(!body.some((r) => r.id === 'operations'));
    const buns = body.find((r) => r.id === 'buns');
    assert.ok(buns, 'buns recipe listed');
    assert.strictEqual(buns.title, 'Buns');
    assert.ok('serving' in buns);
  });

  await t.test('GET /api/recipes/:id, /api/operations and /api/inventory/default', async () => {
    const xml = await fetch(`${url}/api/recipes/buns`);
    assert.strictEqual(xml.status, 200);
    assert.match(xml.headers.get('content-type'), /application\/xml/);
    assert.match(await xml.text(), /<recipe/);

    const missing = await fetch(`${url}/api/recipes/does-not-exist`);
    assert.strictEqual(missing.status, 404);

    const ops = await fetch(`${url}/api/operations`);
    assert.strictEqual(ops.status, 200);
    assert.match(await ops.text(), /<operations/);

    const inv = await getJson(`${url}/api/inventory/default`);
    assert.strictEqual(inv.status, 200);
    assert.ok(Array.isArray(inv.body.tools));
    assert.ok(inv.body.cleaning && typeof inv.body.cleaning.washSeconds === 'number');
  });

  const sessionId = `test-${Date.now()}`;
  const serveTime = Date.now() + 60 * 60 * 1000;

  await t.test('POST /api/sessions creates a session with two dishes', async () => {
    const { status, body } = await postJson(`${url}/api/sessions`, {
      sessionId,
      dishes: [
        { recipeId: 'buns', scale: 1, serveTime },
        { recipeId: 'negroni', scale: 2, serveTime: serveTime + 600000 },
      ],
    });
    assert.strictEqual(status, 201, JSON.stringify(body));
    assertSessionView(body.session);
    assert.strictEqual(body.session.id, sessionId);
    assert.strictEqual(body.session.status, 'draft');
    assert.strictEqual(body.session.dishes.length, 2);
    assert.strictEqual(body.session.dishes[0].title, 'Buns');
    assert.strictEqual(body.session.dishes[1].recipeId, 'negroni');
    assert.strictEqual(body.session.dishes[1].scale, 2);
    assert.ok('plan' in body);
    assertPlanShape(body.plan, 'draft');

    const dup = await postJson(`${url}/api/sessions`, { sessionId, dishes: [{ recipeId: 'buns' }] });
    assert.strictEqual(dup.status, 409);

    const bad = await postJson(`${url}/api/sessions`, { sessionId: `${sessionId}-bad`, dishes: [{ recipeId: 'nope' }] });
    assert.strictEqual(bad.status, 400);

    const noId = await postJson(`${url}/api/sessions`, {});
    assert.strictEqual(noId.status, 400);
  });

  await t.test('GET /api/sessions/:id returns session and plan', async () => {
    const { status, body } = await getJson(`${url}/api/sessions/${sessionId}`);
    assert.strictEqual(status, 200);
    assertSessionView(body.session);
    assert.ok('plan' in body);
    assertPlanShape(body.plan, 'draft');
    const missing = await getJson(`${url}/api/sessions/nope`);
    assert.strictEqual(missing.status, 404);
  });

  const host = await connect(url);
  sockets.push(host);

  await t.test('host joins and receives session, plan, connections, helpRequests', async () => {
    const got = Promise.all([
      waitFor(host, 'session'),
      waitFor(host, 'plan'),
      waitFor(host, 'connections'),
      waitFor(host, 'helpRequests'),
    ]);
    host.emit('joinSession', { sessionId, participantId: '0', name: 'Host', isSpectator: false });
    const [session, plan, connections, helpRequests] = await got;
    assertSessionView(session);
    assert.strictEqual(session.participants.length, 1);
    assert.strictEqual(session.participants[0].id, '0');
    assert.strictEqual(session.participants[0].name, 'Host');
    assert.strictEqual(session.participants[0].isSpectator, false);
    assert.strictEqual(session.participants[0].connected, true);
    assertPlanShape(plan, 'draft');
    assert.deepStrictEqual(connections, [{ id: '0', name: 'Host', isSpectator: false, connected: true, placeholder: false }]);
    assert.deepStrictEqual(helpRequests, []);
  });

  await t.test('joining an unknown session yields an error', async () => {
    const stray = await connect(url);
    sockets.push(stray);
    const err = waitFor(stray, 'error');
    stray.emit('joinSession', { sessionId: 'nope', participantId: '7', name: 'X', isSpectator: false });
    assert.match((await err).message, /not found/i);
    stray.disconnect();
  });

  const cook = await connect(url);
  sockets.push(cook);

  await t.test('a participant joins; everyone sees the roster', async () => {
    const hostSees = waitFor(host, 'session', (s) => s.participants.length === 2, 'session with 2 participants');
    const cookGets = Promise.all([waitFor(cook, 'session'), waitFor(cook, 'plan')]);
    cook.emit('joinSession', { sessionId, participantId: '1', name: 'Alice', isSpectator: false });
    const [session] = await cookGets;
    assertSessionView(session);
    const alice = session.participants.find((p) => p.id === '1');
    assert.ok(alice);
    assert.strictEqual(alice.name, 'Alice');
    assert.strictEqual(alice.connected, true);
    await hostSees;
  });

  await t.test('updateName and updateParticipant', async () => {
    const renamed = waitFor(cook, 'session', (s) => s.participants.some((p) => p.id === '1' && p.name === 'Alicia'));
    cook.emit('updateName', { sessionId, participantId: '1', name: 'Alicia' });
    await renamed;

    const profiled = waitFor(host, 'session', (s) => s.participants.some((p) => p.id === '1' && p.profile.speed === 1.5));
    cook.emit('updateParticipant', { sessionId, participantId: '1', profile: { speed: 1.5, role: 'cleaner' } });
    const session = await profiled;
    const alice = session.participants.find((p) => p.id === '1');
    assert.strictEqual(alice.profile.role, 'cleaner');
    assert.strictEqual(alice.profile.maxConcurrentTimers, 2);

    const err = waitFor(cook, 'error');
    cook.emit('updateParticipant', { sessionId, participantId: '0', profile: { speed: 0.5 } });
    assert.match((await err).message, /host/i);
  });

  await t.test('host adds and removes a placeholder', async () => {
    const added = waitFor(cook, 'session', (s) => s.participants.some((p) => p.placeholder));
    host.emit('addPlaceholder', { sessionId, participantId: '0', name: 'Bob', profile: { speed: 0.8 } });
    const session = await added;
    const bob = session.participants.find((p) => p.placeholder);
    assert.match(bob.id, /^placeholder-\d+$/);
    assert.strictEqual(bob.name, 'Bob');
    assert.strictEqual(bob.profile.speed, 0.8);
    assert.strictEqual(bob.connected, false);

    const removed = waitFor(cook, 'session', (s) => !s.participants.some((p) => p.placeholder));
    host.emit('removePlaceholder', { sessionId, participantId: bob.id });
    await removed;

    const err = waitFor(cook, 'error');
    cook.emit('addPlaceholder', { sessionId, participantId: '1', name: 'Nope' });
    assert.match((await err).message, /host/i);
  });

  await t.test('host updates a dish; non-host is refused', async () => {
    const err = waitFor(cook, 'error');
    cook.emit('updateDishes', { sessionId, participantId: '1', dishes: [{ recipeId: 'buns', scale: 3, serveTime }] });
    assert.match((await err).message, /host/i);

    const updated = waitFor(cook, 'session', (s) => s.dishes.length === 2 && s.dishes[0].scale === 2, 'session with scale 2');
    const plan = waitFor(cook, 'plan');
    host.emit('updateDishes', {
      sessionId,
      participantId: '0',
      dishes: [
        { recipeId: 'buns', scale: 2, serveTime: serveTime + 300000, lateTolerance: 120000 },
        { recipeId: 'negroni', scale: 2, serveTime },
      ],
    });
    const session = await updated;
    assert.strictEqual(session.dishes[0].serveTime, serveTime + 300000);
    assert.strictEqual(session.dishes[0].lateTolerance, 120000);
    assertPlanShape(await plan, 'draft');
  });

  await t.test('host updates inventory and policy', async () => {
    const inv = waitFor(cook, 'session', (s) => s.inventory.appliances.some((a) => a.type === 'oven' && a.slots === 1));
    host.emit('updateInventory', { sessionId, participantId: '0', inventory: { appliances: [{ type: 'oven', slots: 1 }] } });
    const session = await inv;
    assert.ok(session.inventory.tools.length > 0, 'merged over the default inventory');

    const pol = waitFor(cook, 'session', (s) => s.policy.cleaning === 'dedicated');
    host.emit('updatePolicy', { sessionId, participantId: '0', policy: { cleaning: 'dedicated', weights: { fair: 20 } } });
    const after = await pol;
    assert.strictEqual(after.policy.weights.fair, 20);
    assert.strictEqual(after.policy.weights.idle, 8);
  });

  await t.test('events are refused before the session starts', async () => {
    const err = waitFor(cook, 'error');
    cook.emit('event', { sessionId, participantId: '1', type: 'taskDone', uuid: 'buns:mix#b1' });
    assert.match((await err).message, /not running/i);
  });

  await t.test('host starts the session', async () => {
    const before = Date.now();
    const running = waitFor(cook, 'session', (s) => s.status === 'running');
    const plan = waitFor(cook, 'plan');
    host.emit('startSession', { sessionId, participantId: '0' });
    const session = await running;
    assert.ok(typeof session.startTime === 'number' && session.startTime >= before);
    assert.ok(!session.participants.some((p) => p.placeholder), 'placeholders reconciled at start');
    assertPlanShape(await plan, 'running');

    const err = waitFor(host, 'error');
    host.emit('startSession', { sessionId, participantId: '0' });
    assert.match((await err).message, /already started/i);
  });

  await t.test('taskDone event is logged and a plan broadcast follows', async () => {
    const plan = waitFor(cook, 'plan');
    cook.emit('event', { sessionId, participantId: '1', type: 'taskDone', uuid: 'buns:mix#b1' });
    const received = await plan;
    assertPlanShape(received, 'running');

    const { status, body } = await getJson(`${url}/api/sessions/${sessionId}/events`);
    assert.strictEqual(status, 200);
    const types = body.map((e) => e.type);
    assert.ok(types.includes('sessionStarted'), 'sessionStarted logged');
    const done = body.find((e) => e.type === 'taskDone');
    assert.ok(done, 'taskDone logged');
    assert.strictEqual(done.participantId, '1');
    assert.strictEqual(done.uuid, 'buns:mix#b1');
    assert.strictEqual(typeof done.at, 'number');

    const unknown = waitFor(cook, 'error');
    cook.emit('event', { sessionId, participantId: '1', type: 'bogus' });
    assert.match((await unknown).message, /unknown event/i);

    const notSelf = waitFor(cook, 'error');
    cook.emit('event', { sessionId, participantId: '0', type: 'taskDone', uuid: 'x' });
    assert.match((await notSelf).message, /host/i);
  });

  await t.test('askForHelp broadcasts participant ids', async () => {
    const asked = waitFor(host, 'helpRequests', (list) => list.includes('1'));
    cook.emit('askForHelp', { sessionId, participantId: '1', requested: true });
    assert.deepStrictEqual(await asked, ['1']);
    const cleared = waitFor(host, 'helpRequests', (list) => !list.includes('1'));
    cook.emit('askForHelp', { sessionId, participantId: '1', requested: false });
    await cleared;
  });

  await t.test('GET /api/sessions/:id reflects the running state', async () => {
    const { body } = await getJson(`${url}/api/sessions/${sessionId}`);
    assert.strictEqual(body.session.status, 'running');
    assertPlanShape(body.plan, 'running');
  });

  await t.test('disconnect marks the participant as disconnected', async () => {
    const gone = waitFor(host, 'session', (s) => s.participants.some((p) => p.id === '1' && p.connected === false));
    cook.disconnect();
    await gone;
  });

  await t.test('restart returns to draft and clears events', async () => {
    const draft = waitFor(host, 'session', (s) => s.status === 'draft');
    const plan = waitFor(host, 'plan');
    host.emit('restart', { sessionId });
    const session = await draft;
    assert.strictEqual(session.startTime, null);
    assertPlanShape(await plan, 'draft');
    const { body } = await getJson(`${url}/api/sessions/${sessionId}/events`);
    assert.deepStrictEqual(body, []);
  });
});
