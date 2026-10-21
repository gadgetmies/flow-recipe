const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');
const { getDatabase } = require('../database');

const RECIPES_DIR = path.join(__dirname, '..', 'recipes');
const OPERATIONS_FILE = 'operations.xml';
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_ID_LENGTH = 100;
const RESERVED_IDS = new Set(['operations', 'check', 'convert']);

// id → { mtimeMs, entry: { id, title, serving, source, sourceUrl } }
const cache = new Map();
// id → { updatedAt, entry } for user recipes
const userCache = new Map();
const changeListeners = new Set();

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

// An id a new user recipe may take: well-formed, not too long, not reserved and not a built-in recipe file.
function isAvailableUserId(id) {
  return isValidId(id) && id.length <= MAX_ID_LENGTH && !RESERVED_IDS.has(id.toLowerCase()) && !isBuiltin(id);
}

function isReservedId(id) {
  return typeof id === 'string' && RESERVED_IDS.has(id.toLowerCase());
}

// True when a built-in recipe file has this id (compared case-insensitively, so 'Buns' cannot shadow 'buns').
function isBuiltin(id) {
  if (!isValidId(id) || id === 'operations') return false;
  if (fs.existsSync(path.join(RECIPES_DIR, `${id}.xml`))) return true;
  try {
    const lower = `${id.toLowerCase()}.xml`;
    return fs.readdirSync(RECIPES_DIR).some((f) => f.toLowerCase() === lower && f !== OPERATIONS_FILE);
  } catch (error) {
    return false;
  }
}

function recipePath(id) {
  if (!isValidId(id)) return null;
  return path.join(RECIPES_DIR, `${id}.xml`);
}

function holdToSeconds(number, unit) {
  if (!Number.isFinite(number)) return null;
  switch ((unit || 'minutes').toLowerCase()) {
    case 's':
    case 'sec':
    case 'second':
    case 'seconds':
      return number;
    case 'h':
    case 'hour':
    case 'hours':
      return number * 3600;
    case 'min':
    case 'minute':
    case 'minutes':
    default:
      return number * 60;
  }
}

function parseHeader(id, xml) {
  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} },
  }).parseFromString(xml, 'text/xml');
  const root = doc && doc.documentElement;
  let title = id;
  let serving = null;
  if (root && root.nodeName === 'recipe') {
    const titleEl = root.getElementsByTagName('title')[0];
    if (titleEl && titleEl.textContent && titleEl.textContent.trim()) {
      title = titleEl.textContent.trim();
    }
    const servingEls = root.getElementsByTagName('serving');
    for (let i = 0; i < servingEls.length; i++) {
      const el = servingEls[i];
      if (el.parentNode !== root) continue;
      const temperature = el.getAttribute('temperature') || 'ambient';
      const holdAttr = el.getAttribute('hold');
      const hold = holdAttr ? holdToSeconds(parseFloat(holdAttr), el.getAttribute('hold-unit')) : null;
      serving = { temperature, hold };
      break;
    }
  }
  const ref = root && root.nodeName === 'recipe' ? root.getAttribute('ref') : '';
  const rootId = root && root.nodeName === 'recipe' ? root.getAttribute('id') : '';
  return { id, title, serving, ref: ref || null, rootId: rootId || null };
}

// Title, serving, ref and root id of an XML document without validating it; null when it is not a <recipe>.
function readHeader(xml) {
  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} },
  }).parseFromString(xml, 'text/xml');
  const root = doc && doc.documentElement;
  if (!root || root.nodeName !== 'recipe') return null;
  return parseHeader(null, xml);
}

function listBuiltinRecipes() {
  let files;
  try {
    files = fs.readdirSync(RECIPES_DIR);
  } catch (error) {
    console.error('Cannot read recipes directory:', error);
    return [];
  }
  const ids = files
    .filter((f) => f.endsWith('.xml') && f !== OPERATIONS_FILE)
    .map((f) => f.slice(0, -4))
    .filter(isValidId)
    .sort();

  for (const key of cache.keys()) {
    if (!ids.includes(key)) cache.delete(key);
  }

  const result = [];
  for (const id of ids) {
    const file = path.join(RECIPES_DIR, `${id}.xml`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      continue;
    }
    const cached = cache.get(id);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      result.push(cached.entry);
      continue;
    }
    try {
      const { title, serving } = parseHeader(id, fs.readFileSync(file, 'utf-8'));
      const entry = { id, title, serving, source: 'builtin', sourceUrl: null };
      cache.set(id, { mtimeMs: stat.mtimeMs, entry });
      result.push(entry);
    } catch (error) {
      console.error(`Cannot parse recipe ${id}:`, error);
    }
  }
  return result;
}

// ---- user recipes (SQLite table user_recipes) --------------------------------------------------------------------

function db() {
  try {
    return getDatabase();
  } catch (error) {
    return null; // not initialised (e.g. a script using only the file recipes)
  }
}

