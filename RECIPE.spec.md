# Recipe authoring guide (format v2)

You convert a recipe (usually a web page) into ONE Flow Recipe XML document. A multi-cook scheduler reads it, so the
XML states **facts** — ingredients, amounts, steps, durations, temperatures, tools, capacities, how long results stay
good — never who does what or any order beyond the data dependencies. The scheduler derives batches, oven rounds,
pipelines and timing from those facts. Output only the XML; it must parse, validate and plan. §11 is a complete,
working example: follow its shape.

## 1. Document

```xml
<?xml version="1.0" encoding="utf-8"?>
<recipe version="2" id="chocolate-chip-cookies" ref="https://example.com/source-page">
  <title>Chocolate chip cookies</title>
  <serving temperature="ambient"/>
  <ingredients>…</ingredients>
  <tools>…</tools>
  <tasks>…</tasks>
</recipe>
```

- Children in exactly this order; `serving` optional; at least one ingredient; `<tools>` always present.
- `version="2"`; `id` = kebab-case of the title; `ref` = the source URL. `<title>`: the dish name, no "best"/"easy".
- **Ids**: kebab-case, unique across ingredients, tools, tasks and outputs together (a task `plate` and a tool
  `plate` collide). Tasks verb-noun (`chop-onion`), outputs nouns (`chopped-onion`), measured amounts
  `<ingredient>-for-<use>` (`flour-for-dough`).

## 2. Serving

`<serving temperature="hot|cold|ambient" hold="10" hold-unit="minutes"/>`: how the dish is served and how long it
stays servable once done (`hold-unit` `seconds|minutes|hours`, default minutes). Defaults without `hold`: hot 10 min,
cold 20 min, ambient unlimited. Hot meals: `hot`, 5–15 min. Fridge desserts: `cold`. Baked goods: `ambient`.

## 3. Ingredients

`<ingredient id="butter">unsalted butter<properties>…</properties></ingredient>`

- The **name is the text content** (lower case, singular, specific). No `name` attribute, no amounts (amounts live
  in `measure` tasks).
- Properties: `<property name="…" value="…"/>`, or with `<numeric-value number="…" unit="…"/>` or
  `<text-content>` inside.
- `storage` = `fridge` | `freezer` for perishables (milk, butter, eggs, cream, cheese, meat, fish, fresh yeast,
  fresh herbs); omit for the pantry. Their measuring is then kept close to their use.
- `out-of-storage` (numeric duration) only when it differs from the default (fridge 60 min, freezer 10 min):
  butter that must soften 120 min, ice 5 min.
- Free descriptive properties: `type` (fine, ground, dry, pearl), `size` (large), `fat-content` (percent).
- One ingredient per product; the same product used twice (eggs in the dough and for brushing) is one ingredient
  with two measure tasks; variants (white sugar, pearl sugar) are separate ingredients. Measured water is an
  ingredient.

## 4. Tools

`<tool id="baking-sheet">baking sheet<properties><property name="capacity"><numeric-value number="12"
unit="cookie"/></property></properties></tool>`

- A tool names a **type**; the kitchen inventory says how many exist. Use these types as ids when they fit: `bowl`
  (4 l), `large-bowl` (8 l), `cup`, `jug`, `plate`, `serving-plate`, `baking-sheet`, `baking-tin`, `cake-mould`,
  `square-dish`, `shallow-dish`, `cooling-rack`, `pot`, `pan`, `mixing-glass`, `rocks-glass`, `whisk`, `spatula`,
  `frosting-spatula`, `spoon`, `fork`, `knife`, `pastry-brush`, `grater`, `peeler`, `sieve`, `strainer`, `bar-spoon`,
  `fruit-baller`, `blender`, `ladle`, `kitchen-scale`, `precision-scale`, `towel`, `parchment-paper`, `cling-film`,
  `cover`. Other types are allowed (assumed to exist once). `type="…"` maps an id to another type (rare).
- Never declare the oven, hob or microwave; operations bring them.
- `capacity` with a unit: containers in litres (`pot` 3 l) so a rising dough gets a bowl that fits; **carriers** in
  the unit of the stream they carry (`baking-sheet` 12 `cookie`, `pan` 2 `fillet`, `plate` 1 `serving`). Carrier
  capacity turns 24 cookies into 2 sheets and sheets into oven rounds (2 sheets per round). Use the realistic count.
- Parchment paper and cling film are tools, consumed as `<input ref>` by `line` / `cover`.

