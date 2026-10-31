# @flow-recipe/scheduler

The scheduling engine specified in `../../SCHEDULING.spec.md`. Pure JavaScript (ESM), no DOM, no framework, runs in
Node 22 and in the browser. Tested with `node --test`.

This README is the **contract** between the modules. Every module consumes and produces the plain JSON shapes below.
Keep them in sync when you change anything.

```
src/
  index.js            re-exports everything below
  units.js            unit normalisation (mass, volume, time, temperature, pieces; imperial/US + length helpers)
  conversions/        metric unit policy: density table, amount conversion, recipe XML metricizer, unit lint
  inventory.js        default kitchen inventory + helpers
  recipe/             XML → RecipeModel, validation
  catalogue/          operations.xml → Catalogue, duration model, instruction text
  graph/              Phases A+B: RecipeModel[] + Catalogue + Session → Graph
  planner/            Phases C–H: Graph + Session → Plan
  online/             events, replan with frozen prefix, diff, interrupts
  sim/                simulated participants executing a plan, metrics
bin/demo.js           CLI demo
scripts/              validate-recipes.js
test/                 node --test
```

Conventions: times are **epoch milliseconds** in Session/Plan/Events and **seconds** inside the Graph (durations).
Ids are strings. Every optional field has the default noted. Module entry points are listed in `package.json#exports`.

---

## 1. units.js

```js
normaliseAmount({ number, unit }) → { number, unit }   // 'grams'|'g' → 'g'; 'liters'|'l' → 'l'; 'deciliters'|'dl' → 'dl'; 'ml'; 'kg'→ g
toSeconds({ number, unit })        → number            // seconds|minutes|hours|min|s|h
toCelsius({ number, unit })        → number            // celsius|celcius|fahrenheit|c|f
isMass(unit), isVolume(unit), isCount(unit)             // count: pieces|pcs|piece|units
```

Imperial / US units are **additive** helpers: the metric tables and functions above are unchanged (`isMass('oz')` is
still false, `canonicalUnit('oz')` is still `'oz'`), the conversions module uses these instead.

```js
IMPERIAL_MASS   // g:  oz, ounce(s), lb, lbs, pound(s)
IMPERIAL_VOLUME // ml: 'fl oz', floz, fluid ounce(s), cup(s) 236.6 (US cup; VOLUME.cup stays 240), pint(s)/pt 473, quart(s)/qt 946, gallon(s)/gal 3785
LENGTH          // cm: mm, cm, m (+ long spellings), in, inch, inches, '"'
BUTTER_STICK_GRAMS = 113, PINCH_GRAMS = 0.3
imperialKey(unit)                       // 'Fl. Oz.' → 'fl oz'
isImperialMass, isImperialVolume, isImperialLength, isLength, isFahrenheit, isImperial(unit)
toMetricBase({ number, unit }) → { number, unit: 'g'|'ml'|'cm' } | null   // metric and imperial
toCentimeters({ number, unit }) → number | null
```

## 2. RecipeModel (recipe/parse.js)

`parseRecipe(xmlString, { DOMParser, id? })` → `RecipeModel`. Must work with the browser `DOMParser` and with
`@xmldom/xmldom`'s `DOMParser` (use only `getElementsByTagName`, `childNodes`, `nodeType`, `nodeName`,
`getAttribute`, `hasAttribute`, `textContent`).

```js
RecipeModel = {
  id: 'buns',                          // option id, else kebab-case of title
  title: 'Buns',
  ref: 'https://…' | null,
  serving: { temperature: 'hot'|'cold'|'ambient', hold: seconds } | null,   // <serving>; default null → ambient, ∞
  ingredients: [{ id, name, properties: { [name]: { value?: string, number?: number, unit?: string } } }],
  tools: [{ id, name, type, capacity: { number, unit } | null, properties }],  // type defaults to id
  tasks: [Task],
}
Task = {
  id: 'mix-dough',                     // explicit id attribute, else `${recipeId}:t${index}` (index in document order, 1-based)
  operation: 'mix',
  options: { [name]: { number?: number, unit?: string, text?: string } },
  inputs:  [{ ref, amount: number|null, text: string|null }],   // container inputs first, then refs embedded in <instructions>, deduped by ref
  tools:   [{ ref, reserved: bool, amount: number, soil: 'none'|'rinse'|'wash'|null, qty: number }], // from <tools>, task-level and <instructions>; defaults false, 1, null, 1
  outputs: [{ id, name, amount: number|null, unit: string|null, hold: seconds|null, volume: { number, unit }|null, final: bool }],
  returnsTools: [{ ref, name: string|null }],          // <tool> elements inside <outputs>
  instructions: [ { text } | { input: ref, amount? } | { tool: ref } | { output: id } | { option: name } ] | null,
  requires: ['knife'],                                  // from requires="a b"
  steps: [Task] | undefined,                            // only for operation 'join': the flattened children (see below)
}
```

