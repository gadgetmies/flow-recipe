/*

TODO:
* Remove duplication from cucumber grating
* Instructions (collaborate, measure into a bowl)
* Tool for measure
* Numbering for measurements -> number cups
* Add "Ask for help" button
* Multiple end results -> jokes (gt, sandwich) (perhaps a virtual last step?)

*/

import './reset.css'
import './App.css'
//import xml_data from "./recipe/buns";
//import xml_data from './recipe/layer-cake'
//import xml_data from './recipe/debug-cake'
import xml_data from './recipe/bday-cake'
import { useEffect, useRef, useState } from 'react'
import { calculateToolList, findFinalOutputId, findTaskProducing, getInstructions } from './recipeTools'
import { calculateShoppingList } from './shoppingListGenerator'
import { expandNode, scheduleItemsInTimelines } from './timelineScheduler'
import { v4 as uuidV4 } from 'uuid'
import Peer from 'peerjs'
import { ForceGraph2D } from 'react-force-graph'
import * as R from 'ramda'
import QRCodeSVG from 'qrcode.react'
import {
  BottomNavigation,
  BottomNavigationAction,
  Box,
  Button,
  Card,
  CardContent,
  Container,
  createTheme,
  CssBaseline,
  Fab,
  Grid2,
  List,
  ListItem,
  Paper,
  Stack,
  TextField,
  ThemeProvider,
  Typography,
} from '@mui/material'
import SettingsIcon from '@mui/icons-material/Settings'
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart'
import ChecklistIcon from '@mui/icons-material/Checklist'
import WavingHandIcon from '@mui/icons-material/WavingHand'
import { pink, purple } from '@mui/material/colors'

const queryParams = new Proxy(new URLSearchParams(window.location.search), {
  get: (searchParams, prop) => searchParams.get(prop),
})

const getSettings = (sessionId) => JSON.parse(window.localStorage.getItem(sessionId)) || {}
const appendSessionSettings = (sessionId, settings) => {
  window.localStorage.setItem(sessionId, JSON.stringify({ ...getSettings(sessionId), ...settings }))
}