## 5. Tasks

```xml
<task id="chill-dough" operation="chill">
  <options><option name="duration"><numeric-value number="30" unit="minutes"/></option></options>
  <inputs><input ref="cookie-dough"/></inputs>
  <tools><tool ref="large-bowl" reserved="true"/></tools>
  <outputs><output id="chilled-dough" hold="60" hold-unit="minutes">chilled cookie dough</output></outputs>
  <instructions>Cover the <input ref="cookie-dough"/> and chill until firm.</instructions>
</task>
```

- `operation` from §10; every task gets an `id`.
- **Options** `<option name><numeric-value number unit/></option>`: always write the unit — durations
  `minutes|hours|seconds`, temperatures `celsius`, amounts `g|kg|ml|dl|l|tsp|tbsp|pieces`. Default units differ
  per operation (`raise` seconds, `chill` hours). Options not in the catalogue do nothing.
- **Inputs** `<input ref/>`: an ingredient, a tool (consumables) or an output of an EARLIER task (document order).
  `amount="10"` consumes only part of an output (10 of 24 ladyfingers); otherwise all of it.
- **Tools** `<tool ref reserved soil qty/>`:
  - `reserved="true"`: the tool holds the result until it is consumed (bowl with dough, pot on the hob, sheet with
    cookies, glass with the drink). Hand tools (whisk, knife, spatula) are not reserved.
  - `soil="none|rinse|wash"` overrides the operation default: `none` for scales, racks, towels, sheets on
    parchment; `wash` after raw egg, meat, fish, dough, fat, chocolate. Soil exists only on tool references.
  - `qty`: instances needed at once (rare).
- `requires="knife hot-pan oven"` on `<task>`: capabilities a participant needs. Operations add their own (`chop` →
  knife, `fry` → hot-pan, `bake-in-oven` → oven); add one only when the step needs more than its operation implies.
- **Instructions** (recommended for every task except `measure`): imperative sentences with embedded
  `<input ref/>`, `<tool ref/>`, `<option name/>`, rendered as names. They replace the generated text ("Chop onion"),
  so keep the source's cues ("until golden"). The schema requires at least one embedded element.
  - Refs inside instructions are merged into the task: an `<input ref>` not listed in `<inputs>` adds a dependency.
    Reference only what the task consumes or uses.
  - Never put `<output>` in instructions: it declares an output, and repeating one from `<outputs>` is a parse error
    ("declares output twice"). Name results in words.
  - `<option name="duration"/>` without a value renders the value set in `<options>`.
- **Joins**: `<join id="dissolve-yeast">` wraps 2+ tasks one person does back-to-back as one step (crumble yeast,
  stir into milk). Rare; never with long waits inside.

## 6. Outputs, unit streams, carriers

`<output id amount unit hold hold-unit volume volume-unit final>name</output>`

- Every output is consumed by a later task or is `final="true"` (an unconsumed output becomes an extra served dish).
  Mark what goes to the table `final="true"`, usually one output.
- `hold` (default unit minutes): how long the result stays good before its consumer must start. Only on results
  that degrade: whipped cream 30, beaten egg whites 10, warm milk for yeast 10, melted chocolate 15, boiling water
  15, cooked pasta 2, fried food 10, shaped dough before baking 30, hot baked goods 10. Put it on the result that
  degrades (the baked cookie), not on a later transfer.
- `volume` (+ `volume-unit`, default l): size of a dough that needs room to rise.
- **Unit streams**: `amount` + `unit` with a countable noun — `cookie`, `bun`, `serving`, `fillet`, `patty`,
  `dumpling`, `drink`, `bowl` — names a stream of units; `amount` is the count for the stated yield. Plain quantity
  units are NOT streams: `pieces`, `piece`, `pcs`, `unit(s)`, `portion(s)`, `slice(s)`, `dash`, any mass, volume or
  time unit. Write `serving`, not `portion`.
- A stream starts where a mass becomes units (`split` with `parts`, `scoop`, `shape`, `cut`); every later task on it
  repeats `amount` and `unit` (24 `cookie` through to the final output). `split` with `unit-size` (45 g) derives the
  count from the producing output's `amount` in g (`<output id="dough" amount="1100" unit="g">`); prefer `parts`.
