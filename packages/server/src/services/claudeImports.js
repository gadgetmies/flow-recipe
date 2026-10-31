// "Import with Claude": pending import requests handed over from the import page to the user's Claude, which reads
// them through the Flow Recipe connector (remote MCP, see mcpRemote.js), authors the XML and submits a draft that the
// import page then reviews and saves.
//
// Table import_requests (database.js). Status flow: pending → claimed (Claude fetched it) → ready (a draft without
// errors was submitted) → saved (the import page saved it); or cancelled / expired (older than 24 h, swept lazily).

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { getDatabase } = require('../database');
const recipes = require('./recipes');
const importJobs = require('./importJobs');

const TTL_MS = 24 * 60 * 60 * 1000;
// Finished / expired rows (and the pasted text in them) are deleted after a week.
const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPEN_REQUESTS = parseInt(process.env.FLOW_CLAUDE_MAX_OPEN_REQUESTS || '200', 10);
const MIN_SECRET_LENGTH = 24;
const OPEN_STATUSES = ['pending', 'claimed', 'ready'];
const SOURCE_TEXT_CHARS = 12000;
const CONNECTOR_PROVIDER = 'claude-connector';

// requestId → { title, structured, times, yield, servings } of the source Claude fetched (for the ImportResult).
const sourceInfo = new Map();

function httpError(status, message, hint) {
  const error = new Error(message);
  error.status = status;
  if (hint) error.hint = hint;
  return error;
}

// ---- connector configuration --------------------------------------------------------------------------------------

