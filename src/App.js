import "./App.css";
import xml_data from "./recipe/buns";
import { useEffect, useState } from "react";
import {
  findFinalOutputId,
  findStepProducing,
  getInstructions,
} from "./recipeTools";
import { calculateShoppingList } from "./shoppingListGenerator";
import { scheduleItemsInTimelines } from "./timelineScheduler";

const findMatchingStep = (
  timelines,
  currentTimelineIndex,
  nextTimelineIndex,
  currentStep
) => {
  const currentStart = timelines[currentTimelineIndex][currentStep].start;
  const nextTimeline = timelines[nextTimelineIndex];
  console.log(nextTimeline);
  const index = nextTimeline.findIndex(({ start }) => start <= currentStart);
  return index === -1 ? nextTimeline.length - 1 : index;
};

const formatTime = (seconds) =>
  seconds ? new Date(seconds * 1000).toISOString().substr(11, 8) : 0;

function App() {
  const [title, setTitle] = useState("");
  const [shoppingList, setShoppingList] = useState([]);
  const [timelineCount, setTimelineCount] = useState(2);
  const [timelines, setTimelines] = useState([[], []]);
  const [currentStep, setCurrentStep] = useState(0);
  const [currentTimeline, setCurrentTimeline] = useState(0);
  const [recipe, setRecipe] = useState();
  const [recipeDuration, setRecipeDuration] = useState();

  useEffect(() => {
    const parser = new DOMParser();
    const recipe = parser.parseFromString(xml_data, "text/xml");
    setRecipe(recipe);
  }, []);

  useEffect(() => {
    if (!recipe) {
      return;
    }
    const title = recipe.querySelector("title").innerHTML;
    setTitle(title);
  }, [recipe]);

  useEffect(() => {
    if (!recipe) {
      return;
    }
    setShoppingList(calculateShoppingList(recipe));
  }, [recipe]);

  useEffect(() => {
    if (!recipe) {
      return;
    }

    let newTimelines = [];
    for (let i = 0; i < timelineCount; ++i) {
      newTimelines.push([]);
    }
    const finalOutputId = findFinalOutputId(recipe);
    const lastStep = findStepProducing(recipe, finalOutputId);

    console.log(
      `Calculating graph starting from ${lastStep.getAttribute("operation")}`
    );

    scheduleItemsInTimelines(recipe, [lastStep], newTimelines, 0);
    setTimelines(newTimelines);
    setRecipeDuration(
      newTimelines.reduce((acc, [{ start }]) => Math.min(acc, start), 0)
    );
    const timelineIndex = Math.min(currentTimeline, newTimelines.length - 1);
    setCurrentTimeline(timelineIndex);
    setCurrentStep(
      Math.min(currentStep, newTimelines[timelineIndex].length - 1)
    );
  }, [recipe, timelineCount]);

  const width = Math.max(
    ...timelines.map((timeline) => -(timeline[timeline.length - 1]?.start ?? 0))
  );

  const position = formatTime(
    -(recipeDuration - timelines[currentTimeline][currentStep]?.start)
  );

  const height = 100 * timelines.length;
  console.log("current", timelines[currentTimeline][currentStep], {
    timelines,
    currentTimeline,
    currentStep,
  });

  return (
    <div className="App">
      <h1>{title}</h1>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: `100%`, border: "1px solid black" }}
      >
        {timelines.map((timeline, timelineNumber) =>
          timeline.map(({ start, end, title }, i) => (
            <rect
              width={end - start}
              height={100}
              x={width + start}
              y={timelineNumber * 100}
              onClick={() => {
                setCurrentTimeline(timelineNumber);
                setCurrentStep(i);
              }}
              style={{
                fill:
                  timelineNumber === currentTimeline && i === currentStep
                    ? "rgb(0,0,255)"
                    : "rgb(0,255,0)",
                strokeWidth: 3,
                stroke: "rgb(0,0,0)",
              }}
            />
          ))
        )}
      </svg>
      <button
        onClick={() => {
          setTimelineCount(timelineCount + 1);
        }}
      >
        Add timeline
      </button>
      <button
        onClick={() => {
          setTimelineCount(timelineCount - 1);
        }}
      >
        Remove timeline
      </button>
      <br />

      <button
        onClick={() => {
          const nextTimelineIndex = currentTimeline - 1;
          setCurrentTimeline(nextTimelineIndex);
          setCurrentStep(
            findMatchingStep(
              timelines,
              currentTimeline,
              nextTimelineIndex,
              currentStep
            )
          );
        }}
        disabled={currentTimeline === 0}
      >
        Up
      </button>
      <br />
      <button
        onClick={() => setCurrentStep(currentStep + 1)}
        disabled={currentStep + 1 === timelines[currentTimeline]?.length ?? 1}
      >
        Previous
      </button>
      <button
        onClick={() => setCurrentStep(currentStep - 1)}
        disabled={currentStep === 0}
      >
        Next
      </button>
      <br />
      <button
        onClick={() => {
          const nextTimelineIndex = currentTimeline + 1;
          setCurrentTimeline(nextTimelineIndex);
          setCurrentStep(
            findMatchingStep(
              timelines,
              currentTimeline,
              nextTimelineIndex,
              currentStep
            )
          );
        }}
        disabled={currentTimeline === timelines.length - 1}
      >
        Down
      </button>
      <h2>Current step ({currentStep}):</h2>
      {timelines[0]?.length > 0 ? (
        <div>
          {position}
          <br />
          {getInstructions(recipe, timelines[currentTimeline][currentStep])}
        </div>
      ) : null}
      <h2>Shopping list</h2>
      {shoppingList ? (
        <ul>
          {Object.entries(shoppingList).map(([name, { amount, unit }]) => (
            <li>
              {amount} {unit} {name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default App;
