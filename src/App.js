import './reset.css'
import './App.css'
//import xml_data from "./recipe/buns";
import xml_data from './recipe/layer-cake'
//import xml_data from './recipe/debug-cake'
import { useEffect, useRef, useState } from 'react'
import { calculateToolList, findFinalOutputId, findTaskProducing, getInstructions } from './recipeTools'
import { calculateShoppingList } from './shoppingListGenerator'
import { expandNode, scheduleItemsInTimelines } from './timelineScheduler'
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
          You can call me{' '}
          <input name={'name'} style={{ fontSize: 16 }} onChange={(e) => setName(e.target.value)} value={name} />
        </label>
        <br />
        <button
          className="button button-push_button-primary button-push_button-large"
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

function Settings({
  title,
  setupDone,
  connections,
  setName,
  joinSessionLink,
  setShareLinkCopied,
  shareLinkCopied,
  restart,
  isHost,
}) {
  return (
    <div className={'container'} style={{ marginBottom: 100 }}>
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
        <p>
          {isHost && (
            <button className="button button-push_button-large button-push_button-primary" onClick={() => restart()}>
              Restart
            </button>
          )}
        </p>
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

function Task(props) {
  if (props === undefined) return ''
  const {
    task,
    isDone,
    isCurrent,
    inputsReady,
    pendingInputs,
    inputsForTask,
    recipe,
    timeUntilFinished,
    setTasksInProgress,
    tasksInProgress,
    markCurrentTaskDone,
    startTimer,
    jumpToNextTask,
  } = props
  return (
    <>
      <h3 id={task.uuid} style={{ scrollMarginTop: 10 }}>
        {task?.title} {isCurrent && '👈'}
        {isDone && '✅'}
      </h3>
      <>
        {isCurrent && !inputsReady && (
          <>
            Wait for: <br />
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
        {isCurrent && inputsForTask.length > 0 && (
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
        {!isDone && <p>Estimated task duration: {formatTime(task.duration)}</p>}
        {isCurrent && (
          <p>
            <small>Time until finished: {timeUntilFinished}</small>
          </p>
        )}
        {!isHost && !isDone && isCurrent && inputsReady && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            <button
              className={'button button-push_button-primary button-push_button-large'}
              onClick={async () => {
                if (task.timer) {
                  startTimer(task)
                  setTasksInProgress([...tasksInProgress, task.uuid])
                  jumpToNextTask()
                } else {
                  await markCurrentTaskDone()
                }
              }}
            >
              {task.timer ? 'Start timer' : 'Done, next!'}
            </button>
          </div>
        )}
      </>
    </>
  )
}

function Timeline(props) {
  if (props === undefined) return ''
  const {
    width,
    height,
    timelines,
    connections,
    ownLane,
    setCurrentTimeline,
    setSelectedTask,
    scrollToIndex,
    currentTask,
    selectedTimeline,
    selectedTask,
    completedTasks,
  } = props
  return (
    <div
      style={{
        bottom: 40,
        width: '100%',
        backgroundColor: '#eee',
        margin: 0,
        padding: 10,
        boxSizing: 'border-box',
        position: 'fixed',
      }}
    >
      <div style={{ overflowX: 'auto' }}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`0 0 ${width} ${height}`}
          style={{
            width: width * zoom,
            height: `100%`,
            border: '0px solid black',
            marginBottom: 15,
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
                        scrollToIndex(i)
                      }}
                      style={{
                        fill:
                          currentTimelineIsOwn && i === currentTask
                            ? 'rgb(200,200,255)'
                            : !isHost && timelineNumber === selectedTimeline && i === selectedTask.task
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
  )
}

function Timers({ timers, scrollToTask, clearTimer, completedTasks, markTaskCompleted }) {
  const [currentTime, setCurrentTime] = useState(Date.now())

  useEffect(() => {
    timers
      .filter(({ end }) => end - currentTime < 0)
      .map(({ taskUuid }) => !completedTasks.includes(taskUuid) && markTaskCompleted(taskUuid))

    const intervalId = setInterval(() => {
      setCurrentTime(Date.now())
    }, 1000)

    return () => clearInterval(intervalId)
  }, [currentTime, timers])

  return (
    <div style={{ position: 'fixed', bottom: 110, right: 10, display: 'flex', flexDirection: 'column' }}>
      {timers.map(({ title, end, taskUuid }, i) => {
        const timeLeft = Math.max(0, (end - currentTime) / 1000)
        return (
          <div
            key={`timer-${taskUuid}`}
            className={timeLeft === 0 ? 'wiggle' : ''}
            style={{
              width: '7em',
              background: timeLeft === 0 ? '#f99' : 'white',
              borderRadius: 6,
              marginBottom: '0.5em',
              padding: '0.5em',
              boxShadow: '2px 2px 10px rgba(0, 0, 0, 0.2)',
              textAlign: 'center',
              cursor: 'pointer',
            }}
            onClick={() => {
              if (timeLeft === 0) {
                clearTimer(i)
                // TODO: Need to jump to a previous task, if the current is blocked and a previous is unlocked
              } else {
                scrollToTask(taskUuid)
              }
            }}
          >
            <div style={{ fontSize: '75%' }}>{title}</div>
            <div>
              {timeLeft === 0 ? (
                <>
                  <div>Ready!</div>
                  <div style={{ fontSize: '75%' }}>Click to clear</div>
                </>
              ) : (
                formatTime(timeLeft)
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function App() {
  const settings = JSON.parse(window.localStorage.getItem(sessionId)) || {}

  const [title, setTitle] = useState('')
  const [shoppingList, setShoppingList] = useState([])
  const [tools, setTools] = useState([])
  const [timelines, setTimelines] = useState([[]])
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
  const [currentState, setCurrentState] = useState(settings.tab || 'cooking')
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
  const [tasksInProgress, setTasksInProgress] = useState(settings.tasksInProgress || [])
  const [timers, setTimers] = useState([])

  const concatCompletedTasks = (completed) => {
    const merged = Array.from(new Set([...completedTasksRef.current, ...completed]))
    setTasksCompleted(merged)
  }

  const setTasksCompleted = (completed) => {
    console.log({ completed })
    // TODO: use uuids
    window.localStorage.setItem(sessionId, JSON.stringify({ ...settings, completedTasks: completed }))
    completedTasksRef.current = completed
    _setCompletedTasks(completed)
  }

  const scrollToTask = (uuid) =>
    document.getElementById(uuid).scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'start' })

  const scrollToIndex = (taskIndex) => {
    const uuid = timelines[selectedTimeline][taskIndex].uuid
    scrollToTask(uuid)
  }

  const startTimer = ({ timer: { duration, title }, uuid }) => {
    const newTimers = [{ end: Date.now() + duration * 1000, taskUuid: uuid, title }, ...timers]
    setTimers(newTimers)
  }

  const clearTimer = async (index) => {
    let newTimers = timers.slice()
    newTimers.splice(index, 1)
    setTimers(newTimers)
  }

  async function markTaskCompleted(uuid) {
    setTasksCompleted([...completedTasksRef.current, uuid])
    setTasksInProgress(R.without([uuid], tasksInProgress))
    if (isHost) {
      await sendCompletedTasks()
    } else {
      await sendTaskCompleted(uuid)
    }
  }

  const markCurrentTaskDone = async () => {
    const currentTaskItem = timelines[currentTimeline][currentTask]
    await markTaskCompleted(currentTaskItem.uuid)
    // TODO: Need to jump to next task not completed
    const startedTasks = [...completedTasksRef.current, ...tasksInProgress]
    const nextTask = R.findLastIndex((task) => !startedTasks.includes(task.uuid), timelines[currentTimeline])
    console.log({ currentTask, nextTask })
    setCurrentTask(nextTask)
    scrollToIndex(nextTask)
    setSelectedTask({ task: nextTask, timeline: ownLane })
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
        console.log({ data })
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
          const taskUuid = json.data
          setTasksCompleted([...completedTasksRef.current, taskUuid])
          setCurrentTask(tasks.findIndex(({ uuid }) => uuid === taskUuid))
          scrollToTask(taskUuid)
          await sendCompletedTasks()
        }
      }).bind(null, connectionId)
    )
  }

  const handleOpen = () => {
    connectionRef.current.send(JSON.stringify({ type: 'init' }))
    sendName()
    connectionRef.current.on('data', (data) => {
      console.log({ data }, 1)
      const json = JSON.parse(data)
      if (json.type === 'connections') {
        setConnections(json.data)
      } else if (json.type === 'completedTasks') {
        // TODO: Need to jump to a previous task that was blocked if current task is blocked
        setTasksCompleted(json.data)
      }
    })
  }

  const restart = async () => {
    setTasksCompleted([])
    await sendCompletedTasks()
  }

  useEffect(() => {
    /*
    try {
      navigator.wakeLock.request('screen').catch((err) => {
        console.error(`${err.name}, ${err.message}`)
      })
    } catch (err) {
      console.error(`${err.name}, ${err.message}`)
    }*/
  }, [])

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
    if (!recipe || connections.length < 2) {
      return
    }

    let newTimelines = []
    for (let i = 1; i < connections.length; ++i) {
      newTimelines.push([])
    }
    const finalOutputId = findFinalOutputId(recipe)
    const lastTask = findTaskProducing(recipe, finalOutputId)

    let xPathResult = recipe.evaluate('(//task)', recipe, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
    for (let i = 0; i < xPathResult.snapshotLength; ++i) {
      const node = xPathResult.snapshotItem(i)
      expandNode(recipe, node)
    }

    xPathResult = recipe.evaluate(
      '(//task|//ingredient|//tool|//ns:task)',
      recipe,
      function (prefix) {
        if (prefix === 'ns') {
          return 'http://www.w3.org/1999/xhtml'
        } else {
          return null
        }
      },
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    )
    for (let i = 0; i < xPathResult.snapshotLength; ++i) {
      const node = xPathResult.snapshotItem(i)
      node.setAttribute('uuid', i)
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
    concatCompletedTasks([ingredientsAndTools])

    console.log(`Calculating graph starting from ${lastTask.getAttribute('operation')}`, newTimelines)

    // TODO: The pour operation is duplicated in the timeline!
    scheduleItemsInTimelines(
      recipe,
      [{ uuid: finalOutputId, task: lastTask, amountLeft: 1 /*TODO: scale*/ }],
      newTimelines,
      0
    )

    window.timelines = newTimelines
    setTimelines(newTimelines)
    setRecipeDuration(newTimelines.reduce((acc, items) => Math.min(acc, items[items.length - 1]?.start), 0))
    const startedTasks = [...completedTasksRef.current, ...tasksInProgress]
    if (isHost) {
      // TODO: remove duplication
      setOwnLane(undefined)
      setCurrentTimeline(0)
      const nextTask = R.findLastIndex((task) => !startedTasks.includes(task.uuid), newTimelines[0])
      setCurrentTask(nextTask)
      setSelectedTask({ task: nextTask, timeline: 0 })
    } else {
      const ownLane = connections.findIndex(({ id }) => id === ownId) - 1
      if (ownLane !== -1) {
        setOwnLane(ownLane)
        setCurrentTimeline(ownLane)
        const nextTask = R.findLastIndex((task) => !startedTasks.includes(task.uuid), newTimelines[ownLane])
        setCurrentTask(nextTask)
        setSelectedTask({ task: nextTask, timeline: ownLane })
      }
    }

    setSetupDone(true)
  }, [recipe, connections])

  const dependencyGraph = timelines.reduce(
    (g, timeline) => {
      timeline.forEach(({ uuid, title, dependencies }) => {
        g?.nodes.push({ uuid, title })
        dependencies.forEach((iuuid) => g?.links.push({ source: iuuid, target: uuid }))
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
  const timeUntilFinished = formatTime(-timelines[selectedTimeline][selectedTask.task]?.start)

  const height = laneHeight * timelines.length
  const task = timelines[selectedTimeline][selectedTask.task]
  console.log({ task, selected: selectedTask })

  let timeline
  let tasks

  if (isHost) {
    timeline = timelines.flat()
    tasks = timeline.sort(({ start: a }, { start: b }) => a - b)
  } else {
    timeline = timelines[selectedTimeline]
    tasks = R.reverse(timeline)
  }
  const pendingInputs = task?.dependencies?.filter(({ uuid }) => !completedTasks.includes(uuid))
  // TODO: get participants and outputs for inputs
  const inputsForTask = task?.dependencies?.map(({ uuid, input: { name } }) => {
    let uuidMatches = (s) => s.uuid === uuid
    const timelineIndex = timelines.findIndex((t) => t.some(uuidMatches)) // This should probably use the uuid instead of the id
    // Perhaps it would be possible to fetch the output name from the task?
    // How to ensure the referenced output is the correct one?
    return {
      uuid,
      input: name,
      participant: timelineIndex === ownLane ? null : connections[timelineIndex + 1]?.name,
    }
  })
  const joinSessionLink = `${baseUrl}?session=${sessionId}`
  const ownLaneSelected = selectedTimeline === ownLane
  const selectedTimelineOwner = connections[selectedTimeline + 1]?.name
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
          <div style={{ marginBottom: '4em', width: '100%', position: 'absolute' }}>
            {currentState === 'settings' && (
              <Settings
                {...{
                  title,
                  setupDone,
                  connections,
                  setName,
                  joinSessionLink,
                  setShareLinkCopied,
                  shareLinkCopied,
                  restart,
                  isHost,
                }}
              />
            )}
            {currentState === 'shopping' && <Shopping {...{ shoppingList }} />}
            {currentState === 'tools' && <></>}
            {currentState === 'cooking' && (
              <>
                <div className="container" style={{ top: height + 40, marginBottom: 260 }}>
                  {timelines[0]?.length === 0 ? (
                    'Waiting for connections'
                  ) : (
                    <>
                      <h2 className="title">
                        {ownLaneSelected ? 'My tasks' : isHost ? 'Tasks' : `${selectedTimelineOwner}'s tasks`}
                      </h2>
                      {tasks.map((task, i) => {
                        // TODO: why -1
                        const currentTaskIndex = timelines[selectedTimeline].length - currentTask - 1
                        return (
                          <>
                            <Task
                              {...{
                                task,
                                isDone: completedTasks.includes(task.uuid),
                                isCurrent: !isHost && i === currentTaskIndex,
                                inputsReady,
                                pendingInputs,
                                inputsForTask,
                                recipe,
                                timeUntilFinished,
                                setTasksInProgress,
                                tasksInProgress,
                                completedTasks,
                                markCurrentTaskDone,
                                startTimer,
                                currentTask,
                                setCurrentTask,
                                jumpToNextTask: () => {
                                  const nextTask =
                                    R.findLastIndex(
                                      (task) => ![...completedTasksRef.current, ...tasksInProgress].includes(task.uuid),
                                      timelines[ownLane]
                                    ) - 1 // TODO: Why -1 tho?
                                  // TODO: Scroll to current
                                  setCurrentTask(nextTask)
                                  setSelectedTask({ task: nextTask, timeline: ownLane })
                                  scrollToIndex(nextTask)
                                },
                              }}
                            />
                            <hr />
                          </>
                        )
                      })}
                    </>
                  )}
                </div>
                <Timeline
                  {...{
                    width,
                    height,
                    timelines,
                    connections: connections.slice(1),
                    ownLane,
                    setCurrentTimeline,
                    setSelectedTask,
                    scrollToIndex,
                    currentTask,
                    selectedTimeline,
                    selectedTask,
                    completedTasks,
                  }}
                />
              </>
            )}
          </div>
          <Timers {...{ timers, scrollToTask, clearTimer, markTaskCompleted, completedTasks }} />
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
