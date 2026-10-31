// Remote MCP connector: `/mcp/:secret` speaks MCP over Streamable HTTP so the app can be added to Claude (claude.ai,
// Desktop, mobile) as a custom connector. The tool definitions are the stdio server's (@flow-recipe/mcp, ESM, loaded
// with a dynamic import like planning.js loads the scheduler); here they get an in-process backend that calls the
// server's services directly (no HTTP to ourselves).
//
// Stateless: every POST gets a fresh McpServer + StreamableHTTPServerTransport (sessionIdGenerator: undefined,
// JSON responses). GET (standalone SSE stream) and DELETE (session end) answer 405, which MCP clients accept.

const path = require('path');
const { pathToFileURL } = require('url');
const recipes = require('./recipes');
const importJobs = require('./importJobs');
const claudeImports = require('./claudeImports');
const { saveNewRecipe } = require('./recipeSave');

let modulesPromise = null;

function importFirst(specifiers) {
  return specifiers.reduce((chain, spec) => chain.catch(() => import(spec)), Promise.reject(new Error('start')));
}

// { createFlowRecipeServer, StreamableHTTPServerTransport }; rejects (and retries next time) when unavailable.
function loadModules() {
  if (!modulesPromise) {
    const fallback = pathToFileURL(path.join(__dirname, '..', '..', '..', 'mcp', 'src', 'server.js')).href;
    modulesPromise = Promise.all([
      importFirst(['@flow-recipe/mcp/server', fallback]),
      import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    ])
      .then(([mcp, sdk]) => ({
        createFlowRecipeServer: mcp.createFlowRecipeServer,
        StreamableHTTPServerTransport: sdk.StreamableHTTPServerTransport,
      }))
      .catch((error) => {
        modulesPromise = null;
        throw error;
      });
  }
  return modulesPromise;
}

function toolError(status, message, hint) {
  const error = new Error(message);
  error.status = status;
  if (hint) error.hint = hint;
  return error;
}

const SAVE_HINTS = {
  400: 'Pass a valid `id` (lowercase letters, digits and hyphens).',
  409: 'The id is taken. Pass overwrite: true to replace your own imported recipe, or choose another id (built-in recipes cannot be overwritten).',
  422: 'The check found errors; fix them (check_recipe) and upload again.',
};

/**
 * The in-process backend for the shared MCP tools (see packages/mcp/src/backend.js for the interface).
 * `appUrl` is the app's public origin as seen by this request (for links in tool results).
 */
function createBackend({ appUrl, maxXmlBytes }) {
  return {
    kind: 'remote',
    target: 'the Flow Recipe app',

    async listRecipes() {
      return recipes.listRecipes();
    },

    async getRecipe(id) {
      const xml = recipes.readRecipe(id);
      if (!xml) throw toolError(404, `Recipe "${id}" not found.`, 'Use list_recipes to see the available ids.');
      return xml;
    },

    async uploadRecipe({ xml, id, overwrite = false, precisionScale = false, check, attrs, verdict }) {
      const importer = await importJobs.loadImporter();
      if (!importer) throw toolError(503, 'The recipe importer is not available on this server.');
      if (Buffer.byteLength(xml, 'utf8') > maxXmlBytes) {
        throw toolError(413, `The XML is too large (max ${Math.round(maxXmlBytes / 1024)} kB).`, 'Write a more compact document.');
      }
      let recipeId = id || (attrs && recipes.isAvailableUserId(attrs.id || '') ? attrs.id : null);
      if (!recipeId && typeof importer.suggestRecipeId === 'function') {
        const taken = recipes.listRecipes().map((r) => r.id).concat(['operations']);
        recipeId = importer.suggestRecipeId(check.title || (attrs && attrs.title) || 'recipe', taken);
      }
      const { status, body } = await saveNewRecipe(importer, { xml, id: recipeId, overwrite, precisionScale });
      if (status !== 201) throw toolError(status, `Not saved: ${body.error}`, SAVE_HINTS[status]);
      return {
        saved: 'server',
        id: body.id,
        title: body.title,
        startSession: `${appUrl}/?recipe=${encodeURIComponent(body.id)}`,
        next: `Tell the user the recipe "${body.title}" is saved in the Flow Recipe app; they can pick it when planning or open the startSession link.`,
        warnings: (body.check && body.check.warnings) || check.warnings,
        verdict: verdict(body.check || check),
      };
    },

    async listPendingImports() {
      return claudeImports.listPending();
    },

    async getPendingImport(id) {
      return claudeImports.claim(id);
    },

    async submitImport({ id, xml }) {
      return claudeImports.submit(id, xml, { maxBytes: maxXmlBytes });
    },
  };
}