`<join>` becomes one Task with `operation: 'join'`, `steps` = the children in order, `inputs` = refs consumed by steps
but not produced by an earlier step, `outputs` = outputs of steps not consumed by a later step, `tools` = union.
`id` of a join = id attribute or `${recipeId}:join${n}`.

The legacy `<batch>` wrapper with nested `<tasks>` is **not** supported by v2; recipes are migrated to unit streams.

`validateRecipe(model, catalogue)` → `{ valid, errors: [string], warnings: [string] }`. Checks: unique ids across
ingredients/tools/outputs/tasks; every input ref resolves to an ingredient, tool or earlier output; every tool ref
resolves; operation exists; option arity/required per catalogue; units normalisable; outputs with `unit` form
consistent streams; at least one final output (explicit `final` or inferred as unconsumed).

## 3. Catalogue (catalogue/load.js)

`loadCatalogue(operationsXmlString, { DOMParser })` → `Catalogue`.

```js
Catalogue = { [operationName]: Operation }
Operation = {
  name, title,
  minInputs, maxInputs: number|null, minOutputs, maxOutputs: number|null, requiresTools: bool,
  options: { [name]: { required: bool, type: 'numeric'|'text'|'boolean', defaultUnit: string|null } },
  time: {
    model: 'fixed'|'per-unit'|'sub-linear',   // default fixed
    active: seconds,                           // fixed part
    perUnit: seconds,                          // per-unit part (per-unit, sub-linear)
    passive: seconds,                          // constant passive part
    passiveFrom: 'duration' | 'formula:heat' | 'formula:preheat' | null,  // passive computed from the task's options
    byAmount: { spoon?, count?, weigh?, pour? } | null,  // seconds replacing perUnit by the kind of the task's
                                               // `amount` option (timeline attributes; measure: 20/15/40/30)
  },
  attention: 'attended'|'monitored'|'unattended',   // default attended if passive=0 else unattended
  checkInterval: seconds|null, checkDuration: seconds|null,   // monitored only
  divisible: 'none'|'units'|'team',                 // default units for per-unit, else none
  minChunk: seconds, maxPeople: number, speedup: number,
  preemptible: 'never'|'units'|'anywhere', resumeCost: seconds,
  completion: { urgency: 'critical'|'timed'|'relaxed', early: seconds, late: seconds, duration: seconds },
  soil: 'none'|'rinse'|'wash',                      // default soil the operation leaves on its tools
  station: 'counter'|'hob'|'oven'|'sink'|'fridge'|'bar',
  tedium: number,                                   // default 1
  requires: [string],
  expand: 'bake-in-oven' | 'split' | null,          // expansion rule name handled by graph/expand.js
}
```

`durations(operation, task, units, catalogue)` → `{ active, passive }` seconds at speed 1, applying the time model,
`passiveFrom` (duration option in seconds; `formula:heat` = `(temperature°C − 10) × 5`; `formula:preheat` =
`(temperature°C − 20) × 8`) and the `sub-linear` rule `active + perUnit × sqrt(units)`. When the operation has
`byAmount`, the task's `amount` option picks the per-unit seconds: `spoon` (tsp, tbsp, pinch, dash, or a volume up to
15 ml), `count` (pieces, cloves, sheets), `weigh` (a mass, on the scale), `pour` (a larger volume); other units keep
`perUnit` (`amountKind(amount)` / `amountSeconds(time, task)`).

`instructionText(task, recipeModel, catalogue)` → string. Ported from the client's `operations.js` instruction
functions; when `task.instructions` is present, render it (names of refs, option values with units).

## 4. Session (input to graph + planner)

