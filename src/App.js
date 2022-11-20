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
import { v4 as uuidV4 } from "uuid";
import { QRCodeSVG } from "qrcode.react";
import Peer from "peerjs";

const queryParams = new Proxy(new URLSearchParams(window.location.search), {
  get: (searchParams, prop) => searchParams.get(prop),
});

const participantId = queryParams.participant || uuidV4();
let sessionId = queryParams.session;
if (!sessionId) {
  sessionId = uuidV4();
  window.history.replaceState(
    { sessionId, participantId },
    "Buns!",
    `/?session=${sessionId}&participant=${participantId}`
  );
}

const peer = new Peer();
const conn = peer.connect(`recipes-${sessionId}`);
conn.on("open", () => conn.send("Test"));
peer.on("connection", () => {
  conn.on("data", (data) => console.log("data", data));
  conn.on("open", () => {
    conn.send("hello!");
  });
});

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

const laneHeight = 40;
const zoom = 0.4;

function Navigation({
  currentTimeline,
  setCurrentTimeline,
  setCurrentStep,
  timelines,
  currentStep,
}) {
  return (
    <>
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
    </>
  );
}

function createParticipant(
  name = "",
  participantId = uuidV4(),
  joined = false
) {
  return {
    name,
    joined,
    participantId,
    code: uuidV4(),
  };
}

function App() {
  const [title, setTitle] = useState("");
  const [shoppingList, setShoppingList] = useState([]);
  const [timelineCount, setTimelineCount] = useState(2);
  const [timelines, setTimelines] = useState([[], []]);
  const [currentStep, setCurrentStep] = useState(0);
  const [currentTimeline, setCurrentTimeline] = useState(0);
  const [recipe, setRecipe] = useState();
  const [recipeDuration, setRecipeDuration] = useState();
  const [participants, setParticipants] = useState([
    createParticipant("Me", participantId, true),
  ]);
  const [qrCodeUUID, setQRCodeUUID] = useState(undefined);

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
    console.log({ finalOutputId });
    const lastStep = findStepProducing(recipe, finalOutputId);

    console.log(
      `Calculating graph starting from ${lastStep.getAttribute("operation")}`,
      newTimelines
    );

    scheduleItemsInTimelines(recipe, [lastStep], newTimelines, 0);
    setTimelines(newTimelines);
    setRecipeDuration(
      newTimelines.reduce(
        (acc, items) => Math.min(acc, items[items.length - 1]?.start),
        0
      )
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

  const height = laneHeight * timelines.length;
  console.log("current", timelines[currentTimeline][currentStep], {
    timelines,
    currentTimeline,
    currentStep,
  });

  const step = timelines[currentTimeline][currentStep];
  return (
    <div className="App">
      <h1>{title}</h1>

      <div className={"container"}>
        <h2 className="title">Settings</h2>
        <h3>Participants:</h3>
        <table>
          <thead>
            <tr>
              <td>Name</td>
              <td>Status</td>
              <td></td>
            </tr>
          </thead>
          <tbody>
            {participants.map(({ name, participantId }, i) => (
              <tr>
                <td>{name}</td>
                <td>
                  {participants[i].joined
                    ? "Joined"
                    : i !== 0 && (
                        <button onClick={() => setQRCodeUUID(participantId)}>
                          Show code
                        </button>
                      )}
                </td>
                <td>
                  {i !== 0 && (
                    <button
                      onClick={() => {
                        const newParticipants = structuredClone(participants);
                        newParticipants.splice(i, 1);
                        setParticipants(newParticipants);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={3}>
                <button
                  onClick={() =>
                    setParticipants([...participants, createParticipant()])
                  }
                >
                  Add participant
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        {qrCodeUUID && (
          <QRCodeSVG
            value={`${window.location}?participant=${qrCodeUUID}`}
          ></QRCodeSVG>
        )}
        <h3>Count</h3>
        <label>
          <input
            type="number"
            value={timelineCount}
            onChange={(e) => setTimelineCount(e.target.value)}
          />
        </label>
      </div>
      <h2>Steps</h2>
      <div style={{ overflowX: "auto" }}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`0 0 ${width} ${height}`}
          style={{
            width: width * zoom,
            height: `100%`,
            border: "1px solid black",
            marginBottom: 20,
          }}
        >
          {timelines.map((timeline, timelineNumber) =>
            timeline.map(({ start, end, title }, i) => (
              <rect
                width={end - start}
                height={laneHeight}
                x={width + start}
                y={timelineNumber * laneHeight}
                onClick={() => {
                  setCurrentTimeline(timelineNumber);
                  setCurrentStep(i);
                }}
                style={{
                  fill:
                    timelineNumber === currentTimeline && i === currentStep
                      ? "rgb(200,200,255)"
                      : "rgb(240,240,255)",
                  strokeWidth: 3,
                  rx: 5,
                  ry: 5,
                  stroke: "rgb(0,0,0)",
                }}
              />
            ))
          )}
        </svg>
      </div>

      <div className={"container"}>
        <h2 className="title">Step: {step?.title}</h2>
        {timelines[0]?.length > 0 ? (
          <>
            <p>{getInstructions(recipe, step)}</p>
            <p>
              Start time: {position}
              <br />
              Duration: {formatTime(step.duration)}
            </p>
          </>
        ) : null}
      </div>
      <div className="container">
        <h2 className="title">Shopping list</h2>
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
    </div>
  );
}

export default App;
