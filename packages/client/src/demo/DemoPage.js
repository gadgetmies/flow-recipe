// In-app demo (route /demo): simulated participants prepare several recipes, planned and re-planned live by the
// scheduler running in the browser. No server is needed: recipes come from the dev server when it answers, else
// from the bundled copies in ./recipes.js (always in ?mock=1 mode). `/demo#buns,tiramisu` preselects recipes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Card,
  CardContent,
  Chip,
  Container,
  CssBaseline,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Slider,
  Stack,
  TextField,
  ThemeProvider,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import PauseIcon from '@mui/icons-material/Pause'
import SkipNextIcon from '@mui/icons-material/SkipNext'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import InsightsIcon from '@mui/icons-material/Insights'
import { planSession, createSimulation, defaultInventory, mergeInventory } from '@flow-recipe/scheduler'
import theme from '../theme'
import { SERVER_URL, isMockMode } from '../config'
import DraftPlan, { LatenessChip } from '../components/DraftPlan'
import PlanLanes from '../components/PlanLanes'
import TaskCard from '../components/TaskCard'
import { currentItem, dishTitle, participantName } from '../utils/plan'
import { fmtClock, fmtMinutes, timeInputToMs } from '../utils/time'
import { OPERATIONS_XML, RECIPE_LIST, RECIPE_XML } from './recipes'

// A fixed demo day (local time) so that the plan is the same whenever the demo runs.
const DEMO_DAY = new Date(2026, 9, 11, 0, 0, 0, 0).getTime()
const DEFAULT_SERVE = ['18:00', '18:10', '18:20', '18:30', '18:40', '18:50']
const DEFAULT_RECIPES = ['buns', 'tiramisu']
const NAMES = ['Ada', 'Bea', 'Cal', 'Dee', 'Eli']
const SPEEDS = [1, 10, 60, 300]
const CLEANING = ['shared', 'dedicated', 'deferred']
const LOG_LINES = 40
const UI_INTERVAL_MS = 100

const bundledSource = () => ({
  from: 'bundled',
  recipes: RECIPE_LIST,
  xml: RECIPE_XML,
  operationsXml: OPERATIONS_XML,
  inventory: defaultInventory(),
})

async function fetchOk(path) {
  const response = await fetch(`${SERVER_URL}${path}`)
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return response
}

/** Recipes, operations and inventory from the server, or the bundled copies when that fails. */
async function loadSource(mock) {
  if (mock) return bundledSource()
  try {
    const recipes = await (await fetchOk('/api/recipes')).json()
    const operationsXml = await (await fetchOk('/api/operations')).text()
    const inventory = await (await fetchOk('/api/inventory/default')).json()
    const xml = {}
    for (const r of recipes) xml[r.id] = await (await fetchOk(`/api/recipes/${encodeURIComponent(r.id)}`)).text()
    return { from: 'server', recipes, xml, operationsXml, inventory }
  } catch (error) {
    return { ...bundledSource(), error: error.message }
  }
}

