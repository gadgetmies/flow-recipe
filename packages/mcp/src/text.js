// Fixed texts: the measurement rules and the authoring workflow (shared by the prompt and get_authoring_guide).

export function measurementRules({ precisionScale = false } = {}) {
  return `## Measurement rules (enforced by convert_recipe_units / check_recipe)

- Draft amounts EXACTLY as the source states them, in its units (\`1\` \`cup\`, \`2\` \`tbsp\`, \`8\` \`oz\`, \`1\` \`stick\`,
  \`350\` \`fahrenheit\`, \`9x13 inch\`); never convert volume → weight or °F → °C yourself. convert_recipe_units is the
  source of truth: it converts to the metric policy below and notes each change.
- After conversion everything is metric. Temperatures in °C (rounded to 5 °C). Lengths and pan sizes in cm.
- Weigh what can be weighed: solids, powders, flours, sugars, fats, butter, chocolate, nuts, cheese, chopped
  produce and viscous liquids (honey, syrup, oil) → grams (\`g\`, \`kg\`), using the density table (lookup_density).
- Thin liquids (water, milk, stock, wine, cream, juice, spirits) stay volumes: \`ml\`, \`dl\`, \`l\`.
- Countables stay pieces (no unit, or a count unit): eggs, garlic cloves, onions, lemons, gelatine sheets, buns.
- Small amounts (≤ 1 tbsp / under ~10 g) of spices, salt, baking powder/soda, yeast, extracts: ${
    precisionScale
      ? 'THE USER HAS A PRECISION SCALE → grams with 0.1 g resolution (e.g. 3.2 g salt, 0.6 g cinnamon).'
      : 'metric spoons (`tsp` = 5 ml, `tbsp` = 15 ml, nearest ¼ tsp). The user has no precision scale.'
  }
- \`cup\` = US cup 236.6 ml, \`stick\` of butter = 113 g, \`oz\` = 28.35 g, \`lb\` = 453.6 g, \`fl oz\` = 29.57 ml.
- Never do the arithmetic by hand when a tool can: use convert_amount for single amounts and convert_recipe_units on
  the whole document (it leaves a \`<!-- converted from … -->\` comment next to each changed value).
`
}

export const WORKFLOW = `## Workflow: create a flow-recipe recipe from a URL or text

1. Get the source: a URL (fetch_recipe_source { url }) or pasted text (fetch_recipe_source { text }).
   Know whether the user has a precision scale (0.1 g); ask once if they have not said.
2. Read the authoring guide (get_authoring_guide) — XML format, operations, measurement rules, checklist.
3. Draft ONE complete \`<recipe version="2">\` document. Exploit the scheduler: split per-unit work into unit
   streams (\`unit="cookie"\`, split with \`parts\`), return carriers (sheets, pans, bowls) in \`<outputs>\`,
   tool capacities, \`hold\` only on results that degrade, \`<serving>\`, storage properties, \`soil\`, \`requires\`,
   \`reserved\` tools, \`bake-in-oven\` with the sheet tool, \`final="true"\` outputs. Only use operations from the
   catalogue (list_operations). Set \`ref\` to the source URL.
4. convert_recipe_units { xml, precisionScale } and continue with the returned XML.
5. check_recipe { xml, precisionScale }. Fix every error, consider every warning and unit lint, and iterate until
   ok is true and the dry-run plan is sensible (per-unit work pipelines, 3 cooks faster than 1, no diagnostics
   that show a modelling mistake).
6. Show the user a short summary: ingredients (metric, weights), number of steps, estimated time with 1 and 3
   cooks, detected pipelines, anything you assumed. Ask for changes.
7. upload_recipe { xml, id? } (saves to the server, or to FLOW_RECIPES_DIR). Report the id and how to start a
   session with it (\`/?recipe=<id>\`).
`

export const HANDOFF_WORKFLOW = `## Import requests from the app ("Import with Claude")

When the user's message says "import recipe request <id>" (or asks for the recipe they started in the app):
1. get_pending_import { id } (list_pending_imports when there is no id). It returns the URL or pasted text, the
   precision-scale setting, servings, notes and the fetched source. If fetching failed, ask the user to paste the
   recipe text in the app (or here).
2. Author the recipe exactly as in the workflow above (guide → XML → convert_recipe_units → check_recipe).
3. submit_import { id, xml } instead of upload_recipe. Fix errors and resubmit until ready is true, then tell the
   user to go back to the Flow Recipe app to review and save it.
`

export const STDIO_INSTRUCTIONS =
  'Tools for turning recipes (URL or text) into flow-recipe XML for the multi-cook scheduler. You write the XML; ' +
  'the tools fetch sources, convert units, validate, dry-run the scheduler and upload. Start with ' +
  'get_authoring_guide, finish with check_recipe (no errors) and upload_recipe.'

export const REMOTE_INSTRUCTIONS =
  'Flow Recipe connector: you turn recipes (URL or pasted text) into flow-recipe XML for the multi-cook scheduler; ' +
  'the tools fetch the source, convert units, validate, dry-run the scheduler and save. Workflow: ' +
  'get_authoring_guide → fetch_recipe_source (or get_pending_import) → write ONE complete <recipe version="2"> ' +
  'document → convert_recipe_units → check_recipe until ok → submit. When the user asks to "import recipe request ' +
  '<id>" (a request started in the Flow Recipe app), call get_pending_import { id } first and finish with ' +
  'submit_import { id, xml }; then tell the user to go back to the app to review and save it. For a recipe given ' +
  'only in chat, finish with upload_recipe (saves directly). Never do unit arithmetic yourself: convert_recipe_units ' +
  'and check_recipe are the source of truth.'