```js
Session = {
  id: 'abc',
  startTime: epochMs | null,
  now: epochMs,                        // planner clock; offline = startTime
  dishes: [{ id: 'buns', recipeId: 'buns', recipe: RecipeModel, scale: 1, serveTime: epochMs, earlyTolerance: 0, lateTolerance: 300_000 }],
  participants: [{ id, name, availability: [[fromMs, toMs]] | null, speed: 1, capabilities: [string] | null /* null = all */, role: 'cook'|'cleaner'|'spectator', targetShare: 1, maxConcurrentTimers: 2, placeholder: bool }],
  inventory: Inventory,
  policy: Policy,
}
Inventory = {
  tools:      [{ type, count, capacity: { number, unit } | null }],          // e.g. { type:'baking-sheet', count:4, capacity:{ number:16, unit:'bun' } }
              // capacity is only a default: a capacity stated on the recipe's tool always wins (it knows its items' size)
  appliances: [{ type: 'oven'|'microwave'|'hob'|'stand-mixer', slots: number, modes: bool, modeSwitchSeconds: number }],
  stations:   [{ type: 'sink'|'counter', count: number, area: number|null }],   // counter area in units (buffer when no carrier)
  holding:    [{ type: 'fridge'|'freezer'|'warming-drawer', slots: number, keeps: 'cold'|'hot', maxHold: seconds }],
  cleaning:   { rinseSeconds: 20, washSeconds: 90, dishwasher: { slots, cycleSeconds } | null },
}
Policy = {   // defaults in planner/policy.js, see spec §11
  weights: { fair: 10, idle: 8, switch: 3, interrupt: 5, robust: 2, span: 1, stable: 4 },
  switchMatrix: { sameContext: 0, sameDishSameStation: 15, sameDishOtherStation: 30, otherDish: 60, afterCleaning: 30, any: 10 },
  minChunkSeconds: 180, maxIdleStretchSeconds: 480, slackBufferFraction: 0.1, slackBufferMinSeconds: 120,
  hotHoldSeconds: 600, coldHoldSeconds: 1200,
  cleaning: 'shared'|'dedicated'|'deferred', endOfSessionCleaning: true,
  miseEnPlace: false,
  leadSeconds: 30, reactionSeconds: 30, ackTimeoutSeconds: 15,
  replanThresholdSeconds: 90, replanDebounceSeconds: 10, stabilityHorizonSeconds: 900,
  searchBudgetMs: 400, replanBudgetMs: 120, seed: 1,
}
```

`inventory.js` exports `defaultInventory()` (a reasonable home kitchen) and `mergeInventory(base, overrides)`.

## 5. Graph (graph/build.js) — Phases A and B

`buildGraph(session, catalogue)` → `Graph`.

