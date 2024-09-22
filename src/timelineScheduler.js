import { operations } from './operations'
import { findTaskProducing, getInputs, getNodesProducingInputs, getOutputsForInputs } from './recipeTools'
import * as R from 'ramda'

const log = (...args) => {
  return
  console.log(...args)
}

function cloneToFreezeForDebug(value) {
  return JSON.parse(JSON.stringify(value))
}

function value(valueOrFunction, ...args) {
  return typeof valueOrFunction === 'function' ? valueOrFunction(...args) : valueOrFunction
}

function getOperationForNode(node) {
  const operationId = node.getAttribute('operation')
  const operation = operations[operationId]
  if (operation === undefined) {
    throw new Error(`Operation for id '${operationId}' not found!`)
  }
  return operation
}

export function expandNode(graph, node) {
  const operation = getOperationForNode(node)
  let expanded = node
  if (operation.expand && node.getAttribute('expanded') !== 'true') {
    log('Expanding node', node)
    const tasks = operation.expand(graph, node)
    node.remove()
    const tasksElement = graph.getElementsByTagName('tasks')[0]
    log('expanded', ...tasks)
    tasks.forEach((task) => tasksElement.append(task))
    const [last] = tasks.splice(-1, 1)
    last.setAttribute('expanded', 'true')
    tasks.forEach((node) => expandNode(graph, node))
    expanded = last
  }

  return expanded
}

function calculateDependencies(graph, task, timelines, previousDependencies) {
  // Does this need to be called for each output? Should it not be called just for the task?
  // The amount in the current task does not affect the scheduling at this point (i.e. the output being processed when this function is called)

  const inputs = getInputs(task)
  const dependenciesToSchedule = []
  for (const input of inputs) {
    // input = inputs of a task i.e. requesting
    let amountToSchedule = {}
    let itemsWithAmountLeft = undefined // This only counts the inputs, not the scheduled output.
    // Does that however mean that there are always the correct amount of outputs requested and thus counting there is not necessary?
    const inputId = input.getAttribute('ref')
    let amountNeeded = input.getAttribute('amount') || 1
    const producerOutput = graph.getElementById(inputId) // output = output of dependency = producer
    if (!producerOutput) {
      throw new Error(`Error in recipe: Producer for input with id ${inputId} not found`)
    }
    if (producerOutput.tagName !== 'output') {
      continue
    }
    // This will be a problem if the task produces multiple different outputs.
    const producerTask = producerOutput.parentNode.parentNode
    const outputTaskUuid = producerTask.getAttribute('uuid')
    const amountOutputProduces = Number(producerOutput.getAttribute('amount') || 1)
    const previousItems = []
    const uuidMatch = ({ uuid }) => uuid.split('-')[0] === outputTaskUuid
    for (const timeline of timelines) {
      const items = timeline.filter(uuidMatch)
      previousItems.push(...items)
    }

    previousItems.push(...[...dependenciesToSchedule, ...previousDependencies].filter(uuidMatch))
    itemsWithAmountLeft = previousItems.filter(({ amountLeft }) => amountLeft > 0)

    if (itemsWithAmountLeft.length > 0) {
      for (let i = 0; i < itemsWithAmountLeft.length && amountNeeded > 0; ++i) {
        log('Reducing amount from previously scheduled timeline item')
        const itemWithAMountLeft = itemsWithAmountLeft[i]
        const amountToUse = Math.min(itemWithAMountLeft.amountLeft, amountNeeded)
        itemWithAMountLeft.amountLeft -= amountToUse
        amountNeeded -= amountToUse
        dependenciesToSchedule.push({
          scheduled: true,
          ...itemWithAMountLeft,
          amountLeft: 0,
        })
      }
    }

    amountToSchedule = Math.max(0, Math.ceil(amountNeeded / amountOutputProduces))

    const lastScheduledIndex = previousItems
      .map(({ uuid }) => Number(uuid.split('-')[1]))
      .reduce((acc, cur) => (cur > acc ? cur : acc), 0)

    for (let i = 0; i < amountToSchedule; ++i) {
      amountNeeded -= amountOutputProduces
      dependenciesToSchedule.push({
        uuid: `${outputTaskUuid}-${i + (previousItems.length > 0 ? lastScheduledIndex + 1 : 0)}`,
        task: producerTask,
        input: {
          id: inputId,
          name: producerOutput.getAttribute('name'),
        },
        amountLeft: Math.max(-amountNeeded, 0),
      })
    }
  }

  return dependenciesToSchedule
}