- **Pipelines**: consecutive tasks on one stream whose operations are per-unit (**u** in §10) are linked unit by
  unit, so the planner can run them as a pipeline (one person rolls, another places on sheets) or share units
  between people. A non-per-unit task (bake, cool, rest) ends the chain. So split early and write one task per
  per-unit action (portion → roll → place → brush → sprinkle), each with the stream output. Never lump "shape and
  place on sheets" into one task.
- **Carriers**: a tool with a capacity in the stream's unit, used by a per-unit task or the bake, batches the units
  (24 / 12 per sheet = 2 sheets) and stays with them through later tasks and the oven until a task **returns** it by
  listing it in `<outputs>`: `<outputs><output id="cookie-on-rack" …/><tool ref="baking-sheet"/></outputs>`. Return
  each carrier at the task that takes the units off it (transfer to rack, plating), else sheets never come back for
  the next round (`CARRIER_NEVER_RETURNED`). A carrier that goes to the table needs no return. Reserved containers
  are returned the same way once emptied (`split` returns the dough bowl).
- A stream task may also consume non-stream outputs (lined sheet, beaten egg). Give those no `unit`, or the
  validator warns about mixed units.

## 7. Oven, hob, waits

- **Oven**: one `bake-in-oven` (sweet) or `roast` (savoury) task, `temperature` and `duration`, exactly one input
  and one output (combine fillings first). List the carrier as `<tool ref="baking-sheet" reserved="true"
  soil="none"/>` so the rounds follow from capacity × 2 slots. Never write preheat, "put in" or "take out" tasks:
  the task expands into `preheat-oven` (timed from the temperature), `put-into-oven`, `take-out-of-oven`. Cakes:
  `baking-tin` / `cake-mould` (capacity 1 `cake`).
