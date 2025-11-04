import {
  findIngredientWithId,
  getInputs,
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

export function calculateShoppingList(timelines) {
  const ingredientAmounts = {}
  
  timelines.forEach((timeline) => {
    timeline.forEach((item) => {
      if (item.task && item.task.getAttribute('operation') === 'measure') {
        const inputs = getInputs(item.task)
        const options = getOptions(item.task)
        
        inputs.forEach((input) => {
          const ingredientId = input.getAttribute('ref')
          const ingredient = findIngredientWithId(item.task.ownerDocument, ingredientId)
          
          if (ingredient) {
            const name = getElementName(ingredient)
            const unit = getUnitFromOption('amount', options)
            const amount = getNumericValueFromOption('amount', options)
            
            if (name && amount !== null && unit) {
              const key = `${name}-${unit}`
              if (!ingredientAmounts[key]) {
                ingredientAmounts[key] = {
                  name,
                  amount: 0,
                  unit,
                }
              }
              ingredientAmounts[key].amount += amount
            }
          }
        })
      }
    })
  })
  
  return Object.values(ingredientAmounts).reduce((acc, {amount, name, unit}) => {
    if (!acc[name]) {
      acc[name] = {
        amount: 0,
        unit,
      }
    }
    acc[name].amount += amount
    return acc
  }, {})
}