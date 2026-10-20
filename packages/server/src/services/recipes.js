const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

const RECIPES_DIR = path.join(__dirname, '..', 'recipes');
const OPERATIONS_FILE = 'operations.xml';
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

// id → { mtimeMs, entry: { id, title, serving } }
const cache = new Map();

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
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
  return { id, title, serving };
}

function listRecipes() {
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
      const entry = parseHeader(id, fs.readFileSync(file, 'utf-8'));
      cache.set(id, { mtimeMs: stat.mtimeMs, entry });
      result.push(entry);
    } catch (error) {
      console.error(`Cannot parse recipe ${id}:`, error);
    }
  }
  return result;
}

function getRecipeInfo(id) {
  return listRecipes().find((r) => r.id === id) || null;
}

function readRecipe(id) {
  const file = recipePath(id);
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function readOperations() {
  return fs.readFileSync(path.join(RECIPES_DIR, OPERATIONS_FILE), 'utf-8');
}

module.exports = {
  RECIPES_DIR,
  isValidId,
  recipePath,
  listRecipes,
  getRecipeInfo,
  readRecipe,
  readOperations,
};