function connectorSecret() {
  const secret = process.env.FLOW_MCP_SECRET;
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

function connectorConfigured() {
  return !!connectorSecret();
}

// Constant-time comparison of a presented secret with FLOW_MCP_SECRET (false when the connector is disabled).
function secretMatches(given) {
  const secret = connectorSecret();
  if (!secret || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b) && given.length === secret.length;
}

// ---- rows ---------------------------------------------------------------------------------------------------------

function db() {
  return getDatabase();
}

function sweep(now = Date.now()) {
  const database = db();
  database
    .prepare(`UPDATE import_requests SET status = 'expired', updated_at = ? WHERE status IN ('pending', 'claimed', 'ready') AND created_at < ?`)
    .run(now, now - TTL_MS);
  const purged = database.prepare(`SELECT id FROM import_requests WHERE created_at < ?`).all(now - PURGE_AFTER_MS);
  if (purged.length) {
    database.prepare(`DELETE FROM import_requests WHERE created_at < ?`).run(now - PURGE_AFTER_MS);
    for (const row of purged) sourceInfo.delete(row.id);
  }
}

function row(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  sweep();
  return db().prepare(`SELECT * FROM import_requests WHERE id = ?`).get(id) || null;
}

function parseResult(r) {
  if (!r || !r.result_json) return null;
  try {
    return JSON.parse(r.result_json);
  } catch (error) {
    return null;
  }
}

function prompt(id, url) {
  return `Use the Flow Recipe connector to import recipe request ${id} (${url || 'pasted recipe text'}).`;
}

// The view the import page polls: GET /api/import/claude/:id.
function view(r) {
  const out = { id: r.id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, url: r.url || null };
  if (r.status === 'ready' || r.status === 'saved') {
    const result = parseResult(r);
    if (result) out.result = result;
  }
  if (r.recipe_id) out.recipeId = r.recipe_id;
  return out;
}

// ---- REST side (import page) ----------------------------------------------------------------------------------------

/**
 * Creates a pending request from validated import params { url?, text?, ref?, precisionScale, servings, notes }.
 * Returns { requestId, prompt, claudeUrl }.
 */
function createRequest(params) {
  if (!connectorConfigured()) throw httpError(503, 'The Claude connector is not configured on this server (FLOW_MCP_SECRET)');
  sweep();
  const open = db().prepare(`SELECT COUNT(*) AS n FROM import_requests WHERE status IN ('pending', 'claimed', 'ready')`).get().n;
  if (open >= MAX_OPEN_REQUESTS) throw httpError(429, 'Too many open import requests, try again later');
  const id = uuidv4();
  const now = Date.now();
  const url = params.url || params.ref || null;
  db()
    .prepare(
      `INSERT INTO import_requests (id, created_at, updated_at, status, url, text, precision_scale, servings, notes, xml, result_json, recipe_id)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, NULL, NULL)`
    )
    .run(id, now, now, url, params.text || null, params.precisionScale ? 1 : 0, params.servings || null, params.notes || null);
  const text = prompt(id, url);
  console.log(`[claude-import] request ${id} created (${params.url ? 'url' : 'text'})`);
  return { requestId: id, prompt: text, claudeUrl: `https://claude.ai/new?q=${encodeURIComponent(text)}` };
}

function getRequest(id) {
  const r = row(id);
  return r ? view(r) : null;
}

function cancelRequest(id) {
  const r = row(id);
  if (!r) return null;
  if (OPEN_STATUSES.includes(r.status)) {
    db().prepare(`UPDATE import_requests SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(Date.now(), id);
    sourceInfo.delete(id);
  }
  return view(row(id));
}

// Called after POST /api/recipes saved a recipe with { importRequestId }. Unknown / closed requests are ignored.
function markSaved(id, recipeId) {
  const r = row(id);
  if (!r || !OPEN_STATUSES.includes(r.status)) return false;
  db().prepare(`UPDATE import_requests SET status = 'saved', recipe_id = ?, updated_at = ? WHERE id = ?`).run(recipeId, Date.now(), id);
  sourceInfo.delete(id);
  return true;
}

// ---- agent side (MCP tools) -----------------------------------------------------------------------------------------

function openRow(id) {
  const r = row(id);
  if (!r) {
    throw httpError(404, `Import request ${id} not found.`, 'Check the id in the user’s message, or call list_pending_imports.');
  }
  if (r.status === 'cancelled') throw httpError(410, `Import request ${id} was cancelled in the app.`, 'Ask the user to start a new import in the app if they still want it.');
  if (r.status === 'expired') throw httpError(410, `Import request ${id} has expired (requests are kept 24 h).`, 'Ask the user to start a new import in the app.');
  if (r.status === 'saved') {
    throw httpError(409, `Import request ${id} is already saved as recipe "${r.recipe_id}".`, 'Nothing left to do; use upload_recipe with overwrite to change a saved recipe.');
  }
  return r;
}

/** Pending/claimed requests from the last 24 h, newest first: [{ id, url, createdAt, status }]. */
function listPending() {
  sweep();
  return db()
    .prepare(`SELECT id, url, created_at, status FROM import_requests WHERE status IN ('pending', 'claimed') ORDER BY created_at DESC LIMIT 50`)
    .all()
    .map((r) => ({ id: r.id, url: r.url || null, createdAt: r.created_at, status: r.status }));
}

function compactSource(source) {
  if (!source || typeof source !== 'object') return source;
  const out = { ...source };
  if (typeof out.text === 'string' && out.text.length > SOURCE_TEXT_CHARS) {
    out.text = `${out.text.slice(0, SOURCE_TEXT_CHARS)}… [${out.text.length - SOURCE_TEXT_CHARS} more characters]`;
  }
  return out;
}

/**
 * Claims a request for Claude: { id, status, url, text, precisionScale, servings, notes, source?, sourceError? }.
 * The source is fetched from the url (or built from the pasted text; a ref next to pasted text is never fetched).
 */
async function claim(id, { signal } = {}) {
  let r = openRow(id);
  if (r.status === 'pending') {
    db().prepare(`UPDATE import_requests SET status = 'claimed', updated_at = ? WHERE id = ? AND status = 'pending'`).run(Date.now(), id);
    r = row(id);
    console.log(`[claude-import] request ${id} claimed`);
  }
  const out = {
    id: r.id,
    status: r.status,
    url: r.url || null,
    text: r.text || null,
    precisionScale: !!r.precision_scale,
    servings: r.servings || null,
    notes: r.notes || null,
  };
  const importer = await importJobs.loadImporter();
  try {
    let source = null;
    if (r.text && importer && typeof importer.textSource === 'function') {
      source = importer.textSource(r.text, { url: r.url || null });
    } else if (r.url) {
      if (!importer || typeof importer.fetchRecipeSource !== 'function') throw new Error('the recipe importer is not available on this server');
      // The importer's default fetch is the pinned SSRF-guarded one (FLOW_IMPORT_ALLOW_PRIVATE=1 lifts it).
      source = await importer.fetchRecipeSource(r.url, signal ? { signal } : {});
    }
    if (source) {
      out.source = compactSource(source);
      sourceInfo.set(r.id, {
        title: source.title || null,
        structured: !!source.structured,
        times: source.times || {},
        yield: source.yield || null,
        servings: Number.isFinite(source.servings) ? source.servings : null,
      });
    }
  } catch (error) {
    out.sourceError = `Could not fetch ${r.url}: ${(error && error.message) || error}`;
  }
  return out;
}

function sourceTimes(times) {
  const t = times && typeof times === 'object' ? times : {};
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);
  return { prep: n(t.prep), cook: n(t.cook), total: n(t.total) };
}

function existingRecipeIds() {
  return recipes.listRecipes().map((x) => x.id).concat(['operations']);
}

/**
 * Stores Claude's draft: metricize → checkRecipeXml with the request's precisionScale. Status becomes 'ready' when the
 * check has no errors. A draft with errors never replaces an earlier ready draft. Returns
 * { id, status, ready, recipeId, check, conversions, conversionWarnings, keptPrevious }.
 */
async function submit(id, xml, { maxBytes = 256 * 1024 } = {}) {
  const r = openRow(id);
  if (typeof xml !== 'string' || !xml.trim()) throw httpError(400, 'xml is required');
  if (Buffer.byteLength(xml, 'utf8') > maxBytes) throw httpError(413, `xml is too large (max ${Math.round(maxBytes / 1024)} kB)`);
  const importer = await importJobs.loadImporter();
  if (!importer || typeof importer.checkRecipeXml !== 'function') throw httpError(503, 'Recipe importer is not available on this server');
  const precisionScale = !!r.precision_scale;

  // Root attributes first (version, ref = the request's url, an id that is free), then the unit conversion.
  let doc = xml;
  const header = recipes.readHeader(doc);
  const taken = existingRecipeIds();
  const title = (header && header.title) || (sourceInfo.get(id) || {}).title || 'recipe';
  let recipeId = header && header.rootId && recipes.isAvailableUserId(header.rootId) && !taken.includes(header.rootId) ? header.rootId : null;
  if (!recipeId && typeof importer.suggestRecipeId === 'function') recipeId = importer.suggestRecipeId(title, taken);
  if (typeof importer.setRootAttributes === 'function' && header) {
    doc = importer.setRootAttributes(doc, { version: '2', id: recipeId, ref: r.url || null });
  }

  let conversions = [];
  const conversionWarnings = [];
  const wellFormed = typeof importer.checkWellFormed === 'function' ? importer.checkWellFormed(doc).length === 0 : true;
  const conv = await importJobs.conversions();
  if (conv && wellFormed) {
    try {
      const res = conv.metricizeRecipeXml(doc, { DOMParser: importer.QuietDOMParser || DOMParser, XMLSerializer, precisionScale });
      if (res && typeof res.xml === 'string') doc = res.xml;
      conversions = (res && res.changes) || [];
      conversionWarnings.push(...((res && res.warnings) || []));
    } catch (error) {
      conversionWarnings.push(`Unit conversion failed: ${error.message}`);
    }
  }
  const check = await importer.checkRecipeXml(doc, { precisionScale, ...(recipeId ? { id: recipeId } : {}) });
  if (conversionWarnings.length) check.warnings = [...(check.warnings || []), ...conversionWarnings];
  const ok = !!check.ok && !(check.errors && check.errors.length);

  const now = Date.now();
  const previous = parseResult(r);
  const attempts = ((previous && previous.attempts) || 0) + 1;
  const info = sourceInfo.get(id) || {};
  const result = {
    id: check.id || recipeId,
    xml: doc,
    check,
    conversions,
    source: {
      url: r.url || null,
      title: info.title || check.title || null,
      structured: !!info.structured,
      times: sourceTimes(info.times),
      yield: info.yield || null,
      servings: Number.isFinite(info.servings) ? info.servings : null,
    },
    attempts,
    llm: { provider: CONNECTOR_PROVIDER },
  };

  let keptPrevious = false;
  if (ok) {
    db()
      .prepare(`UPDATE import_requests SET status = 'ready', xml = ?, result_json = ?, updated_at = ? WHERE id = ?`)
      .run(doc, JSON.stringify(result), now, id);
  } else if (r.status === 'ready') {
    // Keep the ready draft the user may be reviewing; remember the attempt count only.
    keptPrevious = true;
    if (previous) {
      previous.attempts = attempts;
      db().prepare(`UPDATE import_requests SET result_json = ? WHERE id = ?`).run(JSON.stringify(previous), id);
    }
  } else {
    db()
      .prepare(`UPDATE import_requests SET status = 'claimed', xml = ?, result_json = ?, updated_at = ? WHERE id = ?`)
      .run(doc, JSON.stringify({ ...result, draft: true }), now, id);
  }
  const status = row(id).status;
  console.log(`[claude-import] request ${id}: draft ${attempts} ${ok ? 'ready' : 'has errors'}`);
  return { id, status, ready: ok, recipeId: result.id, check, conversions, conversionWarnings, keptPrevious, attempts };
}

module.exports = {
  TTL_MS,
  MIN_SECRET_LENGTH,
  CONNECTOR_PROVIDER,
  connectorSecret,
  connectorConfigured,
  secretMatches,
  sweep,
  createRequest,
  getRequest,
  cancelRequest,
  markSaved,
  listPending,
  claim,
  submit,
};
