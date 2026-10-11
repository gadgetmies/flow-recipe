const { getDatabase } = require('../database');
const recipes = require('./recipes');

const HOST_ID = '0';
const DEFAULT_LATE_TOLERANCE = 300000;
const DEFAULT_SERVE_OFFSET = 90 * 60 * 1000;

const DEFAULT_PROFILE = {
  speed: 1,
  capabilities: null,
  role: 'cook',
  targetShare: 1,
  maxConcurrentTimers: 2,
};

// Defaults per packages/scheduler/README.md §4 (spec §11). The scheduler owns the semantics; the server only
// stores a complete policy object so that clients always see every field.
const DEFAULT_POLICY = {
  weights: { fair: 10, idle: 8, switch: 3, interrupt: 5, robust: 2, span: 1, stable: 4 },
  switchMatrix: { sameContext: 0, sameDishSameStation: 15, sameDishOtherStation: 30, otherDish: 60, afterCleaning: 30, any: 10 },
  minChunkSeconds: 180,
  maxIdleStretchSeconds: 480,
  slackBufferFraction: 0.1,
  slackBufferMinSeconds: 120,
  hotHoldSeconds: 600,
  coldHoldSeconds: 1200,
  cleaning: 'shared',
  endOfSessionCleaning: true,
  miseEnPlace: false,
  leadSeconds: 30,
  reactionSeconds: 30,
  ackTimeoutSeconds: 15,
  replanThresholdSeconds: 90,
  replanDebounceSeconds: 10,
  stabilityHorizonSeconds: 900,
  searchBudgetMs: 400,
  replanBudgetMs: 120,
  seed: 1,
};