const baseUrl = window.location.href.split(/[?#]/)[0]
const sessionId = queryParams.session || uuidV4()

let storedParticipantId = getSettings(sessionId).participantId
if (!storedParticipantId) {
  storedParticipantId = queryParams.session ? uuidV4() : '0'
  appendSessionSettings(sessionId, { participantId: storedParticipantId })
}

const participantId = storedParticipantId
const isHost = participantId === '0'

window.history.replaceState({ sessionId }, 'Flow Recipe', `${baseUrl}?session=${sessionId}`)

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

const NameDialog = ({ name, setName, setNameSet, updateName }) => (
  <Grid2 container padding={2} direction="column" alignItems="center" justify="center" style={{ minHeight: '100vh' }}>
    <Grid2 item xs={3}>
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Typography gutterBottom variant="h5" component="div">
              Set your name
            </Typography>
            <TextField name={'name'} label="name" onChange={(e) => setName(e.target.value)} value={name} />
            <Button
              variant="contained"
              disabled={name === ''}
              onClick={() => {
                setNameSet(true)
                appendSessionSettings(sessionId, { name })
                window.localStorage.setItem('global-settings', JSON.stringify({ defaultName: name }))
                updateName(name)
              }}
            >
              Let's begin!
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Grid2>
  </Grid2>
)

function Settings({
  title,
  setupDone,
  connections,
  name,
  setName,
  updateName,
  joinSessionLink,
  setShareLinkCopied,
  shareLinkCopied,
  restart,
  isHost,
  connectionId,
}) {
  return (
    <Box paddingBottom={9}>
      <Stack spacing={2}>
        <Typography variant="h6">Recipe: {title}</Typography>
        <Card>
          <CardContent>
            <Typography variant="h6">Participants</Typography>
            <List>
              {!setupDone
                ? 'Connecting...'
                : connections.map(({ name: connectionName, id }) => (
                    <ListItem key={id}>
                      {connectionId === id ? (
                        <TextField
                          name="name"
                          label="your name"
                          value={name}
                          onChange={(e) => {
                            // TODO: should this use a ref, because the updates come from the peer?
                            const newName = e.target.value
                            console.log({ name: newName })
                            setName(newName)
                            updateName(newName)
                          }}
                        />
                      ) : (
                        connectionName + (id === '0' ? ' (Host)' : '')
                      )}
                    </ListItem>
                  ))}
            </List>
          </CardContent>
        </Card>
        <Card
          padding={2}
          color="primary"
          variant="solid"
          sx={{ borderRadius: 2, width: 'fit-content', backgroundColor: 'primary.main' }}
        >
          <CardContent>
            <Stack justifyContent="center" alignItems="center" spacing={2}>
              <Typography variant="h6" color="white">
                Invite participants
              </Typography>
              <QRCodeSVG value={joinSessionLink} fgColor={'white'} bgColor={'transparent'} />
              <Button
                variant="outlined"
                sx={{ color: 'white', borderColor: 'white' }}
                onClick={() => {
                  navigator.clipboard.writeText(joinSessionLink)
                  setShareLinkCopied(true)
                  window.setTimeout(() => setShareLinkCopied(false), 2000)
                }}
              >
                {shareLinkCopied ? 'Link copied!' : 'Copy link'}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Stack>
      <p>
        {isHost && (
          <Button variant="contained" onClick={() => restart()}>
            Restart
          </Button>
        )}
      </p>
    </Box>
  )
}

function Shopping({ shoppingList }) {
  return (
    <Box>
      {shoppingList ? (
        <List>
          {Object.entries(shoppingList).map(([name, { amount, unit }], i) => (
            <ListItem key={`${name}-${i}`}>
              {amount} {unit} {name}
            </ListItem>
          ))}
        </List>
      ) : null}
    </Box>
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
    timelines,
    isDone,
    isCurrent,
    inputsReady,
    pendingInputs,
    inputsForTask,
    recipe,
    timeUntilFinished,
    setTasksInProgress,
    tasksInProgress,
    markTaskDone,
    markCurrentTaskDone,
    startTimer,
    jumpToNextTask,
    isHost,
  } = props
  const id = 'task' + task.uuid
  return (
    <Card sx={{ opacity: isCurrent || isHost ? 1 : 0.5 }} id={id} style={{ scrollMarginTop: 50 }} key={id}>
      {/*TODO: Why does the scroll margin top not work?*/}
      <CardContent>
        <Typography variant="h4" gutterBottom>
          {task?.title} {isCurrent && '👈'}
          {isDone && '✅'}
        </Typography>
        <Stack spacing={2}>
          {isCurrent && !inputsReady && (
            <>
              Wait for: <br />
              <ul>
                {pendingInputs
                  .map(({ uuid: pi }) => inputsForTask.find((i) => i.uuid === pi))
                  .map(({ input, participant }) => (
                    <li key={input}>
                      {input} {participant !== null && `from ${participant}`}
                    </li>
                  ))}
              </ul>
            </>
          )}
          {isCurrent && inputsForTask.length > 0 && (
            <>
              Get: <br />
              <ul>
                {inputsForTask.map(({ participant, input }) => (
                  <li key={input}>
                    {input} {participant !== null && `from ${participant}`}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p>{getInstructions(recipe, task)}</p>
          {!isDone && <Typography variant="subtitle2">Estimated task duration: {formatTime(task.duration)}</Typography>}
          {/* isCurrent && <Typography variant="subtitle2">Time until finished: {timeUntilFinished}</Typography> */}
          {!isDone && (isHost || (isCurrent && inputsReady)) && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <Button
                variant="contained"
                onClick={async () => {
                  if (isHost) {
                    const [timeline, taskIndex] = timelines.flatMap((timeline, i) => {
                      const taskIndex = timeline.indexOf(task)
                      return taskIndex !== -1 ? [i, taskIndex] : []
                    })
                    markTaskDone(timeline, taskIndex)
                  } else if (task.timer) {
                    startTimer(task)
                    setTasksInProgress([...tasksInProgress, task.uuid])
                    jumpToNextTask()
                  } else {
                    await markCurrentTaskDone()
                  }
                }}
              >
                {isHost ? 'Mark done' : task.timer ? 'Start timer' : 'Done, next!'}
              </Button>
            </div>
          )}
        </Stack>
      </CardContent>
    </Card>
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
    <Box
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        pb: 7,
        background: 'white',
        borderTop: '1px solid #eee',
        boxShadow: 3,
      }}
      padding={2}
    >
      <div style={{ overflowX: 'auto' }} className={'hide-scrollbar'}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`0 0 ${width} ${height}`}
          style={{
            width: width * zoom,
            height: `100%`,
            border: '0px solid black',
            marginBottom: 5,
          }}
        >
          {timelines.map((timeline, timelineNumber) => {
            const y = timelineNumber * laneHeight

            return [
              <text
                x={0}
                y={y + laneHeight / 2 + 10}
                style={{ fontSize: Math.round(laneHeight / 3) }}
                key={timelineNumber + connections[timelineNumber]?.name}
              >
                {connections[timelineNumber]?.name}
              </text>,
              timeline.map(({ start, end, title, uuid }, i) => {
                const currentTimelineIsOwn = timelineNumber === ownLane
                return (
                  <rect
                    id={'timeline' + uuid}
                    key={'timeline' + uuid}
                    width={end - start - 10}
                    height={laneHeight - 10}
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
                      fill: completedTasks.includes(uuid)
                        ? '#1ee9a5'
                        : currentTimelineIsOwn && i === currentTask
                        ? '#e91e63'
                        : currentTimelineIsOwn
                        ? 'rgba(233, 30, 99, 0.5)'
                        : !isHost && timelineNumber === selectedTimeline && i === selectedTask.task
                        ? 'rgb(255,200,200)'
                        : 'rgb(217,217,217)',
                      rx: 10,
                      ry: 10,
                    }}
                  />
                )
              }),
            ]
          })}
        </svg>
      </div>
    </Box>
  )
}

function Timers({
  timers,
  scrollToTask,
  clearTimer,
  completedTasks,
  markTaskCompleted,
  setHelpRequest,
  helpRequested,
  helpRequests,
  ownName,
}) {
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
      {Array.from(helpRequests)
        .filter((name) => name !== ownName)
        .map((name) => (
          <Fab color="primary" aria-label="add" className={'wiggle'} variant="extended" sx={{ margin: 1 }}>
            <WavingHandIcon sx={{ mr: 1 }} />
            {name}
          </Fab>
        ))}
      {!isHost && (
        <Fab
          color="primary"
          aria-label="add"
          onClick={(e) => {
            e.target.blur()
            return setHelpRequest(!helpRequested);
          }}
          className={helpRequested ? 'wiggle' : ''}
        >
          <WavingHandIcon />
        </Fab>
      )}
    </div>
  )
}

