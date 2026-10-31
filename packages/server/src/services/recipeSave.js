// Saving a user recipe from XML: id rules, the importer's check (which also refuses foreign elements, namespaces and
// processing instructions — the stored-XSS guard) and the user_recipes row. Shared by POST /api/recipes and the
// remote MCP connector's upload_recipe.

const recipes = require('./recipes');

// { status, error } when `id` cannot be used for a user recipe, else null.
function idError(id) {
  if (!recipes.isValidId(id) || id.length > recipes.MAX_ID_LENGTH) {
    return { status: 400, error: 'Invalid recipe id (letters, digits, - and _; max 100 characters)' };
  }
  if (recipes.isReservedId(id) || recipes.isBuiltin(id)) {
    return { status: 409, error: `Recipe id '${id}' is reserved by a built-in recipe` };
  }
  return null;
}

// The stored document's root id always equals the id it is stored under.
function withRootId(importer, xml, id) {
  return typeof importer.setRootAttributes === 'function' ? importer.setRootAttributes(xml, { id }) : xml;
}

/**
 * Checks and saves `xml` as a new (or, with overwrite, replaced) user recipe.
 * Returns { status: 201, body: { id, title, check } } or { status: 4xx, body: { error, check? } }.
 */
async function saveNewRecipe(importer, { xml, id, overwrite = false, precisionScale = false }) {
  const header = recipes.readHeader(xml);
  if (!header) return { status: 400, body: { error: 'xml is not a <recipe> document' } };
  if (id !== undefined && id !== null && id !== '' && typeof id !== 'string') {
    return { status: 400, body: { error: 'id must be a string' } };
  }
  if (!id) id = header.rootId;
  if (!id) return { status: 400, body: { error: 'id is required (or an id attribute on <recipe>)' } };
  const invalid = idError(id);
  if (invalid) return { status: invalid.status, body: { error: invalid.error } };
  if (!overwrite && recipes.userRecipeExists(id)) {
    return { status: 409, body: { error: `Recipe '${id}' already exists` } };
  }
  const check = await importer.checkRecipeXml(xml, { id, precisionScale: precisionScale === true });
  if (!check || !check.ok || (check.errors && check.errors.length)) {
    return { status: 422, body: { error: 'The recipe has errors', check } };
  }
  try {
    const saved = recipes.saveUserRecipe({ id, xml: withRootId(importer, xml, id), title: check.title || header.title }, { overwrite });
    console.log(`[recipes] ${saved.created ? 'saved' : 'replaced'} user recipe ${id}`);
    return { status: 201, body: { id, title: saved.title, check } };
  } catch (error) {
    if (error.status) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

module.exports = { idError, withRootId, saveNewRecipe };
