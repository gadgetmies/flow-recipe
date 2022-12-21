import { operations } from "./operations";

function getOption(options, optionName) {
  return options.querySelector(`[name=${optionName}]`).children[0];
}

export function getNumericValueFromOption(optionName, options) {
  return Number(getOption(options, optionName).getAttribute("number"));
}

export function getUnitFromOption(optionName, options) {
  return getOption(options, optionName).getAttribute("unit");
}

export function getDurationInSeconds(options) {
  const unit = getUnitFromOption("duration", options);
  const multiplier = unit === "hours" ? 60 * 60 : unit === "minutes" ? 60 : 1;
  return getNumericValueFromOption("duration", options) * multiplier;
}

export function getOptions(node) {
  return node.querySelector("options");
}

export function getOutputs(node) {
  return getChildren(node, "output");
}

export function getInputs(node) {
  return getChildren(node, "input");
}

export function getChildren(node, selector) {
  return Array.from(node.querySelectorAll(selector));
}

// TODO: rename ingredient -> input as it is not always an ingredient
export function getInputRefNodes(recipe, node) {
  return getInputs(node).map((input) => {
    const inputId = input.getAttribute("ref");
    return recipe.getElementById(inputId);
  });
}

export function getAmounts(recipe, node) {
  return getInputs(node)
    .map((input) => recipe.getElementById(input.getAttribute("ref")))
    .filter((i) => i.tagName === "ingredient")
    .map((ingredient) => {
      const options = getOptions(node);
      const amount = getNumericValueFromOption("amount", options);
      const unit = getUnitFromOption("amount", options);
      return {
        name: ingredient.getAttribute("name"),
        amount: `${amount} ${unit}`,
      };
    });
}

export function getTools(recipe, node) {
  return getInputs(node)
    .map((input) => recipe.getElementById(input.getAttribute("ref")))
    .filter((i) => i.tagName === "tool")
    .map((tool) => {
      return { name: tool.getAttribute("name") };
    });
}

export function getNodesProducingInputs(recipe, node) {
  return getInputs(node)
    .map((input) => recipe.getElementById(input.getAttribute("ref")))
}

// TODO: rename. Meaning: get inputs that are not ingredients or tools
export function getOutputsForInputs(recipe, node) {
  return getNodesProducingInputs(recipe, node)
    .filter((i) => !["tool", "ingredient"].includes(i.tagName))
}

export function getNameForInputAtIndex(recipe, node, i) {
  const ingredients = getInputRefNodes(recipe, node);
  return ingredients[i].getAttribute("name");
}

export function getFirstInputName(recipe, node) {
  return getNameForInputAtIndex(recipe, node, 0);
}

export function getRefForInputAtIndex(node, i) {
  return getInputs(node)[i].getAttribute("ref");
}

export function getFirstInputRef(node) {
  return getRefForInputAtIndex(node, 0);
}

export function findIngredientWithId(recipe, id) {
  return recipe.querySelector(`ingredient[id="${id}"]`);
}

export function findToolWithId(recipe, id) {
  return recipe.querySelector(`tool[id="${id}"]`);
}

export function findTaskProducing(graph, outputId) {
  const output = graph.querySelector(`output[id="${outputId}"]`);
  if (output === null) {
    const ingredient = findIngredientWithId(graph, outputId);
    const tool = findToolWithId(graph, outputId);
    if (ingredient === null && tool === null) {
      throw new Error(`task producing output with id '${outputId}' not Found.`);
    } else {
      return null;
    }
  }
  return output.parentNode.parentNode;
}

export function findOutputWithId(id, recipe) {
  return recipe.querySelector(`[id="${id}"]`);
}

export function findFinalOutputId(xml) {
  const inputIds = getInputs(xml).map((i) => i.getAttribute("ref"));
  const outputIds = getOutputs(xml).map((i) => i.getAttribute("id"));
  const finalOutputId = outputIds.find((id) => !inputIds.includes(id));
  if (finalOutputId === null) {
    console.error("End result not found!", {
      inputIds,
      outputIds,
      finalOutputId,
    });
    throw new Error("End result not found!");
  }
  return finalOutputId;
}

export function getInstructions(recipe, item) {
  const node = findTaskProducing(recipe, item.id);
  const operation = operations[node.getAttribute("operation")];
  return operation.instruction(recipe, node);
}

export function calculateToolList(recipe) {
  return getChildren(recipe, "tool").map((tool) => ({
    name: tool.getAttribute("name"),
  }));
}