```js
Graph = {
  tasks: { [id]: TaskInstance },
  order: [id],                       // topological
  edges: [Edge],
  buffers: [Buffer],
  dishes: [{ id, recipeId, title, serveTime, earlyTolerance, lateTolerance, temperature, hold, sinkId }],
  diagnostics: [Diagnostic],
}
TaskInstance = {
  id: 'buns:roll#b1',                // `${dishId}:${recipeTaskId}` + `#b<n>` per batch instance; chunks add `/c<n>` later
  dishId, recipeTaskId, operation, title,
  instructions: string,              // rendered text (per batch: "sheet 2 of 4" suffix where relevant)
  units: number,                     // n_j
  unitStream: string|null,           // e.g. 'bun'
  batch: { index, of } | null,
  active: seconds, passive: seconds, timeModel, perUnit: seconds,
  attention, checkInterval, checkDuration, divisible, minChunk, maxPeople, speedup, preemptible, resumeCost,
  completion: { urgency, early, late, duration } | null,   // present when passive > 0
  context: { dish, station, tool: string|null },
  tedium, requires: [string],
  tools: [{ type, qty, mode: 'active'|'reserved', soil }],
  appliance: { type, slots: number, mode: string|null } | null,   // mode = temperature string, e.g. '225c'
  returnsTools: [type],
  hold: seconds | Infinity,
  outputs: [{ id, amount, unit }], inputs: [{ ref, amount }],
  kind: 'work' | 'sink',             // sink = virtual serve task (active 0)
  serveWindow: { earliest, latest } | null,   // epochMs, sinks only
}
Edge = { from, to, kind: 'fs' | 'stream' | 'maxlag', lag: seconds /* stream: SS lag */, ffLag: seconds, hold: seconds /* maxlag */, unitStream }
Buffer = { from, to, carrier: string|null /* tool type */, capPerCarrier: number, carriers: number, capacity: number, releaseTask: id|null, station: 'counter'|null }
Diagnostic = { code, message, dish?, task?, delta? }
```

Ingredient handling (spec §3.10, `graph/mise.js`): measuring steps of fridge/freezer ingredients get an
out-of-storage hold; with `policy.miseEnPlace` the builder adds `gather` tasks (`mise:gather-pantry`, and
`mise:gather-<fridge|freezer>:<dishId>[:<ingredientId>]`) with fs edges to the users and maxlag edges through measuring
steps. Gather tasks have `dishId: null` (pantry) or the dish id, `operation: 'gather'`, `releaseLead` (seconds).

Rules (spec §5.1–5.2): expansion to fixpoint; join → one instance (durations summed, instructions concatenated);
quantities propagated backward from each dish's final outputs (scale applied); batch instantiation when a carrier or
appliance capacity is smaller than `units`; streaming edges between consecutive per-unit tasks on the same
`unitStream`; maxlag edges for finite `hold`; dish sinks with serve windows and hold from `serving` or policy;
buffers derived from carrier tools and their release tasks; `appliance.mode` from the `temperature` option.

## 6. Plan (planner/index.js) — Phases C–H

`plan(graph, session, { previousPlan, frozen, now, mode, status, preferAssignments, budgetMs, maxIterations })` → `Plan`.
Pipeline inside: Phase C windows → Phase E dispatch → Phase D chain hints (kept only when the objective improves) →
Phase F seeded annealing (`policy.searchIterations` moves, `searchBudgetMs` as a safety cap; 0 skips it) → Phase G
repair ladder when a dish is late. Deterministic for a given seed.

```js
Plan = {
  mode: 'offline'|'online', status: 'draft'|'running'|'done',
  seed, computedAt, now, startTime, endTime,
  diagnostics: [Diagnostic],
  diff: [{ participantId, changes: [{ uuid, field, from, to, reason }] }] | null,
  lanes: [Lane],
  dishes: [{ dishId, serveTarget, plannedServe, spread, holdUsed, late: seconds }],
  report: { fairness: number, loads: { [participantId]: { load, expected } }, switches, interruptsRisk, makespan, planningMs,
            objective: { total, terms, weighted },                 // spec §4.2, lower is better
            search: { iterations, improved, budgetMs, hintsApplied },
            chains: [ Phase D analysis per per-unit chain, incl. perBurst workforce ] },
  shoppingList: [{ name, amount, unit }],
}
Lane = { participantId, items: [Item], report: { load, expectedLoad, switches, longestLopsidedIdle, timersHeld } }
Item = {
  uuid,                               // TaskInstance id + optional `/c<n>` chunk suffix; appointments: `${taskId}@done`; cleaning: `clean:${toolType}#<n>`
  taskId,                             // the TaskInstance behind it (null for idle)
  kind: 'work'|'cleaning'|'appointment'|'check'|'setup'|'resume'|'blocked'|'idle',
  start, end,                         // epochMs planned
  status: 'planned'|'started'|'paused'|'done',
  actualStart?, actualEnd?, progress?,
  title, instructions, dishId,
  context: { dish, station, tool },
  units: { from, to, of } | null,
  inputsFrom: [{ outputId, participantId, byTime }], outputsTo: [{ outputId, participantId, byTime }],
  preemptible, urgency: 'critical'|'timed'|'relaxed'|null,
  window: { earliest, latest } | null,
  timer: { title, durationSeconds, firesAt } | null,
  dependencies: [uuid],
  tools: [{ type, instanceId }],
  passiveUntil: epochMs | null,       // for work items with a passive phase
}
```

Invariants (checked by `planner/check.js` `checkPlan(plan, graph, session)` → `[string]`): no overlapping items on a
lane (except `idle`), no over-allocated tool instance/appliance slot/station, precedence and lags respected, anchored
tasks inside their windows, no non-preemptible item overlapping an appointment, every critical/timed completion has
exactly one appointment holder, serve windows met or a diagnostic present.

## 7. Online (online/index.js)

```js
Event = { type: 'sessionStarted'|'taskStarted'|'taskDone'|'taskPaused'|'taskProgress'|'timerFired'|'appointmentAcknowledged'|'participantJoined'|'participantLeft'|'participantPaused'|'resourceChanged'|'deadlineChanged', at: epochMs, participantId?, uuid?, units?, payload? }
State = { session, graph, catalogue, plan, events: [Event], frozen: { [uuid]: Item } }
createState(session, catalogue, { graph? }) → State   // builds graph (unless given) and the offline plan
applyEvent(state, event) → { state, replanNeeded: bool, reason }
replan(state, now) → { state, plan, diff }       // frozen prefix, stability, placeholder reconciliation
diffPlans(prev, next, now, horizonSeconds) → diff
chooseInterruptTarget(state, appointment | uuid, now) → { participantId, cost, preempts: uuid|null, broadcast? } | null
dueInterrupts(state, now) → [{ item, uuid, opensAt, holder, target }]   // appointments opening within lead + reaction whose holder is busy
```
Items carry their actuals: `taskStarted` sets `actualStart` and shifts the planned times by the delta (originals kept
in `plannedStart`/`plannedEnd`); `taskPaused` turns the item into `kind: 'resume'` with `progress { done, of,
remainingActive }` under the same uuid, so later events keep addressing one item.

## 8. Simulation (sim/index.js)

```js
simulate({ session, catalogue, graph?, seed, speedNoise: 0.25, lateStartProbability: 0.1, tick: 5_000 }, onTick?)
  → { events, finalPlan, draftPlan, metrics: { lateness: {dishId: seconds}, interrupts, replans, events, fairness, blockedSeconds, idleLopsided }, log: [string] }
