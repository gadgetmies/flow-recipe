import { operations } from "./operations";
import { findStepProducing } from "./recipeTools";

function value(valueOrFunction, ...args) {
  return typeof valueOrFunction === "function"
    ? valueOrFunction(...args)
    : valueOrFunction;
}

export function scheduleItemsInTimelines(graph, nodes, timelines, mustFinishBy) {
  if (nodes.length === 0) {
    return;
  }

  console.log({ nodes, timelines, readyAt: mustFinishBy, graph });

  for (const node of nodes) {
    const dependencies = [];

    console.log("Processing", node.innerHTML);
    const operationId = node.getAttribute("operation");
    const operation = operations[operationId];
    const outputs = node.querySelectorAll("output");
    let firstStepsStartsAt = 0;

    console.log("Calculating timeline");
    // TODO: Sort operations by longest passive time?
    for (const output of outputs) {
      console.log({ output, operationId, operation });
      const operationTimeline = operation.timeline(node);
      // Operation timeline items need to be inserted in sequence, hence reset end time here
      let nextInSequenceStartsAt = mustFinishBy;

      for (
        let operationIndex = operationTimeline.length - 1;
        operationIndex >= 0;
        --operationIndex
      ) {
        const operationTimelineItem = operationTimeline[operationIndex];

        const passiveDuration = value(
          operationTimelineItem.passive,
          node,
          output
        );
        const activeDuration = value(
          operationTimelineItem.active,
          node,
          output
        );
        const duration = passiveDuration + activeDuration;

        const timelineItem = {
          title: operationTimelineItem.title || operationId,
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
              nextInSequenceStartsAt < timeline[indexInTimeline].start
            ) {
              console.log(
                "Unable to start before dependent operations are started"
              );
              continue;
            }

            const fitsBetweenCurrentAndNext =
              timeline.length > 2 &&
              indexInTimeline > 0 &&
              timeline[indexInTimeline - 1].start - timeline[indexInTimeline].end >=
                activeDuration &&
              timeline[indexInTimeline].end + duration <=
                nextInSequenceStartsAt;
            if (fitsBetweenCurrentAndNext) {
              const end = Math.min(
                timeline[indexInTimeline - 1].start,
                nextInSequenceStartsAt - passiveDuration
              );
              const start = end - activeDuration;
              nextInSequenceStartsAt = start;
              possibleSpots.push({
                method: 'insert',
                timelineNumber,
                index: indexInTimeline,
                start,
                end,
                nextInSequenceStartsAt,
              });

              break;
            }

            const atLastTimelineItem = indexInTimeline + 1 >= timeline.length;
            if (atLastTimelineItem) {
              console.log(
                `No open slots found. Adding the item at the end of the timeline ${timelineNumber}`
              );
              const lastItem = timeline[lastIndex];
              const start = Math.min(
                nextInSequenceStartsAt - duration,
                lastItem ? lastItem.start - activeDuration : 0
              );
              const end = start + activeDuration;
              possibleSpots.push({
                method: 'push',
                timelineNumber,
                index: timeline.length,
                start,
                end,
                nextInSequenceStartsAt,
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

        const { start, end, index, timelineNumber } = firstAvailableSpot;

        const item = {
          duration,
          start,
          end,
          ...timelineItem,
        };

        nextInSequenceStartsAt = start;
        firstStepsStartsAt = Math.min(firstStepsStartsAt, start);
        console.log(
          "Slicing",
          timelineNumber,
          index,
          timelines[timelineNumber]
        );
        timelines[timelineNumber].splice(index, 0, item);
      }
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
    console.log("Next nodes", dependencies);
    scheduleItemsInTimelines(graph, dependencies, timelines, firstStepsStartsAt);
  }
}
