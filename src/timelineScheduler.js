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

function expandNode(graph, node) {
  const operation = getOperationForNode(node)
  let expanded = node
  if (operation.expand) {
    const originalUuid = node.getAttribute('uuid')
    log('Expanding node', node)
    const tasks = operation.expand(graph, node)
    node.remove()
    const tasksElement = graph.getElementsByTagName('tasks')[0]
    log('expanded', ...tasks)
    tasks.forEach((task) => tasksElement.append(task))
    const [last] = tasks.splice(-1, 1)
    last.setAttribute('uuid', originalUuid)
    tasks.forEach((node) => expandNode(graph, node))
    expanded = last
  }

  return expanded
}

function queueDependencies(task, timelines, outputsRequested, dependencyInputIds, amountOutputProduces) {
  const inputs = getInputs(task)
  for (const input of inputs) {
    let previouslyScheduledItem = undefined // This only counts the inputs, not the scheduled output. Does that however mean that there are always the correct amount of outputs requested and thus counting there is not necessary?
    const inputId = input.getAttribute('ref')
    for (const timeline of timelines) {
      const item = timeline.find(({ id: itemId }) => itemId === inputId)
      if (item && item.amountLeft > 0) {
        previouslyScheduledItem = item
        break
      }
    }
    if (previouslyScheduledItem) {
      log('Reducing amount from previously scheduled timeline item')
      previouslyScheduledItem.amountLeft -= outputsRequested // This is a bit of apples to oranges if there are multiple outputs with different amounts
      const amountNeeded = -previouslyScheduledItem.amountLeft
      dependencyInputIds.push(
        ...R.times(R.always(inputId), Math.max(0, Math.ceil(amountNeeded / amountOutputProduces)))
      )
      previouslyScheduledItem.amountLeft = Math.max(previouslyScheduledItem.amountLeft, 0)
    } else {
      dependencyInputIds.push(...R.times(R.always(inputId), Math.ceil(outputsRequested / amountOutputProduces)))
    }
  }
}

export function scheduleItemsInTimelines(graph, nodes, timelines, round = 0) {
  const entries = Object.entries(nodes)
  if (entries.length === 0) {
    return
  }

  log(
    {
      timelines: cloneToFreezeForDebug(timelines),
      graph,
    },
    ...entries
  )

  let dependencyInputIds = []
  for (const [_, { count: outputsRequested, task: originalTask }] of entries) {
    log('Processing', originalTask)
    const task = expandNode(graph, originalTask)
    const operation = getOperationForNode(task)
    const outputs = task.querySelectorAll('output')
    const operationTimelineItem = operation.timeline(task)
    const title = operation.title(task)
    const taskUuid = task.getAttribute('uuid')
    const inputUuids = getOutputsForInputs(graph, task).map((output) => ({
      uuid: output.parentNode.parentNode.getAttribute('uuid'),
      name: output.getAttribute('name'),
    }))

    log('Calculating timeline')
    // TODO: Sort operations by longest passive time?
    for (const output of outputs) {
      const outputId = output.getAttribute('id')
      log({ output, operation })
      const passiveDuration = value(operationTimelineItem.passive, task, output)
      const activeDuration = value(operationTimelineItem.active, task, output)
      const duration = passiveDuration + activeDuration
      const amountOutputProduces = Number(output.getAttribute('amount') || 1) // This states how many items this output produces
      // The count states how many of the tasks are needed based on an output. Does it take into account the amount produced in an output (or the amount required in input)?

      // These should be duplicated if multiple outputs are requested
      const timelineItem = {
        id: outputId,
        uuid: taskUuid, // what to use here if there are multiple outputs?
        inputs: inputUuids,
        // Perhaps the nodes could be used here and later updated to refer to the indexes?
        // Oh, or perhaps all the nodes in the graph could be indexed at the beginning of processing in order to use that for referencing?
      }

      queueDependencies(task, timelines, outputsRequested, dependencyInputIds, amountOutputProduces)

      // TODO: Schedule count number of tasks instead of just one
      log('Processing', timelineItem, operationTimelineItem)

      // TODO: the amount calculation might be off here
      // TODO: using outputsRequested here might cause over scheduling of tasks
      for (let i = 0; i < Math.ceil(outputsRequested / amountOutputProduces); ++i) {
        const possibleSpots = []

        const mustFinishBy = timelines.reduce((earliestTime, timeline) => {
          const earliestStart = timeline.reduce(
            (t, i) => (i.inputs.some(({ uuid }) => uuid === taskUuid) ? Math.min(i.start, t) : t),
            0
          )
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
                console.log('nan')
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

        console.log(firstAvailableSpot)
        const { start, end, index, timelineNumber: spotTimelineNumber } = firstAvailableSpot

        const item = {
          duration,
          start,
          end,
          title,
          amountLeft: Math.max(amountOutputProduces - outputsRequested, 0), // What if amount is smaller than count? Is this already considered above?
          ...timelineItem,
        }

        if (title === 'Split') {
          console.log('split')
        }
        log('Splicing', spotTimelineNumber, index, cloneToFreezeForDebug(timelines[spotTimelineNumber]))

        timelines[spotTimelineNumber].splice(index, 0, item)
      }
    }
  }
  // TODO: Perhaps include in the depencencies array a list of the uuids of the already scheduled items that depend on that specific item?

  // Do these need to be grouped or would it be enough to just have duplicates in the list?
  const dependencies = Object.fromEntries(
    Object.entries(R.countBy(R.identity)(dependencyInputIds))
      .map(([id, count]) => [id, { count, task: findTaskProducing(graph, id) }])
      .filter(([_, { count, task }]) => count > 0 && task !== null /* ingredient or tool */)
  )

  log('Next nodes', dependencies)
  scheduleItemsInTimelines(graph, dependencies, timelines, round + 1)
}
