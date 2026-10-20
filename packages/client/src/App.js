import './reset.css'
import './App.css'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import { v4 as uuidV4 } from 'uuid'
import { Alert, BottomNavigation, BottomNavigationAction, Box, Card, CardContent, Chip, Container, CssBaseline, Paper, Stack, ThemeProvider, Typography } from '@mui/material'
import SettingsIcon from '@mui/icons-material/Settings'
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart'
import ChecklistIcon from '@mui/icons-material/Checklist'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import ShareIcon from '@mui/icons-material/Share'
import InsightsIcon from '@mui/icons-material/Insights'
import theme from './theme'
import { getQueryParams, isMockMode, HOST_ID } from './config'
import useSession, { appendSessionSettings, getGlobalSettings, getSettings, setGlobalSettings } from './hooks/useSession'
import GraphViewPage from './GraphViewPage'
import HostSettings from './components/HostSettings'
import ShoppingList from './components/ShoppingList'
import Invite from './components/Invite'
import InitDialog from './components/InitDialog'
import DraftPlan from './components/DraftPlan'
import PlanLanes from './components/PlanLanes'
import TaskCard from './components/TaskCard'
import Timers from './components/Timers'
import InterruptAlert from './components/InterruptAlert'
import { CelebrationPopup, FoodParticleAnimation, GoPopup } from './components/Celebration'
import { allDone, allItems, currentItem, describeChange, diffFor, laneFor, laneItems } from './utils/plan'

const GraphView = lazy(() => import('./components/GraphView'))
const DemoPage = lazy(() => import('./demo/DemoPage'))
const ImportPage = lazy(() => import('./import/ImportPage'))

const scrollToTask = (uuid) => {
  document.getElementById('lane-item-' + uuid)?.scrollIntoView?.({ inline: 'center', block: 'nearest' })
  window.setTimeout(() => document.getElementById('task-' + uuid)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 100)
}