function jsonRpcError(res, httpStatus, code, message) {
  if (res.headersSent) return;
  res.status(httpStatus).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function notFound(res) {
  res.status(404).json({ error: 'Not found' });
}

/**
 * Express handlers for `/mcp/:secret`: `handle` for POST/GET/DELETE, `errorHandler` for body-parser failures on
 * that path. Never logs the path (it holds the secret).
 */
function createMcpHandlers({ maxXmlBytes = 256 * 1024 } = {}) {
  async function handle(req, res) {
    if (!claudeImports.secretMatches(req.params.secret)) return notFound(res);
    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no session to end (DELETE).
      res.setHeader('Allow', 'POST');
      return jsonRpcError(res, 405, -32000, 'Method not allowed.');
    }
    let modules;
    try {
      modules = await loadModules();
    } catch (error) {
      console.error('[mcp] cannot load the MCP server modules:', error.message);
      return jsonRpcError(res, 503, -32603, 'The Flow Recipe connector is not available on this server.');
    }
    const appUrl = `${req.protocol}://${req.get('host')}`;
    let server = null;
    let transport = null;
    res.on('close', () => {
      if (transport) transport.close().catch(() => {});
      if (server) server.close().catch(() => {});
    });
    try {
      server = modules.createFlowRecipeServer({ backend: createBackend({ appUrl, maxXmlBytes }) });
      transport = new modules.StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      // express.json() already read JSON bodies; anything else is left for the transport (it answers 415).
      await transport.handleRequest(req, res, req.is('application/json') ? req.body : undefined);
    } catch (error) {
      console.error('[mcp] request failed:', error && error.message);
      jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  }

  // Errors raised before `handle` (express.json): malformed JSON, body over the limit.
  function errorHandler(error, req, res, next) {
    if (!error) return next();
    if (!claudeImports.secretMatches(req.params.secret)) return notFound(res);
    if (error.type === 'entity.parse.failed') return jsonRpcError(res, 400, -32700, 'Parse error: malformed JSON');
    if (error.type === 'entity.too.large') return jsonRpcError(res, 413, -32600, 'Request body is too large');
    console.error('[mcp] request failed:', error && error.message);
    return jsonRpcError(res, 500, -32603, 'Internal server error');
  }

  return { handle, errorHandler };
}

// Startup log: never prints the secret.
function logStatus() {
  const raw = process.env.FLOW_MCP_SECRET;
  if (claudeImports.connectorConfigured()) {
    console.log('[mcp] remote MCP connector enabled at /mcp/<FLOW_MCP_SECRET> (add https://<your-app>/mcp/<FLOW_MCP_SECRET> to Claude as a custom connector)');
  } else if (raw) {
    console.warn(`[mcp] FLOW_MCP_SECRET is shorter than ${claudeImports.MIN_SECRET_LENGTH} characters: the remote MCP connector is disabled`);
  } else {
    console.log('[mcp] remote MCP connector disabled (set FLOW_MCP_SECRET to enable it)');
  }
}

module.exports = { createMcpHandlers, createBackend, loadModules, logStatus };
