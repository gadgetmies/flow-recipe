import './reset.css'
import './App.css'
//import xml_data from "./recipe/buns";
import xml_data from './recipe/layer-cake'
//import xml_data from './recipe/debug-cake'
import { useEffect, useRef, useState } from 'react'
import { calculateToolList, findFinalOutputId, findTaskProducing, getInstructions } from './recipeTools'
import { calculateShoppingList } from './shoppingListGenerator'
import { scheduleItemsInTimelines } from './timelineScheduler'
import { v4 as uuidV4 } from 'uuid'
import { QRCodeSVG } from 'qrcode.react'
import Peer from 'peerjs'
//import { ForceGraph2D } from 'react-force-graph'
import * as R from 'ramda'

const queryParams = new Proxy(new URLSearchParams(window.location.search), {
  get: (searchParams, prop) => searchParams.get(prop),
})

const baseUrl = window.location.href.split(/[?#]/)[0]

const sessionId = queryParams.session || uuidV4()
const participantId = queryParams.session ? queryParams.participant || uuidV4() : '0'
const isHost = participantId === '0'

window.history.replaceState(
  { sessionId, participantId },
  'Buns!',
  `${baseUrl}?session=${sessionId}&participant=${participantId}`
)

const ownId = `recipes-${sessionId}-${participantId}`
const hostId = `recipes-${sessionId}-0`

const findMatchingTask = (timelines, currentTimelineIndex, nextTimelineIndex, currentTask) => {
  const currentStart = timelines[currentTimelineIndex][currentTask].start
  const nextTimeline = timelines[nextTimelineIndex]
  const index = nextTimeline.findIndex(({ start }) => start <= currentStart)
  return index === -1 ? nextTimeline.length - 1 : index
}

const formatTime = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().substr(11, 8) : 0)

const laneHeight = 80
const zoom = 0.4

function Navigation({ currentTimeline, setCurrentTimeline, setCurrentTask, timelines, currentTask }) {
  return (
    <>
      <button
        onClick={() => {
          const nextTimelineIndex = currentTimeline - 1
          setCurrentTimeline(nextTimelineIndex)
          setCurrentTask(findMatchingTask(timelines, currentTimeline, nextTimelineIndex, currentTask))
        }}
        disabled={currentTimeline === 0}
      >
        Up
      </button>
      <br />
      <button
        onClick={() => setCurrentTask(currentTask + 1)}
        disabled={currentTask + 1 === timelines[currentTimeline]?.length ?? 1}
      >
        Previous
      </button>
      <button onClick={() => setCurrentTask(currentTask - 1)} disabled={currentTask === 0}>
        Next
      </button>
      <br />
      <button
        onClick={() => {
          const nextTimelineIndex = currentTimeline + 1
          setCurrentTimeline(nextTimelineIndex)
          setCurrentTask(findMatchingTask(timelines, currentTimeline, nextTimelineIndex, currentTask))
        }}
        disabled={currentTimeline === timelines.length - 1}
      >
        Down
      </button>
    </>
  )
}

const createPeer = (sessionId, participantId, callback = () => {}) => {
  let peer = new Peer(ownId)
  peer.on('open', (ID) => {
    console.log('My peer ID is: ' + ID)
    callback(peer)
  })
  return peer
}

const NameInput = ({ name, setName, setNameSet, updateName }) => (
  <>
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          margin: 'auto',
          width: '20em',
          borderRadius: '1em',
          backgroundColor: '#ccf',
          padding: '1em',
        }}
      >
        <h2 style={{ marginTop: 0 }}>Set your name to begin</h2>
        <label>
          You can call me <input name={'name'} onChange={(e) => setName(e.target.value)} value={name} />
        </label>
        <br />
        <button
          disabled={name === ''}
          onClick={() => {
            setNameSet(true)
            const settings = JSON.parse(window.localStorage.getItem(sessionId)) || {}
            window.localStorage.setItem(sessionId, JSON.stringify({ ...settings, name: name }))
            window.localStorage.setItem('global-settings', JSON.stringify({ defaultName: name }))
            updateName(name)
          }}
        >
          Let's begin!
        </button>
      </div>
    </div>
  </>
)

