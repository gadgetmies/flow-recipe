import "./App.css";
import xml_data from "./recipe/buns";
import { useEffect, useRef, useState } from "react";
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

const baseUrl = window.location.href.split(/[?#]/)[0];

const participantId = Number(queryParams.participant) || 0;
let sessionId = queryParams.session;
if (!sessionId) {
  sessionId = uuidV4();
  window.history.replaceState(
    { sessionId, participantId },
    "Buns!",
    `${baseUrl}?session=${sessionId}&participant=${participantId}`
  );
}

const ownId = `recipes-${sessionId}-${participantId}`;
const hostId = `recipes-${sessionId}-0`;

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

const createPeer = (sessionId, participantId, callback = () => {}) => {
  let peer = new Peer(ownId);
  peer.on("open", (ID) => {
    console.log("My peer ID is: " + ID);
    callback(peer);
  });
  return peer;
};

function App() {
  const [title, setTitle] = useState("");
  const [shoppingList, setShoppingList] = useState([]);
  const [timelines, setTimelines] = useState([[], []]);
  const [currentStep, setCurrentStep] = useState(0);
  const [currentTimeline, setCurrentTimeline] = useState(0);
  const [recipe, setRecipe] = useState();
  const [recipeDuration, setRecipeDuration] = useState();
  const [name, setName] = useState(
    JSON.parse(window.localStorage.getItem(sessionId))?.name || ""
  );
  const [nameSet, setNameSet] = useState(name !== "");
  const connectionsRef = useRef([{ id: hostId, name }]);
  const [connections, _setConnections] = useState(connectionsRef.current);
  const nextConnectionNumberRef = useRef(1);
  const [nextConnectionNumber, _setNextConnectionNumber] = useState(
    nextConnectionNumberRef.current
  );
  const [setupDone, setSetupDone] = useState(participantId === 0);
  const completedStepsRef = useRef([]);
  const [completedSteps, _setCompletedSteps] = useState(
    completedStepsRef.current
  );
  const setCompletedSteps = (newValue) => {
    completedStepsRef.current = newValue;
    _setCompletedSteps(newValue);
  };

  const markCurrentStepDone = async () => {
    const currentStepItem = timelines[currentTimeline][currentStep];
    console.log({ currentStepItem });
    const currentStepId = currentStepItem.id;
    setCompletedSteps([...completedStepsRef.current, currentStepId]);
    if (participantId === 0) {
      await sendCompletedSteps();
    } else {
      await sendStepCompleted(currentStepId);
    }
    setCurrentStep(currentStep - 1);
  };

  const connectionRef = useRef();

  const setConnections = (newConnections) => {
    connectionsRef.current = newConnections;
    _setConnections(newConnections);
  };

  const setNextConnectionNumber = (nextConnectionNumber) => {
    nextConnectionNumberRef.current = nextConnectionNumber;
    _setNextConnectionNumber(nextConnectionNumber);
  };

  const p = useRef(null);

  const mergeConnection = (connection, connections) => {
    let newConnections = connections.slice();
    const index = newConnections.findIndex(({ id }) => id === connection.id);
    newConnections.splice(index !== -1 ? index : newConnections.length, 1, {
      ...newConnections[index],
      ...connection,
    });
    return newConnections;
  };

  const sendMessageToAllConnections = async (message) => {
    for (const connection of connectionsRef.current.slice(1)) {
      try {
        connection.connection.send(JSON.stringify(message));
      } catch (e) {
        console.error(e, connection);
      }
    }
  };

  const sendConnections = async () => {
    await sendMessageToAllConnections({
      type: "connections",
      data: connectionsRef.current.map(({ connection, ...rest }) => ({
        ...rest,
      })),
    });
  };

  const sendStepCompleted = (stepId) => {
    connectionRef.current.send(
      JSON.stringify({ type: "stepCompleted", data: stepId })
    );
  };

  const sendCompletedSteps = async () => {
    await sendMessageToAllConnections({
      type: "completedSteps",
      data: completedStepsRef.current,
    });
  };

  const handleConnection = (connection) => {
    const connectionId = connection.peer;
    const newConnections = mergeConnection(
      { id: connectionId, connection, name: "" },
      connectionsRef.current // does this need to be ref current?
    );
    setConnections(newConnections);
    setNextConnectionNumber(nextConnectionNumberRef.current + 1);
    console.log(newConnections);

    connection.on(
      "data",
      (async (connectionId, data) => {
        const json = JSON.parse(data);
        if (json.type === "init") {
          await sendConnections();
        } else if (json.type === "name") {
          setConnections(
            mergeConnection(
              {
                id: connectionId,
                name: json.data,
              },
              connectionsRef.current
            )
          );
          await sendConnections();
        } else if (json.type === "stepCompleted") {
          setCompletedSteps([...completedStepsRef.current, json.data]);
          await sendCompletedSteps();
        }
        console.log(data);
      }).bind(null, connectionId)
    );
  };

  const handleOpen = () => {
    connectionRef.current.send(JSON.stringify({ type: "init" }));
    sendName();
    connectionRef.current.on("data", (data) => {
      console.log(data);
      const json = JSON.parse(data);
      if (json.type === "connections") {
        setConnections(json.data);
      } else if (json.type === "completedSteps") {
        setCompletedSteps(json.data);
      }
    });
  };

  useEffect(() => {
    createPeer(
      sessionId,
      participantId,
      (peer) => {
        p.current = peer;
        if (participantId === 0) {
          peer.on("connection", handleConnection);
        } else {
          const connection = peer.connect(hostId);
          connectionRef.current = connection;
          connection.on("open", handleOpen);
        }
      },
      []
    );

    return () => {
      // p.current?.close();
    };
  }, []);

  const sendName = () => {
    connectionRef.current.send(JSON.stringify({ type: "name", data: name }));
  };

  const updateName = (name) => {
    if (participantId === 0) {
      const newConnections = mergeConnection(
        {
          id: hostId,
          name,
        },
        connectionsRef.current // does this need to be ref current?
      );
      setConnections(newConnections);
      sendConnections();
    } else {
      sendName();
    }
  };

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
    if (!recipe || (participantId !== 0 && connections.length < 2)) {
      return;
    }

    let newTimelines = [];
    for (let i = 0; i < connections.length; ++i) {
      newTimelines.push([]);
    }
    const finalOutputId = findFinalOutputId(recipe);
    console.log({ finalOutputId });
    const lastStep = findStepProducing(recipe, finalOutputId);
    const xPathResult = recipe.evaluate(
      "//ingredient",
      recipe,
      null,
      XPathResult.UNORDERED_NODE_ITERATOR_TYPE,
      null
    );

    const ingredients = [];
    let node = xPathResult.iterateNext();
    while (node) {
      ingredients.push(node.getAttribute("id"));
      node = xPathResult.iterateNext();
    }
    setCompletedSteps(ingredients);

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
    const ownLane = connections.findIndex(({ id }) => id === ownId);
    if (ownLane !== -1) {
      setCurrentTimeline(ownLane);
      setCurrentStep(newTimelines[ownLane].length - 1);
    }

    setSetupDone(true);
  }, [recipe, connections]);

  const width = Math.max(
    ...timelines.map((timeline) => -(timeline[timeline.length - 1]?.start ?? 0))
  );

  const position = formatTime(
    -(recipeDuration - timelines[currentTimeline][currentStep]?.start)
  );
  const timeUntilFinished = formatTime(
    timelines[currentTimeline][currentStep]?.start
  );

  const height = laneHeight * timelines.length;
  const step = timelines[currentTimeline][currentStep];
  console.log("inputs", step);
  const pendingInputs = step?.inputs?.some((i) => !completedSteps.includes(i));
  return (
    <div className="App">
      {!nameSet ? (
        <div style={{ display: "flex", minHeight: "100vh" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              margin: "auto",
              width: "20em",
              borderRadius: "1em",
              backgroundColor: "#ccf",
              padding: "1em",
            }}
          >
            <h2 style={{ marginTop: 0 }}>Set your name to begin</h2>
            <label>
              You can call me{" "}
              <input
                name={"name"}
                onChange={(e) => setName(e.target.value)}
                value={name}
              />
            </label>
            <br />
            <button
              disabled={name === ""}
              onClick={() => {
                setNameSet(true);
                const settings =
                  JSON.parse(window.localStorage.getItem(sessionId)) || {};
                window.localStorage.setItem(
                  sessionId,
                  JSON.stringify({ ...settings, name })
                );
                updateName(name);
              }}
            >
              Let's begin!
            </button>
          </div>
        </div>
      ) : (
        <>
          <h1>{title}</h1>
          <div className={"container"}>
            <h2 className="title">Settings</h2>
            <h3>Participants:</h3>
            {!setupDone ? (
              "Connecting..."
            ) : (
              <table>
                <thead>
                  <tr>
                    <td>Name</td>
                  </tr>
                </thead>
                <tbody>
                  {connections.map(({ name, id }, i) => (
                    <tr key={id}>
                      <td>
                        {participantId === i ? (
                          <input
                            name="name"
                            value={name}
                            onChange={(e) => {
                              setName(e.target.value);
                            }}
                          />
                        ) : (
                          name
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {participantId === 0 && (
              <>
                <h3>Add participant</h3>
                <QRCodeSVG
                  value={`${baseUrl}?session=${sessionId}&participant=${nextConnectionNumber}`}
                />
              </>
            )}
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
                timeline.map(({ start, end, title, id }, i) => (
                  <rect
                    key={id}
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
                          : completedSteps.includes(id)
                          ? "rgb(240,255,240)"
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
              pendingInputs ? (
                "Waiting for previous steps to complete"
              ) : (
                <>
                  <p>{getInstructions(recipe, step)}</p>
                  <p>Estimated step duration: {formatTime(step.duration)}</p>
                  <div
                    style={{ display: "flex", justifyContent: "center" }}
                    onClick={markCurrentStepDone}
                  >
                    <button>Done!</button>
                  </div>
                  <p>Time until finished: {timeUntilFinished}</p>
                </>
              )
            ) : null}
          </div>
          <div className="container">
            <h2 className="title">Shopping list</h2>
            {shoppingList ? (
              <ul>
                {Object.entries(shoppingList).map(
                  ([name, { amount, unit }], i) => (
                    <li key={`${name}-${i}`}>
                      {amount} {unit} {name}
                    </li>
                  )
                )}
              </ul>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export default App;
