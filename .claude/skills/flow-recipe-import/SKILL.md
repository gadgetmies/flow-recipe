---
name: flow-recipe-import
description: Import, add or create a recipe for the flow-recipe app — turn a recipe URL or pasted recipe text into flow-recipe XML for the multi-cook scheduler (metric units, unit streams, carriers, holds), check it with a scheduler dry run and upload it to the flow-recipe server. Use when the user says "import/add/create a recipe", "convert this recipe for flow recipe", gives a recipe link to add, or asks to make a new flow-recipe recipe.
---

# Import a recipe into flow-recipe

You (Claude) are the model that writes the recipe. The `flow-recipe` MCP server (registered in `.mcp.json`,
tools prefixed `mcp__flow-recipe__`) does everything deterministic: fetching, unit conversion, validation, a
scheduler dry run and the upload. Never do unit arithmetic in your head when a tool can do it.

If the `flow-recipe` tools are not available, use the **fallback without MCP** at the end of this file — the
workflow is the same.

## 1. Get the source and the one question

1. Take the recipe URL or pasted text from the user's message. If there is neither, ask for it (one message).
2. Precision scale: if the user has not said whether they own a precision scale (0.1 g resolution), ask **once**,
   in the same message as any other question: "Do you have a precision scale (0.1 g)? If yes, I'll give small
   amounts of spices, salt and yeast in grams; otherwise in teaspoons." No answer → assume no
   (`precisionScale: false`). Do not ask anything else unless the source is genuinely ambiguous (e.g. two recipes
   on one page).
3. Fetch: `fetch_recipe_source { url }` (or `{ text }` for pasted text). Prefer the structured fields
   (`ingredients`, `steps`, `yield`, `times`) and use `text` for details they miss (pan sizes, oven temperature,
   resting times, notes). If fetching fails (blocked site, paywall), ask the user to paste the recipe and call
   `fetch_recipe_source { text }`.

## 2. Read the authoring guide

Call `get_authoring_guide { precisionScale }` once per session. It contains the XML format (RECIPE.spec.md), the
measurement rules and the operation catalogue. Use only operation names and option names from the catalogue
(`list_operations { filter }` to look one up). For a modelling example, `get_recipe { id: "buns" }` shows unit
streams, carriers, holds and `bake-in-oven` with a sheet.

## 3. Draft the XML — write for the scheduler

Write ONE complete `<recipe version="2" id="…" ref="SOURCE_URL">` document with `<title>`, `<serving>`,
`<ingredients>`, `<tools>` and `<tasks>`. The scheduler distributes tasks between cooks, so model the real
structure of the work rather than transcribing paragraphs:

- **One task per action.** Split "Cream the butter and sugar, then beat in the eggs" into `measure` tasks for
  each ingredient plus `cream` and `beat` (or whatever the catalogue has). Every ingredient is measured by a
  `measure` task whose `amount` option holds the quantity.
- **Unit streams for per-unit work.** When something is made in pieces (cookies, buns, dumplings, patties,
  skewers, pancakes, portions), `split` the mass with a `parts` option (the count, e.g. 24) into an output with
  `amount="24" unit="cookie"`, and keep `unit="cookie"` on every downstream output (shape → place on sheet →
  bake → cool). This lets several cooks pipeline the work. The amount must be the same through the stream.
  (`unit-size` only works when the producing output carries an `amount` in g; prefer `parts`.)
- **Carriers and tool capacities.** Give carrier tools a `capacity` property in units (`<numeric-value
  number="12" unit="cookie"/>` on a baking sheet, rack, pan). Use the sheet as a `reserved="true"` tool of
  `place-on-sheet` and `bake-in-oven`, and return it in the `<outputs>` of the task that releases it
  (`<tool ref="baking-sheet"/>`), so it can be reused for the next round. Return bowls/pans after the step
  that empties them.
- **Holds.** `hold` (minutes) is how long a result stays good before its consumer must start. Put it **only on
  results that degrade** — whipped cream 30, beaten egg whites 10, warm milk for yeast 10, melted chocolate 15,
  boiling water 15, cooked pasta 2, fried food 10, shaped dough before baking 30, hot baked goods 10 — on the
  result that degrades, not on a later transfer. **Omit it** for things that keep (cut vegetables, a made sauce,
  measured dry ingredients): no hold means "keeps indefinitely" (RECIPE.spec.md §6).
- **Serving.** `<serving temperature="hot|cold|ambient" hold="…" hold-unit="minutes"/>` — how long the dish
  stays good once finished.
- **Storage.** Ingredient properties for storage (e.g. fridge items and `out-of-storage` times) as in the guide.
- **Soil and requires.** `soil="none|rinse|wash"` on tools (scales and dry measuring: `none`), `requires="knife"`,
  `requires="oven"`, `requires="hot-pan"` per the catalogue.
- **Passive steps** (rise, chill, marinate, bake, simmer) use the catalogue's duration option; they free the
  cooks, so state realistic durations from the source.
- **Final outputs.** Mark what is served with `final="true"`. Use `<join>` only where the guide says to.
- Ids: lowercase kebab-case, unique across ingredients, tools, outputs and tasks. Recipe id from the title
  (e.g. `chocolate-chip-cookies`).