- **Hob** (each needs `duration`, per round, from the source): `fry` (per-unit; a pan with a capacity in the
  stream's unit gives rounds), `sear`, `saute` (onions, garlic, vegetables), `toast` (nuts, spices), `simmer`
  (sauces, stews, soups), `cook` (pasta, rice, grains, eggs), `boil`, `steam`; `heat` takes `temperature` or
  `duration`; `melt` and `soften` take none.
- **Waits** have one input, one output and a required `duration`: `raise` (proofing), `chill` (fridge), `freeze`,
  `rest` (dough, meat), `cool` (room temperature, rack), `marinate` (fridge), `soak`. Ranges → the lower bound;
  overnight → 8 hours. Never `wait` (it links nothing).

## 8. Measuring and units

- One `measure` task per ingredient **use**: `amount` option, the ingredient as input, one output. Unmeasured uses
  ("salt to taste", "oil for greasing", "flour for dusting") take the ingredient directly as an input of the task.
- Tools: `<tool ref="kitchen-scale" soil="none"/>` when weighing (`precision-scale` below 10 g if the user has one);
  optionally the reserved container it goes into (several measures may share one bowl).
- **Metric only** — never cups, ounces, pounds, sticks, °F or inches:
  - **grams** (g, kg) first: flour, sugar, butter, fats, chocolate, nuts, grains, rice, pasta, cheese, chopped
    produce, honey, syrup, oil and other viscous liquids;
  - **ml / dl / l** for thin liquids: water, milk, stock, wine, cream, juice, spirits;
  - **`tsp` (5 ml) / `tbsp` (15 ml)** for small amounts (≤ 1 tbsp, under ~10 g) of salt, spices, baking powder,
    baking soda, yeast, extracts — unless the user has a precision scale: then grams with one decimal;
  - **`pieces`** for countables: eggs, onions, garlic cloves, lemons, fillets, gelatine sheets;
  - temperatures `celsius`, lengths cm.
- A deterministic converter fixes leftover units afterwards (cups → g via densities, °F → °C), but write metric
  yourself.
- **Scaling**: every amount, `parts` and stream `amount` is for the yield the source states (24 cookies, 4
  servings). Never rescale; the scheduler scales the whole recipe.

## 9. Checklist and common mistakes

1. Root `<recipe version="2" id ref>`, children in order, `<tools>` present, well-formed.
2. Operations from §10; required options present, every number with a unit.
3. Inputs resolve to an ingredient, a tool or an EARLIER task's output; tool refs to declared tools.
4. Ids unique across everything, kebab-case.
5. Every output consumed or `final="true"`.
6. One task per per-unit action on the stream; carriers have capacity in the stream unit, ride along into the bake
   as a reserved tool and are returned in `<outputs>` where the units leave them.
7. One measure per ingredient use, metric, amounts for the stated yield.
8. Holds on degrading results, `<serving>` set, perishables with `storage`.

Mistakes: `name` attributes or amounts on ingredients; preheat tasks; `wait` instead of `rest`/`cool`; `portion` or
`pieces` as a stream unit; one "shape and bake" task; two inputs to `bake-in-oven`; `<output>` in instructions;
instructions without any embedded ref; the baking sheet never returned; `<batch>` or nested `<tasks>` (v1,
rejected); cups/ounces; durations without a unit; stray outputs nobody uses.

## 10. Operations

**u** = per-unit (pipelines, shareable between people); `in` = inputs allowed; * = required option. Pick the most
specific operation and put nuances in the instructions.

| Operation | in | Options | Use for |
|---|---|---|---|
| `measure` | 1–2 | amount* | one ingredient use |
| `chop` **u**, `dice` **u**, `mince` **u** | 1 | | knife work |
| `slice` | 1 | parts* | into a number of slices |
| `cut` **u** | 1 | parts | into pieces or portions (bars, strips) |
| `peel` **u**, `grate` **u**, `zest` **u**, `juice` **u** | 1 | | produce |
| `crumble` **u**, `separate` **u**, `crush`, `sift` | 1 (sift 1+) | | yeast, eggs, biscuits, flour |
| `rinse` **u**, `drain` | 1 | | at the sink |
| `split` **u** | 1 | parts or unit-size | a mass into stream units |
| `mix`, `fold`, `incorporate` **u**, `mix-in-steps` **u** | 1+ (fold, incorporate, mix-in-steps 2+) | | combine; add gradually |
| `beat` **u**, `whip` **u**, `cream` **u** | 1 (cream 2+, needs a tool) | | eggs; cream, egg whites; butter + sugar |
| `knead`, `blend`, `mash`, `toss`, `season` | 1+ (season 2+; blend needs a tool) | | dough; purée; potatoes; salads; salt and pepper |
| `stir` **u**, `muddle` **u**, `fill` **u**, `strain` **u**, `express` **u** | 1 (muddle, express 1+; strain 1–2) | | drinks |
| `heat`, `melt`, `soften`, `boil` | 1 | heat: temperature or duration; boil: duration | hob basics |
| `fry` **u**, `sear` **u**, `saute`, `toast`, `simmer`, `cook`, `steam` | 1+ | duration* | hob (§7) |
| `bake-in-oven`, `roast` | 1 | temperature*, duration* | oven (§7) |
| `bake-in-microwave` | 1 | duration*, power | microwave |
| `raise`, `chill`, `freeze`, `rest`, `cool`, `marinate`, `soak` | 1 (marinate, soak 1+) | duration* (soak optional) | waits (§7) |
| `roll-out`, `level` | 1 | | dough sheet; smooth a surface |
| `shape` **u**, `spherify` **u**, `scoop` **u**, `pipe` **u**, `ball` **u** | 1–2 (shape, spherify, ball 1) | | form units |
| `place-on-sheet` **u**, `place` **u**, `pour` **u**, `transfer` **u**, `plate` **u** | 1+ (place-on-sheet, place, pour 1–2; transfer needs a tool) | | onto carriers, into dishes |
| `grease` **u**, `line` **u**, `cover` **u** | grease 1 + a tool; line 1+; cover 2+ | | tins, sheets, film/lid |
| `brush` **u**, `sprinkle` **u**, `glaze` **u**, `garnish` **u**, `dust` | 2+ | | toppings |
| `spread`, `spoon`, `add-on-top`, `press`, `stack` **u**, `assemble` **u**, `decorate` **u** | 2+ | | layers, sandwiches, cakes |

Not for recipes: `gather`, `batch`, `clean`, `serve`, `wait`, `preheat-oven`, `put-into-oven`, `take-out-of-oven`,
`enjoy`.

## 11. Complete example

24 cookies from one dough, two sheets of 12, baked in one oven round (2 slots), moved to a rack (which returns the
sheets), cooled. Portion → roll → place is a per-unit chain on the `cookie` stream.

```xml
<?xml version="1.0" encoding="utf-8"?>
<recipe version="2" id="chocolate-chip-cookies" ref="https://example.com/chocolate-chip-cookies">
  <title>Chocolate chip cookies</title>
  <serving temperature="ambient"/>
  <ingredients>
    <ingredient id="butter">unsalted butter<properties>
        <property name="storage" value="fridge"/>
        <property name="out-of-storage"><numeric-value number="120" unit="minutes"/></property>
      </properties></ingredient>
    <ingredient id="sugar">light brown sugar</ingredient>
    <ingredient id="egg">egg<properties><property name="storage" value="fridge"/>
        <property name="size" value="large"/></properties></ingredient>
    <ingredient id="flour">all-purpose flour</ingredient>
    <ingredient id="baking-soda">baking soda</ingredient>
    <ingredient id="salt">salt<properties><property name="type" value="fine"/></properties></ingredient>
    <ingredient id="chocolate-chips">dark chocolate chips</ingredient>
  </ingredients>
  <tools>
    <tool id="kitchen-scale">kitchen scale</tool>
    <tool id="large-bowl">large bowl<properties>
        <property name="capacity"><numeric-value number="8" unit="l"/></property></properties></tool>
    <tool id="bowl">bowl<properties>
        <property name="capacity"><numeric-value number="4" unit="l"/></property></properties></tool>
    <tool id="whisk">whisk</tool>
    <tool id="spatula">spatula</tool>
    <tool id="baking-sheet">baking sheet<properties>
        <property name="capacity"><numeric-value number="12" unit="cookie"/></property></properties></tool>
    <tool id="parchment-paper">parchment paper</tool>
    <tool id="cooling-rack">cooling rack<properties>
        <property name="capacity"><numeric-value number="24" unit="cookie"/></property></properties></tool>
  </tools>
  <tasks>
    <task id="measure-butter" operation="measure">
      <options><option name="amount"><numeric-value number="225" unit="g"/></option></options>
      <inputs><input ref="butter"/></inputs>
      <tools><tool ref="kitchen-scale" soil="none"/><tool ref="large-bowl" reserved="true"/></tools>
      <outputs><output id="butter-for-dough">butter</output></outputs>
    </task>
    <task id="measure-sugar" operation="measure">
      <options><option name="amount"><numeric-value number="300" unit="g"/></option></options>
      <inputs><input ref="sugar"/></inputs>
      <tools><tool ref="kitchen-scale" soil="none"/><tool ref="large-bowl" reserved="true"/></tools>
      <outputs><output id="sugar-for-dough">sugar</output></outputs>
    </task>
    <task id="measure-eggs" operation="measure">
      <options><option name="amount"><numeric-value number="2" unit="pieces"/></option></options>
      <inputs><input ref="egg"/></inputs><outputs><output id="eggs-for-dough">eggs</output></outputs>
    </task>
    <task id="measure-flour" operation="measure">
      <options><option name="amount"><numeric-value number="280" unit="g"/></option></options>
      <inputs><input ref="flour"/></inputs>
      <tools><tool ref="kitchen-scale" soil="none"/><tool ref="bowl" reserved="true"/></tools>
      <outputs><output id="flour-for-dough">flour</output></outputs>
    </task>
    <task id="measure-baking-soda" operation="measure">
      <options><option name="amount"><numeric-value number="1" unit="tsp"/></option></options>
      <inputs><input ref="baking-soda"/></inputs><outputs><output id="baking-soda-for-dough">baking soda</output></outputs>
    </task>
    <task id="measure-salt" operation="measure">
      <options><option name="amount"><numeric-value number="0.5" unit="tsp"/></option></options>
      <inputs><input ref="salt"/></inputs><outputs><output id="salt-for-dough">salt</output></outputs>
    </task>
    <task id="measure-chocolate-chips" operation="measure">
      <options><option name="amount"><numeric-value number="340" unit="g"/></option></options>
      <inputs><input ref="chocolate-chips"/></inputs>
      <tools><tool ref="kitchen-scale" soil="none"/></tools>
      <outputs><output id="chips-for-dough">chocolate chips</output></outputs>
    </task>
    <task id="cream-butter-and-sugar" operation="cream">
      <inputs><input ref="butter-for-dough"/><input ref="sugar-for-dough"/></inputs>
      <tools><tool ref="large-bowl" reserved="true" soil="wash"/><tool ref="whisk" soil="wash"/></tools>
      <outputs><output id="creamed-butter">creamed butter and sugar</output></outputs>
      <instructions>Beat the soft <input ref="butter-for-dough"/> with the <input ref="sugar-for-dough"/> until pale
        and fluffy, about 3 minutes.</instructions>
    </task>
    <task id="beat-in-eggs" operation="incorporate">
      <inputs><input ref="creamed-butter"/><input ref="eggs-for-dough"/></inputs>
      <tools><tool ref="large-bowl" reserved="true" soil="wash"/><tool ref="whisk" soil="wash"/></tools>
      <outputs><output id="wet-mix">wet mix</output></outputs>
    </task>
    <task id="mix-dry-ingredients" operation="mix">
      <inputs><input ref="flour-for-dough"/><input ref="baking-soda-for-dough"/><input ref="salt-for-dough"/></inputs>
      <tools><tool ref="bowl" reserved="true"/><tool ref="spatula"/></tools>
      <outputs><output id="dry-mix">dry mix</output></outputs>
    </task>
    <task id="fold-dough" operation="fold">
      <inputs><input ref="wet-mix"/><input ref="dry-mix"/><input ref="chips-for-dough"/></inputs>
      <tools><tool ref="large-bowl" reserved="true" soil="wash"/><tool ref="spatula" soil="wash"/></tools>
      <outputs><output id="cookie-dough">cookie dough</output><tool ref="bowl"/></outputs>
      <instructions>Fold the <input ref="dry-mix"/> into the <input ref="wet-mix"/> until no flour streaks
        remain, then fold in the <input ref="chips-for-dough"/>.</instructions>
    </task>
    <task id="chill-dough" operation="chill">
      <options><option name="duration"><numeric-value number="30" unit="minutes"/></option></options>
      <inputs><input ref="cookie-dough"/></inputs>
      <tools><tool ref="large-bowl" reserved="true"/></tools>
      <outputs><output id="chilled-dough" hold="60" hold-unit="minutes">chilled cookie dough</output></outputs>
    </task>
    <task id="line-sheets" operation="line">
      <inputs><input ref="parchment-paper"/></inputs>
      <tools><tool ref="baking-sheet" reserved="true"/></tools>
      <outputs><output id="lined-sheet">lined baking sheet</output></outputs>
    </task>
    <task id="portion-dough" operation="split">
      <options><option name="parts"><numeric-value number="24"/></option></options>
      <inputs><input ref="chilled-dough"/></inputs><outputs><output id="dough-portion" amount="24" unit="cookie">portion of dough</output><tool ref="large-bowl"/></outputs>
    </task>
    <task id="roll-balls" operation="spherify">
      <inputs><input ref="dough-portion"/></inputs><outputs><output id="dough-ball" amount="24" unit="cookie">dough ball</output></outputs>
    </task>
    <task id="place-on-sheet" operation="place-on-sheet">
      <inputs><input ref="dough-ball"/><input ref="lined-sheet"/></inputs>
      <tools><tool ref="baking-sheet" reserved="true"/></tools>
      <outputs><output id="cookie-on-sheet" amount="24" unit="cookie">cookie on the sheet</output></outputs>
      <instructions>Place the <input ref="dough-ball"/> on the <input ref="lined-sheet"/>, 5 cm apart.</instructions>
    </task>
    <task id="bake-cookies" operation="bake-in-oven">
      <options>
        <option name="temperature"><numeric-value number="180" unit="celsius"/></option>
        <option name="duration"><numeric-value number="11" unit="minutes"/></option>
      </options>
      <inputs><input ref="cookie-on-sheet"/></inputs>
      <tools><tool ref="baking-sheet" reserved="true" soil="none"/></tools>
      <outputs><output id="baked-cookie" amount="24" unit="cookie" hold="10" hold-unit="minutes">baked cookie</output></outputs>
    </task>
    <task id="move-to-rack" operation="transfer">
      <inputs><input ref="baked-cookie"/></inputs>
      <tools><tool ref="cooling-rack" reserved="true" soil="none"/><tool ref="spatula"/></tools>
      <outputs><output id="cookie-on-rack" amount="24" unit="cookie">cookie on the rack</output><tool ref="baking-sheet"/></outputs>
      <instructions>Let the <input ref="baked-cookie"/> firm up on the sheet for 2 minutes, then lift them onto
        the <tool ref="cooling-rack"/> with the <tool ref="spatula"/>.</instructions>
    </task>
    <task id="cool-cookies" operation="cool">
      <options><option name="duration"><numeric-value number="15" unit="minutes"/></option></options>
      <inputs><input ref="cookie-on-rack"/></inputs>
      <tools><tool ref="cooling-rack" reserved="true" soil="none"/></tools>
      <outputs><output id="cookies" amount="24" unit="cookie" final="true">chocolate chip cookies</output></outputs>
    </task>
  </tasks>
</recipe>
```