function userEntry(row) {
  const cached = userCache.get(row.id);
  if (cached && cached.updatedAt === row.updated_at) return cached.entry;
  let serving = null;
  let title = row.title || row.id;
  try {
    const header = parseHeader(row.id, row.xml);
    serving = header.serving;
    if (!row.title && header.title) title = header.title;
  } catch (error) {
    console.error(`Cannot parse user recipe ${row.id}:`, error.message);
  }
  const entry = { id: row.id, title, serving, source: 'imported', sourceUrl: row.source_url || null };
  userCache.set(row.id, { updatedAt: row.updated_at, entry });
  return entry;
}

function listUserRecipes() {
  const database = db();
  if (!database) return [];
  const rows = database.prepare(`SELECT id, title, xml, source_url, updated_at FROM user_recipes ORDER BY id`).all();
  const ids = new Set(rows.map((r) => r.id));
  for (const key of userCache.keys()) if (!ids.has(key)) userCache.delete(key);
  return rows.map(userEntry);
}

function getUserRecipe(id) {
  const database = db();
  if (!database || !isValidId(id)) return null;
  const row = database.prepare(`SELECT * FROM user_recipes WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    xml: row.xml,
    sourceUrl: row.source_url || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function userRecipeExists(id) {
  const database = db();
  if (!database || !isValidId(id)) return false;
  return !!database.prepare(`SELECT 1 FROM user_recipes WHERE id = ?`).get(id);
}

function notifyChange(id) {
  userCache.delete(id);
  for (const listener of changeListeners) {
    try {
      listener(id);
    } catch (error) {
      console.error('Recipe change listener failed:', error);
    }
  }
}

// Called with the recipe id whenever a user recipe is saved or deleted. Returns an unsubscribe function.
function onUserRecipeChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

// Inserts or replaces a user recipe. Throws (with `status`) when the id is not available.
function saveUserRecipe({ id, xml, title, sourceUrl }, { overwrite = false } = {}) {
  if (!isAvailableUserId(id)) {
    const error = new Error(isValidId(id) ? `Recipe id '${id}' is reserved by a built-in recipe` : 'Invalid recipe id');
    error.status = isValidId(id) ? 409 : 400;
    throw error;
  }
  const database = getDatabase();
  const header = readHeader(xml) || {};
  const now = Date.now();
  const existing = database.prepare(`SELECT created_at FROM user_recipes WHERE id = ?`).get(id);
  if (existing && !overwrite) {
    const error = new Error(`Recipe '${id}' already exists`);
    error.status = 409;
    throw error;
  }
  const row = {
    id,
    title: (title || header.title || id).slice(0, 500),
    xml,
    source_url: sourceUrl || header.ref || null,
    created_at: existing ? existing.created_at : now,
    updated_at: now,
  };
  database
    .prepare(
      `INSERT INTO user_recipes (id, title, xml, source_url, created_at, updated_at)
       VALUES (@id, @title, @xml, @source_url, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, xml = excluded.xml,
         source_url = excluded.source_url, updated_at = excluded.updated_at`
    )
    .run(row);
  notifyChange(id);
  return { id, title: row.title, sourceUrl: row.source_url, created: !existing };
}

function deleteUserRecipe(id) {
  const database = db();
  if (!database || !isValidId(id)) return false;
  const info = database.prepare(`DELETE FROM user_recipes WHERE id = ?`).run(id);
  if (info.changes > 0) notifyChange(id);
  return info.changes > 0;
}

// ---- combined view ----------------------------------------------------------------------------------------------

// Built-in recipes first (sorted by id), then imported ones. A user row that shadows a built-in id (e.g. a file
// added later) is hidden: the built-in file wins.
function listRecipes() {
  const builtin = listBuiltinRecipes();
  const builtinIds = new Set(builtin.map((r) => r.id));
  let user = [];
  try {
    user = listUserRecipes().filter((r) => !builtinIds.has(r.id));
  } catch (error) {
    console.error('Cannot list user recipes:', error);
  }
  return [...builtin, ...user];
}

function getRecipeInfo(id) {
  return listRecipes().find((r) => r.id === id) || null;
}

// XML of a built-in recipe file, else of a user recipe; null when neither exists.
function readRecipe(id) {
  if (id === 'operations') return null;
  const file = recipePath(id);
  if (!file) return null;
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8');
  const user = getUserRecipe(id);
  return user ? user.xml : null;
}

function readOperations() {
  return fs.readFileSync(path.join(RECIPES_DIR, OPERATIONS_FILE), 'utf-8');
}

module.exports = {
  RECIPES_DIR,
  MAX_ID_LENGTH,
  isValidId,
  isAvailableUserId,
  isReservedId,
  isBuiltin,
  recipePath,
  readHeader,
  listRecipes,
  listBuiltinRecipes,
  listUserRecipes,
  getRecipeInfo,
  readRecipe,
  readOperations,
  getUserRecipe,
  userRecipeExists,
  saveUserRecipe,
  deleteUserRecipe,
  onUserRecipeChange,
};