createSimulation(cfg) → { step(ms), state, now, log }   // the same loop, advanced incrementally (browser demo)
renderLanes(plan, { width }) → string                   // text Gantt (CLI); fmt(ms) → 'HH:MM'
```
Participants start their next item when it is due and they are free, finish after `active × speed × noise`,
acknowledge appointments with a reaction delay; every event goes through `applyEvent`/`replan`.

## 8b. Dev tools

```
node scripts/plan-recipes.js buns,tiramisu 3 [items]     # plan real recipes from packages/server/src/recipes and print the lanes
node scripts/validate-recipes.js                         # schema + parse + validate every recipe
node bin/demo.js --recipes buns,tiramisu,negroni --participants 4 --sheets 2 --seed 7 [--verbose] [--plan-only]
```

## 9. Top-level helper

```js
planSession({ recipes: { [id]: xmlString }, operationsXml, session, DOMParser }) → { catalogue, graph, plan }
```

## 10. Conversions (conversions/)

`@flow-recipe/scheduler/conversions` (also re-exported from the package index). Pure ESM, browser-safe: the XML
function takes the `DOMParser` / `XMLSerializer` constructors (browser globals or `@xmldom/xmldom`).

**Unit policy.** Everything metric. Weighable ingredients (flours, sugars, fats, oils, honey and syrups, cheese,
nuts, chopped produce …) are measured in **g** (kg from 1000 g). Thin liquids (water, milk, cream, stock, wine,
juice, spirits) stay in **ml / dl / l**. Countables stay **pieces** (eggs, garlic cloves, onions, lemons, gelatine
sheets). Small amounts (≤ 1 tbsp or < 10 g) of spices, salt, leavening, extracts and other `spoon` entries stay
**metric spoons** (`tsp` = 5 ml, `tbsp` = 15 ml, to 1/4) — unless the cook has a precision scale
(`precisionScale: true`), then they are grams with 0.1 g resolution. Temperatures in °C (nearest 5), lengths in cm
(nearest 0.5).

```js
DENSITIES        // [{ id, names: [display name, ...aliases], gPerMl, kind, pieceGrams?, spoon?, note?, source }]
                 // 380 entries; kind: liquid|viscous|fat|powder|granular|spice|leavening|produce|nut|grain|dairy|other
findDensity(name, properties?) → entry | null
findDensities(name, properties?) → [entry]          // every matching entry, best first
normaliseIngredientName(name) → string
toMetricAmount({ number, unit }, { ingredient, properties?, precisionScale = false, density? })
  → { number, unit, from: { number, unit }, method: 'unchanged'|'metric'|'density'|'spoon'|'count', density, note }