const theme = createTheme({
  palette: {
    background: {
      default: '#e7ecf8',
    },
    primary: pink,
    secondary: purple,
  },
})

function App() {
  const settings = getSettings(sessionId)

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
  const [name, setName] = useState(settings?.name || globalSettings?.defaultName || '')
  const [nameSet, setNameSet] = useState(name !== '')
  const [shareLinkCopied, setShareLinkCopied] = useState(false)
  const [currentState, setCurrentState] = useState(settings.tab || isHost ? 'settings' : 'cooking')

  const connectionsRef = useRef([{ id: hostId, name }])
  const [connections, _setConnections] = useState(connectionsRef.current)
  const nextConnectionNumberRef = useRef(1)
  const [nextConnectionNumber, _setNextConnectionNumber] = useState(nextConnectionNumberRef.current)
  const [setupDone, setSetupDone] = useState(isHost)
  const completedTasksRef = useRef(settings.completedTasks || [])
  const [completedTasks, _setCompletedTasks] = useState(completedTasksRef.current)
  const [tasksInProgress, setTasksInProgress] = useState(settings.tasksInProgress || [])
  const [timers, setTimers] = useState([])

  const helpRequestsRef = useRef(new Set())
  const [helpRequests, _setHelpRequests] = useState(helpRequestsRef.current)
  const [helpRequested, setHelpRequested] = useState(false)

  const selectTab = (tab) => {
    setCurrentState(tab)
    appendSessionSettings(sessionId, { tab })
  }

  const concatCompletedTasks = (completed) => {
    const merged = Array.from(new Set([...completedTasksRef.current, ...completed]))
    setTasksCompleted(merged)
  }

  const setTasksCompleted = (completed) => {
    // TODO: use uuids
    appendSessionSettings(sessionId, { completedTasks: completed })
    completedTasksRef.current = completed
    _setCompletedTasks(completed)
  }

  const scrollToTask = (uuid) => {
    console.log(
      'scrolling to ' + uuid,
      document.getElementById('task' + uuid),
      document.getElementById('timeline' + uuid)
    )

    // TODO: how to enable smooth scrolling for both?
    // TODO: why does this fail without .? on reset?
    document.getElementById('timeline' + uuid)?.scrollIntoView({ inline: 'center' })
    setTimeout(
      () =>
        document.getElementById('task' + uuid)?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'start' }),
      100
    )
  }

  const scrollToIndex = (taskIndex) => {
    const uuid = window.timelines[selectedTimeline][taskIndex].uuid
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

  const findNextTask = (timeline) => {
    const startedTasks = [...completedTasksRef.current, ...tasksInProgress]
    const nextTask = R.findLastIndex((task) => !startedTasks.includes(task.uuid), timelines[timeline])
    console.log({ task, nextTask })
    return nextTask
  }

  const markTaskDone = async (timeline, task) => {
    const taskItem = timelines[timeline][task]
    await markTaskCompleted(taskItem.uuid)
    // TODO: Need to jump to next task not completed
    const nextTask = findNextTask(timeline)
    scrollToIndex(nextTask)
    return nextTask
  }

  const markCurrentTaskDone = async () => {
    const nextTask = await markTaskDone(currentTimeline, currentTask)
    setCurrentTask(nextTask)
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
    console.log('sending connections', connectionsRef.current)
    await sendMessageToAllConnections({
      type: 'connections',
      data: connectionsRef.current.map(({ connection, ...rest }) => ({
        ...rest,
      })),
    })
  }

  const setHelpRequest = async (requested) => {
    setHelpRequested(requested)
    connectionRef.current.send(JSON.stringify({ type: 'askForHelp', data: requested }))
  }

  const setHelpRequests = (newHelpRequests) => {
    helpRequestsRef.current = newHelpRequests
    _setHelpRequests(newHelpRequests)
  }

  const sendTaskCompleted = (taskId) => {
    connectionRef.current.send(JSON.stringify({ type: 'taskCompleted', data: taskId }))
  }

  const sendCompletedTasks = async () => {
    console.log('sending completed tasks', completedTasksRef.current)
    await sendMessageToAllConnections({
      type: 'completedTasks',
      data: completedTasksRef.current,
    })
  }

  const sendHelpRequests = async () => {
    console.log('sending help requests', {
      type: 'helpRequests',
      data: Array.from(helpRequestsRef.current),
    })
    await sendMessageToAllConnections({
      type: 'helpRequests',
      data: Array.from(helpRequestsRef.current),
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
          await sendCompletedTasks()
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
          // TODO: make this select the last, not completed task
          setCurrentTask(tasks.findIndex(({ uuid }) => uuid === taskUuid))
          scrollToTask(taskUuid)
          await sendCompletedTasks()
        } else if (json.type === 'askForHelp') {
          const requester = connectionsRef.current.find(({ id }) => id === connectionId).name
          if (json.data) {
            setHelpRequests(new Set([...helpRequestsRef.current, requester]))
          } else {
            const newHelpRequests = helpRequestsRef.current
            newHelpRequests.delete(requester)
            setHelpRequests(newHelpRequests)
          }
          await sendHelpRequests()
        }
      }).bind(null, connectionId)
    )
  }

  const handleOpen = () => {
    connectionRef.current.send(JSON.stringify({ type: 'init' }))
    sendName()
    connectionRef.current.on('data', (data) => {
      console.log('on data', { data })
      const json = JSON.parse(data)
      if (json.type === 'connections') {
        setConnections(json.data)
      } else if (json.type === 'completedTasks') {
        // TODO: Need to jump to a previous task that was blocked if current task is blocked
        setTasksCompleted(json.data)
        // TODO: Figure out how to find out the uuid of the current task
        if (json.data.includes(currentTask)) {
          const nextTask = findNextTask(ownLane)
          setCurrentTask(nextTask)
          setSelectedTask({ task: nextTask, timeline: ownLane })
        }
        if (json.data.length === 0) {
          // reset
          setTasksInProgress([])
          setTimers([])
          const ownTimeline = window.timelines[ownLane]
          const firstTaskIndex = ownTimeline.length - 1
          setCurrentTask(firstTaskIndex)
          setSelectedTask({ task: firstTaskIndex, timeline: ownLane })
          appendSessionSettings(sessionId, { completedTasks: [] })
          scrollToIndex(firstTaskIndex)
        }
      } else if (json.type === 'helpRequests') {
        setHelpRequests(json.data)
      }
    })
  }

  const restart = async () => {
    setTasksCompleted([])
    appendSessionSettings(sessionId, { completedTasks: [] })
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
    console.log(connectionRef.current)
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

    //console.log('recipe', new XMLSerializer().serializeToString(recipe))

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
      [{ uuid: finalOutputId, task: lastTask, amountsLeft: { [finalOutputId]: 1 } /*TODO: scale*/ }],
      newTimelines,
      0
    )

    const duplicates = newTimelines
      .reduce((acc, curr) => [...curr, ...acc], [])
      .reduce(
        ({ duplicates, rest }, curr) => {
          if (rest.find(({ uuid }) => uuid === curr.uuid)) duplicates.push(curr)
          else rest.push(curr)
          return { duplicates, rest }
        },
        { duplicates: [], rest: [] }
      )
    if (duplicates.duplicates.length > 0) {
      console.error('Duplicate tasks found!', duplicates)
    }

    console.log({ newTimelines })

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
      const newOwnLane = connections.findIndex(({ id }) => id === ownId) - 1
      if (newOwnLane !== -1) {
        setOwnLane(newOwnLane)
        setCurrentTimeline(newOwnLane)
        const nextTask = R.findLastIndex((task) => !startedTasks.includes(task.uuid), newTimelines[newOwnLane])
        setCurrentTask(nextTask)
        setSelectedTask({ task: nextTask, timeline: newOwnLane })
      }
    }

    setSetupDone(true)
  }, [recipe, connections])

  const dependencyGraph = timelines.reduce(
    (g, timeline) => {
      timeline.forEach(({ uuid, title, dependencies }) => {
        g?.nodes.push({ id: uuid, title: `${uuid}-${title}` })
        dependencies.forEach(({ uuid: iuuid }) => g?.links.push({ source: iuuid, target: uuid }))
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
  //console.log({ task, selected: selectedTask })

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
  const debug = queryParams.query?.debug !== undefined
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container sx={{ minHeight: '100vh' }}>
        {debug && (
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
          />
        )}
        {!nameSet ? (
          <NameDialog {...{ setName, name, updateName, setNameSet }} />
        ) : (
          <>
            <div>
              {currentState === 'settings' && (
                <Settings
                  {...{
                    title,
                    setupDone,
                    connections,
                    name,
                    setName,
                    updateName,
                    joinSessionLink,
                    setShareLinkCopied,
                    shareLinkCopied,
                    restart,
                    isHost,
                    connectionId: p.current?.id,
                  }}
                />
              )}
              {currentState === 'shopping' && <Shopping {...{ shoppingList }} />}
              {currentState === 'tools' && <></>}
              {currentState === 'cooking' && (
                <>
                  <Box sx={{ pb: 20 }}>
                    <Box paddingY={2}>
                      {timelines[0]?.length === 0 ? (
                        'Waiting for connections'
                      ) : (
                        <Stack spacing={2}>
                          <Card>
                            <CardContent>
                              <Typography variant="h4" gutterBottom>
                                Instructions
                              </Typography>
                              <Stack spacing={2}>
                                <p>
                                  Your task is to create something wonderful with your friends by following the steps
                                  below. Please note that this is not a test of speed or skills, but of collaboration.
                                </p>
                                <p>
                                  The scheduling nor the recipe is very smart at the moment, so expect to have many cups
                                  and bowls used during the process. Tools, such as whisks, spatulas, spoons etc. might
                                  need to be reused, so please return those to the tool bowl when you have completed the
                                  step that required the use of the tool.
                                </p>
                                <p>
                                  In case you need assistance, you can raise your hand virtually by pressing the ✋
                                  -button in the lower left corner.
                                </p>
                                <p>Happy baking, have fun! 😊🧑‍🍳</p>
                              </Stack>
                            </CardContent>
                          </Card>
                          {/*}
                        <Typography variant="h1">
                          {ownLaneSelected ? 'My tasks' : isHost ? 'Tasks' : `${selectedTimelineOwner}'s tasks`}
                        </Typography>*/}
                          {tasks.map((task, i) => {
                            // TODO: why -1
                            const currentTaskIndex = timelines[selectedTimeline].length - currentTask - 1
                            return (
                              <Task
                                {...{
                                  task,
                                  timelines,
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
                                  markTaskDone,
                                  startTimer,
                                  currentTask,
                                  setCurrentTask,
                                  isHost,
                                  jumpToNextTask: () => {
                                    // TODO: is this the same as markCurrentTaskDone?
                                    const nextTask =
                                      R.findLastIndex(
                                        (task) =>
                                          ![...completedTasksRef.current, ...tasksInProgress].includes(task.uuid),
                                        timelines[ownLane]
                                      ) - 1 // TODO: Why -1 tho?
                                    // TODO: Scroll to current
                                    setCurrentTask(nextTask)
                                    setSelectedTask({ task: nextTask, timeline: ownLane })
                                    scrollToIndex(nextTask)
                                  },
                                }}
                              />
                            )
                          })}
                        </Stack>
                      )}
                    </Box>
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
                  </Box>{' '}
                  <Timers
                    {...{
                      timers,
                      scrollToTask,
                      clearTimer,
                      markTaskCompleted,
                      completedTasks,
                      setHelpRequest,
                      helpRequested,
                      helpRequests,
                      ownName: name,
                    }}
                  />
                </>
              )}
            </div>

            <Paper sx={{ position: 'fixed', bottom: 0, left: 0, right: 0 }} elevation={3}>
              <BottomNavigation
                sx={{
                  '& .Mui-selected': {
                    '& .MuiSvgIcon-root, & .MuiBottomNavigationAction-label': {
                      color: 'primary.main',
                    },
                  },
                }}
                showLabels
                value={currentState}
                onChange={(event, newValue) => {
                  console.log({ newValue })
                  selectTab(newValue)
                }}
              >
                <BottomNavigationAction label="Settings" value="settings" icon={<SettingsIcon />} />
                <BottomNavigationAction label="Shopping" value="shopping" icon={<ShoppingCartIcon />} />
                {/*<BottomNavigationAction label="Tools" value="tools" icon={<HandymanIcon />} />*/}
                <BottomNavigationAction label="Tasks" value="cooking" icon={<ChecklistIcon />} />
              </BottomNavigation>
            </Paper>
          </>
        )}
        {/*
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
      */}
      </Container>
    </ThemeProvider>
  )
}

export default App
