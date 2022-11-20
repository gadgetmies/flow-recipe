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

export function getDuration(options) {
  const multiplier =
    getUnitFromOption("duration", options) === "minutes" ? 60 : 1;
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
export function getIngredients(recipe, node) {
  return getInputs(node).map((input) => {
    const ingredientId = input.getAttribute("ref");
    return recipe.getElementById(ingredientId);
  });
}

export function getAmounts(recipe, node) {
  return getInputs(node).map((input) => {
    const ingredientId = input.getAttribute("ref");
    const ingredient = recipe.getElementById(ingredientId);
    const options = getOptions(node);
    const amount = getNumericValueFromOption("amount", options);
    const unit = getUnitFromOption("amount", options);
    return {
      name: ingredient.getAttribute("name"),
      amount: `${amount} ${unit}`,
    };
  });
}

export function getNameForInputAtIndex(recipe, node, i) {
  const ingredients = getIngredients(recipe, node);
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

export function findStepProducing(graph, outputId) {
  const output = graph.querySelector(`output[id="${outputId}"]`);
  if (output === null) {
    const ingredient = findIngredientWithId(graph, outputId);
    if (ingredient === null) {
      throw new Error(`step producing output with id '${outputId}' not Found`);
    } else {
      return null;
    }
  }
  return output.parentNode.parentNode;
}

export function findFinalOutputId(xml) {
  const inputIds = getInputs(xml).map((i) => i.getAttribute("ref"));
  const outputIds = getOutputs(xml).map((i) => i.getAttribute("id"));
  const results = outputIds.filter((id) => !inputIds.includes(id));
  if (results.length !== 1) {
    throw new Error("End result not found!");
  }
  return results[0];
}

export function getInstructions(recipe, item) {
  console.log({ item });
  if (!item) {
    debugger;
  }
  const node = findStepProducing(recipe, item.id);
  const operation = operations[node.getAttribute("operation")];
  return operation.instruction(recipe, node);
}
