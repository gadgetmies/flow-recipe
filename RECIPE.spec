# Recipe XML Generation Specification

This specification guides an agent to convert a web-based recipe into a structured XML recipe file following the schema defined in `recipe.xsd`.

## Schema Reference

The XML structure must conform to the XSD schema located at:
`packages/server/src/recipes/recipe.xsd`

All generated XML must validate against this schema. Refer to the schema for the authoritative definition of allowed elements, attributes, and their constraints.

## Overview

The goal is to create a file containing an XML recipe definition that follows the schema in recipe.xsd:
```xml
<?xml version="1.0" encoding="utf-8" ?>
<recipe xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="recipe.xsd" ref="SOURCE_URL">
    <title>Recipe Title</title>
    <ingredients>...</ingredients>
    <tools>...</tools>
    <tasks>...</tasks>
</recipe>
```

## Step-by-Step Process

### Step 1: Scrape and Parse the Web Page

1. **Obtain the recipe URL** from the user or input
2. **Fetch the web page content** using appropriate web scraping techniques
3. **Parse the HTML** to extract structured recipe data:
   - Recipe title
   - Ingredients list with quantities and units
   - Cooking steps/instructions
   - Any mentioned tools or equipment
   - Cooking times and temperatures
   - Servings information (if available)

4. **Extract metadata**:
   - Source URL (for the `ref` attribute in the `<recipe>` element)
   - Recipe title

**Output**: Structured data containing title, ingredients, steps, tools, and metadata.

---

### Step 2: Extract Ingredients and Build Ingredients List

1. **Parse each ingredient** from the scraped recipe:
   - Extract ingredient name
   - Extract quantity and unit (if specified)
   - Identify any properties (e.g., "fine salt", "ground coriander", "medium egg")

2. **Create unique ingredient IDs**:
   - Use kebab-case format (e.g., "white-chocolate-spread", "baking-powder")
   - Ensure IDs are unique within the recipe
   - Match IDs to ingredient names consistently

3. **Build the ingredients XML section** (must conform to XSD schema):
   ```xml
   <ingredients>
       <ingredient id="ingredient-id" name="Ingredient Name">
           <properties>
               <!-- Option 1: Text property using value attribute -->
               <property name="property-name" value="property-value"/>
               <!-- Option 2: Text property using text-content element -->
               <property name="property-name">
                   <text-content>property-value</text-content>
               </property>
               <!-- Option 3: Numeric property -->
               <property name="property-name">
                   <numeric-value number="NUMBER" unit="UNIT">optional text content</numeric-value>
               </property>
           </properties>
       </ingredient>
   </ingredients>
   ```

4. **Handle ingredient properties** (per XSD schema):
   - Text properties: Use `value="property-value"` attribute OR `<text-content>property-value</text-content>` element (e.g., `type="fine"`, `size="medium"`)
   - Numeric properties: Use `<numeric-value>` element with `number` (decimal) and optional `unit` attributes
   - The `<numeric-value>` element can contain optional text content (per XSD simpleContent extension)

5. **Create a mapping** of ingredient names to IDs for later reference in tasks

**Output**: Complete `<ingredients>` XML section with all ingredients from the recipe.

---

### Step 3: Extract Tools and Generate Tools List

1. **Identify all tools mentioned** in the recipe:
   - Scan ingredient lists, instructions, and step descriptions
   - Common tools: bowls, spoons, spatulas, whisks, scales, ovens, pans, molds, etc.
   - Look for implicit tools (e.g., "mix in a bowl" implies a bowl tool)

2. **Create unique tool IDs**:
   - Use kebab-case format (e.g., "silicone-cake-mould", "kitchen-scale")
   - Ensure IDs are unique within the recipe

3. **Build the tools XML section** (must conform to XSD schema):
   ```xml
   <tools>
       <tool id="tool-id" name="Tool Name">
           <properties>
               <!-- Properties follow same structure as ingredient properties -->
               <property name="property-name" value="property-value"/>
               <!-- OR -->
               <property name="property-name">
                   <numeric-value number="NUMBER" unit="UNIT">optional text</numeric-value>
               </property>
           </properties>
       </tool>
   </tools>
   ```

