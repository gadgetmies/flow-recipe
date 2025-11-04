import {
  findIngredientWithId,
  getChildren,
  getNumericValueFromOption,
  getOptions,
  getUnitFromOption
} from "./recipeTools";

function getElementName(element) {
  if (!element) return null
  
  const textContent = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join('')
    .trim()
  
  return textContent || null
}

export function calculateShoppingList(recipe) {
  return getChildren(recipe, "task[operation='measure'] inputs input")
    .map((input) => {
      const ingredient = findIngredientWithId(
        recipe,
        input.getAttribute("ref")
      );
      const options = getOptions(input.parentNode.parentNode);
      if (ingredient) {
        const name = getElementName(ingredient);
        const unit = getUnitFromOption("amount", options);
        const amount = getNumericValueFromOption("amount", options);
        return {
          name,
          amount,
          unit,
        };
      } else {
        return null;
      }
    })
    .filter((i) => i)
    .reduce((acc, {amount, name, unit}) => {
      // TODO: calculate multiplier for unit
      return {
        ...acc,
        [name]: {
          amount: amount + (acc[name]?.amount ?? 0),
          unit,
        },
      };
    }, {});
}