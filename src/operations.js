import {
  getAmounts,
  getDurationInSeconds,
  getFirstInputName,
  getFirstInputRef,
  getFirstToolName,
  getInputRefNodes,
  getNameForInputAtIndex,
  getNameForToolAtIndex,
  getNodesProducingInputs,
  getNumericValueFromOption,
  getNumericValueString,
  getOption,
  getOptions,
  getOutputs,
  getUnitFromOption,
} from './recipeTools'

const xmlToElement = (xml) => {
  let template = document.createElement('template')
  xml = xml.trim() // Never return a text node of whitespace as the result
  template.innerHTML = xml
  return template.content.firstChild
}

export const getTextInstructions = (graph, node) => {
  const instructionNode = node.querySelector('instructions')
  if (!instructionNode) {
    return undefined
  }
  const options = getOptions(node)
  return Array.from(instructionNode.childNodes)
    .filter((node) => !(node instanceof Comment))
    .map((node) => {
      if (node.tagName === 'option') {
        // TODO: a bit silly to get the name from the node and then use that to search the node from the options
        return getNumericValueString(node.getAttribute('name'), options)
      } else if (node instanceof Text) {
        return node.wholeText
      } else {
        if (node.childNodes.length > 0) {
          return node.childNodes[0].wholeText
        } else {
          return graph.getElementById(node.getAttribute('ref')).getAttribute('name')
        }
      }
    })
    .join('')
}
export const operations = {
  measure: {
    timeline: (node) => ({ active: 60, passive: 0 }),
    title: (node) => 'Measure',
    instruction: (recipe, node) => {
      try {
        const [{ name, amount }] = getAmounts(recipe, node)
        const container = getNodesProducingInputs(recipe, node)[1]
        return (
          <div>
            Measure {`${amount} ${name}`}
            {container && ` into ${container.getAttribute('name')}`}
          </div>
        )
      } catch (e) {
        throw new Error(`Unable to parse instructions for node: ${node.innerHTML} (${e.toString()})`)
      }
    },
  },
  heat: {
    instruction: (recipe, node) => {
      const options = getOptions(node)
      const temperatureOption = getOption(options, 'temperature')

      const firstInputName = `${getFirstInputName(recipe, node)}`

      return temperatureOption
        ? `Heat ${firstInputName} to ${getNumericValueString('temperature', options)}`
        : `Heat ${firstInputName} for ${getNumericValueString('duration', options)}`
    },
    timeline: (node) => {
      const options = getOptions(node)
      const temperatureOption = getOption(options, 'temperature')

      const time = temperatureOption
        ? (temperatureOption.getAttribute('number') - 10) * 5
        : getDurationInSeconds(options)
      return {
        title: 'Heat',
        active: 30,
        passive: Math.max(0, time),
      }
    },
    title: (node) => 'Heat',
  },
  'preheat-oven': {
    instruction: (recipe, node) => {
      const options = getOptions(node)
      return `Set the oven to ${getNumericValueString('temperature', options)}`
    },
    timeline: (node) => ({
      title: 'Preheat the oven',
      active: 30,
      passive: (getNumericValueFromOption('temperature', getOptions(node)) - 20) * 8,
    }),
    title: (node) => 'Preheat the oven',
  },
  crumble: {
    instruction: (recipe, node) => {
      // TODO: How to generate names for outputs so they can be referenced in the instructions?
      return `Crumble ${getFirstInputName(recipe, node)}`
    },
    timeline: (node) => ({ active: 30, passive: 0 }),
    title: (node) => 'Crumble',
  },
  mix: {
    instruction: (recipe, node) => {
      const inputs = getInputRefNodes(recipe, node).map((i) => i.getAttribute('name'))

      const last = inputs.splice(-1, 1)

      return <div>Mix {`${inputs.join(', ')}${inputs.length > 0 ? ' & ' : ''}${last}`}</div>
    },
    timeline: (node) => ({ active: 60, passive: 0 }),
    title: (node) => 'Mix',
  },
  incorporate: {
    instruction: (recipe, node) => {
      const inputs = getInputRefNodes(recipe, node).map((i) => i.getAttribute('name'))

      const [first, ...rest] = inputs
      const last = rest.splice(-1, 1)

      return (
        <div>
          Incorporate {`${rest.join(',')}${rest.length > 0 ? ' & ' : ''}${last}`} into {first}
        </div>
      )
    },
    timeline: (node) => ({ active: 60, passive: 0 }),
    title: (node) => 'Mix',
  },
  'mix-in-steps': {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Mix ${secondInputName} to ${firstInputName} in steps`
    },
    timeline: (node) => ({
      active: 10, // TODO
      passive: 0,
    }),
    title: (node) => 'Mix in steps',
  },
  wait: {
    // TODO: reuse wait?
    instruction: (recipe, node) => {
      const options = getOptions(node)
      return `Wait for ${getNumericValueString('duration', options)}`
    },
    timeline: (node) => ({
      active: 60,
      passive: getDurationInSeconds(getOptions(node)),
    }),
    title: (node) => 'Wait',
  },
  raise: {
    // TODO: reuse wait?
    instruction: (recipe, node) => {
      const options = getOptions(node)
      return `Raise ${getFirstInputName(recipe, node)} for ${getNumericValueString('duration', options)}`
    },
    timeline: (node) => ({
      active: 60,
      passive: getDurationInSeconds(getOptions(node)) - 60,
    }),
    title: (node) => 'Raise',
  },
  batch: {
    instruction: () => 'Process in batches',
    timeline: (node) => ({ active: 60, passive: 0 }),
    title: (node) => 'Process in batches',
  },
  fill: {
    instruction: (recipe, node) => {
      return `Fill ${getFirstInputName(recipe, node)}`
    },
    timeline: (node) => ({ active: 240, passive: 0 }),
    title: (node) => 'Fill',
  },
  pour: {
    instruction: (recipe, node) => {
      // TODO: this does not work when pouring to a input rather than a tool (e.g. greased mould)
      return `Pour ${getFirstInputName(recipe, node)} into ${getFirstToolName(recipe, node)}` // TODO: this will make the order of the tools matter i.e. the bowl must come first, then e.g. spatula
    },
    timeline: (node) => ({ active: 180, passive: 0 }),
    title: (node) => 'Pour',
  },
  spherify: {
    instruction: (recipe, node) => {
      return `Roll ${getFirstInputName(recipe, node)} into balls`
    },
    timeline: (node) => ({ active: 240, passive: 0 }),
    title: (node) => 'Roll into balls',
  },
  separate: {
    instruction: (recipe, node) => {
      return `Separate ${getFirstInputName(recipe, node)}` // TODO: add tool / input. Usually probably one input from previous step that needs to be split
    },
    timeline: (node) => ({ active: 120, passive: 0 }),
    title: (node) => 'Separate',
  },
  grease: {
    instruction: (recipe, node) => {
      return `Grease ${getFirstToolName(recipe, node)} with ${getFirstInputName(recipe, node)}`
    },
    timeline: (node) => ({ active: 120, passive: 0 }),
    title: (node) => 'Grease',
  },
  stir: {
    instruction: (recipe, node) => {
      return `Stir ${getFirstInputName(recipe, node)} with ${getFirstToolName(recipe, node)}`
    },
    timeline: (node) => ({ active: 120, passive: 0 }),
    title: (node) => 'Stir',
  },
  soften: {
    instruction: (recipe, node) => {
      return `Soften ${getFirstInputName(recipe, node)} with ${getFirstToolName(recipe, node)}`
    },
    timeline: (node) => ({ active: 120, passive: 0 }),
    title: (node) => 'Soften',
  },
  ball: {
    instruction: (recipe, node) => {
      return `Carve out balls from ${getFirstInputName(recipe, node)} with ${getFirstToolName(recipe, node)}`
    },
    timeline: (node) => ({ active: 180, passive: 0 }),
    title: (node) => 'Ball',
  },
  decorate: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Decorate ${firstInputName} with ${secondInputName}`
    },
    timeline: (node) => ({ active: 180, passive: 0 }),
    title: (node) => 'Decorate',
  },
  cream: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Cream ${firstInputName} and ${secondInputName} with ${getFirstToolName(recipe, node)}`
    },
    timeline: (node) => ({ active: 120, passive: 0 }),
    title: (node) => 'Cream',
  },
  stack: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Stack ${firstInputName} on top of ${secondInputName}`
    },
    timeline: (node) => ({ active: 60, passive: 0 }),
    title: (node) => 'Stack',
  },
  'bake-in-microwave': {
    instruction: (recipe, node) => {
      const options = getOptions(node)
      const powerOption = getOption(options, 'power')

      const firstInputName = `${getFirstInputName(recipe, node)}`

      return powerOption
        ? `Bake ${firstInputName} with ${getNumericValueString(
            'power',
            options
          )} in the microwave oven for ${getNumericValueString('duration', options)}`
        : `Bake ${firstInputName} for ${getNumericValueString('duration', options)} in the microwave oven`
    },
    timeline: (node) => {
      const options = getOptions(node)
      const temperatureOption = getOption(options, 'temperature')

      const time = temperatureOption
        ? (temperatureOption.getAttribute('number') - 10) * 5
        : getDurationInSeconds(options)
      return {
        title: 'Bake',
        active: 30,
        passive: Math.max(0, time),
      }
    },
    title: (node) => 'Bake',
  },
  split: {
    timeline: (node) => {
      const options = getOptions(node)
      const parts = `${getNumericValueFromOption('parts', options)}`
      return {
        title: 'Split',
        active: parts.length * 30,
        passive: 0,
      }
    },
    instruction: (recipe, node) => {
      const options = getOptions(node)
      const parts = `${getNumericValueFromOption('parts', options)}`
      return `Split ${getFirstInputName(recipe, node)} into ${parts} parts`
    },
    expand: (recipe, node) => {
      const options = getOptions(node)
      const parts = getNumericValueFromOption('parts', options)
      const output = getOutputs(node)[0]
      return [
        `<task operation="split">
${node.querySelector('options').outerHTML}
<inputs>
    ${Array.from(node.querySelectorAll('input'))
      .map((input) => input.outerHTML)
      .join('\n')}
</inputs>
<outputs>
  <output id="${output.getAttribute('id')}" amount="${parts}" name="${output.getAttribute('name')}"/>
</outputs>
</task>`,
      ].map(xmlToElement)
    },
    title: (node) => 'Split',
  },
  'bake-in-oven': {
    instruction: (recipe, node) => {
      const options = getOptions(node)
      // Perhaps it would be better to have a grouping element in the xml and place the steps inside it
      // although that might be problematic as other items might be able to squeeze between.
      return `Bake ${getNameForInputAtIndex(recipe, node, 1)} at ${getNumericValueString('temperature', options)}`
    },
    expand: (recipe, node) => {
      const options = getOptions(node)
      const temperature = `${getNumericValueFromOption('temperature', options)}`
      const duration = getNumericValueFromOption('duration', options)
      const durationUnit = getUnitFromOption('duration', options)
      const temperatureUnit = `${getUnitFromOption('temperature', options)}`
      const preheatTaskId = `oven-at-${temperature}-${temperatureUnit[0]}`
      const inputRef = getFirstInputRef(node)
      const inputName = getFirstInputName(recipe, node)
      const bakedId = `baked-${inputRef}`
      const output = getOutputs(node)[0]
      const outputId = output.getAttribute('id')
      const outputName = output.getAttribute('name') || `Baked ${inputName}`

      return [
        `<task operation="preheat-oven">
        <options>
          <option name="temperature">
            <numeric-value number="${temperature}" unit="${temperatureUnit}"/>
          </option>
        </options>
        <outputs>
          <output id="${preheatTaskId}"/>
        </outputs>
      </task>`,
        `<task operation="put-into-oven"><!-- TODO rename operation -->
        <options>
          <option name="duration">
            <numeric-value number="${duration}" unit="${durationUnit}"/>
          </option>
        </options>
        <inputs>
          <input ref="${inputRef}"/>
          <input ref="${preheatTaskId}"/>
        </inputs>
        <outputs>
          <output id="${bakedId}" name="baking ${inputName}" />
        </outputs>
      </task>`,
        `<task operation="take-out-of-oven">
        <inputs>
          <input ref="${bakedId}"/>
        </inputs>
        <outputs>
          <output id="${outputId}" name="${outputName}"/>
        </outputs>
      </task>`,
      ].map(xmlToElement)
    },
    title: (node) => 'Bake',
  },
  'put-into-oven': {
    instruction: (recipe, node) => {
      return `Put ${getNameForInputAtIndex(recipe, node, 0)} into oven`
    },
    timeline: (node) => ({
      title: 'Put into oven',
      active: 30,
      passive: getDurationInSeconds(getOptions(node)),
    }),
    title: (node) => 'Put into oven',
  },
  'take-out-of-oven': {
    instruction: (recipe, node) => {
      return `Take ${getNameForInputAtIndex(recipe, node, 0)} out of oven`
    },
    timeline: (node) => ({
      title: 'Take out',
      active: 30,
      passive: 0,
    }),
    title: (node) => 'Take out of oven',
  },
  brush: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Brush ${firstInputName} with ${secondInputName}`
    },
    timeline: (node) => ({ active: 60, passive: 0 }),
    title: (node) => 'Brush',
  },
  sprinkle: {
    instruction: (recipe, node) => {
      const text = getTextInstructions(recipe, node)
      if (text !== undefined) {
        return text
      }
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Sprinkle ${secondInputName} on ${firstInputName}`
    },
    timeline: (node) => ({ active: 60, passive: 0 }),
    title: (node) => 'Sprinkle',
  },
  grate: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      return `Grate ${firstInputName}`
    },
    timeline: (node) => ({ active: 120, passive: 0 }), // TODO: calculate time based on weight (and type of input)
    title: (node) => 'Grate',
  },
  spread: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Spread ${firstInputName} onto ${secondInputName}`
    },
    timeline: (node) => ({ active: 360, passive: 0 }), // Probably best to define this in the task
    title: (node) => 'Spread',
  },
  transfer: {
    instruction: (recipe, node) => {
      const inputName = getNameForInputAtIndex(recipe, node, 0)
      const toolName = getNameForToolAtIndex(recipe, node, 1)
      return `Transfer ${inputName} onto ${toolName}`
    },
    timeline: (node) => ({ active: 120, passive: 0 }), // Probably best to define this in the task
    title: (node) => 'Transfer',
  },
  beat: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      return `Beat ${firstInputName}`
    },
    timeline: (node) => ({ active: 60, passive: 0 }),
    title: (node) => 'Beat',
  },
  'place-on-sheet': {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      return `Place ${firstInputName} on a sheet`
    },
    timeline: (node) => ({ active: 120, passive: 0 }),
    title: (node) => 'Place on sheet',
  },
  chill: {
    instruction: (recipe, node) => {
      const options = getOptions(node)
      const unit = getUnitFromOption('duration', options)
      const duration =
        getDurationInSeconds(getOptions(node)) / (unit === 'hours' ? 60 * 60 : unit === 'minutes' ? 60 : 1)

      return `Chill ${getFirstInputName(recipe, node)} for ${duration} ${unit}`
    },
    timeline: (node) => ({
      active: 30,
      passive: getDurationInSeconds(getOptions(node)),
    }),
    title: (node) => 'Chill',
    timer: (recipe, node) => ({
      title: `Chill ${getFirstInputName(recipe, node)}`,
      duration: getDurationInSeconds(getOptions(node)),
    }),
  },
  spoon: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1) // TODO: there can be multiple inputs!
      return `Spoon ${secondInputName} on ${firstInputName}`
    },
    timeline: (node) => ({ active: 60, passive: 0 }),
    title: (node) => 'Spoon',
  },
  cover: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Cover ${secondInputName} with ${firstInputName}`
    },
    timeline: (node) => ({ active: 60, passive: 0 }),
    title: (node) => 'Cover',
  },
  level: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      return `Level ${firstInputName}`
    },
    timeline: (node) => ({ active: 120, passive: 0 }),
    title: (node) => 'Level',
  },
  'add-on-top': {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Add ${secondInputName} on top of ${firstInputName}`
    },
    timeline: (node) => ({ active: 120, passive: 0 }),
    title: (node) => 'Add on top',
  },
  press: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Press ${secondInputName} into ${firstInputName}`
    },
    timeline: (node) => ({ active: 120, passive: 0 }),
    title: (node) => 'Press',
  },
  line: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Line ${firstInputName} with ${secondInputName}`
    },
    timeline: (node) => ({ active: 120, passive: 0 }),
    title: (node) => 'Line',
  },
  melt: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      return `Melt ${firstInputName}`
    },
    timeline: (node) => ({ active: 30, passive: 60 }),
    title: (node) => 'Melt',
  },
  fold: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Fold ${secondInputName} into ${firstInputName}`
    },
    timeline: (node) => ({ active: 120, passive: 0 }),
    title: (node) => 'Fold',
  },
  boil: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      return `Boil ${firstInputName}`
    },
    timeline: (node) => ({ active: 30, passive: 200 }),
    title: (node) => 'Boil',
  },
  soak: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      const secondInputName = getNameForInputAtIndex(recipe, node, 1)
      return `Soak ${firstInputName} with ${secondInputName}`
    },
    timeline: (node) => ({ active: 60, passive: 120 }),
    title: (node) => 'Soak',
  },
  whip: {
    instruction: (recipe, node) => {
      const firstInputName = getNameForInputAtIndex(recipe, node, 0)
      return `Whip ${firstInputName}`
    },
    timeline: (node) => ({ active: 300, passive: 0 }),
    title: (node) => 'Whip',
  },
}