4. **Handle tool properties** (per XSD schema):
   - Text properties: Use `value` attribute OR `<text-content>` element
   - Numeric properties: Use `<numeric-value>` element with `number` (decimal) and optional `unit` attributes
   - Size/dimension properties (e.g., circumference, capacity)
   - Type properties (e.g., "microwave-safe")

5. **Create a mapping** of tool names to IDs for later reference in tasks

**Output**: Complete `<tools>` XML section with all tools mentioned or implied in the recipe.

---

### Step 4: Extract Steps and Create Tasks

#### Step 4.1: Extract Steps and Split into Tasks

1. **Parse each step** from the recipe instructions:
   - Each numbered step in the recipe may contain multiple operations
   - Identify compound steps (e.g., "Mix ingredients and then heat" = two tasks)

2. **Split compound steps** into individual tasks:
   - A single step may require multiple operations
   - Each operation should become a separate `<task>` element
   - Maintain the logical sequence and dependencies

3. **Identify implicit steps**:
   - Measurement steps (if quantities are specified in ingredients)
   - Preparation steps (e.g., "preheat oven", "grease pan")
   - Transfer steps (e.g., "pour into mold")

**Output**: List of individual operations/tasks to be converted to XML.

---

#### Step 4.2: Recognize Operations

1. **Review available operations** in `operations.js`:
   - Available operations include: measure, heat, preheat-oven, crumble, mix, incorporate, mix-in-steps, wait, raise, batch, fill, pour, spherify, separate, grease, stir, soften, ball, decorate, cream, stack, bake-in-microwave, bake-in-oven, split, put-into-oven, take-out-of-oven, brush, sprinkle, grate, spread, transfer, beat, place-on-sheet, chill, spoon, cover, level, add-on-top, press, line, melt, fold, boil, soak, whip

2. **Match each step to an operation**:
   - Analyze the verb/action in the step (e.g., "mix", "bake", "heat", "pour")
   - Consider the context (e.g., "bake in oven" vs "bake in microwave")
   - Use semantic matching, not just keyword matching

3. **Handle unknown operations**:
   - If no matching operation exists, create a new operation in `operations.js`
   - The new operation must include:
     - `instruction`: Function that generates instruction text
     - `timeline`: Function that returns `{ active: NUMBER, passive: NUMBER }`
     - `title`: Function that returns the operation title
   - Follow the pattern of existing operations

4. **Document the operation** with its required options and parameters

**Output**: For each task, identified operation name and required options.

---

#### Step 4.3: Create Task XML

For each identified task, create a `<task>` element conforming to the XSD schema. The task structure is flexible (mixed content with choice elements). Use container elements for organization:

```xml
<task operation="OPERATION_NAME">
    <options>
        <option name="option-name">
            <!-- Option 1: Numeric value -->
            <numeric-value number="NUMBER" unit="UNIT">optional text</numeric-value>
            <!-- Option 2: Text content -->
            <text-content>text value</text-content>
        </option>
    </options>
    <tools>
        <tool ref="tool-id" reserved="true|false" name="optional-name" reusable="true|false"/>
    </tools>
    <inputs>
        <input ref="input-id">optional text content</input>
    </inputs>
    <outputs>
        <!-- Outputs can be either output elements or tool elements -->
        <output id="output-id">Output Name (text content)</output>
        <!-- OR tool can be in outputs -->
        <tool ref="tool-id" name="optional-name" reusable="true|false"/>
    </outputs>
    <instructions>
        <!-- Optional: Custom instruction text with embedded refs -->
        Text content with <input ref="..."/>, <tool ref="..."/>, <output id="..."/>, and <option name="..."> elements
    </instructions>
</task>
```

#### Step 4.4: Unit conversions

Review the recipe recognising all non-metric units converting the amounts and the unit to metric. 
If there are amounts for ingredients that are not liquids, but are measured by volume, convert those to grams using a best estimate for the conversion ratio. Add a comment next to all the amounts that have been converted from volume to weight.

**Note**: Per XSD schema, tasks can also have individual `<input>`, `<tool>`, or `<output>` elements at the task level (not in containers), but using containers (`<inputs>`, `<tools>`, `<outputs>`) is recommended for clarity.

**Required components**:

1. **Operation attribute**: Set `operation="OPERATION_NAME"` matching the identified operation

