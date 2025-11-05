/*

TODO:
* Spectator mode
  * Join the session only after clicking join / spectate
* Keep participant order same after refresh
* Link multi outputs
* Remove duplication from cucumber grating
* Instructions (collaborate, measure into a bowl)
* Tool for measure
* Numbering for measurements -> number cups
* Multiple end results -> jokes (gt, sandwich) (perhaps a virtual last step?)
* Automatically generated shared final step (enjoy)
  * Generate final output name from recipe
* Fix scaling

*/

import './reset.css'
import './App.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { findFinalOutputId, findTaskProducing, getInstructions } from './recipeTools'
import { calculateShoppingList } from './shoppingListGenerator'
import { expandNode, scheduleItemsInTimelines } from './timelineScheduler'
import { v4 as uuidV4 } from 'uuid'
import { io } from 'socket.io-client'
import ForceGraph2D from 'react-force-graph-2d'
import * as R from 'ramda'
import QRCodeSVG from 'qrcode.react'
import {
  Alert,
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
  Link,
} from '@mui/material'
import SettingsIcon from '@mui/icons-material/Settings'
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart'
import ChecklistIcon from '@mui/icons-material/Checklist'
import WavingHandIcon from '@mui/icons-material/WavingHand'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
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

const formatTime = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().substr(11, 8) : 0)

const laneHeight = 80
const zoom = 0.4

