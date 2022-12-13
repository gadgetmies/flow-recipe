import "./reset.css";
import "./App.css";
import xml_data from "./recipe/buns";
import { useEffect, useRef, useState } from "react";
import {
  findFinalOutputId,
  findOutputWithId,
  findStepProducing,
  getInputs,
  getInstructions,
  getOutputs,
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

const sessionId = queryParams.session || uuidV4();
const participantId = queryParams.session
  ? queryParams.participant || uuidV4()
  : "0";
const isHost = participantId === "0";

window.history.replaceState(
  { sessionId, participantId },
  "Buns!",
  `${baseUrl}?session=${sessionId}&participant=${participantId}`
);

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

const laneHeight = 80;
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
  const [selectedStep, setSelectedStep] = useState({ timeline: 0, step: 0 });
  const [ownLane, setOwnLane] = useState(0);
  const [currentTimeline, setCurrentTimeline] = useState(0);
  const [recipe, setRecipe] = useState();
  const [recipeDuration, setRecipeDuration] = useState();
  const [name, setName] = useState(
    JSON.parse(window.localStorage.getItem(sessionId))?.name || ""
  );
  const [nameSet, setNameSet] = useState(name !== "");
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [currentState, setCurrentState] = useState("settings");

  const connectionsRef = useRef([{ id: hostId, name }]);
  const [connections, _setConnections] = useState(connectionsRef.current);
  const nextConnectionNumberRef = useRef(1);
  const [nextConnectionNumber, _setNextConnectionNumber] = useState(
    nextConnectionNumberRef.current
  );
  const [setupDone, setSetupDone] = useState(isHost);
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
    if (isHost) {
      await sendCompletedSteps();
    } else {
      await sendStepCompleted(currentStepId);
    }
    const nextStep = currentStep - 1;
    setCurrentStep(nextStep);
    setSelectedStep({ step: nextStep, timeline: ownLane });
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
        if (isHost) {
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
    if (isHost) {
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
    if (!recipe || (!isHost && connections.length < 2)) {
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
      setOwnLane(ownLane);
      setCurrentTimeline(ownLane);
      const nextStep = newTimelines[ownLane].length - 1;
      setCurrentStep(nextStep);
      setSelectedStep({ step: nextStep, timeline: ownLane });
    }

    setSetupDone(true);
  }, [recipe, connections]);

  const nameLabelWidth = 200;
  const width =
    Math.max(
      ...timelines.map(
        (timeline) => -(timeline[timeline.length - 1]?.start ?? 0)
      )
    ) + nameLabelWidth;

  const position = formatTime(
    -(
      recipeDuration -
      timelines[selectedStep.timeline][selectedStep.step]?.start
    )
  );
  const timeUntilFinished = formatTime(
    timelines[selectedStep.timeline][selectedStep.step]?.start
  );

  const height = laneHeight * timelines.length;
  const step = timelines[selectedStep.timeline][selectedStep.step];
  const pendingInputs = step?.inputs?.filter(
    (i) => !completedSteps.includes(i)
  );
  // TODO: get participants and outputs for inputs
  const inputsForStep = step?.inputs?.map((id) => {
    const timeline = timelines.findIndex((t) => t.some((s) => s.id === id));
    return {
      id,
      input: findOutputWithId(id, recipe).getAttribute("name"),
      participant:
        timeline === currentTimeline ? null : connections[timeline].name,
    };
  });
  console.log({ inputsForStep, pendingInputs });
  const joinSessionLink = `${baseUrl}?session=${sessionId}`;
  const currentIsSelected =
    currentStep === selectedStep.step && selectedStep.timeline === ownLane;
  return (
    <div className="App" style={{ minHeight: "100vh", overflow: "hidden" }}>
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
          <div style={{ marginBottom: "4em" }}>
            {currentState === "settings" && (
              <div className={"container"}>
                <>
                  <h2>Recipe</h2>
                  Buns
                  <h2>Participants:</h2>
                  {!setupDone
                    ? "Connecting..."
                    : connections.map(({ name, id }) => (
                        <li key={id}>
                          {participantId === id ? (
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
                        </li>
                      ))}
                  <>
                    <h3>Invite participants:</h3>
                    <p>Use QR:</p>
                    <QRCodeSVG value={joinSessionLink} />
                    <p>or</p>
                    <p>Use a link:</p>
                    <button
                      className="button button-push_button-large button-push_button-primary"
                      onClick={() => {
                        navigator.clipboard.writeText(joinSessionLink);
                        setShareLinkCopied(true);
                        window.setTimeout(
                          () => setShareLinkCopied(false),
                          2000
                        );
                      }}
                    >
                      {shareLinkCopied
                        ? "Link copied!"
                        : "Copy link to clipboard"}
                    </button>
                  </>
                </>
              </div>
            )}
            {currentState === "shopping" && (
              <div className="container">
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
            )}

            {currentState === "cooking" && (
              <div className="container">
                <h2 className={"title"}>Steps for: buns</h2>
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
                    {timelines.map((timeline, timelineNumber) => {
                      const y = timelineNumber * laneHeight;

                      return (
                        <>
                          <text
                            x={0}
                            y={y + laneHeight / 2}
                            style={{ fontSize: Math.round(laneHeight / 2) }}
                          >
                            {connections[timelineNumber]?.name}
                          </text>
                          {timeline.map(({ start, end, title, id }, i) => {
                            const currentTimelineIsOwn =
                              timelineNumber === ownLane;
                            return (
                              <rect
                                key={id}
                                width={end - start}
                                height={laneHeight}
                                x={width + start}
                                y={y}
                                onClick={() => {
                                  setCurrentTimeline(timelineNumber);
                                  setSelectedStep({
                                    step: i,
                                    timeline: timelineNumber,
                                  });
                                }}
                                style={{
                                  fill:
                                    currentTimelineIsOwn && i === currentStep
                                      ? "rgb(200,200,255)"
                                      : timelineNumber ===
                                          selectedStep.timeline &&
                                        i === selectedStep.step
                                      ? "rgb(255,200,200)"
                                      : completedSteps.includes(id)
                                      ? "rgb(240,255,240)"
                                      : "rgb(240,240,255)",
                                  strokeWidth: 3,
                                  rx: 5,
                                  ry: 5,
                                  stroke: "rgb(0,0,0)",
                                }}
                              />
                            );
                          })}
                        </>
                      );
                    })}
                  </svg>
                </div>

                <h2 className="title">
                  {currentIsSelected ? "Step" : "Preview"}: {step?.title}
                </h2>
                {timelines[0]?.length > 0 && (
                  <>
                    {currentIsSelected && pendingInputs.length > 0 && (
                      <>
                        Waiting for: <br />
                        <ul>
                          {pendingInputs
                            .map((pi) => inputsForStep.find((i) => i.id === pi))
                            .map(({ input, participant }) => (
                              <li>
                                {input}{" "}
                                {participant !== null && `from ${participant}`}
                              </li>
                            ))}
                        </ul>
                      </>
                    )}
                    {inputsForStep.length > 0 && (
                      <p>
                        Get: <br />
                        <ul>
                          {inputsForStep.map(({ participant, input }) => (
                            <li>
                              {input}{" "}
                              {participant !== null && `from ${participant}`}
                            </li>
                          ))}
                        </ul>
                      </p>
                    )}
                    <p>{getInstructions(recipe, step)}</p>
                    <p>Estimated step duration: {formatTime(step.duration)}</p>
                    <p>
                      <small>Time until finished: {timeUntilFinished}</small>
                    </p>
                    {currentIsSelected && (
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "center",
                        }}
                        onClick={markCurrentStepDone}
                      >
                        <button
                          className={
                            "button button-push_button-primary button-push_button-large"
                          }
                        >
                          Done, next!
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
      <div className={"nav"}>
        <div
          className={`nav-item clickable ${
            currentState === "settings" ? "nav-item_current" : ""
          }`}
          onClick={() => setCurrentState("settings")}
        >
          Settings
        </div>
        <div
          className={`nav-item clickable ${
            currentState === "shopping" ? "nav-item_current" : ""
          }`}
          onClick={() => setCurrentState("shopping")}
        >
          Shopping list
        </div>
        <div
          className={`nav-item clickable ${
            currentState === "cooking" ? "nav-item_current" : ""
          }`}
          onClick={() => setCurrentState("cooking")}
        >
          Steps
        </div>
      </div>
    </div>
  );
}

export default App;
