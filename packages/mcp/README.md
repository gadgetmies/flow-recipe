# @flow-recipe/mcp

An [MCP](https://modelcontextprotocol.io) server that lets an agent such as Claude import recipes into flow-recipe.
The agent is the language model: it reads the source and writes the recipe XML. The server's tools do the
deterministic parts with `@flow-recipe/importer` and `@flow-recipe/scheduler` — fetching and extracting the recipe
page, unit conversion (density table), validation, a scheduler dry run with 1 and 3 cooks, and saving the result
to the flow-recipe server.

The matching Claude Code skill is `.claude/skills/flow-recipe-import/SKILL.md` ("import this recipe …").

Transport: stdio. Node ≥ 20. Entry point: `packages/mcp/src/index.js` (bin `flow-recipe-mcp`).

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
| `import_recipe_with_server_llm` | `url` or `text`, `precisionScale?`, `servings?`, `notes?`, `timeoutSeconds?` | Runs the server's own LLM import (`POST /api/import`, polls the job); does not save |

Prompt: `create_recipe_from_url { url?, precisionScale? }` — the workflow as a user message.
Resource: `flow-recipe://authoring-guide` — RECIPE.spec.md.

## Development

```sh
yarn workspace @flow-recipe/mcp test     # node --test: spawns the server over stdio with the SDK client
npx @modelcontextprotocol/inspector node packages/mcp/src/index.js   # interactive inspection
```

Logs go to stderr; stdout is the protocol.