2. **Options** (if required by the operation, per XSD schema):
   - `amount`: For measure operations (number + unit)
   - `temperature`: For heat/bake operations (number + unit, typically "celsius" or "fahrenheit")
   - `duration`: For time-based operations (number + unit: "seconds", "minutes", "hours")
   - `power`: For microwave operations (number + unit, typically "watts" or "percent")
   - `parts`: For split operations (number only)
   - Extract these from the recipe step text
   - Use `<numeric-value>` element with `number` (decimal) and optional `unit` attributes
   - Optionally use `<text-content>` for text-based options
   - The `<numeric-value>` element can contain optional text content

3. **Tools** (per XSD schema):
   - Reference tools by ID using `<tool ref="tool-id"/>` within `<tools>` container
   - Add `reserved="true"` (boolean) if the tool is used for the entire duration (e.g., bowl during mixing)
   - Add `reusable="true"` (boolean) if the tool can be reused after this task
   - Add optional `name` attribute for tool identification
   - Add `amount` attribute (decimal, defaults to 1) for tools that scale with output:
     - **Use `amount="1"`** (or omit, as it's default) for tools consumed per output: serving glasses, plates, cake molds, baking pans, individual containers
     - **Omit `amount` and use `reusable="true"`** for reusable tools: mixing bowls, measuring tools, utensils, equipment
     - Tools in `<outputs>` section typically have `amount="1"` (per output)
     - Tools in `<tools>` section with `reusable="true"` don't need/use `amount` for scaling
   - Include all tools mentioned or implied in the step
   - Tools can also appear in `<outputs>` section (see outputs below)
   - **Important**: If a tool is referenced in the `<instructions>` element (using `<tool ref="..."/>`), do NOT also list it in the `<tools>` container

4. **Inputs** (per XSD schema):
   - Reference ingredients or outputs from previous tasks using `<input ref="id"/>` within `<inputs>` container
   - Use ingredient IDs for initial ingredients
   - Use output IDs for intermediate products from previous tasks
   - Order matters: first input is typically the primary ingredient
   - Input elements can contain optional text content (mixed content)
   - **Important**: If an input is referenced in the `<instructions>` element (using `<input ref="..."/>`), do NOT also list it in the `<inputs>` container

5. **Outputs** (per XSD schema):
   - Create unique output IDs (e.g., "measured-flour", "mixed-batter", "baked-cake")
   - Output elements contain text content (the output name/description) and have required `id` attribute
   - Use kebab-case for IDs
   - Each task should produce at least one output
   - The `<outputs>` container can contain both `<output>` elements AND `<tool>` elements
   - Tools in outputs can have `ref`, `name`, and `reusable` attributes (for tools that are produced/modified by the task)

6. **Instructions** (optional, per XSD schema):
   - Can include custom instruction text (mixed content) with embedded references:
     - `<input ref="..."/>` - reference to an input
     - `<tool ref="..."/>` - reference to a tool
     - `<output id="..."/>` - reference to an output
     - `<option name="...">` - reference to an option (can contain `<numeric-value>` or `<text-content>`)
   - If omitted, the operation's default instruction function will be used
   - **Important**: If an input or tool is referenced in the `<instructions>` element, it should NOT be listed separately in the `<inputs>` or `<tools>` containers to avoid duplication

**Special cases**:

- **Measure operations**: Always require an `amount` option. Output should be a measured quantity with a unique ID.
- **Bake operations**: May need to be expanded into multiple tasks (preheat, put-into-oven, take-out-of-oven) if using `bake-in-oven` operation
- **Split operations**: Require a `parts` option and may need special handling

**Output**: Complete `<task>` XML elements for all identified tasks.

---

#### Step 4.4: Ensure Correct Output References

1. **Build a dependency graph**:
   - For each task, list its inputs (from ingredients or previous outputs)
   - Track which task produces each output ID
   - Verify that all inputs are either:
     - Ingredient IDs (from the ingredients section)
     - Tool IDs (from the tools section)
     - Output IDs from previous tasks

2. **Validate references**:
   - Check that every `<input ref="...">` references a valid:
     - Ingredient ID (in `<ingredients>`)
     - Tool ID (in `<tools>`)
     - Output ID from a previous task
   - Ensure no circular dependencies
   - Ensure all outputs are eventually used (except final outputs)

3. **Fix missing references**:
   - If an input references something that doesn't exist, create it:
     - Add missing ingredients to the ingredients section
     - Add missing tools to the tools section
     - Add intermediate measure/prep tasks if needed

4. **Order tasks correctly**:
   - Tasks should be ordered so that inputs are available before use
   - Measurement tasks typically come first
   - Final assembly/consumption tasks come last

5. **Create intermediate outputs**:
   - If a step mentions something that wasn't explicitly created, create an intermediate task
   - Example: "mix flour and sugar" → ensure both are measured first if not already

6. **Handle task dependencies**:
   - Some operations (like `bake-in-oven`) expand into multiple tasks
   - Ensure the expanded tasks are properly sequenced
   - Ensure outputs from expanded tasks are correctly referenced

**Output**: Validated and corrected task XML with all references resolved.

---

## Validation Checklist

Before finalizing the recipe XML, verify:

- [ ] Recipe has a valid `<title>` element (required per XSD)
- [ ] Recipe has a `ref` attribute with the source URL (optional per XSD, but recommended)
- [ ] All ingredients from the recipe are in the `<ingredients>` section
- [ ] All tools mentioned are in the `<tools>` section
- [ ] Each task has a valid `operation` attribute matching an operation in `operations.js`
- [ ] All required options for each operation are provided
- [ ] All `<input ref="...">` references exist (ingredient, tool, or previous output)
- [ ] All `<tool ref="...">` references exist in the tools section
- [ ] If an input or tool is referenced in `<instructions>`, it is NOT also listed in `<inputs>` or `<tools>` containers
- [ ] All outputs have unique IDs
- [ ] Tasks are ordered such that inputs are available before use
- [ ] Final outputs are not referenced as inputs (they are the end result)
- [ ] The XML is well-formed and validates against `recipe.xsd` schema
- [ ] All numeric values use decimal format (per XSD: `number` attribute is `xs:decimal`)
- [ ] All required attributes are present (per XSD: `id`, `name`, `ref`, `operation`)
- [ ] All boolean attributes (`reserved`, `reusable`) use proper boolean values if present

---

## Example Transformation

**Original Recipe Step**: "Mix 200g flour, 100g sugar, and 2 eggs in a large bowl until smooth."

**Extracted Tasks**:

1. Measure flour (200g) → output: "measured-flour"
2. Measure sugar (100g) → output: "measured-sugar"
3. Measure eggs (2 pieces) → output: "measured-eggs"
4. Mix measured-flour, measured-sugar, and measured-eggs → output: "mixed-batter"

**XML Representation**:
```xml
<task operation="measure">
    <options>
        <option name="amount">
            <numeric-value number="200" unit="g"/>
        </option>
    </options>
    <tools>
        <tool ref="kitchen-scale"/>
    </tools>
    <inputs>
        <input ref="flour"/>
    </inputs>
    <outputs>
        <output id="measured-flour">flour</output>
    </outputs>
</task>
<!-- Similar for sugar and eggs -->
<task operation="mix">
    <tools>
        <tool ref="bowl" reserved="true"/>
    </tools>
    <inputs>
        <input ref="measured-flour"/>
        <input ref="measured-sugar"/>
        <input ref="measured-eggs"/>
    </inputs>
    <outputs>
        <output id="mixed-batter">batter</output>
    </outputs>
</task>
```

---

## Notes

- **Schema validation**: Always validate generated XML against `packages/server/src/recipes/recipe.xsd` before finalizing
- **Naming conventions**: Use kebab-case for all IDs (ingredients, tools, outputs)
- **Units**: Use standard units (g, kg, ml, l, celsius, fahrenheit, minutes, hours, seconds)
- **Numeric values**: The `number` attribute must be a valid decimal (per XSD: `xs:decimal`)
- **Output format**: Output elements contain text content (the name), not a `name` attribute (per XSD simpleContent extension)
- **Tool reservations**: Mark tools as `reserved="true"` (boolean) when they hold ingredients for an extended period
- **Tool reuse**: Mark tools as `reusable="true"` (boolean) if they can be reused after the task
- **Output naming**: Output text content should be descriptive and help identify the intermediate product
- **Missing operations**: When adding new operations, ensure they follow the existing pattern in `operations.js`
- **Complex operations**: Some operations (like `bake-in-oven`) have `expand` functions that create multiple tasks automatically
- **Mixed content**: Many elements support mixed content (text + child elements) per XSD schema
- **Property formats**: Properties can use either `value` attribute OR `<text-content>` element for text values