const SERVER_URL = process.env.REACT_APP_SERVER_URL || 
  (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001')

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
  recipeName,
  scale,
  onScaleChange,
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
        <Card>
          <CardContent>
            <Typography variant="h6">Options</Typography>
            {isHost ? (
              <TextField
                name="scale"
                label="Scale"
                type="number"
                inputProps={{
                  min: 1,
                  step: 1,
                  onInput: (e) => {
                    console.log('onScaleChange', e.target.value)
                    const newScale = parseInt(e.target.value)
                    if (!isNaN(newScale) && newScale > 0) {
                      onScaleChange(newScale)
                    }
                  },
                }}
                value={scale}
                onChange={(e) => {
                  console.log('onScaleChange', e.target.value)
                  const newScale = parseInt(e.target.value)
                  if (!isNaN(newScale) && newScale > 0) {
                    onScaleChange(newScale)
                  }
                }}
              />
            ) : (
              <Typography>Scale: {scale}</Typography>
            )}
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
          <>
          <Button variant="contained" onClick={() => restart()}>
            Restart
          </Button><br/>
          <Link variant="contained" href={`${baseUrl}?recipe=${recipeName}`}>
            New session with recipe: {recipeName}
          </Link>
        </>
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

function GraphView({ dependencyGraph, completedTasks }) {
  const graphRef = useRef()
  
  if (!dependencyGraph || dependencyGraph.nodes.length === 0) {
    return (
      <Box padding={2}>
        <Typography>No graph data available</Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ height: 'calc(100vh - 120px)', width: '100%' }}>
      <ForceGraph2D
        ref={graphRef}
        graphData={dependencyGraph}
        nodeLabel={(node) => node.title || node.id}
        nodeColor={(node) => completedTasks.includes(node.id) ? '#1ee9a5' : '#e91e63'}
        linkColor={() => 'rgba(0,0,0,0.2)'}
        linkDirectionalArrowLength={6}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={() => 'rgba(0,0,0,0.3)'}
        nodeVal={(node) => {
          const incomingLinks = dependencyGraph.links.filter(l => l.target === node.id).length
          return Math.max(3, Math.sqrt(incomingLinks + 1) * 3)
        }}
        cooldownTicks={100}
        onNodeClick={(node) => {
          const nodeElement = document.getElementById('task' + node.id)
          if (nodeElement) {
            nodeElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const label = node.title || node.id
          const fontSize = 12 / globalScale
          ctx.font = `${fontSize}px Sans-Serif`
          const textWidth = ctx.measureText(label).width
          const bckgDimensions = [textWidth, fontSize].map((n) => n + fontSize * 0.2)

          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
          ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, ...bckgDimensions)

          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = '#333'
          ctx.fillText(label, node.x, node.y)

          node.__bckgDimensions = bckgDimensions
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          ctx.fillStyle = color
          const bckgDimensions = node.__bckgDimensions
          bckgDimensions &&
            ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, ...bckgDimensions)
        }}
      />
    </Box>
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
          {isDone && <CheckCircleIcon sx={{ verticalAlign: 'middle', ml: 1, color: 'success.main' }} />}
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
  }, [currentTime, timers, completedTasks, markTaskCompleted])

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 70,
        right: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
      }}
    >
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
          color={helpRequested ? 'primary' : 'white'}
          aria-label="add"
          onClick={(e) => {
            e.target.blur()
            return setHelpRequest(!helpRequested)
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
  const [timelines, setTimelines] = useState([[]])
  const [currentTask, setCurrentTask] = useState(0)
  const [selectedTask, setSelectedTask] = useState({ timeline: 0, task: 0 })
  const [ownLane, setOwnLane] = useState(0)
  const [currentTimeline, setCurrentTimeline] = useState(0)
  const [recipe, setRecipe] = useState()
  const [recipeName, setRecipeName] = useState(isHost ? queryParams.recipe || 'bday-cake' : null)
  let globalSettings = JSON.parse(window.localStorage.getItem('global-settings'))
  const [name, setName] = useState(settings?.name || globalSettings?.defaultName || '')
  const [nameSet, setNameSet] = useState(name !== '')
  const [shareLinkCopied, setShareLinkCopied] = useState(false)
  const [currentState, setCurrentState] = useState(settings.tab || isHost ? 'settings' : 'cooking')
  const [errorMessage, setErrorMessage] = useState(null)

  const connectionsRef = useRef([{ id: hostId, name }])
  const [connections, _setConnections] = useState(connectionsRef.current)
  const [setupDone, setSetupDone] = useState(isHost)
  const completedTasksRef = useRef(settings.completedTasks || [])
  const [completedTasks, _setCompletedTasks] = useState(completedTasksRef.current)
  const [tasksInProgress, setTasksInProgress] = useState(settings.tasksInProgress || [])
  const [timers, setTimers] = useState([])
  const [scale, setScale] = useState(1)

  const helpRequestsRef = useRef(new Set())
  const [helpRequests, _setHelpRequests] = useState(helpRequestsRef.current)
  const [helpRequested, setHelpRequested] = useState(false)

  const timelinesRef = useRef(timelines)
  const ownLaneRef = useRef(ownLane)
  const selectedTaskRef = useRef(selectedTask)
  const tasksInProgressRef = useRef(settings.tasksInProgress || [])

  const selectTab = (tab) => {
    setCurrentState(tab)
    appendSessionSettings(sessionId, { tab })
  }

  const concatCompletedTasks = useCallback((completed) => {
    const merged = Array.from(new Set([...completedTasksRef.current, ...completed]))
    setTasksCompleted(merged)
  }, [])

  const setTasksCompleted = (completed) => {
    // TODO: use uuids
    appendSessionSettings(sessionId, { completedTasks: completed })
    completedTasksRef.current = completed
    _setCompletedTasks(completed)
  }

  const scrollToTask = useCallback((uuid) => {
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
  }, [])

  const scrollToIndex = useCallback((taskIndex, timeline = selectedTaskRef.current.timeline) => {
    if (!timelinesRef.current?.[timeline]?.[taskIndex]) return;
    const uuid = timelinesRef.current[timeline][taskIndex].uuid
    scrollToTask(uuid)
  }, [scrollToTask])

  const startTimer = ({ timer: { duration, title }, uuid }) => {
    const newTimers = [{ end: Date.now() + duration * 1000, taskUuid: uuid, title }, ...timers]
    setTimers(newTimers)
  }

  const clearTimer = async (index) => {
    let newTimers = timers.slice()
    newTimers.splice(index, 1)
    setTimers(newTimers)
  }

  const markTaskCompleted = useCallback(async (uuid) => {
    setTasksCompleted([...completedTasksRef.current, uuid])
    setTasksInProgress(R.without([uuid], tasksInProgress))
    sendTaskCompleted(uuid)
  }, [tasksInProgress])

  const findNextTask = useCallback((timeline) => {
    if (!timelinesRef.current?.[timeline]) return -1;
    const startedTasks = [...completedTasksRef.current, ...tasksInProgressRef.current]
    const nextTask = R.findLastIndex((taskItem) => !startedTasks.includes(taskItem.uuid), timelinesRef.current[timeline])
    console.log({ nextTask })
    return nextTask
  }, [])

  const markTaskDone = async (timeline, task) => {
    if (!timelinesRef.current?.[timeline]?.[task]) return -1;
    const taskItem = timelinesRef.current[timeline][task]
    await markTaskCompleted(taskItem.uuid)
    // TODO: Need to jump to next task not completed
    const nextTask = findNextTask(timeline)
    scrollToIndex(nextTask, timeline)
    return nextTask
  }

  const markCurrentTaskDone = async () => {
    const nextTask = await markTaskDone(currentTimeline, currentTask)
    setCurrentTask(nextTask)
    setSelectedTask({ task: nextTask, timeline: ownLane })
  }

  const socketRef = useRef(null)

  const setConnections = (newConnections) => {
    connectionsRef.current = newConnections
    _setConnections(newConnections)
  }

  const setHelpRequests = (newHelpRequests) => {
    const helpSet = Array.isArray(newHelpRequests) ? new Set(newHelpRequests) : newHelpRequests
    helpRequestsRef.current = helpSet
    _setHelpRequests(helpSet)
  }

  const setHelpRequest = async (requested) => {
    setHelpRequested(requested)
    if (socketRef.current) {
      socketRef.current.emit('askForHelp', {
        sessionId,
        participantId,
        requested,
      })
    }
  }

  const sendTaskCompleted = (taskId) => {
    if (socketRef.current) {
      socketRef.current.emit('taskCompleted', {
        sessionId,
        participantId,
        taskUuid: taskId,
      })
    }
  }

  const restart = async () => {
    setTasksCompleted([])
    appendSessionSettings(sessionId, { completedTasks: [] })
    if (socketRef.current) {
      socketRef.current.emit('restart', { sessionId })
    }
  }

  useEffect(() => {
    timelinesRef.current = timelines
  }, [timelines])

  useEffect(() => {
    ownLaneRef.current = ownLane
  }, [ownLane])

  useEffect(() => {
    selectedTaskRef.current = selectedTask
  }, [selectedTask])

  useEffect(() => {
    tasksInProgressRef.current = tasksInProgress
  }, [tasksInProgress])

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
    const createSessionIfNeeded = async () => {
      if (isHost && !queryParams.session) {
        try {
          const response = await fetch(`${SERVER_URL}/api/sessions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              sessionId,
              recipeName,
            }),
          })

          if (!response.ok) {
            if (response.status === 409) {
              console.log('Session already exists, continuing...')
              return
            }
            const errorData = await response.json()
            throw new Error(errorData.error || 'Failed to create session')
          }

          const data = await response.json()
          console.log('Session created:', data)
        } catch (error) {
          console.error('Error creating session:', error)
          setErrorMessage(error.message || 'Failed to create session')
        }
      }
    }

    createSessionIfNeeded()
  }, [recipeName])

  useEffect(() => {
    const socket = io(SERVER_URL)
    socketRef.current = socket

    socket.on('connect', () => {
      console.log('Connected to server')
      socket.emit('joinSession', {
        sessionId,
        participantId,
        name: name || '',
      })
    })

    socket.on('recipeName', (recipeName) => {
      console.log('Received recipe name from server:', recipeName)
      setRecipeName(recipeName)
    })

    socket.on('connections', (participants) => {
      console.log('Received connections:', participants)
      const connectionsList = participants.map((p) => ({
        id: p.id === '0' ? hostId : `recipes-${sessionId}-${p.id}`,
        name: p.name,
      }))
      setConnections(connectionsList)
      setSetupDone(true)
    })

    socket.on('completedTasks', (completedTaskUuids) => {
      console.log('Received completed tasks:', completedTaskUuids)
      setTasksCompleted(completedTaskUuids)
      if (completedTaskUuids.length === 0) {
        setTasksInProgress([])
        setTimers([])
        const currentOwnLane = ownLaneRef.current
        if (timelinesRef.current?.[currentOwnLane]) {
          const firstTaskIndex = findNextTask(currentOwnLane)
          setCurrentTask(firstTaskIndex)
          setSelectedTask({ task: firstTaskIndex, timeline: currentOwnLane })
          appendSessionSettings(sessionId, { completedTasks: [] })
          scrollToIndex(firstTaskIndex, currentOwnLane)
        }
      }
    })

    socket.on('helpRequests', (requests) => {
      console.log('Received help requests:', requests)
      setHelpRequests(new Set(requests))
    })

    socket.on('scale', (scaleValue) => {
      console.log('Received scale from server:', scaleValue)
      setScale(scaleValue || 1)
    })

    socket.on('error', (error) => {
      console.error('Socket error:', error)
      setErrorMessage(error.message || 'An error occurred')
    })

    socket.on('disconnect', () => {
      console.log('Disconnected from server')
    })

    return () => {
      socket.disconnect()
    }
  }, [name, findNextTask, scrollToIndex])

  const handleScaleChange = (newScale) => {
    console.log('handleScaleChange', newScale)
    if (socketRef.current && isHost) {
      socketRef.current.emit('updateScale', {
        sessionId,
        participantId,
        scale: newScale,
      })
    }
  }

  const updateName = (newName) => {
    if (socketRef.current) {
      socketRef.current.emit('updateName', {
        sessionId,
        participantId,
        name: newName,
      })
    }
  }

  useEffect(() => {
    if (!recipeName) {
      return
    }

    const loadRecipe = async () => {
      try {
        const response = await fetch(`${SERVER_URL}/api/recipes/${recipeName}`)
        if (!response.ok) {
          throw new Error(`Failed to load recipe: ${response.statusText}`)
        }
        const xmlText = await response.text()
        const parser = new DOMParser()
        const recipe = parser.parseFromString(xmlText, 'text/xml')
        setRecipe(recipe)
      } catch (error) {
        console.error('Failed to load recipe:', error)
      }
    }
    loadRecipe()
  }, [recipeName])

  useEffect(() => {
    if (!recipe) {
      return
    }
    const title = recipe.querySelector('title').innerHTML
    setTitle(title)
  }, [recipe])

  useEffect(() => {
    if (timelines.length === 0 || timelines.every(t => t.length === 0)) {
      return
    }
    setShoppingList(calculateShoppingList(timelines))
  }, [timelines])

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
      expandNode(recipe, node, scale)
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
      [{ uuid: finalOutputId, task: lastTask, amountsLeft: { [finalOutputId]: scale } }],
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

    setTimelines(newTimelines)
    setShoppingList(calculateShoppingList(newTimelines))
    const startedTasks = [...completedTasksRef.current, ...tasksInProgress]
    if (isHost) {
      // TODO: remove duplication
      setOwnLane(undefined)
      setCurrentTimeline(0)
      const nextTask = R.findLastIndex((task) => !startedTasks.includes(task.uuid), newTimelines[0])
      setCurrentTask(nextTask)
      setSelectedTask({ task: nextTask, timeline: 0 })
    } else {
      const newOwnLane = connections.findIndex(({ id }) => id === ownId) -1
      if (newOwnLane < 0) {
        throw new Error('Own id not found in connections')
      }
      setOwnLane(newOwnLane)
      setCurrentTimeline(newOwnLane)
      // Only try to find next task if the timeline exists and has tasks
      if (newTimelines[newOwnLane] && newTimelines[newOwnLane].length > 0) {
        const nextTask = R.findLastIndex((task) => !startedTasks.includes(task.uuid), newTimelines[newOwnLane])
        setCurrentTask(nextTask)
        setSelectedTask({ task: nextTask, timeline: newOwnLane })
      } else {
        // If no timeline exists yet, set to first task
        setCurrentTask(0)
        setSelectedTask({ task: 0, timeline: newOwnLane })
      }
    }

    setSetupDone(true)
  }, [recipe, connections, concatCompletedTasks, tasksInProgress, scale])

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
  const width = Math.max(...(timelines?.map((timeline) => -(timeline?.[timeline?.length - 1]?.start ?? 0)) ?? [0])) + nameLabelWidth

  const selectedTimeline = selectedTask.timeline
  const selectedTaskData = timelines?.[selectedTimeline]?.[selectedTask.task]

  const height = laneHeight * (timelines?.length ?? 0)
  const task = selectedTaskData
  //console.log({ task, selected: selectedTask })

  let timeline
  let tasks

  if (isHost) {
    timeline = timelines?.flat() ?? []
    tasks = timeline.sort(({ start: a }, { start: b }) => a - b)
  } else {
    timeline = timelines?.[selectedTimeline] ?? []
    tasks = R.reverse(timeline)
  }
  const pendingInputs = task?.dependencies?.filter(({ uuid }) => !completedTasks.includes(uuid)) ?? []
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
  const inputsReady = pendingInputs?.length === 0

  console.log({ timelines, selectedTimeline, selectedTask, currentTask, ownLane })
  // const debug = queryParams.query?.debug !== undefined
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container sx={{ minHeight: '100vh' }}>
        {errorMessage && (
          <Box sx={{ mt: 2, mb: 2 }}>
            <Alert severity="error" onClose={() => setErrorMessage(null)}>
              {errorMessage}
            </Alert>
          </Box>
        )}
        {/*debug && (
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
        )*/}
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
                    connectionId: ownId,
                    recipeName,
                    scale,
                    onScaleChange: handleScaleChange,
                  }}
                />
              )}
              {currentState === 'shopping' && <Shopping {...{ shoppingList }} />}
              {currentState === 'tools' && <></>}
              {currentState === 'graph' && <GraphView {...{ dependencyGraph, completedTasks }} />}
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
                                  -button in the bottom right corner.
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
                            const currentTaskIndex = isHost ? i : (timelines[selectedTimeline]?.length ?? 0) - currentTask - 1
                            const isCurrentTask = !isHost && i === currentTaskIndex
                            return (
                              <Task
                                key={task.uuid}
                                {...{
                                  task,
                                  timelines,
                                  isDone: completedTasks.includes(task.uuid),
                                  isCurrent: isCurrentTask,
                                  inputsReady: isCurrentTask ? inputsReady : false,
                                  pendingInputs: isCurrentTask ? pendingInputs : [],
                                  inputsForTask: isCurrentTask ? inputsForTask : [],
                                  recipe,
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
                                    const nextTask = R.findLastIndex(
                                      (task) => ![...completedTasksRef.current, ...tasksInProgress].includes(task.uuid),
                                      timelines[ownLane] ?? []
                                    )
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
                {isHost && <BottomNavigationAction label="Graph" value="graph" icon={<AccountTreeIcon />} />}
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