function MainApp() {
  const queryParams = useMemo(() => getQueryParams(), [])
  const mock = useMemo(() => isMockMode(), [])
  const baseUrl = window.location.href.split(/[?#]/)[0]
  const sessionId = useMemo(() => queryParams.session || (mock ? 'mock-session' : uuidV4()), [queryParams.session, mock])

  const participantId = useMemo(() => {
    let stored = getSettings(sessionId).participantId
    if (!stored) {
      stored = queryParams.session ? uuidV4() : HOST_ID
      appendSessionSettings(sessionId, { participantId: stored })
    }
    return stored
  }, [sessionId, queryParams.session])
  const isHost = participantId === HOST_ID

  // `?recipe=<id>` (e.g. from the import page) stays in the URL next to the new session id, so that a reload before the
  // session exists still creates it with that recipe (the server answers 409 once it exists, which is ignored).
  const recipeParam = queryParams.recipe && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(queryParams.recipe) ? queryParams.recipe : null
  useEffect(() => {
    const url = `${baseUrl}?session=${sessionId}${recipeParam ? `&recipe=${recipeParam}` : ''}${mock ? '&mock=1' : ''}`
    window.history.replaceState({ sessionId }, 'Flow Recipe', url)
  }, [sessionId, baseUrl, mock, recipeParam])

  const settings = useMemo(() => getSettings(sessionId), [sessionId])
  const [name, setName] = useState(settings.name || getGlobalSettings().defaultName || '')
  const [isSpectator, setIsSpectator] = useState(settings.isSpectator)
  const [nameSet, setNameSet] = useState(name !== '' && settings.isSpectator !== undefined)
  const [tab, setTab] = useState(settings.tab || (isHost ? 'settings' : 'cooking'))
  const [selected, setSelected] = useState(null) // { uuid, participantId }
  const [dismissedDiff, setDismissedDiff] = useState(null)
  const [celebrationShown, setCelebrationShown] = useState(false)
  const celebrationDismissedRef = useRef(false)
  const [animationRestartKey, setAnimationRestartKey] = useState(0)
  const [showGoPopup, setShowGoPopup] = useState(false)
  const previousStatusRef = useRef(null)

  const {
    session,
    plan,
    helpRequests,
    interrupt,
    error,
    clearError,
    updateName,
    updateParticipant,
    addPlaceholder,
    removePlaceholder,
    updateDishes,
    updateInventory,
    updatePolicy,
    startSession,
    restart,
    sendEvent,
    askForHelp,
  } = useSession({
    sessionId,
    participantId,
    name,
    isSpectator,
    enabled: nameSet,
    mock,
    createIfMissing: isHost && !mock && (!queryParams.session || recipeParam) ? { recipeId: recipeParam } : null,
  })

  // keep the spectator flag in sync with what the server says about me
  const me = session?.participants?.find((p) => p.id === participantId)
  useEffect(() => {
    if (me && me.isSpectator !== undefined && me.isSpectator !== isSpectator) {
      setIsSpectator(me.isSpectator)
      appendSessionSettings(sessionId, { isSpectator: me.isSpectator })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.isSpectator])

  const status = session?.status || 'draft'
  const isRunning = status === 'running' || status === 'done'

  // GO popup when the host starts the session (cooks only)
  useEffect(() => {
    const previous = previousStatusRef.current
    previousStatusRef.current = status
    if (previous === 'draft' && status === 'running' && !isHost && !isSpectator) {
      setShowGoPopup(true)
      const t = setTimeout(() => setShowGoPopup(false), 2500)
      return () => clearTimeout(t)
    }
    return undefined
  }, [status, isHost, isSpectator])

  // celebration when every lane item is done
  const everythingDone = allDone(plan)
  useEffect(() => {
    if (everythingDone && !celebrationShown && !celebrationDismissedRef.current) setCelebrationShown(true)
    if (!everythingDone) {
      setCelebrationShown(false)
      celebrationDismissedRef.current = false
    }
  }, [everythingDone, celebrationShown])

  const selectTab = (t) => {
    setTab(t)
    appendSessionSettings(sessionId, { tab: t })
  }

  const handleNameChange = (newName) => {
    setName(newName)
    appendSessionSettings(sessionId, { name: newName })
    setGlobalSettings({ defaultName: newName })
    updateName(newName)
  }

  const handleSelect = useCallback((item, laneParticipantId) => {
    setSelected({ uuid: item.uuid, participantId: laneParticipantId })
    scrollToTask(item.uuid)
  }, [])

  const ownLane = laneFor(plan, participantId)
  const ownCurrent = currentItem(ownLane)
  const seesAllLanes = isHost || isSpectator
  const listedItems = useMemo(() => {
    if (seesAllLanes) return allItems(plan)
    return laneItems(ownLane).map((i) => ({ ...i, participantId }))
  }, [plan, ownLane, seesAllLanes, participantId])
  const expandedUuid = selected?.uuid && listedItems.some((i) => i.uuid === selected.uuid) ? selected.uuid : ownCurrent?.uuid || listedItems.find((i) => i.status !== 'done')?.uuid

  const myDiff = diffFor(plan, participantId)
  const diffKey = plan ? `${plan.computedAt}` : null
  const showDiff = myDiff && myDiff.changes?.length > 0 && dismissedDiff !== diffKey

  const joinSessionLink = `${baseUrl}?session=${sessionId}${mock ? '&mock=1' : ''}`
  const ownAllDone = ownLane && laneItems(ownLane).length > 0 && laneItems(ownLane).every((i) => i.status === 'done')

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container sx={{ minHeight: '100vh' }}>
        {error && (
          <Box sx={{ mt: 2, mb: 2 }}>
            <Alert severity="error" onClose={clearError}>
              {error}
            </Alert>
          </Box>
        )}

        {!nameSet ? (
          <InitDialog
            name={name}
            setName={setName}
            isSpectator={isSpectator}
            onJoin={({ name: newName, isSpectator: spectator }) => {
              setIsSpectator(spectator)
              setNameSet(true)
              appendSessionSettings(sessionId, { name: newName, isSpectator: spectator })
              setGlobalSettings({ defaultName: newName })
              updateName(newName)
              updateParticipant(participantId, { isSpectator: spectator })
            }}
          />
        ) : (
          <>
            <Box sx={{ pt: 2 }}>
              {tab === 'settings' && (
                <HostSettings
                  session={session}
                  plan={plan}
                  ownParticipantId={participantId}
                  isHost={isHost}
                  mock={mock}
                  name={name}
                  onNameChange={handleNameChange}
                  baseUrl={baseUrl}
                  onUpdateParticipant={(id, patch) => {
                    if (id === participantId && patch.isSpectator !== undefined) {
                      setIsSpectator(patch.isSpectator)
                      appendSessionSettings(sessionId, { isSpectator: patch.isSpectator })
                    }
                    updateParticipant(id, patch)
                  }}
                  onAddPlaceholder={addPlaceholder}
                  onRemovePlaceholder={removePlaceholder}
                  onUpdateDishes={updateDishes}
                  onUpdateInventory={updateInventory}
                  onUpdatePolicy={updatePolicy}
                  onStart={startSession}
                  onRestart={() => {
                    celebrationDismissedRef.current = false
                    setCelebrationShown(false)
                    setSelected(null)
                    restart()
                  }}
                />
              )}
              {tab === 'shopping' && <ShoppingList shoppingList={plan?.shoppingList} />}
              {tab === 'invite' && <Invite joinSessionLink={joinSessionLink} />}
              {tab === 'plan' && <DraftPlan plan={plan} session={session} ownParticipantId={participantId} selectedUuid={selected?.uuid} onSelect={handleSelect} />}
              {tab === 'graph' && (
                <Suspense fallback={<Typography sx={{ p: 2 }}>Loading graph…</Typography>}>
                  <GraphView plan={plan} onSelect={(uuid) => setSelected({ uuid })} />
                </Suspense>
              )}
              {tab === 'cooking' && (
                <>
                  <Box sx={{ pb: `${(plan?.lanes?.length || 1) * 34 + 120}px` }}>
                    <Stack spacing={2}>
                      {showDiff && (
                        <Alert severity="info" onClose={() => setDismissedDiff(diffKey)}>
                          <Stack spacing={0.5}>
                            {myDiff.changes.map((c, i) => (
                              <span key={`${c.uuid}-${c.field}-${i}`}>{describeChange(c)}</span>
                            ))}
                          </Stack>
                        </Alert>
                      )}
                      <Card>
                        <CardContent>
                          <Typography variant="h4" gutterBottom>
                            Instructions
                          </Typography>
                          <Stack spacing={2}>
                            <p>
                              Your task is to create something wonderful with your friends by following the steps below. Please note that this is not a
                              test of speed or skills, but of collaboration.
                            </p>
                            <p>In case you need assistance, you can raise your hand virtually by pressing the ✋ -button in the bottom right corner.</p>
                            <p>Remember to wash your hands before starting 💦👏😊!</p>
                            <p>Happy cooking, have fun! 🧑‍🍳</p>
                          </Stack>
                        </CardContent>
                      </Card>
                      {!plan && (
                        <Card>
                          <CardContent>
                            <Typography>Waiting for the plan…</Typography>
                          </CardContent>
                        </Card>
                      )}
                      {plan && !isRunning && (
                        <Card>
                          <CardContent>
                            <Stack spacing={1} alignItems="center">
                              <Typography variant="h5" gutterBottom>
                                {isHost ? 'This is the draft plan' : 'Waiting for the host to start the session…'}
                              </Typography>
                              <Typography variant="body1" color="text.secondary">
                                {isHost ? 'Press Start in Settings when everyone is here.' : 'You can already read your tasks below.'}
                              </Typography>
                              <Chip size="small" label="draft" />
                            </Stack>
                          </CardContent>
                        </Card>
                      )}
                      {listedItems.map((item) => {
                        const own = item.participantId === participantId
                        const canAct = isHost || (own && isRunning && !isSpectator)
                        return (
                          <TaskCard
                            key={item.uuid}
                            item={item}
                            session={session}
                            ownParticipantId={participantId}
                            laneParticipantId={item.participantId}
                            isCurrent={own && ownCurrent?.uuid === item.uuid}
                            expanded={item.uuid === expandedUuid}
                            canAct={canAct}
                            actAs={isHost && !own ? item.participantId : null}
                            onToggle={() => setSelected({ uuid: item.uuid, participantId: item.participantId })}
                            onEvent={sendEvent}
                          />
                        )
                      })}
                      {ownAllDone && (
                        <Card sx={{ bgcolor: 'success.light', color: 'success.contrastText' }}>
                          <CardContent>
                            <Stack direction="row" spacing={2} alignItems="center">
                              <CheckCircleIcon sx={{ fontSize: 40 }} />
                              <Typography variant="h5">You've completed all your tasks!</Typography>
                            </Stack>
                          </CardContent>
                        </Card>
                      )}
                    </Stack>
                  </Box>
                  <PlanLanes plan={plan} session={session} ownParticipantId={participantId} selectedUuid={selected?.uuid} onSelect={handleSelect} />
                  <Timers
                    lane={ownLane}
                    session={session}
                    ownParticipantId={participantId}
                    isHost={isHost}
                    helpRequests={helpRequests}
                    onAskForHelp={askForHelp}
                    onScrollTo={(uuid) => {
                      setSelected({ uuid, participantId })
                      scrollToTask(uuid)
                    }}
                  />
                </>
              )}
            </Box>

            <Paper sx={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 4 }} elevation={3}>
              <BottomNavigation
                sx={{ '& .Mui-selected': { '& .MuiSvgIcon-root, & .MuiBottomNavigationAction-label': { color: 'primary.main' } } }}
                showLabels
                value={tab}
                onChange={(event, newValue) => selectTab(newValue)}
              >
                <BottomNavigationAction label="Settings" value="settings" icon={<SettingsIcon />} />
                <BottomNavigationAction label="Shopping" value="shopping" icon={<ShoppingCartIcon />} />
                <BottomNavigationAction label="Invite" value="invite" icon={<ShareIcon />} />
                <BottomNavigationAction label="Plan" value="plan" icon={<InsightsIcon />} />
                <BottomNavigationAction label="Tasks" value="cooking" icon={<ChecklistIcon />} />
                {isHost && <BottomNavigationAction label="Graph" value="graph" icon={<AccountTreeIcon />} />}
              </BottomNavigation>
            </Paper>
          </>
        )}
      </Container>
      <InterruptAlert interrupt={interrupt} plan={plan} onAcknowledge={(i) => sendEvent('appointmentAcknowledged', i.appointmentUuid)} />
      <CelebrationPopup
        open={everythingDone && celebrationShown}
        onClose={() => {
          setCelebrationShown(false)
          celebrationDismissedRef.current = true
        }}
        onRestartAnimation={() => setAnimationRestartKey((k) => k + 1)}
      />
      <GoPopup open={showGoPopup} />
      <FoodParticleAnimation active={everythingDone && celebrationShown} restartKey={animationRestartKey} />
    </ThemeProvider>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/graph" element={<GraphViewPage />} />
      <Route
        path="/demo"
        element={
          <Suspense fallback={<Typography sx={{ p: 2 }}>Loading…</Typography>}>
            <DemoPage />
          </Suspense>
        }
      />
      <Route
        path="/import"
        element={
          <Suspense fallback={<Typography sx={{ p: 2 }}>Loading…</Typography>}>
            <ImportPage />
          </Suspense>
        }
      />
      <Route path="*" element={<MainApp />} />
    </Routes>
  )
}

export default App
