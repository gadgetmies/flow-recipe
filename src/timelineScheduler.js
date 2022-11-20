import { operations } from "./operations";
import { findStepProducing } from "./recipeTools";

function value(valueOrFunction, ...args) {
  return typeof valueOrFunction === "function"
    ? valueOrFunction(...args)
    : valueOrFunction;
}

function getOperationForNode(node) {
  const operationId = node.getAttribute("operation");
  return operations[operationId];
}

function expandNode(graph, node) {
  const operation = getOperationForNode(node);

  if (operation.expand) {
    console.log("Expanding node", node);
    const steps = operation.expand(graph, node);
    node.remove();
    const stepsElement = graph.getElementsByTagName("steps")[0];
    console.log("expanded", ...steps);
    steps.forEach((step) => stepsElement.append(step));
    const [last] = steps.splice(-1, 1);
    steps.forEach((node) => expandNode(graph, node));
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

  console.log(
    {
      timelines: structuredClone(timelines),
      readyAt: mustFinishBy,
      graph,
    },
    ...nodes
  );

  for (let node of nodes) {
    const dependencies = [];

    console.log("Processing", node);
    node = expandNode(graph, node);
    const operation = getOperationForNode(node);
    const outputs = node.querySelectorAll("output");
    const operationTimelineItem = operation.timeline(node);
    const title = operation.title(node);
    let stepStartsAt;

    console.log("Calculating timeline");
    // TODO: Sort operations by longest passive time?
    for (const output of outputs) {
      console.log({ output, operation });
      const passiveDuration = value(
        operationTimelineItem.passive,
        node,
        output
      );
      const activeDuration = value(operationTimelineItem.active, node, output);
      const duration = passiveDuration + activeDuration;

      const timelineItem = {
        id: output.getAttribute("id"),
      };

      console.log("Processing", timelineItem, operationTimelineItem);

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
            console.log(
              "Unable to start before dependent operations are started"
            );
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
            console.log(
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
      console.log(JSON.stringify({ possibleSpots }, null, 2));

      const firstAvailableSpot = possibleSpots
        .splice(1)
        .reduce((firstSpot, spot) => {
          console.log("Comparing", firstSpot, spot);
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

      stepStartsAt = start;
      console.log(
        "Splicing",
        spotTimelineNumber,
        index,
        structuredClone(timelines[spotTimelineNumber])
      );

      timelines[spotTimelineNumber].splice(index, 0, item);
    }

    const inputs = node.querySelectorAll("input");

    for (const input of inputs) {
      const step = findStepProducing(graph, input.getAttribute("ref"));
      if (step !== null) {
        dependencies.push(step);
      } else {
        console.log(`Ingredient ${input.getAttribute("ref")}`);
      }
    }
    console.log("Next nodes", ...dependencies);
    scheduleItemsInTimelines(
      graph,
      dependencies,
      timelines,
      stepStartsAt,
      round + 1
    );
  }
}
