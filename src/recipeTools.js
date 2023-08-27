import { operations } from './operations'

export function getOption(options, optionName) {
  return Array.from(options).find((o) => o.getAttribute('name') === optionName)
}

function getNumericValue(option) {
  return option.querySelector('numeric-value')
}

export function getNumericValueFromOption(optionName, options) {
  return Number(getNumericValue(getOption(options, optionName)).getAttribute('number'))
}

export function getUnitFromOption(optionName, options) {
  return getNumericValue(getOption(options, optionName)).getAttribute('unit')
}

export function getNumericValueString(optionName, options) {
  return `${getNumericValueFromOption(optionName, options)} ${getUnitFromOption(optionName, options)}`
}

export function getDurationInSeconds(options) {
  const unit = getUnitFromOption('duration', options)
  const multiplier = unit === 'hours' ? 60 * 60 : unit === 'minutes' ? 60 : 1
  return getNumericValueFromOption('duration', options) * multiplier
}

export function getOptions(node) {
  return node.querySelectorAll('option') // TODO: was "options"
}

export function getOutputs(node) {
  return getChildren(node, 'output')
}

export function getInputs(node) {
  return getChildren(node, 'input')
}

export function getChildren(node, selector) {
  return Array.from(node.querySelectorAll(selector))
}

// TODO: rename ingredient -> input as it is not always an ingredient
export function getInputRefNodes(recipe, node) {
  return getInputs(node).map((input) => {
    const inputId = input.getAttribute('ref')
    return recipe.getElementById(inputId)
  })
}

export function getToolRefNodes(recipe, node) {
  return getTools(recipe, node).map((tool) => {
    const toolId = tool.getAttribute('ref')
    return recipe.getElementById(toolId)
  })
}

export function getAmounts(recipe, node) {
  return getInputs(node)
    .map((input) => recipe.getElementById(input.getAttribute('ref')))
    .filter((i) => i.tagName === 'ingredient')
    .map((ingredient) => {
      const options = getOptions(node)
      const amount = getNumericValueFromOption('amount', options)
      const unit = getUnitFromOption('amount', options)
      return {
        name: ingredient.getAttribute('name'),
        amount: `${amount} ${unit}`,
      }
    })
}

export function getTools(recipe, node) {
  return getChildren(node, 'tool')
}

export function getNodesProducingInputs(recipe, node) {
  const inputs = getInputs(node)
  const inputTasks = inputs.map((input) => recipe.getElementById(input.getAttribute('ref')))
  if (inputTasks.some((t) => t === null)) {
    throw new Error(
      `Input tasks not found for inputs: ${inputs.map((i) => i.getAttribute('ref'))}, found: ${inputTasks
        .filter((t) => t)
        .map((t) => t.getAttribute('id'))}`
    )
  }
  return inputTasks
}

// TODO: rename. Meaning: get inputs that are not ingredients or tools
export function getOutputsForInputs(recipe, node) {
  let excludeToolsAndIngredients = (i) => !['tool', 'ingredient'].includes(i.tagName)
  return getNodesProducingInputs(recipe, node).filter(excludeToolsAndIngredients)
}

export function getNameForInputAtIndex(recipe, node, i) {
  const ingredients = getInputRefNodes(recipe, node)
  return ingredients[i].getAttribute('name')
}

export function getNameForToolAtIndex(recipe, node, i) {
  const tools = getToolRefNodes(recipe, node)
  return tools[i].getAttribute('name')
}

export function getFirstToolName(recipe, node) {
  return getNameForToolAtIndex(recipe, node, 0)
}

export function getFirstInputName(recipe, node) {
  return getNameForInputAtIndex(recipe, node, 0)
}

export function getRefForInputAtIndex(node, i) {
  return getInputs(node)[i].getAttribute('ref')
}

export function getFirstInputRef(node) {
  return getRefForInputAtIndex(node, 0)
}

export function findIngredientWithId(recipe, id) {
  return recipe.querySelector(`ingredient[id="${id}"]`)
}

export function findToolWithId(recipe, id) {
  return recipe.querySelector(`tool[id="${id}"]`)
}

export function findTaskProducing(graph, outputId) {
  const output = graph.querySelector(`output[id="${outputId}"]`)
  if (output === null) {
    const ingredient = findIngredientWithId(graph, outputId)
    const tool = findToolWithId(graph, outputId)
    if (ingredient === null && tool === null) {
      throw new Error(`task producing output with id '${outputId}' not Found.`)
    } else {
      return null
    }
  }
  return output.parentNode.parentNode
}

export function findOutputWithId(id, recipe) {
  return recipe.querySelector(`[id="${id}"]`)
}

export function findOutputWithUuid(uuid, recipe) {
  return recipe.querySelector(`[uuid="${uuid}"]`)
}

export function findFinalOutputId(xml) {
  const inputIds = getInputs(xml).map((i) => i.getAttribute('ref'))
  const outputIds = getOutputs(xml).map((i) => i.getAttribute('id'))
  const finalOutputId = outputIds.find((id) => !inputIds.includes(id))
  if (finalOutputId === null) {
    console.error('End result not found!', {
      inputIds,
      outputIds,
      finalOutputId,
    })
    throw new Error('End result not found!')
  }
  return finalOutputId
}

export function getInstructions(recipe, item) {
  const node = item.task
  const operation = operations[node.getAttribute('operation')]
  return operation.instruction(recipe, node)
}

export function calculateToolList(recipe) {
  return getChildren(recipe, 'tool').map((tool) => ({
    name: tool.getAttribute('name'),
  }))
}