function Settings({ title, setupDone, connections, setName, joinSessionLink, setShareLinkCopied, shareLinkCopied }) {
  return (
    <div className={'container'}>
      <>
        <h2>Recipe</h2>
        {title}
        <h2>Participants:</h2>
        {!setupDone
          ? 'Connecting...'
          : connections.map(({ name, id }) => (
              <li key={id}>
                {participantId === id ? (
                  <input
                    name="name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
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
              navigator.clipboard.writeText(joinSessionLink)
              setShareLinkCopied(true)
              window.setTimeout(() => setShareLinkCopied(false), 2000)
            }}
          >
            {shareLinkCopied ? 'Link copied!' : 'Copy link to clipboard'}
          </button>
        </>
      </>
    </div>
  )
}

function Shopping({ shoppingList }) {
  return (
    <div className="container">
      {shoppingList ? (
        <ul>
          {Object.entries(shoppingList).map(([name, { amount, unit }], i) => (
            <li key={`${name}-${i}`}>
              {amount} {unit} {name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Tools(tools) {
  return (
    <div className="container">
      {tools ? (
        <ul>
          {tools.map(({ name }) => (
            <li key={`${name}`}>{name}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Task({
  task,
  isCurrent,
  inputsReady,
  pendingInputs,
  inputsForTask,
  recipe,
  timeUntilFinished,
  markCurrentTaskDone,
}) {
  return (
    <>
      <h3 id={task.uuid}>{task?.title}</h3>
      <>
        {isCurrent && !inputsReady && (
          <>
            Waiting for: <br />
            <ul>
              {pendingInputs
                .map(({ uuid: pi }) => inputsForTask.find((i) => i.uuid === pi))
                .map(({ input, participant }) => (
                  <li>
                    {input} {participant !== null && `from ${participant}`}
                  </li>
                ))}
            </ul>
          </>
        )}
        {inputsForTask.length > 0 && (
          <p>
            Get: <br />
            <ul>
              {inputsForTask.map(({ participant, input }) => (
                <li>
                  {input} {participant !== null && `from ${participant}`}
                </li>
              ))}
            </ul>
          </p>
        )}
        <p>{getInstructions(recipe, task)}</p>
        <p>Estimated task duration: {formatTime(task.duration)}</p>
        <p>
          <small>Time until finished: {timeUntilFinished}</small>
        </p>
        {isCurrent && inputsReady && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
            }}
            onClick={markCurrentTaskDone}
          >
            <button className={'button button-push_button-primary button-push_button-large'}>Done, next!</button>
          </div>
        )}
      </>
    </>
  )
}

function App() {
  const settings = JSON.parse(window.localStorage.getItem(sessionId)) || {}

  const [title, setTitle] = useState('')
  const [shoppingList, setShoppingList] = useState([])
  const [tools, setTools] = useState([])
  const [timelines, setTimelines] = useState([[], []])
  const [currentTask, setCurrentTask] = useState(0)
  const [selectedTask, setSelectedTask] = useState({ timeline: 0, task: 0 })
  const [ownLane, setOwnLane] = useState(0)
  const [currentTimeline, setCurrentTimeline] = useState(0)
  const [recipe, setRecipe] = useState()
  const [recipeDuration, setRecipeDuration] = useState()
  let globalSettings = JSON.parse(window.localStorage.getItem('global-settings'))
  const [name, setName] = useState(globalSettings?.defaultName || settings?.name || '')
  const [nameSet, setNameSet] = useState(name !== '')
  const [shareLinkCopied, setShareLinkCopied] = useState(false)
  const [currentState, setCurrentState] = useState(settings.tab || 'settings')
  const selectTab = (tab) => {
    setCurrentState(tab)
    const settings = JSON.parse(window.localStorage.getItem(sessionId)) || {}
    window.localStorage.setItem(sessionId, JSON.stringify({ ...settings, tab }))
  }

  const connectionsRef = useRef([{ id: hostId, name }])
  const [connections, _setConnections] = useState(connectionsRef.current)
  const nextConnectionNumberRef = useRef(1)
  const [nextConnectionNumber, _setNextConnectionNumber] = useState(nextConnectionNumberRef.current)
  const [setupDone, setSetupDone] = useState(isHost)
  const completedTasksRef = useRef(settings.completedTasks || [])
  const [completedTasks, _setCompletedTasks] = useState(completedTasksRef.current)
  const setTasksCompleted = (completed) => {
    // TODO: use uuids
    const settings = JSON.parse(window.localStorage.getItem(sessionId)) || {}
    const merged = Array.from(new Set([...(settings.completedTasks || []), ...completed]))
    window.localStorage.setItem(sessionId, JSON.stringify({ ...settings, completedTasks: merged }))
    completedTasksRef.current = merged
    _setCompletedTasks(merged)
  }

  const scrollToTask = (taskIndex) => {
    const uuid = timelines[ownLane][taskIndex].uuid
    document.getElementById(uuid).scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const markCurrentTaskDone = async () => {
    const currentTaskItem = timelines[currentTimeline][currentTask]
    const currentTaskUuid = currentTaskItem.uuid
    setTasksCompleted([...completedTasksRef.current, currentTaskUuid])
    if (isHost) {
      await sendCompletedTasks()
    } else {
      await sendTaskCompleted(currentTaskUuid)
    }
    const nextTask = currentTask - 1
    setCurrentTask(nextTask)
    setSelectedTask({ task: nextTask, timeline: ownLane })
    scrollToTask(nextTask)
  }

  const connectionRef = useRef()

  const setConnections = (newConnections) => {
    connectionsRef.current = newConnections
    _setConnections(newConnections)
  }

  const setNextConnectionNumber = (nextConnectionNumber) => {
    nextConnectionNumberRef.current = nextConnectionNumber
    _setNextConnectionNumber(nextConnectionNumber)
  }

  const p = useRef(null)

  const mergeConnection = (connection, connections) => {
    let newConnections = connections.slice()
    const index = newConnections.findIndex(({ id }) => id === connection.id)
    newConnections.splice(index !== -1 ? index : newConnections.length, 1, {
      ...newConnections[index],
      ...connection,
    })
    return newConnections
  }

  const sendMessageToAllConnections = async (message) => {
    for (const connection of connectionsRef.current.slice(1)) {
      try {
        connection.connection.send(JSON.stringify(message))
      } catch (e) {
        console.error(e, connection)
      }
    }
  }

  const sendConnections = async () => {
    await sendMessageToAllConnections({
      type: 'connections',
      data: connectionsRef.current.map(({ connection, ...rest }) => ({
        ...rest,
      })),
    })
  }

  const sendTaskCompleted = (taskId) => {
    connectionRef.current.send(JSON.stringify({ type: 'taskCompleted', data: taskId }))
  }

  const sendCompletedTasks = async () => {
    await sendMessageToAllConnections({
      type: 'completedTasks',
      data: completedTasksRef.current,
    })
  }

  const handleConnection = (connection) => {
    const connectionId = connection.peer
    const newConnections = mergeConnection(
      { id: connectionId, connection, name: '' },
      connectionsRef.current // does this need to be ref current?
    )
    setConnections(newConnections)
    setNextConnectionNumber(nextConnectionNumberRef.current + 1)

    connection.on(
      'data',
      (async (connectionId, data) => {
        const json = JSON.parse(data)
        if (json.type === 'init') {
          await sendConnections()
        } else if (json.type === 'name') {
          setConnections(
            mergeConnection(
              {
                id: connectionId,
                name: json.data,
              },
              connectionsRef.current
            )
          )
          await sendConnections()
        } else if (json.type === 'taskCompleted') {
          setTasksCompleted([...completedTasksRef.current, json.data])
          await sendCompletedTasks()
        }
      }).bind(null, connectionId)
    )
  }

  const handleOpen = () => {
    connectionRef.current.send(JSON.stringify({ type: 'init' }))
    sendName()
    connectionRef.current.on('data', (data) => {
      const json = JSON.parse(data)
      if (json.type === 'connections') {
        setConnections(json.data)
      } else if (json.type === 'completedTasks') {
        setTasksCompleted(json.data)
      }
    })
  }

  useEffect(() => {
    createPeer(
      sessionId,
      participantId,
      (peer) => {
        p.current = peer
        if (isHost) {
          peer.on('connection', handleConnection)
        } else {
          const connection = peer.connect(hostId)
          connectionRef.current = connection
          connection.on('open', handleOpen)
        }
      },
      []
    )

    return () => {
      // p.current?.close();
    }
  }, [])

  const sendName = () => {
    connectionRef.current.send(JSON.stringify({ type: 'name', data: name }))
  }

  const updateName = (name) => {
    if (isHost) {
      const newConnections = mergeConnection(
        {
          id: hostId,
          name,
        },
        connectionsRef.current // does this need to be ref current?
      )
      setConnections(newConnections)
      sendConnections()
    } else {
      sendName()
    }
  }

  useEffect(() => {
    const parser = new DOMParser()
    const recipe = parser.parseFromString(xml_data, 'text/xml')
    setRecipe(recipe)
  }, [])

  useEffect(() => {
    if (!recipe) {
      return
    }
    const title = recipe.querySelector('title').innerHTML
    setTitle(title)
  }, [recipe])

  useEffect(() => {
    if (!recipe) {
      return
    }
    setShoppingList(calculateShoppingList(recipe))
  }, [recipe])

  useEffect(() => {
    if (!recipe) {
      return
    }
    setTools(calculateToolList(recipe))
  }, [recipe])

  useEffect(() => {
    if (!recipe || (!isHost && connections.length < 2)) {
      return
    }

    let newTimelines = []
    for (let i = 0; i < connections.length; ++i) {
      newTimelines.push([])
      newTimelines.push([])
      newTimelines.push([])
    }
    const finalOutputId = findFinalOutputId(recipe)
    const lastTask = findTaskProducing(recipe, finalOutputId)

    let xPathResult = recipe.evaluate(
      '(//task|//ingredient|//tool)',
      recipe,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    )
    for (let i = 0; i < xPathResult.snapshotLength; ++i) {
      const node = xPathResult.snapshotItem(i)
      node.setAttribute('uuid', uuidV4())
    }

    console.log('recipe', new XMLSerializer().serializeToString(recipe))

    const ingredientsAndTools = []
    xPathResult = recipe.evaluate(
      '(//ingredient|//tool)[@uuid]',
      recipe,
      null,
      XPathResult.UNORDERED_NODE_ITERATOR_TYPE,
      null
    )
    let node = xPathResult.iterateNext()
    while (node) {
      ingredientsAndTools.push(node.getAttribute('uuid'))
      node = xPathResult.iterateNext()
    }
    setTasksCompleted(ingredientsAndTools)

    console.log(`Calculating graph starting from ${lastTask.getAttribute('operation')}`, newTimelines)

    scheduleItemsInTimelines(recipe, { [finalOutputId]: { task: lastTask, count: 1 /*TODO: scale*/ } }, newTimelines, 0)
    window.timelines = timelines
    setTimelines(newTimelines)
    setRecipeDuration(newTimelines.reduce((acc, items) => Math.min(acc, items[items.length - 1]?.start), 0))
    const ownLane = connections.findIndex(({ id }) => id === ownId)
    if (ownLane !== -1) {
      setOwnLane(ownLane)
      setCurrentTimeline(ownLane)
      const nextTask = newTimelines[ownLane].findLastIndex((task) => !completedTasks.includes(task.uuid))
      setCurrentTask(nextTask)
      setSelectedTask({ task: nextTask, timeline: ownLane })
    }

    setSetupDone(true)
  }, [recipe, connections])

  const dependencyGraph = timelines.reduce(
    (g, timeline) => {
      timeline.forEach(({ uuid, title, inputs }) => {
        g?.nodes.push({ uuid, title })
        inputs.forEach((iuuid) => g?.links.push({ source: iuuid, target: uuid }))
      })
      return g
    },
    { nodes: [], links: [] }
  )

  console.log({ dependencyGraph })

  const nameLabelWidth = 200
  const width = Math.max(...timelines.map((timeline) => -(timeline[timeline.length - 1]?.start ?? 0))) + nameLabelWidth

  const selectedTimeline = selectedTask.timeline
  const position = formatTime(-(recipeDuration - timelines[selectedTimeline][selectedTask.task]?.start))
  const timeUntilFinished = formatTime(timelines[selectedTimeline][selectedTask.task]?.start)

  const height = laneHeight * timelines.length
  const task = timelines[selectedTimeline][selectedTask.task]
  const ownTimeline = timelines[ownLane]
  const ownTasks = R.reverse(ownTimeline)
  const pendingInputs = task?.inputs?.filter(({ uuid }) => !completedTasks.includes(uuid))
  // TODO: get participants and outputs for inputs
  const inputsForTask = task?.inputs?.map(({ uuid, name }) => {
    let uuidMatches = (s) => s.uuid === uuid
    const timelineIndex = timelines.findIndex((t) => t.some(uuidMatches)) // This should probably use the uuid instead of the id
    // Perhaps it would be possible to fetch the output name from the task?
    // How to ensure the referenced output is the correct one?
    return {
      uuid,
      input: name,
      participant: timelineIndex === ownLane ? null : connections[timelineIndex]?.name,
    }
  })
  const joinSessionLink = `${baseUrl}?session=${sessionId}`
  const ownLaneSelected = selectedTimeline === ownLane
  const selectedTimelineOwner = connections[selectedTimeline]?.name
  const inputsReady = pendingInputs?.length === 0
  return (
    <div className="App" style={{ minHeight: '100vh', overflow: 'hidden' }}>
      {/*
      <ForceGraph2D
        graphData={dependencyGraph}
        nodeAutoColorBy="group"
        nodeCanvasObject={(node, ctx, globalScale) => {
          const label = node.title
          const fontSize = 12 / globalScale
          ctx.font = `${fontSize}px Sans-Serif`
          const textWidth = ctx.measureText(label).width
          const bckgDimensions = [textWidth, fontSize].map((n) => n + fontSize * 0.2) // some padding

          ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
          ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, ...bckgDimensions)

          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = node.color
          ctx.fillText(label, node.x, node.y)

          node.__bckgDimensions = bckgDimensions // to re-use in nodePointerAreaPaint
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          ctx.fillStyle = color
          const bckgDimensions = node.__bckgDimensions
          bckgDimensions &&
            ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, ...bckgDimensions)
        }}
      />*/}
      {!nameSet ? (
        <NameInput {...{ setName, name, updateName, setNameSet }} />
      ) : (
        <>
          <div style={{ marginBottom: '4em' }}>
            {currentState === 'settings' && (
              <Settings
                {...{ title, setupDone, connections, setName, joinSessionLink, setShareLinkCopied, shareLinkCopied }}
              />
            )}
            {currentState === 'shopping' && <Shopping {...{ shoppingList }} />}
            {currentState === 'tools' && <Tools {...{ tools }} />}
            {currentState === 'cooking' && (
              <>
                <div className="container">
                  <h2 className={'title'}>Timeline</h2>
                  <div style={{ overflowX: 'auto' }}>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox={`0 0 ${width} ${height}`}
                      style={{
                        width: width * zoom,
                        height: `100%`,
                        border: '1px solid black',
                        marginBottom: 20,
                      }}
                    >
                      {timelines.map((timeline, timelineNumber) => {
                        const y = timelineNumber * laneHeight

                        return (
                          <>
                            <text x={0} y={y + laneHeight / 2} style={{ fontSize: Math.round(laneHeight / 2) }}>
                              {connections[timelineNumber]?.name}
                            </text>
                            {timeline.map(({ start, end, title, uuid }, i) => {
                              const currentTimelineIsOwn = timelineNumber === ownLane
                              return (
                                <rect
                                  key={uuid}
                                  width={end - start}
                                  height={laneHeight}
                                  x={width + start}
                                  y={y}
                                  onClick={() => {
                                    setCurrentTimeline(timelineNumber)
                                    setSelectedTask({
                                      task: i,
                                      timeline: timelineNumber,
                                    })
                                  }}
                                  style={{
                                    fill:
                                      currentTimelineIsOwn && i === currentTask
                                        ? 'rgb(200,200,255)'
                                        : timelineNumber === selectedTimeline && i === selectedTask.task
                                        ? 'rgb(255,200,200)'
                                        : completedTasks.includes(uuid)
                                        ? 'rgb(240,255,240)'
                                        : 'rgb(240,240,255)',
                                    strokeWidth: 3,
                                    rx: 5,
                                    ry: 5,
                                    stroke: 'rgb(0,0,0)',
                                  }}
                                />
                              )
                            })}
                          </>
                        )
                      })}
                    </svg>
                  </div>
                </div>
                <div className="container">
                  {timelines[0]?.length > 0 && (
                    <>
                      <h2 className="title">{ownLaneSelected ? 'My tasks' : `${selectedTimelineOwner}'s tasks`}</h2>
                      {!ownLaneSelected && (
                        <Task
                          {...{
                            task,
                            isCurrent: false,
                            inputsReady,
                            pendingInputs,
                            inputsForTask,
                            recipe,
                            timeUntilFinished,
                          }}
                        />
                      )}
                      {ownLaneSelected &&
                        ownTasks.map((task, i) => (
                          <>
                            <Task
                              {...{
                                task,
                                isCurrent: i === timelines[ownLane].length - currentTask - 1,
                                inputsReady,
                                pendingInputs,
                                inputsForTask,
                                recipe,
                                timeUntilFinished,
                                markCurrentTaskDone,
                              }}
                            />
                            <hr />
                          </>
                        ))}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
      <div className={'nav'}>
        <div
          className={`nav-item clickable ${currentState === 'settings' ? 'nav-item_current' : ''}`}
          onClick={() => selectTab('settings')}
        >
          Settings
        </div>
        <div
          className={`nav-item clickable ${currentState === 'shopping' ? 'nav-item_current' : ''}`}
          onClick={() => selectTab('shopping')}
        >
          Shopping list
        </div>
        <div
          className={`nav-item clickable ${currentState === 'tools' ? 'nav-item_current' : ''}`}
          onClick={() => selectTab('tools')}
        >
          Tools
        </div>
        <div
          className={`nav-item clickable ${currentState === 'cooking' ? 'nav-item_current' : ''}`}
          onClick={() => selectTab('cooking')}
        >
          Tasks
        </div>
      </div>
    </div>
  )
}

export default App
