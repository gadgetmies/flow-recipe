import { operations } from "./operations";
import {
  findIngredientWithId,
  findTaskProducing,
  getOutputsForInputs,
  getInputs,
} from "./recipeTools";

const log = (...args) => {
  console.log(...args);
};

function cloneToFreezeForDebug(value) {
  return JSON.parse(JSON.stringify(value));
}

function value(valueOrFunction, ...args) {
  return typeof valueOrFunction === "function"
    ? valueOrFunction(...args)
    : valueOrFunction;
}

function getOperationForNode(node) {
  const operationId = node.getAttribute("operation");
  const operation = operations[operationId];
  if (operation === undefined) {
    throw new Error(`Operation for id '${operationId}' not found!`);
  }
  return operation;
}

function expandNode(graph, node) {
  const operation = getOperationForNode(node);

  if (operation.expand) {
    log("Expanding node", node);
    const tasks = operation.expand(graph, node);
    node.remove();
    const tasksElement = graph.getElementsByTagName("tasks")[0];
    log("expanded", ...tasks);
    tasks.forEach((task) => tasksElement.append(task));
    const [last] = tasks.splice(-1, 1);
    tasks.forEach((node) => expandNode(graph, node));
    return last;
  } else {
    return node;
  }
}

export function scheduleItemsInTimelines(
  graph,
  nodes,
  timelines,
  mustFinishBy,
  round = 0
) {
  if (nodes.length === 0) {
    return;
  }

  log(
    {
      timelines: cloneToFreezeForDebug(timelines),
      readyAt: mustFinishBy,
      graph,
    },
    ...nodes
  );

  for (let node of nodes) {
    const dependencies = [];

    log("Processing", node);
    node = expandNode(graph, node);
    const operation = getOperationForNode(node);
    const outputs = node.querySelectorAll("output");
    const operationTimelineItem = operation.timeline(node);
    const title = operation.title(node);
    let taskStartsAt;
    const outputsForInputs = getOutputsForInputs(graph, node);
    const tasksProducingOutputs = outputsForInputs.map(
      (i) => i.parentNode.parentNode
    );
    console.log({ inputs: outputsForInputs });
    const inputIds = outputsForInputs.map((n) => {
      return n.getAttribute("id");
    });
    console.log(inputIds);

    log("Calculating timeline");
    // TODO: Sort operations by longest passive time?
    for (const output of outputs) {
      log({ output, operation });
      const passiveDuration = value(
        operationTimelineItem.passive,
        node,
        output
      );
      const activeDuration = value(operationTimelineItem.active, node, output);
      const duration = passiveDuration + activeDuration;

      const timelineItem = {
        id: output.getAttribute("id"),
        inputs: inputIds,
      };

      log("Processing", timelineItem, operationTimelineItem);

      const possibleSpots = [];

      for (const timeline of timelines) {
        const timelineNumber = timelines.indexOf(timeline);
        for (
          let indexInTimeline = 0;
          indexInTimeline <= timeline.length;
          ++indexInTimeline
        ) {
          const lastIndex = timeline.length - 1;
          if (
            indexInTimeline < lastIndex &&
            mustFinishBy < timeline[indexInTimeline].start
          ) {
            log("Unable to start before dependent operations are started");
            continue;
          }

          const fitsBetweenCurrentAndNext =
            timeline.length > 2 &&
            indexInTimeline > 0 &&
            timeline[indexInTimeline - 1].start -
              timeline[indexInTimeline].end >=
              activeDuration &&
            timeline[indexInTimeline].end + duration <= mustFinishBy;
          if (fitsBetweenCurrentAndNext) {
            const end = Math.min(
              timeline[indexInTimeline - 1].start,
              mustFinishBy - passiveDuration
            );
            const start = end - activeDuration;
            mustFinishBy = start;
            possibleSpots.push({
              method: "insert",
              timelineNumber,
              index: indexInTimeline,
              start,
              end,
              mustFinishBy,
            });

            break;
          }

          const atLastTimelineItem = indexInTimeline + 1 >= timeline.length;
          if (atLastTimelineItem) {
            log(
              `No open slots found. Only possible to add the item at the end in timeline ${timelineNumber}`
            );
            const lastItem = timeline[lastIndex];
            const start = Math.min(
              mustFinishBy - duration,
              lastItem ? lastItem.start - activeDuration : 0
            );
            const end = start + activeDuration;
            possibleSpots.push({
              method: "push",
              timelineNumber,
              index: timeline.length,
              start,
              end,
              mustFinishBy,
            });

            break;
          }
        }
      }
      log(JSON.stringify({ possibleSpots }, null, 2));

      const firstAvailableSpot = possibleSpots
        .splice(1)
        .reduce((firstSpot, spot) => {
          log("Comparing", firstSpot, spot);
          return spot.start > firstSpot.start ||
            (spot.start === firstSpot.start && spot.index < firstSpot.index)
            ? spot
            : firstSpot;
        }, possibleSpots[0]);

      const {
        start,
        end,
        index,
        timelineNumber: spotTimelineNumber,
      } = firstAvailableSpot;

      const item = {
        duration,
        start,
        end,
        title: title,
        ...timelineItem,
      };

      taskStartsAt = start;
      log(
        "Splicing",
        spotTimelineNumber,
        index,
        cloneToFreezeForDebug(timelines[spotTimelineNumber])
      );

      timelines[spotTimelineNumber].splice(index, 0, item);
    }

    for (const task of tasksProducingOutputs) {
      //const task = findTaskProducing(graph, input.getAttribute("ref"));
      if (task !== null) {
        dependencies.push(task);
      } else {
        log(`Ingredient ${task.getAttribute("id")}`);
      }
    }
    log("Next nodes", ...dependencies);
    scheduleItemsInTimelines(
      graph,
      dependencies,
      timelines,
      taskStartsAt,
      round + 1
    );
  }
}
