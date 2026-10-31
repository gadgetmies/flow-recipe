# @flow-recipe/mcp

An [MCP](https://modelcontextprotocol.io) server that lets an agent such as Claude import recipes into flow-recipe.
The agent is the language model: it reads the source and writes the recipe XML. The server's tools do the
deterministic parts with `@flow-recipe/importer` and `@flow-recipe/scheduler` — fetching and extracting the recipe
page, unit conversion (density table), validation, a scheduler dry run with 1 and 3 cooks, and saving the result
to the flow-recipe server.

The matching Claude Code skill is `.claude/skills/flow-recipe-import/SKILL.md` ("import this recipe …").

Transports: stdio (`packages/mcp/src/index.js`, bin `flow-recipe-mcp`) for Claude Code / Claude Desktop, and remote
Streamable HTTP served by the flow-recipe server itself at `/mcp/<FLOW_MCP_SECRET>` for claude.ai, Claude Desktop and
mobile (see [Use the app from Claude](#use-the-app-from-claude-custom-connector)). Both share the tool definitions in
`src/server.js`; `createFlowRecipeServer({ backend })` takes a backend adapter (`src/backend.js`): the stdio server
uses the REST API, the remote server calls the server's services in-process. Node ≥ 20.

## Use the app from Claude (custom connector)

Claude on the web, desktop and phone cannot run a local MCP server, but it can use a remote one. The flow-recipe
server serves the same tools over Streamable HTTP, so your own Claude subscription does the authoring — no API key on
the server.

1. **On the deployment** set `FLOW_MCP_SECRET` to a random string of at least 24 characters, e.g.
   `openssl rand -hex 32`, and restart. The log says
   `remote MCP connector enabled at /mcp/<FLOW_MCP_SECRET>`; `GET /api/llm` reports `claude: { connector: true }`.
2. **In Claude**: Settings → Connectors → **Add custom connector**. Name: `Flow Recipe`. URL:

   ```
   https://<your-app>/mcp/<FLOW_MCP_SECRET>
   ```

   (no OAuth; leave the advanced settings empty). On a Team/Enterprise plan an owner adds it under organisation
   settings first. Connectors added on claude.ai are also available in Claude Desktop and the mobile apps.
3. Enable the connector in a chat (the tools menu) and say "import this recipe into Flow Recipe: <url>" — or use the
   app's import page: choose **Use Claude (via the Flow Recipe connector)**, press **Continue in Claude**; the chat
   opens with "Use the Flow Recipe connector to import recipe request <id> (…)". Claude calls `get_pending_import`,
   writes and checks the XML and calls `submit_import`; the import page picks the draft up for review and saving.

**The URL is a credential.** Anyone who has it can use the tools (read and save recipes, see pending import
requests). Do not post it; rotate it by changing `FLOW_MCP_SECRET` (and the connector URL in Claude). Wrong secrets get
`404`. The endpoint is stateless (a fresh MCP server per request, JSON responses, `GET`/`DELETE` → `405`).

Remote mode differences: no `import_recipe_with_server_llm`, no `FLOW_RECIPES_DIR`; `upload_recipe` saves directly
into the app (for chat-only imports); the handoff tools `list_pending_imports`, `get_pending_import`, `submit_import`
are always available.

## Setup

Install the workspace once from the repository root:

```sh
yarn install
```

### Claude Code

The repository root contains `.mcp.json`, so Claude Code offers the `flow-recipe` server when started in this
repository (approve it once, or check with `/mcp`). It runs `node packages/mcp/src/index.js` and passes through
`FLOW_RECIPE_SERVER`, `FLOW_UPLOAD_TOKEN` and `FLOW_RECIPES_DIR` from your shell environment.

To register it yourself (e.g. for use outside the repository):

```sh
claude mcp add flow-recipe \
  --env FLOW_RECIPE_SERVER=http://localhost:3001 \
  -- node /absolute/path/to/flow-recipe/packages/mcp/src/index.js
```

Then ask: "Import this recipe: https://…" — the skill drives the tools.

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "flow-recipe": {
      "command": "node",
      "args": ["/absolute/path/to/flow-recipe/packages/mcp/src/index.js"],
      "env": {
        "FLOW_RECIPE_SERVER": "http://localhost:3001",
        "FLOW_UPLOAD_TOKEN": "only-if-the-server-requires-one"
      }
    }
  }
}
```

Claude Desktop has no repository skills; use the `create_recipe_from_url` prompt (in the prompt/attachment menu)
to get the same workflow, or just say "import this recipe into flow-recipe: <url>".

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLOW_RECIPE_SERVER` | `http://localhost:3001` | Base URL of the flow-recipe server (`yarn start` in the repo). |
| `FLOW_UPLOAD_TOKEN` | — | Sent as `Authorization: Bearer <token>` on uploads and server imports. Needed when the server sets `FLOW_UPLOAD_TOKEN`. |
| `FLOW_RECIPES_DIR` | — | When set, `upload_recipe` writes `<dir>/<id>.xml` instead of POSTing, and `list_recipes`/`get_recipe` include that directory. Use `packages/server/src/recipes` to add a built-in recipe. |
| `FLOW_MCP_SECRET` | — | The server's connector secret. Needed only for the handoff tools over stdio (`Authorization: Bearer` on `/api/import/claude…`). |
| `FLOW_IMPORT_ALLOW_PRIVATE` | — | `1` lets `fetch_recipe_source` fetch private/loopback addresses (blocked by default; the check is repeated on every connection, so DNS rebinding cannot bypass it). |

## Tools

All results are JSON text (except the guide, catalogue and recipe XML, which are plain text). Failures set
`isError` and carry `error` plus a `hint` saying what to do.

| Tool | Arguments | Result |
| --- | --- | --- |
| `get_authoring_guide` | `precisionScale?`, `includeCatalogue?` | RECIPE.spec.md + measurement rules + workflow + operation catalogue summary |
| `list_operations` | `filter?` | Catalogue summary (filter matches name, station, requirements) |
| `fetch_recipe_source` | `url` or `text`, `maxTextChars?` | `Source`: title, yield, servings, ingredients, steps, times (s), readable text (capped) |
| `convert_amount` | `amount` (number or "1 1/2"), `unit?`, `ingredient?`, `precisionScale?` | `{ number, unit, from, method, density, note }` |
| `lookup_density` | `ingredient`, `limit?` | `{ match, candidates }` with g/ml and grams per cup/tbsp/tsp |
| `convert_recipe_units` | `xml`, `precisionScale?` | `{ xml, changes, warnings }` — metric amounts, °C, cm |
| `check_recipe` | `xml`, `precisionScale?`, `id?` | `CheckResult` + `verdict`: errors, warnings, unit lint, summary, scheduler dry run |
| `list_recipes` | — | Recipes on the server (and in `FLOW_RECIPES_DIR`) |
| `get_recipe` | `id` | Recipe XML |
| `upload_recipe` | `xml`, `id?`, `overwrite?`, `precisionScale?` | Checks locally and refuses on errors; then `POST /api/recipes` (or writes the file) |
| `import_recipe_with_server_llm` | `url` or `text`, `precisionScale?`, `servings?`, `notes?`, `timeoutSeconds?` | Runs the server's own LLM import (`POST /api/import`, polls the job); does not save. stdio only |
| `list_pending_imports` | — | "Import with Claude" requests waiting for Claude (last 24 h): `{ requests: [{ id, url, createdAt, status }], next }` |
| `get_pending_import` | `id` | `{ id, status, url, text, precisionScale, servings, notes, source, next }`; marks the request claimed. Fetch failures → `isError` with a hint to paste the text |
| `submit_import` | `id`, `xml` | Converts units (request's precision-scale setting) and checks; `{ status, ready, recipeId, attempts, conversions, check, next }`. `ready` → the app shows the draft for review; resubmitting replaces it |

The handoff tools work in both modes: remote directly, stdio through the server's `/api/import/claude` agent endpoints
with `FLOW_MCP_SECRET` set in the MCP server's environment.

Prompt: `create_recipe_from_url { url?, precisionScale? }` — the workflow as a user message.
Resource: `flow-recipe://authoring-guide` — RECIPE.spec.md.

## Development

```sh
yarn workspace @flow-recipe/mcp test     # node --test: spawns the server over stdio with the SDK client
npx @modelcontextprotocol/inspector node packages/mcp/src/index.js   # interactive inspection
```

Logs go to stderr; stdout is the protocol.