function db() {
  return getDatabase();
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallback;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergePolicy(base, overrides) {
  const out = { ...base };
  if (!isPlainObject(overrides)) return out;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = { ...base[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function mergeProfile(base, overrides) {
  const out = { ...DEFAULT_PROFILE, ...(base || {}) };
  if (!isPlainObject(overrides)) return out;
  for (const key of Object.keys(DEFAULT_PROFILE)) {
    if (overrides[key] !== undefined) out[key] = overrides[key];
  }
  return out;
}

function toNumber(value, fallback) {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return Number.isFinite(n) ? n : fallback;
}

// ---- sessions -------------------------------------------------------------------------------------------------

function sessionExists(sessionId) {
  return !!db().prepare(`SELECT 1 FROM sessions WHERE session_id = ?`).get(sessionId);
}

function normaliseDishes(input, { defaultServeTime }) {
  const list = Array.isArray(input) && input.length > 0 ? input : [{ recipeId: 'bday-cake' }];
  const seen = new Set();
  const out = [];
  list.forEach((d, index) => {
    if (!d || typeof d !== 'object') throw new Error(`Dish ${index + 1} is not an object`);
    const recipeId = d.recipeId;
    if (!recipes.isValidId(recipeId)) throw new Error(`Dish ${index + 1}: invalid recipeId`);
    const info = recipes.getRecipeInfo(recipeId);
    if (!info) throw new Error(`Dish ${index + 1}: unknown recipe '${recipeId}'`);
    let id = typeof d.id === 'string' && d.id.trim() ? d.id.trim() : recipeId;
    let n = 2;
    while (seen.has(id)) id = `${recipeId}-${n++}`;
    seen.add(id);
    const scale = toNumber(d.scale, 1);
    if (!(scale > 0)) throw new Error(`Dish ${index + 1}: invalid scale`);
    out.push({
      id,
      recipeId,
      title: info.title,
      scale,
      serveTime: toNumber(d.serveTime, defaultServeTime),
      earlyTolerance: Math.max(0, toNumber(d.earlyTolerance, 0)),
      lateTolerance: Math.max(0, toNumber(d.lateTolerance, DEFAULT_LATE_TOLERANCE)),
      position: index,
    });
  });
  return out;
}

function writeDishes(sessionId, dishes) {
  const insert = db().prepare(
    `INSERT INTO dishes (id, session_id, recipe_id, title, scale, serve_time, early_tolerance, late_tolerance, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db().prepare(`DELETE FROM dishes WHERE session_id = ?`).run(sessionId);
  for (const d of dishes) {
    insert.run(d.id, sessionId, d.recipeId, d.title, d.scale, d.serveTime, d.earlyTolerance, d.lateTolerance, d.position);
  }
  const first = dishes[0];
  db().prepare(`UPDATE sessions SET recipe_name = ?, scale = ? WHERE session_id = ?`).run(
    first ? first.recipeId : null,
    first ? first.scale : 1,
    sessionId
  );
}

function createSession({ sessionId, dishes, inventory, policy, startTime }) {
  if (!sessionId || typeof sessionId !== 'string') throw new Error('Session ID is required');
  const now = Date.now();
  const normalisedDishes = normaliseDishes(dishes, { defaultServeTime: now + DEFAULT_SERVE_OFFSET });
  const fullPolicy = mergePolicy(DEFAULT_POLICY, policy);
  const start = startTime === undefined || startTime === null ? null : toNumber(startTime, null);

  const run = db().transaction(() => {
    db().prepare(
      `INSERT INTO sessions (session_id, created_at, status, start_time, inventory_json, policy_json, plan_json, scale, mise_en_place, session_started, recipe_name)
       VALUES (?, ?, 'draft', ?, ?, ?, NULL, 1, ?, 0, NULL)`
    ).run(sessionId, new Date(now).toISOString(), start, JSON.stringify(inventory), JSON.stringify(fullPolicy), fullPolicy.miseEnPlace ? 1 : 0);
    writeDishes(sessionId, normalisedDishes);
  });
  run();
  return getSession(sessionId);
}

function getSession(sessionId) {
  const row = db().prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId);
  if (!row) return null;
  const dishes = db()
    .prepare(`SELECT * FROM dishes WHERE session_id = ? ORDER BY position`)
    .all(sessionId)
    .map((d) => ({
      id: d.id,
      recipeId: d.recipe_id,
      title: d.title,
      scale: d.scale,
      serveTime: d.serve_time,
      earlyTolerance: d.early_tolerance,
      lateTolerance: d.late_tolerance,
    }));
  return {
    id: row.session_id,
    status: row.status || 'draft',
    createdAt: Date.parse(row.created_at) || row.created_at,
    startTime: row.start_time === null || row.start_time === undefined ? null : Number(row.start_time),
    dishes,
    inventory: parseJson(row.inventory_json, null),
    policy: mergePolicy(DEFAULT_POLICY, parseJson(row.policy_json, {})),
    participants: getParticipants(sessionId),
  };
}

function setDishes(sessionId, dishes) {
  const now = Date.now();
  const normalised = normaliseDishes(dishes, { defaultServeTime: now + DEFAULT_SERVE_OFFSET });
  db().transaction(() => writeDishes(sessionId, normalised))();
  return normalised;
}

function setInventory(sessionId, inventory) {
  db().prepare(`UPDATE sessions SET inventory_json = ? WHERE session_id = ?`).run(JSON.stringify(inventory), sessionId);
}

function setPolicy(sessionId, partial) {
  const row = db().prepare(`SELECT policy_json FROM sessions WHERE session_id = ?`).get(sessionId);
  const merged = mergePolicy(mergePolicy(DEFAULT_POLICY, parseJson(row && row.policy_json, {})), partial);
  db()
    .prepare(`UPDATE sessions SET policy_json = ?, mise_en_place = ? WHERE session_id = ?`)
    .run(JSON.stringify(merged), merged.miseEnPlace ? 1 : 0, sessionId);
  return merged;
}

function setStatus(sessionId, status, startTime) {
  const sessionStarted = status === 'running' || status === 'done' ? 1 : 0;
  if (startTime === undefined) {
    db().prepare(`UPDATE sessions SET status = ?, session_started = ? WHERE session_id = ?`).run(status, sessionStarted, sessionId);
  } else {
    db()
      .prepare(`UPDATE sessions SET status = ?, session_started = ?, start_time = ? WHERE session_id = ?`)
      .run(status, sessionStarted, startTime, sessionId);
  }
}

function setPlan(sessionId, plan) {
  db().prepare(`UPDATE sessions SET plan_json = ? WHERE session_id = ?`).run(plan ? JSON.stringify(plan) : null, sessionId);
}

function getStoredPlan(sessionId) {
  const row = db().prepare(`SELECT plan_json FROM sessions WHERE session_id = ?`).get(sessionId);
  return row ? parseJson(row.plan_json, null) : null;
}

// ---- participants ---------------------------------------------------------------------------------------------

function rowToParticipant(p) {
  return {
    id: p.participant_id,
    name: p.name,
    isSpectator: p.is_spectator === 1,
    connected: p.connected === 1,
    placeholder: p.placeholder === 1,
    profile: mergeProfile(parseJson(p.profile_json, {}), null),
  };
}

function getParticipants(sessionId) {
  return db()
    .prepare(`SELECT * FROM participants WHERE session_id = ? ORDER BY joined_at, participant_id`)
    .all(sessionId)
    .map(rowToParticipant);
}

function getParticipant(sessionId, participantId) {
  const row = db()
    .prepare(`SELECT * FROM participants WHERE session_id = ? AND participant_id = ?`)
    .get(sessionId, participantId);
  return row ? rowToParticipant(row) : null;
}

function getConnections(sessionId) {
  return getParticipants(sessionId).map(({ id, name, isSpectator, connected, placeholder }) => ({
    id,
    name,
    isSpectator,
    connected,
    placeholder,
  }));
}

function joinParticipant(sessionId, { participantId, socketId, name, isSpectator }) {
  const existing = db()
    .prepare(`SELECT participant_id, name, is_spectator FROM participants WHERE session_id = ? AND participant_id = ?`)
    .get(sessionId, participantId);
  if (existing) {
    const spectatorValue = isSpectator === undefined ? existing.is_spectator : isSpectator ? 1 : 0;
    db()
      .prepare(
        `UPDATE participants SET socket_id = ?, name = ?, is_spectator = ?, connected = 1, placeholder = 0
         WHERE session_id = ? AND participant_id = ?`
      )
      .run(socketId, name === undefined ? existing.name : name || '', spectatorValue, sessionId, participantId);
    return { created: false };
  }
  const spectatorValue = isSpectator === undefined ? 1 : isSpectator ? 1 : 0;
  db()
    .prepare(
      `INSERT INTO participants (session_id, participant_id, socket_id, name, joined_at, is_spectator, connected, placeholder, profile_json)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`
    )
    .run(sessionId, participantId, socketId, name || '', new Date().toISOString(), spectatorValue, JSON.stringify(DEFAULT_PROFILE));
  return { created: true };
}

function updateName(sessionId, participantId, name) {
  db().prepare(`UPDATE participants SET name = ? WHERE session_id = ? AND participant_id = ?`).run(name || '', sessionId, participantId);
}

function updateParticipant(sessionId, participantId, { profile, isSpectator, name }) {
  const row = db()
    .prepare(`SELECT profile_json, is_spectator, name FROM participants WHERE session_id = ? AND participant_id = ?`)
    .get(sessionId, participantId);
  if (!row) return null;
  const merged = mergeProfile(parseJson(row.profile_json, {}), profile);
  db()
    .prepare(`UPDATE participants SET profile_json = ?, is_spectator = ?, name = ? WHERE session_id = ? AND participant_id = ?`)
    .run(
      JSON.stringify(merged),
      isSpectator === undefined ? row.is_spectator : isSpectator ? 1 : 0,
      name === undefined ? row.name : name || '',
      sessionId,
      participantId
    );
  return getParticipant(sessionId, participantId);
}

function setConnected(sessionId, participantId, connected, socketId) {
  if (socketId === undefined) {
    db()
      .prepare(`UPDATE participants SET connected = ? WHERE session_id = ? AND participant_id = ?`)
      .run(connected ? 1 : 0, sessionId, participantId);
  } else {
    db()
      .prepare(`UPDATE participants SET connected = ?, socket_id = ? WHERE session_id = ? AND participant_id = ?`)
      .run(connected ? 1 : 0, socketId, sessionId, participantId);
  }
}

function findBySocket(socketId) {
  const row = db().prepare(`SELECT session_id, participant_id FROM participants WHERE socket_id = ?`).get(socketId);
  return row ? { sessionId: row.session_id, participantId: row.participant_id } : null;
}

function addPlaceholder(sessionId, { participantId, name, profile } = {}) {
  let id = participantId;
  if (!id || !/^placeholder-\d+$/.test(id) || getParticipant(sessionId, id)) {
    const rows = db()
      .prepare(`SELECT participant_id FROM participants WHERE session_id = ? AND participant_id LIKE 'placeholder-%'`)
      .all(sessionId);
    let max = 0;
    for (const r of rows) {
      const n = parseInt(r.participant_id.slice('placeholder-'.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    id = `placeholder-${max + 1}`;
  }
  const displayName = name && String(name).trim() ? String(name).trim() : `Cook ${id.slice('placeholder-'.length)}`;
  db()
    .prepare(
      `INSERT INTO participants (session_id, participant_id, socket_id, name, joined_at, is_spectator, connected, placeholder, profile_json)
       VALUES (?, ?, '', ?, ?, 0, 0, 1, ?)`
    )
    .run(sessionId, id, displayName, new Date().toISOString(), JSON.stringify(mergeProfile({}, profile)));
  return getParticipant(sessionId, id);
}

function removePlaceholder(sessionId, participantId) {
  const result = db()
    .prepare(`DELETE FROM participants WHERE session_id = ? AND participant_id = ? AND placeholder = 1`)
    .run(sessionId, participantId);
  return result.changes > 0;
}

function removeAllPlaceholders(sessionId) {
  return db().prepare(`DELETE FROM participants WHERE session_id = ? AND placeholder = 1`).run(sessionId).changes;
}

// ---- events ---------------------------------------------------------------------------------------------------

function rowToEvent(row) {
  const event = { id: row.id, type: row.type, at: Number(row.at) };
  if (row.participant_id !== null && row.participant_id !== undefined) event.participantId = row.participant_id;
  if (row.uuid !== null && row.uuid !== undefined) event.uuid = row.uuid;
  if (row.units !== null && row.units !== undefined) event.units = row.units;
  const payload = parseJson(row.payload_json, undefined);
  if (payload !== undefined) event.payload = payload;
  return event;
}

function appendEvent(sessionId, event) {
  const result = db()
    .prepare(
      `INSERT INTO events (session_id, participant_id, type, uuid, units, payload_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      event.participantId === undefined ? null : String(event.participantId),
      event.type,
      event.uuid === undefined ? null : String(event.uuid),
      event.units === undefined || event.units === null ? null : Number(event.units),
      event.payload === undefined ? null : JSON.stringify(event.payload),
      event.at
    );
  return { ...event, id: Number(result.lastInsertRowid) };
}

function getEvents(sessionId) {
  return db().prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id`).all(sessionId).map(rowToEvent);
}

function clearEvents(sessionId) {
  db().prepare(`DELETE FROM events WHERE session_id = ?`).run(sessionId);
}

// ---- help requests --------------------------------------------------------------------------------------------

function setHelpRequest(sessionId, participantId, requested) {
  if (requested) {
    db()
      .prepare(`INSERT OR REPLACE INTO help_requests (session_id, participant_id, active, requested_at) VALUES (?, ?, 1, ?)`)
      .run(sessionId, participantId, new Date().toISOString());
  } else {
    db().prepare(`UPDATE help_requests SET active = 0 WHERE session_id = ? AND participant_id = ?`).run(sessionId, participantId);
  }
}

function getHelpRequests(sessionId) {
  return db()
    .prepare(`SELECT participant_id FROM help_requests WHERE session_id = ? AND active = 1 ORDER BY requested_at`)
    .all(sessionId)
    .map((row) => row.participant_id);
}

function clearHelpRequests(sessionId) {
  db().prepare(`UPDATE help_requests SET active = 0 WHERE session_id = ?`).run(sessionId);
}

module.exports = {
  HOST_ID,
  DEFAULT_POLICY,
  DEFAULT_PROFILE,
  sessionExists,
  createSession,
  getSession,
  setDishes,
  setInventory,
  setPolicy,
  setStatus,
  setPlan,
  getStoredPlan,
  getParticipants,
  getParticipant,
  getConnections,
  joinParticipant,
  updateName,
  updateParticipant,
  setConnected,
  findBySocket,
  addPlaceholder,
  removePlaceholder,
  removeAllPlaceholders,
  appendEvent,
  getEvents,
  clearEvents,
  setHelpRequest,
  getHelpRequests,
  clearHelpRequests,
};
