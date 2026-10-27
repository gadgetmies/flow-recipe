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
   amounts of spices, salt, yeast and herbs in grams; otherwise in teaspoons." No answer → assume no
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
  number="12" unit="cookie"/>` on a baking sheet, rack, pan) — how many of THESE items fit (size, spacing from
  the source); the recipe's capacity always beats the kitchen default. Use the sheet as a `reserved="true"` tool of
  `place-on-sheet` and `bake-in-oven`, and return it in the `<outputs>` of the task that releases it
  (`<tool ref="baking-sheet"/>`), so it can be reused for the next round. Return bowls/pans after the step
  that empties them.
- **Holds.** `hold` (minutes) is how long a result stays good before its consumer must start. Put it **only on
  results that degrade** — whipped cream 30, beaten egg whites 10, warm milk for yeast 10, melted chocolate 15,
  boiling water 15, cooked pasta 2, fried food 10, shaped dough before baking 30, hot baked goods 10 — on the
  result that degrades, not on a later transfer. **Omit it** for things that keep (cut vegetables, a made sauce,
  measured dry ingredients): no hold means "keeps indefinitely" (RECIPE.spec.md §6).
- **One vessel, several steps.** Steps done one after another in the same pot or pan (brown the beef, soften the
  onions in its fat, stir in flour, add the liquid) must be linked by data — a shared `<tool ref>` does not order
  them. Each step consumes the previous step's output; when the earlier result leaves the pot, give that task an
  extra output for the used pot (`pot-with-fond`) and make it an input of the next step (RECIPE.spec.md §7). The
  check warns "Vessel order: …" otherwise; fix it, do not accept it.
- **Tools.** Use the guide's tool types (`cutting-board`, `casserole-pot`, `hand-mixer`, `rolling-pin`,
  `serving-bowl`, `baking-stone` exist in the default kitchen); an unknown type is assumed to exist once, which
  serialises work. A single carrier (one pizza stone) is fine: the oven bakes it round by round as long as the
  task that takes the bread off returns it.
- **Serving.** `<serving temperature="hot|cold|ambient" hold="…" hold-unit="minutes"/>` — how long the dish
  stays good once finished. **Copy that hold onto the `final="true"` output** (`hold="10" hold-unit="minutes"`):
  it is what keeps the last step close to serving when several dishes are planned together (the scheduler falls
  back to the serving hold, and the check warns when the final output lacks it).
- **Storage.** Ingredient properties for storage (e.g. fridge items and `out-of-storage` times) as in the guide.
- **Soil and requires.** `soil="none|rinse|wash"` on tools (scales and dry measuring: `none`), `requires="knife"`,
  `requires="oven"`, `requires="hot-pan"` per the catalogue.
- **Passive steps** (rise, chill, marinate, bake, simmer) use the catalogue's duration option; they free the
  cooks, so state realistic durations from the source.
- **Final outputs.** Mark what is served with `final="true"` and give it the serving hold. Use `<join>` only where the guide says to.
- Ids: lowercase kebab-case, unique across ingredients, tools, outputs and tasks. Recipe id from the title
  (e.g. `chocolate-chip-cookies`).
- **Units: copy the source; the converter converts.** Write every amount exactly as the source states it, in
  its own units (`1` `cup`, `2` `tbsp`, `0.5` `tsp`, `8` `oz`, `1` `stick`, `350` `fahrenheit`, `9x13 inch`,
  `3` `dl`, `1` `tl`, `2` `rkl`). Do not convert volume → weight or °F → °C yourself — `convert_recipe_units`
  does it deterministically from its density table and notes every change. **When the source gives a weight,
  use it** (also in parentheses: "3/4 cup (150 g) brown sugar" → `150` `g`; "1.2 kg / 2.4 lb" → `1.2` `kg`).
  Decimals only (`0.5`, not `1/2`); countables are `pieces`; pinch/sprig/bunch/handful stay counts; packages
  (`prk`, `pkt`, can) need the package size in the ingredient name. Mass → units: `split` with `parts` (the
  count); `unit-size` only when the producing output has an `amount` in g.

## 4. Convert units

Call `convert_recipe_units { xml, precisionScale }` and **continue with the returned `xml`**. Read `changes` and
`warnings`: if an ingredient had no known density (kept as ml), use `lookup_density { ingredient }` with a more
specific name or rename the ingredient, or convert it with `convert_amount` and edit the amount yourself. Rules:
weights in g for solids, powders, fats, sugars and viscous liquids; thin liquids in ml/dl/l; countables as pieces;
small amounts (≤ 1 tbsp and under 10 g) of spices, salt, leavening, extracts, fresh herbs, starch … as
`tsp`/`tbsp` (or grams with 0.1 g with a precision scale); °C; cm. Nordic/German/French spoons (`tl`, `rkl`,
`msk`, `krm`, `EL`, `TL`) become `tsp`/`tbsp`. Every `warning` in `unitLint` (an unknown unit, an ambiguous `t`)
must be fixed: an unconverted unit means wrong amounts for the cook.

## 5. Check and iterate

Call `check_recipe { xml, precisionScale }`. Repeat steps 3–5 until:

- `ok` is `true` (no `errors`). Fix each error at its cause (unknown operation → pick one from the catalogue;
  unresolved ref → fix the id; missing option → add it; `Scheduler dry run failed: …` → the recipe can never be
  planned, usually because a reserved bowl, pot or carrier is never returned; the message names the tool and
  the waiting tasks). The server refuses to upload a recipe with errors.
- every `warnings` / `unitLint` entry is fixed or deliberately accepted (say which and why in your summary).
- every `Vessel order:` warning is fixed (one vessel, several steps — see step 3).
- the dry-run `plan` is sensible: it succeeded; per-unit work shows up as pipelines (`chains`); 3 cooks are no
  slower than 1 and faster when the recipe has parallel work. The dry run plans as soon as possible:
  `plan.runs[].makespanSeconds` is the elapsed time from the first step to serving, `activeSeconds` the hands-on
  time, `plan.criticalPathSeconds` the time with unlimited cooks (the modelled steps and waits that must happen one
  after another). **Compare the 1-cook time with the source's total time** (`fetch_recipe_source` →
  `times.total`, or prep + cook):
  - Within **+30 % or +15 min, whichever is larger**: fine (a single cook cannot overlap all the hands-on work).
  - Longer, but the critical path alone already exceeds the source total: the source understates its waits (rising,
    chilling, cooling and "cook 40 min" claims usually do). Check your waits against the source *text*, not its
    total; if they match it, the estimate is right — say so in the summary.
  - A real modelling mistake shows as a 1-cook time beyond **max(source total, critical path) × 1.3 + 15 min**, a
    critical path longer than the waits the text states, or 3 cooks no faster than 1 although there is parallel
    work. Usual causes: a passive step modelled as active (bake/simmer/chill without its operation's duration), a
    carrier never returned, a too-small capacity, unlinked one-pot steps, or an invented wait.
  - Clearly shorter than the source means a wait is missing.
  Say in the summary how the estimate compares. (Measuring costs about 20 s per spoon and 40 s per weighed amount,
  so it is not a reason for a long estimate.)

Stop after ~5 rounds and report what is still wrong instead of looping.

## 6. Show the user a short summary

Before uploading, show (keep it short):

- Title, id, servings / yield, source URL.
- Ingredients with metric amounts (weights where applicable); mark converted ones ("1 cup flour → 125 g").
- Number of steps; estimated time with 1 cook and with 3 cooks next to the source's total time; detected pipelines (e.g. "cookies: shape → bake
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