roundForKitchen(grams, { precisionScale }) → number   // <1 g: 0.5 g, <10 g: 1 g (0.1 g precision); <250: 1 g; <1000: 5 g; else 10 g
toCelsiusRounded(fahrenheit) → number                 // 350 → 175
inchesToCm(inches) → number                           // 9 → 23
convertInchText('9x13 inch') → '23x33 cm' | null
metricizeRecipeXml(xml, { DOMParser, XMLSerializer, precisionScale = false })
  → { xml, changes: [{ taskId, ingredientId, from, to, method, note }], warnings: [string] }
lintRecipeUnits(model, { precisionScale }) → [{ level: 'warning'|'info', taskId, message }]
```

`gPerMl` is grams per millilitre *as measured with cups and spoons* (spooned flour, packed brown sugar, chopped
onion, grated cheese), derived from the King Arthur ingredient weight chart (g per US cup ÷ 236.6) and USDA
FoodData Central. Notable choices: all-purpose flour 0.53 (125 g/cup), granulated sugar 0.85, brown sugar 0.90
(packed), butter 0.96 (one stick = 113 g), table salt 1.2 (1 tsp ≈ 6 g). **Kosher salt defaults to Diamond
Crystal** (0.57 g/ml, 1 tsp ≈ 2.8 g), the brand most US recipe writers assume; Morton kosher salt is ~1.7× denser
— name it ("Morton kosher salt") or set `<property name="brand" value="Morton"/>` to get 0.96. Bare "coriander" is
the ground spice, "fresh coriander" / "cilantro" the herb; British "cornflour" is cornstarch. `pieceGrams` is
informative (egg ≈ 50 g without shell, garlic clove ≈ 5 g, medium onion ≈ 150 g, gelatine sheet ≈ 1.7 g).

`findDensity` normalises the name (case, accents, punctuation, hyphens, plurals), drops leading quantities and
units and anything in parentheses, prefers the part before the first comma ("unsalted butter, softened"), tries
"a or b" alternatives in order, prepends descriptive properties (`type`, `kind`, `variety`, `brand`, `form` …, so
`cinnamon` + `type=ground` is "ground cinnamon"), then picks the alias with the most words that occurs as a
contiguous run, ties going to the one ending later (the head noun: "orange bitters" → bitters). An entry id also
matches.

`toMetricAmount` rules, in order:
- no unit, count units, clove/sprig/can/pinch/dash … → unchanged (`count`); with a precision scale a pinch is 0.3 g;
  `stick(s)` of a fat → 113 g each;
- metric mass → unchanged; oz/lb → g (`metric`), except `oz` of a thin liquid, read as fluid ounces → ml;
- volume (metric spoons/ml/dl/l, or cup/fl oz/pint/quart/gallon):
  - unknown ingredient → ml (`metric`, note `no density known`); metric volumes stay as they are;
  - thin liquid → ml (≥ 1 l → l); tiny amounts (≤ 1 tbsp) of extracts and other spoon liquids → spoons (or g with a
    precision scale); metric volumes stay as they are;
  - spice / leavening / spoon entry, ≤ 1 tbsp or < 10 g, no precision scale → metric spoons (`spoon`);
  - anything else with a density → g (`density`).
- metric lengths stay; inches → cm; unknown units are left unchanged with a note.

`metricizeRecipeXml` converts every `<option name="amount">` (the ingredient comes from the task's input ref: an
`<ingredient>`'s text and properties, else an earlier output's name), Fahrenheit in any numeric-value (°C, nearest
5), any other imperial mass / volume / inch numeric-value (tool capacity in quarts → l), output `volume` in US
units → l, and inch sizes in `size`/`diameter`/`length`/… property values (`9x13 inch` → `23x33 cm`). Each changed
value gets a comment in front: `<!-- converted from 1 cup (all-purpose flour, 0.53 g/ml) -->`. It is idempotent
(the second run changes nothing and returns the input string) and returns the input untouched when nothing
changes; otherwise the document is re-serialised (XML declaration and trailing newline kept).

`lintRecipeUnits` reports `warning`s for non-metric units (options, tool / ingredient properties, output volumes),
solids measured by volume (ml/dl/l), and spoons used for more than 2 tbsp of a weighable ingredient; `info` for
small spoon amounts of weighable ingredients, spoon ingredients that could be weighed on a precision scale, volumes
with no known density, and thin liquids measured by weight.
