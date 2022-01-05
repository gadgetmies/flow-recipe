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

function App() {
  const [title, setTitle] = useState("");
  const [shoppingList, setShoppingList] = useState([]);
  const [timelines, setTimelines] = useState([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [currentTimeline, setCurrentTimeline] = useState(0);
  const [recipe, setRecipe] = useState();

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
    let newTimelines = [[], []];
    const finalOutputId = findFinalOutputId(recipe);
    const lastStep = findStepProducing(recipe, finalOutputId);

    console.log(
      `Calculating graph starting from ${lastStep.getAttribute("operation")}`
    );

    scheduleItemsInTimelines(recipe, [lastStep], newTimelines, 0);
    setCurrentStep(newTimelines[0].length - 1);
    setTimelines(newTimelines);
    console.log("Done", newTimelines);
  }, [recipe]);

  const width = Math.max(
    ...timelines.map((timeline) => -(timeline[timeline.length - 1]?.start ?? 0))
  );

  return (
    <div className="App">
      <h1>{title}</h1>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${width} 100`}
        style={{ width: "100%", height: `${100 * timelines.length}px` }}
      >
        {timelines.map((timeline, timelineNumber) =>
          timeline.map(({ start, end, title }, i) => (
            <rect
              width={end - start}
              height={100}
              x={width + start}
              y={timelineNumber * 100}
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
      <button
        onClick={() => {
          setCurrentStep(
            Math.min(currentStep, timelines[currentTimeline - 1].length - 1)
          );
          setCurrentTimeline(currentTimeline - 1);
        }}
        disabled={currentTimeline === 0}
      >
        Up
      </button>
      <button
        onClick={() => setCurrentTimeline(currentTimeline + 1)}
        disabled={currentTimeline === timelines.length - 1}
      >
        Down
      </button>
      <h2>Current step ({currentStep}):</h2>
      {timelines[0]?.length > 0 ? (
        <div>
          {timelines[currentTimeline][currentStep].start}
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