- **Units: copy the source.** Write every amount exactly as the source states it, in its own units
  (`1` `cup`, `2` `tbsp`, `0.5` `tsp`, `8` `oz`, `1` `stick`, `350` `fahrenheit`, `9x13 inch`). Do not convert
  volume → weight or °F → °C yourself — `convert_recipe_units` does it deterministically from its density table
  and notes every change. Decimals only (`0.5`, not `1/2`); countables are `pieces`.

## 4. Convert units

Call `convert_recipe_units { xml, precisionScale }` and **continue with the returned `xml`**. Read `changes` and
`warnings`: if an ingredient had no known density (kept as ml), use `lookup_density { ingredient }` with a more
specific name or rename the ingredient, or convert it with `convert_amount` and edit the amount yourself. Rules:
weights in g for solids, powders, fats, sugars and viscous liquids; thin liquids in ml/dl/l; countables as pieces;
small spice/salt/leavening amounts as `tsp`/`tbsp` (or grams with 0.1 g with a precision scale); °C; cm.

## 5. Check and iterate

Call `check_recipe { xml, precisionScale }`. Repeat steps 3–5 until:

- `ok` is `true` (no `errors`). Fix each error at its cause (unknown operation → pick one from the catalogue;
  unresolved ref → fix the id; missing option → add it).
- every `warnings` / `unitLint` entry is fixed or deliberately accepted (say which and why in your summary).
- the dry-run `plan` is sensible: it succeeded; per-unit work shows up as pipelines (`chains`); 3 cooks are
  faster than 1 when the recipe has parallel work; the estimated time is close to the source's total time
  (± passive time you modelled). A wildly longer time usually means a missing carrier return, a capacity that is
  too small, a missing `hold`, or a passive step modelled as active.

Stop after ~5 rounds and report what is still wrong instead of looping.

## 6. Show the user a short summary

Before uploading, show (keep it short):

- Title, id, servings / yield, source URL.
- Ingredients with metric amounts (weights where applicable); mark converted ones ("1 cup flour → 125 g").
- Number of steps; estimated time with 1 cook and with 3 cooks; detected pipelines (e.g. "cookies: shape → bake
  → cool, 24 units on 2 sheets").
- Assumptions you made (unknown densities, durations you estimated, pan sizes) and accepted warnings.

Ask "Upload it?" unless the user already asked you to upload without confirmation. Apply requested changes and
re-check.

## 7. Upload (or save locally)

Call `upload_recipe { xml, id }`. It re-checks and refuses on errors. Results:

- `saved: "server"` → tell the user the id and that they can start a session with it (pick it in the app, or open
  `/?recipe=<id>`).
- HTTP 409 → the id exists: ask whether to overwrite their imported recipe (`overwrite: true`) or pick a new id.
  Built-in recipes cannot be overwritten.
- 401/403 → the server needs `FLOW_UPLOAD_TOKEN` in the MCP env (see `packages/mcp/README.md`).
- Server unreachable → offer to start it (`yarn start` in the repo) or save the file locally: write it to
  `packages/server/src/recipes/<id>.xml` (the built-in recipe folder) or wherever the user wants, or run the MCP
  with `FLOW_RECIPES_DIR` set.

If the server has its own LLM configured and the user prefers it, `import_recipe_with_server_llm { url }` runs the
server's import; review its `check` and still upload with `upload_recipe`.

## Fallback without MCP

Same workflow, with files and the command line (run from the repository root):

1. Source: fetch the page with WebFetch (or ask the user to paste the recipe text).
2. Guide: read `RECIPE.spec.md` (format, rules, checklist) and `packages/server/src/recipes/operations.xml`
   (operation names, options, units). Example: `packages/server/src/recipes/buns.xml`.
3. Draft: write the XML to a scratch file, e.g. `/tmp/<id>.xml` (or your scratchpad directory).
4. Convert units: `node packages/importer/bin/check.js --convert /tmp/<id>.xml` (writes the metricized XML; add
   `--precision-scale` when the user has a 0.1 g scale). Re-read the file afterwards.
5. Check: `node packages/importer/bin/check.js /tmp/<id>.xml` prints the CheckResult JSON (`ok`, `errors`,
   `warnings`, `unitLint`, `summary`, `plan`). Iterate as in step 5.
6. Summary to the user as in step 6.
7. Upload:

   ```sh
   node -e 'process.stdout.write(JSON.stringify({ xml: require("fs").readFileSync(process.argv[1], "utf8") }))' /tmp/<id>.xml \
     | curl -sS -X POST "${FLOW_RECIPE_SERVER:-http://localhost:3001}/api/recipes" \
         -H 'Content-Type: application/json' \
         ${FLOW_UPLOAD_TOKEN:+-H "Authorization: Bearer $FLOW_UPLOAD_TOKEN"} \
         --data-binary @-
   ```

   201 → `{ id, title, check }`; 422 → fix `check.errors`; 409 → add `"overwrite": true` to the JSON or change
   the id. Without a server, copy the file to `packages/server/src/recipes/<id>.xml`.