/** `#buns,tiramisu` → ['buns', 'tiramisu'] (bare tokens only). */
export function recipesFromHash(hash) {
  const token = String(hash || '').replace(/^#/, '')
  if (!/^[a-z0-9,-]+$/i.test(token)) return null
  const ids = token.split(',').filter(Boolean)
  return ids.length > 0 ? ids : null
}

function lateFor(metrics, dish) {
  const measured = metrics?.lateness?.[dish.dishId]
  if (measured !== null && measured !== undefined) return measured
  return (dish.plannedServe - dish.serveTarget) / 1000
}

function LogLine({ entry }) {
  const replan = /^replan/.test(entry.text)
  const interrupt = /^INTERRUPT/.test(entry.text)
  return (
    <Box
      component="div"
      sx={{
        fontFamily: 'monospace',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        px: 0.5,
        bgcolor: interrupt ? 'error.light' : replan ? 'info.light' : 'transparent',
        color: interrupt ? 'error.contrastText' : replan ? 'info.contrastText' : 'text.primary',
        fontWeight: interrupt || replan ? 600 : 400,
      }}
    >
      {fmtClock(entry.at)} {entry.text}
    </Box>
  )
}

function Metric({ label, value }) {
  return (
    <Box sx={{ minWidth: 72 }}>
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Typography variant="subtitle1" component="div" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
        {value}
      </Typography>
    </Box>
  )
}

export default function DemoPage() {
  const { hash } = useLocation()
  const mock = useMemo(() => isMockMode(), [])
  const presetRecipes = useMemo(() => recipesFromHash(hash), [hash])

  // ---- source data ----
  const [source, setSource] = useState(null)
  useEffect(() => {
    let cancelled = false
    loadSource(mock).then((s) => {
      if (!cancelled) setSource(s)
    })
    return () => {
      cancelled = true
    }
  }, [mock])

  // ---- controls ----
  const [selected, setSelected] = useState(presetRecipes || DEFAULT_RECIPES)
  const [serveAt, setServeAt] = useState({})
  const [count, setCount] = useState(3)
  const [names, setNames] = useState(NAMES)
  const [sheets, setSheets] = useState(4)
  const [cleaning, setCleaning] = useState('shared')
  const [seed, setSeed] = useState(7)
  const [noise, setNoise] = useState(0.25)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!source) return
    const known = new Set(source.recipes.map((r) => r.id))
    setSelected((ids) => {
      const kept = ids.filter((id) => known.has(id))
      return kept.length > 0 ? kept : source.recipes.slice(0, 2).map((r) => r.id)
    })
  }, [source])

  const toggleRecipe = (id) => setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
  const serveValue = (id, i) => serveAt[id] || DEFAULT_SERVE[i] || DEFAULT_SERVE[DEFAULT_SERVE.length - 1]

  // ---- planning ----
  const [planned, setPlanned] = useState(null) // { session, viewSession, catalogue, graph, plan }
  const simRef = useRef(null)
  const [live, setLive] = useState(null) // { clock, plan, entries, metrics, done, counters }
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(10)
  const [selectedItem, setSelectedItem] = useState(null)

  const publish = useCallback((snapshot) => {
    const sim = simRef.current
    setLive({
      clock: snapshot.clock,
      plan: snapshot.state.plan,
      entries: snapshot.entries.slice(-LOG_LINES),
      metrics: snapshot.metrics,
      done: snapshot.done,
      counters: sim ? sim.counters : { replans: 0, interrupts: 0, events: 0 },
    })
  }, [])

  const startSimulation = useCallback(
    (p) => {
      const sim = createSimulation({
        session: { ...p.session, startTime: p.plan.startTime },
        catalogue: p.catalogue,
        graph: p.graph,
        seed: p.seed,
        speedNoise: p.noise,
        lateStartProbability: 0.1,
      })
      simRef.current = sim
      setPlaying(false)
      setSelectedItem(null)
      publish(sim.step(0))
    },
    [publish]
  )

  const handlePlan = () => {
    if (!source || selected.length === 0) return
    setPlaying(false)
    setError(null)
    try {
      const recipes = Object.fromEntries(selected.map((id) => [id, source.xml[id]]))
      const n = Math.min(5, Math.max(2, count))
      const participants = names.slice(0, n).map((name, i) => ({
        id: i === 0 ? '0' : `p${i + 1}`,
        name: name || NAMES[i],
        speed: 1,
        role: cleaning === 'dedicated' && i === n - 1 ? 'cleaner' : 'cook',
      }))
      const session = {
        id: 'demo',
        startTime: null,
        now: null,
        dishes: selected.map((id, i) => ({
          id,
          recipeId: id,
          scale: 1,
          serveTime: timeInputToMs(serveValue(id, i), DEMO_DAY),
          earlyTolerance: 0,
          lateTolerance: 300_000,
        })),
        participants,
        inventory: mergeInventory(source.inventory || defaultInventory(), {
          tools: [{ type: 'baking-sheet', count: sheets }],
        }),
        policy: { seed: Number(seed) || 0, cleaning },
      }
      const result = planSession({
        recipes,
        operationsXml: source.operationsXml,
        session,
        DOMParser: window.DOMParser,
        planOptions: { mode: 'offline', status: 'draft' },
      })
      const viewSession = {
        id: 'demo',
        participants,
        dishes: result.session.dishes.map((d) => ({ ...d, title: d.recipe?.title || d.recipeId })),
      }
      const p = {
        session: result.session,
        viewSession,
        catalogue: result.catalogue,
        graph: result.graph,
        plan: result.plan,
        seed: Number(seed) || 0,
        noise,
      }
      setPlanned(p)
      startSimulation(p)
    } catch (e) {
      setError(e.message || String(e))
      setPlanned(null)
      simRef.current = null
      setLive(null)
    }
  }

  const stepOnce = () => {
    const sim = simRef.current
    if (sim) publish(sim.step(sim.tick))
  }

  const pause = () => {
    setPlaying(false)
    const sim = simRef.current
    if (sim) publish(sim.step(0)) // the play loop throttles its updates; show the latest state
  }

  const reset = () => {
    if (planned) startSimulation(planned)
  }

  // ---- play loop: every animation frame advances the simulation by the elapsed real time × speed ----
  useEffect(() => {
    if (!playing) return undefined
    const sim = simRef.current
    if (!sim) return undefined
    let last = performance.now()
    let lastUi = 0
    let frame = null
    const loop = (t) => {
      const elapsed = Math.min(1000, Math.max(0, t - last)) * speed
      last = t
      const snapshot = sim.step(elapsed)
      if (snapshot.done) {
        publish(snapshot)
        setPlaying(false)
        return
      }
      if (t - lastUi >= UI_INTERVAL_MS) {
        lastUi = t
        publish(snapshot)
      }
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [playing, speed, publish])

  // ---- log auto-scroll (every publish yields a new entries array) ----
  const logRef = useRef(null)
  const entries = live?.entries
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  const recipesList = source?.recipes || []
  const viewSession = planned?.viewSession || null
  const selectedCard =
    selectedItem && live
      ? live.plan.lanes
          .flatMap((l) => l.items.map((it) => ({ ...it, participantId: l.participantId })))
          .find((it) => it.uuid === selectedItem)
      : null

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container sx={{ minHeight: '100vh', py: 2 }}>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center">
            <InsightsIcon color="primary" />
            <Typography variant="h5" component="h1">
              Scheduler demo
            </Typography>
            {source && (
              <Chip
                size="small"
                variant="outlined"
                label={source.from === 'server' ? 'recipes from server' : 'bundled recipes'}
              />
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Simulated participants cook several dishes at once. The plan is computed in your browser and re-planned live
            as the simulated cooks run early, late or get interrupted by timers.
          </Typography>

          {source?.error && (
            <Alert severity="info">Server not reachable ({source.error}); using the bundled recipes.</Alert>
          )}
          {error && (
            <Alert severity="error" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Setup
              </Typography>
              {!source ? (
                <Typography color="text.secondary">Loading recipes…</Typography>
              ) : (
                <Stack spacing={2}>
                  <Box>
                    <Typography variant="subtitle2" gutterBottom>
                      Recipes
                    </Typography>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {recipesList.map((r) => {
                        const on = selected.includes(r.id)
                        return (
                          <Chip
                            key={r.id}
                            label={r.title}
                            color={on ? 'primary' : 'default'}
                            variant={on ? 'filled' : 'outlined'}
                            onClick={() => toggleRecipe(r.id)}
                            data-testid={`recipe-chip-${r.id}`}
                          />
                        )
                      })}
                    </Stack>
                  </Box>
                  {selected.length > 0 && (
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {selected.map((id, i) => (
                        <TextField
                          key={id}
                          size="small"
                          type="time"
                          label={`Serve ${recipesList.find((r) => r.id === id)?.title || id}`}
                          InputLabelProps={{ shrink: true }}
                          value={serveValue(id, i)}
                          onChange={(e) => setServeAt((s) => ({ ...s, [id]: e.target.value }))}
                          sx={{ width: 170 }}
                        />
                      ))}
                    </Stack>
                  )}
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
                    <FormControl size="small" sx={{ width: 130 }}>
                      <InputLabel id="demo-count-label">Participants</InputLabel>
                      <Select
                        labelId="demo-count-label"
                        label="Participants"
                        value={count}
                        onChange={(e) => setCount(Number(e.target.value))}
                      >
                        {[2, 3, 4, 5].map((n) => (
                          <MenuItem key={n} value={n}>
                            {n}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    {names.slice(0, count).map((name, i) => (
                      <TextField
                        key={i}
                        size="small"
                        label={`Name ${i + 1}`}
                        value={name}
                        onChange={(e) => setNames((ns) => ns.map((x, j) => (j === i ? e.target.value : x)))}
                        sx={{ width: 110 }}
                      />
                    ))}
                  </Stack>
                  <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
                    <ToggleButtonGroup
                      size="small"
                      exclusive
                      value={sheets}
                      onChange={(e, v) => v && setSheets(v)}
                      aria-label="baking sheets"
                    >
                      <ToggleButton value={4}>4 sheets</ToggleButton>
                      <ToggleButton value={2}>2 sheets</ToggleButton>
                    </ToggleButtonGroup>
                    <FormControl size="small" sx={{ width: 140 }}>
                      <InputLabel id="demo-cleaning-label">Cleaning</InputLabel>
                      <Select
                        labelId="demo-cleaning-label"
                        label="Cleaning"
                        value={cleaning}
                        onChange={(e) => setCleaning(e.target.value)}
                      >
                        {CLEANING.map((c) => (
                          <MenuItem key={c} value={c}>
                            {c}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <TextField
                      size="small"
                      label="Seed"
                      type="number"
                      value={seed}
                      onChange={(e) => setSeed(e.target.value)}
                      inputProps={{ min: 0, step: 1 }}
                      sx={{ width: 90 }}
                    />
                    <Box sx={{ width: 180, px: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        Speed noise {Math.round(noise * 100)}%
                      </Typography>
                      <Slider
                        size="small"
                        min={0}
                        max={0.6}
                        step={0.05}
                        value={noise}
                        onChange={(e, v) => setNoise(Number(v))}
                        aria-label="speed noise"
                      />
                    </Box>
                  </Stack>
                  <Box>
                    <Button
                      variant="contained"
                      startIcon={<InsightsIcon />}
                      onClick={handlePlan}
                      disabled={selected.length === 0}
                    >
                      Plan
                    </Button>
                  </Box>
                </Stack>
              )}
            </CardContent>
          </Card>

          {planned && live && (
            <Card>
              <CardContent>
                <Stack spacing={2}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="h6">Live</Typography>
                    <Chip size="small" color="primary" label={fmtClock(live.clock)} />
                    {live.done ? (
                      <Chip size="small" color="success" label="all done" />
                    ) : (
                      <Chip size="small" variant="outlined" label={playing ? 'playing' : 'paused'} />
                    )}
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    {playing ? (
                      <Button variant="contained" startIcon={<PauseIcon />} onClick={pause}>
                        Pause
                      </Button>
                    ) : (
                      <Button
                        variant="contained"
                        startIcon={<PlayArrowIcon />}
                        onClick={() => setPlaying(true)}
                        disabled={live.done}
                      >
                        Play
                      </Button>
                    )}
                    <Button
                      variant="outlined"
                      startIcon={<SkipNextIcon />}
                      onClick={stepOnce}
                      disabled={playing || live.done}
                    >
                      Step
                    </Button>
                    <Button variant="outlined" startIcon={<RestartAltIcon />} onClick={reset}>
                      Reset
                    </Button>
                    <ButtonGroup size="small" aria-label="speed">
                      {SPEEDS.map((s) => (
                        <Button key={s} variant={s === speed ? 'contained' : 'outlined'} onClick={() => setSpeed(s)}>
                          {s}×
                        </Button>
                      ))}
                    </ButtonGroup>
                  </Stack>

                  <Box sx={{ mx: -1 }}>
                    <PlanLanes
                      plan={live.plan}
                      session={viewSession}
                      ownParticipantId={null}
                      selectedUuid={selectedItem}
                      onSelect={(item) => setSelectedItem(item.uuid)}
                      fixed={false}
                      now={live.clock}
                    />
                  </Box>

                  <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                    <Metric label="replans" value={live.counters.replans} />
                    <Metric label="interrupts" value={live.counters.interrupts} />
                    <Metric label="events" value={live.counters.events} />
                    <Metric
                      label="fairness"
                      value={live.metrics.fairness === null ? '—' : `${Math.round(live.metrics.fairness * 100)}%`}
                    />
                    <Metric label="blocked" value={fmtMinutes(live.metrics.blockedSeconds)} />
                    <Metric label="lopsided idle" value={fmtMinutes(live.metrics.idleLopsided)} />
                  </Stack>

                  <Box>
                    <Typography variant="subtitle2" gutterBottom>
                      Dish status
                    </Typography>
                    <Stack spacing={0.5}>
                      {(live.plan.dishes || []).map((d) => (
                        <Stack
                          key={d.dishId}
                          direction="row"
                          spacing={1}
                          alignItems="center"
                          flexWrap="wrap"
                          useFlexGap
                        >
                          <Typography sx={{ minWidth: 100, fontWeight: 500 }}>
                            {dishTitle(viewSession, d.dishId)}
                          </Typography>
                          <Typography variant="body2">
                            target {fmtClock(d.serveTarget)} · planned {fmtClock(d.plannedServe)}
                          </Typography>
                          <LatenessChip late={lateFor(live.metrics, d)} />
                        </Stack>
                      ))}
                    </Stack>
                  </Box>

                  <Box>
                    <Typography variant="subtitle2" gutterBottom>
                      Participants
                    </Typography>
                    <Stack spacing={1.5}>
                      {live.plan.lanes.map((lane) => {
                        const item = currentItem(lane)
                        return (
                          <Box key={lane.participantId}>
                            <Typography variant="caption" color="text.secondary">
                              {participantName(viewSession, lane.participantId)} ·{' '}
                              {item
                                ? item.status === 'started' || item.status === 'paused'
                                  ? 'now'
                                  : 'next'
                                : 'finished'}
                            </Typography>
                            {item ? (
                              <TaskCard
                                item={item}
                                session={viewSession}
                                ownParticipantId={null}
                                laneParticipantId={lane.participantId}
                                isCurrent={item.status === 'started'}
                                expanded
                                readOnly
                                now={live.clock}
                              />
                            ) : (
                              <Typography variant="body2">All tasks done.</Typography>
                            )}
                          </Box>
                        )
                      })}
                    </Stack>
                  </Box>

                  {selectedCard && (
                    <Box>
                      <Typography variant="subtitle2" gutterBottom>
                        Selected item
                      </Typography>
                      <TaskCard
                        item={selectedCard}
                        session={viewSession}
                        ownParticipantId={null}
                        laneParticipantId={selectedCard.participantId}
                        expanded
                        readOnly
                        now={live.clock}
                      />
                    </Box>
                  )}

                  <Box>
                    <Typography variant="subtitle2" gutterBottom>
                      Event log
                    </Typography>
                    <Box
                      ref={logRef}
                      data-testid="demo-log"
                      sx={{
                        maxHeight: 260,
                        overflowY: 'auto',
                        bgcolor: 'grey.50',
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 1,
                        p: 0.5,
                      }}
                    >
                      {live.entries.length === 0 ? (
                        <Typography variant="body2" color="text.secondary" sx={{ px: 0.5 }}>
                          Press Play or Step.
                        </Typography>
                      ) : (
                        live.entries.map((entry, i) => <LogLine key={`${entry.at}-${i}`} entry={entry} />)
                      )}
                    </Box>
                  </Box>
                </Stack>
              </CardContent>
            </Card>
          )}

          {planned && (
            <DraftPlan
              plan={planned.plan}
              session={viewSession}
              ownParticipantId={null}
              selectedUuid={selectedItem}
              onSelect={(item) => setSelectedItem(item.uuid)}
              now={live?.clock ?? null}
            />
          )}
        </Stack>
      </Container>
    </ThemeProvider>
  )
}
