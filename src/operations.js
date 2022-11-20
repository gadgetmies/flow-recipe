import {
  getAmounts,
  getDuration,
  getFirstInputName,
  getFirstInputRef,
  getIngredients,
  getNameForInputAtIndex,
  getNumericValueFromOption,
  getOptions,
  getOutputs,
  getUnitFromOption,
} from "./recipeTools";

const xmlToElement = (xml) => {
  let template = document.createElement("template");
  xml = xml.trim(); // Never return a text node of whitespace as the result
  template.innerHTML = xml;
  return template.content.firstChild;
};

export const operations = {
  measure: {
    timeline: (node) => [{ active: 60, passive: 0 }],
    title: (node) => "Measure",
    instruction: (recipe, node) => {
      const [{ name, amount }] = getAmounts(recipe, node);
      return <div>Measure {`${amount} ${name}`}</div>;
    },
  },
  heat: {
    instruction: (recipe, node) => {
      const options = getOptions(node);
      return `Heat ${getFirstInputName(
        recipe,
        node
      )} to ${getNumericValueFromOption(
        "temperature",
        options
      )} ${getUnitFromOption("temperature", options)}`;
    },
    timeline: (node) => [
      {
        title: "Heat",
        active: 30,
        passive: Math.max(
          0,
          (getNumericValueFromOption("temperature", getOptions(node)) - 10) * 5
        ),
      },
    ],
    title: (node) => "Heat",
  },
  "preheat-oven": {
    instruction: (recipe, node) => {
      const options = getOptions(node);
      return `Preheat the oven to ${getNumericValueFromOption(
        "temperature",
        options
      )} ${getUnitFromOption("temperature", options)}`;
    },
    timeline: (node) => [
      {
        title: "Preheat the oven",
        active: 30,
        passive:
          (getNumericValueFromOption("temperature", getOptions(node)) - 20) *
          10,
      },
    ],
    title: (node) => "Preheat the oven",
  },
  crumble: {
    instruction: (recipe, node) => {
      // TODO: How to generate names for outputs so they can be referenced in the instructions?
      return `Crumble ${getFirstInputName(recipe, node)}`;
    },
    timeline: (node) => [{ active: 30, passive: 0 }],
    title: (node) => "Crumble",
  },
  mix: {
    instruction: (recipe, node) => {
      const ingredients = getIngredients(recipe, node).map((ingredient) =>
        ingredient.getAttribute("name")
      );

      return (
        <div>
          Mix:
          <ul>
            {ingredients.map((name) => (
              <li>{name}</li>
            ))}
          </ul>
        </div>
      );
    },
    timeline: (node) => [{ active: 60, passive: 0 }],
    title: (node) => "Mix",
  },
  "mix-in-steps": {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0);
      const secondInputName = getNameForInputAtIndex(recipe, node, 1);
      return `Mix ${secondInputName} to ${firstInputName} in steps`;
    },
    timeline: (node) => [
      {
        active: 10, // TODO
        passive: 0,
      },
    ],
    title: (node) => "Mix in steps",
  },
  raise: {
    instruction: (recipe, node) => {
      const options = getOptions(node);
      return `Raise ${getFirstInputName(
        recipe,
        node
      )} for ${getNumericValueFromOption(
        "duration",
        options
      )} ${getUnitFromOption("duration", options)}`;
    },
    timeline: (node) => [
      { active: 60, passive: getDuration(getOptions(node)) },
    ],
    title: (node) => "Raise",
  },
  batch: {
    instruction: () => "Process in batches",
    timeline: (node) => [{ active: 60, passive: 0 }],
    title: (node) => "Process in batches",
  },
  spherify: {
    instruction: (recipe, node) => {
      return `Roll ${getFirstInputName(recipe, node)} into balls`;
    },
    timeline: (node) => [{ active: 240, passive: 0 }],
    title: (node) => "Roll into balls",
  },
  bake: {
    instruction: (recipe, node) => {
      const options = getOptions(node);
      // Perhaps it would be better to have a grouping element in the xml and place the steps inside it
      // although that might be problematic as other items might be able to squeeze between.
      return `Bake ${getNameForInputAtIndex(
        recipe,
        node,
        1
      )} at ${getNumericValueFromOption(
        "temperature",
        options
      )} ${getUnitFromOption("temperature", options)}`;
    },
    expand: (recipe, node) => {
      const options = getOptions(node);
      const temperature = `${getNumericValueFromOption(
        "temperature",
        options
      )}`;
      const unit = `${getUnitFromOption("temperature", options)}`;
      const preheatStepId = `oven-at-${temperature}-${unit[0]}`;
      const inputRef = getFirstInputRef(node);
      const bakedId = `baked-${inputRef}`;
      const outputId = getOutputs(node)[0].getAttribute("id");

      return [
        `<step operation="preheat-oven">
        <options>
          <option name="temperature">
            <numeric-value number="${temperature}" unit="${unit}"/>
          </option>
        </options>
        <outputs>
          <output id="${preheatStepId}"/>
        </outputs>
      </step>`,
        `<step operation="put-into-oven"><!-- TODO rename operation -->
        <inputs>
          <input ref="${preheatStepId}"/>
          <input ref="${inputRef}"/>
        </inputs>
        <outputs>
          <output id="${bakedId}" />
        </outputs>
      </step>`,
        `<step operation="take-out-of-oven">
        <inputs>
          <input ref="${bakedId}"/>
        </inputs>
        <outputs>
          <output id="${outputId}" />
        </outputs>
      </step>`,
      ].map(xmlToElement);
    },
    title: (node) => "Bake",
  },
  "put-into-oven": {
    instruction: (recipe, node) => {
      return `Put ${getNameForInputAtIndex(recipe, node, 0)} into oven`;
    },
    timeline: (node) => [
      {
        title: "Put into oven",
        active: 30,
        passive: 0
      },
    ],
    title: (node) => "Put into oven",
  },
  "take-out-of-oven": {
    instruction: (recipe, node) => {
      return `Take ${getNameForInputAtIndex(recipe, node, 0)} out of oven`;
    },
    timeline: (node) => [
      {
        title: "Take out",
        active: 30,
        passive: 0
      },
    ],
    title: (node) => "Take out of oven",
  },
  brush: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0);
      const secondInputName = getNameForInputAtIndex(recipe, node, 1);
      return `Brush ${firstInputName} with ${secondInputName}`;
    },
    timeline: (node) => [{ active: 60, passive: 0 }],
    title: (node) => "Brush",
  },
  sprinkle: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0);
      const secondInputName = getNameForInputAtIndex(recipe, node, 1);
      return `Sprinkle ${secondInputName} on ${firstInputName}`;
    },
    timeline: (node) => [{ active: 60, passive: 0 }],
    title: (node) => "Sprinkle",
  },
  beat: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0);
      return `Beat ${firstInputName}`;
    },
    timeline: (node) => [{ active: 60, passive: 0 }],
    title: (node) => "Beat",
  },
  "place-on-sheet": {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0);
      return `Place ${firstInputName} on a sheet`;
    },
    timeline: (node) => [{ active: 120, passive: 0 }],
    title: (node) => "Place on sheet",
  },
};