export function scheduleItemsInTimelines(graph, tasksToSchedule, timelines, round = 0) {
  if (tasksToSchedule.length === 0) {
    return
  }

  log(
    {
      timelines: cloneToFreezeForDebug(timelines),
      graph,
    },
    ...tasksToSchedule
  )

  let dependenciesToSchedule = []
  for (const { uuid, task, amountLeft } of tasksToSchedule) {
    log('Processing', task)
    const operation = getOperationForNode(task)
    const operationTimelineItem = operation.timeline(task)
    const title = operation.title(task)

    log('Calculating timeline')

    // TODO: Sort operations by longest passive time?
    const dependenciesForTask = calculateDependencies(graph, task, timelines, dependenciesToSchedule)
    dependenciesToSchedule.push(...dependenciesForTask.filter(({ scheduled }) => !scheduled))

    //    for (const output of outputs) { Why was this done for each output?
    //      const outputId = output.getAttribute('id')
    //      log({ output, operation })
    const passiveDuration = value(operationTimelineItem.passive, task) //, output) Why was output passed here?
    const activeDuration = value(operationTimelineItem.active, task) //, output)
    const duration = passiveDuration + activeDuration

    // There are only one split operation in the timeline, but the inputs of the different pour operations refer to different ids

    const timelineItem = {
      task,
      uuid,
      dependencies: dependenciesForTask, // This needs to have a reference to the outputs needed
      // Perhaps the nodes could be used here and later updated to refer to the indexes?
      // Oh, or perhaps all the nodes in the graph could be indexed at the beginning of processing in order to use that for referencing?
    }

    log('Processing', timelineItem, operationTimelineItem)

    const possibleSpots = []

    const mustFinishBy = timelines.reduce((earliestTime, timeline) => {
      const earliestStart = timeline.reduce((t, item) => {
        return item.dependencies.some(({ uuid: iuuid }) => iuuid === uuid) ? Math.min(item.start, t) : t
      }, 0)
      return Math.min(earliestStart, earliestTime)
    }, 0)

    for (const timeline of timelines) {
      const timelineNumber = timelines.indexOf(timeline)
      for (let indexInTimeline = 0; indexInTimeline <= timeline.length; ++indexInTimeline) {
        const lastIndex = timeline.length - 1
        if (indexInTimeline < lastIndex && mustFinishBy < timeline[indexInTimeline].start) {
          log('Unable to start before dependent operations are started')
          continue
        }

        const fitsBetweenCurrentAndNext =
          timeline.length > 2 &&
          indexInTimeline > 0 &&
          timeline[indexInTimeline - 1].start - timeline[indexInTimeline].end >= activeDuration &&
          timeline[indexInTimeline].end + duration <= mustFinishBy
        if (fitsBetweenCurrentAndNext) {
          const end = Math.min(timeline[indexInTimeline - 1].start, mustFinishBy - passiveDuration)
          const start = end - activeDuration
          possibleSpots.push({
            method: 'insert',
            timelineNumber,
            index: indexInTimeline,
            start,
            end,
          })

          break
        }

        const atLastTimelineItem = indexInTimeline + 1 >= timeline.length
        if (atLastTimelineItem) {
          log(`No open slots found. Only possible to add the item at the end in timeline ${timelineNumber}`)
          const lastItem = timeline[lastIndex]
          const start = Math.min(mustFinishBy - duration, lastItem ? lastItem.start - activeDuration : 0)
          if (Number.isNaN(start)) {
            log('nan')
          }
          const end = start + activeDuration
          possibleSpots.push({
            method: 'push',
            timelineNumber,
            index: timeline.length,
            start,
            end,
          })

          break
        }
      }
    }
    log(JSON.stringify({ possibleSpots }, null, 2))

    const firstAvailableSpot = possibleSpots.splice(1).reduce((firstSpot, spot) => {
      log('Comparing', firstSpot, spot)
      return spot.start > firstSpot.start || (spot.start === firstSpot.start && spot.index < firstSpot.index)
        ? spot
        : firstSpot
    }, possibleSpots[0])

    log(firstAvailableSpot)
    const { start, end, index, timelineNumber: spotTimelineNumber } = firstAvailableSpot

    const item = {
      uuid,
      duration,
      start,
      end,
      title,
      amountLeft,
      timer: operation.timer && operation.timer(graph, task),
      ...timelineItem,
    }

    if (title === 'Split') {
      log('split')
    }
    log('Splicing', spotTimelineNumber, index, cloneToFreezeForDebug(timelines[spotTimelineNumber]))

    timelines[spotTimelineNumber].splice(index, 0, item)
  }
  // TODO: Perhaps include in the depencencies array a list of the uuids of the already scheduled items that depend on that specific item?

  log('Next nodes', dependenciesToSchedule)
  scheduleItemsInTimelines(graph, dependenciesToSchedule, timelines, round + 1)
}
