// Settings tab. The host edits dishes, participants, inventory and policy and starts/restarts the session; everyone
// else sees a read-only summary and edits their own profile.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  Link,
  List,
  ListItem,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import DeleteIcon from '@mui/icons-material/Delete'
import AddIcon from '@mui/icons-material/Add'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import { getDefaultInventory, getRecipes } from '../api'
import { fmtClock, msToTimeInput, timeInputToMs } from '../utils/time'
import { HOST_ID } from '../config'

const CAPABILITIES = ['knife', 'hot-pan', 'oven']
const ROLES = ['cook', 'cleaner', 'spectator']
const WEIGHTS = ['fair', 'idle', 'switch', 'span']

/** Debounce a callback: the last call within `ms` wins. */
function useDebounced(fn, ms = 400) {
  const timer = useRef(null)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => () => timer.current && clearTimeout(timer.current), [])
  return (...args) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => fnRef.current(...args), ms)
  }
}

// ---------- dishes ----------

function DishesEditor({ dishes, recipes, onChange, readOnly }) {
  const [local, setLocal] = useState(dishes)
  useEffect(() => setLocal(dishes), [dishes])
  const emit = useDebounced((next) => onChange(next.map(({ title, ...d }) => d)))
  const update = (i, patch) => {
    const next = local.map((d, j) => (j === i ? { ...d, ...patch } : d))
    setLocal(next)
    emit(next)
  }
  const remove = (i) => {
    const next = local.filter((_, j) => j !== i)
    setLocal(next)
    onChange(next.map(({ title, ...d }) => d))
  }
  const add = () => {
    const recipe = recipes.find((r) => !local.some((d) => d.recipeId === r.id)) || recipes[0]
    if (!recipe) return
    const next = [
      ...local,
      { recipeId: recipe.id, title: recipe.title, scale: 1, serveTime: Date.now() + 90 * 60_000, earlyTolerance: 0, lateTolerance: 300_000 },
    ]
    setLocal(next)
    onChange(next.map(({ title, ...d }) => d))
  }

  if (readOnly) {
    return (
      <List dense>
        {dishes.map((d) => (
          <ListItem key={d.id || d.recipeId}>
            <Typography>
              <b>{d.title || d.recipeId}</b> × {d.scale}, serve at {fmtClock(d.serveTime)}
            </Typography>
          </ListItem>
        ))}
      </List>
    )
  }

  return (
    <Stack spacing={2}>
      {local.map((d, i) => (
        <Stack key={d.id || `${d.recipeId}-${i}`} spacing={1}>
          <Stack direction="row" spacing={1} alignItems="center">
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel id={`dish-${i}-label`}>Recipe</InputLabel>
              <Select
                labelId={`dish-${i}-label`}
                label="Recipe"
                value={d.recipeId}
                onChange={(e) => {
                  const r = recipes.find((x) => x.id === e.target.value)
                  update(i, { recipeId: e.target.value, title: r?.title || e.target.value })
                }}
              >
                {(recipes.some((r) => r.id === d.recipeId) ? recipes : [...recipes, { id: d.recipeId, title: d.title || d.recipeId }]).map((r) => (
                  <MenuItem key={r.id} value={r.id}>
                    {r.title}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <IconButton aria-label="remove dish" onClick={() => remove(i)} disabled={local.length <= 1}>
              <DeleteIcon />
            </IconButton>
          </Stack>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <TextField
              size="small"
              label="Scale"
              type="number"
              inputProps={{ min: 0.25, step: 0.25 }}
              value={d.scale}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (!Number.isNaN(v) && v > 0) update(i, { scale: v })
              }}
              sx={{ width: 90 }}
            />
            <TextField
              size="small"
              label="Serve at"
              type="time"
              InputLabelProps={{ shrink: true }}
              value={msToTimeInput(d.serveTime)}
              onChange={(e) => {
                const ms = timeInputToMs(e.target.value, d.serveTime || Date.now())
                if (ms) update(i, { serveTime: ms })
              }}
              sx={{ width: 130 }}
            />
            <TextField
              size="small"
              label="Early (min)"
              type="number"
              inputProps={{ min: 0 }}
              value={Math.round((d.earlyTolerance || 0) / 60_000)}
              onChange={(e) => update(i, { earlyTolerance: Math.max(0, parseInt(e.target.value, 10) || 0) * 60_000 })}
              sx={{ width: 100 }}
            />
            <TextField
              size="small"
              label="Late (min)"
              type="number"
              inputProps={{ min: 0 }}
              value={Math.round((d.lateTolerance || 0) / 60_000)}
              onChange={(e) => update(i, { lateTolerance: Math.max(0, parseInt(e.target.value, 10) || 0) * 60_000 })}
              sx={{ width: 100 }}
            />
          </Stack>
        </Stack>
      ))}
      <Button startIcon={<AddIcon />} onClick={add} disabled={recipes.length === 0}>
        Add dish
      </Button>
    </Stack>
  )
}

// ---------- participants ----------

function ProfileEditor({ participant, onChange, canEdit }) {
  const profile = participant.profile || {}
  const [speed, setSpeed] = useState(profile.speed ?? 1)
  const [share, setShare] = useState(profile.targetShare ?? 1)
  useEffect(() => setSpeed(profile.speed ?? 1), [profile.speed])
  useEffect(() => setShare(profile.targetShare ?? 1), [profile.targetShare])
  const caps = profile.capabilities === null || profile.capabilities === undefined ? CAPABILITIES : profile.capabilities

  if (!canEdit) {
    return (
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip size="small" variant="outlined" label={`speed ${profile.speed ?? 1}`} />
        <Chip size="small" variant="outlined" label={profile.role || 'cook'} />
        {caps.map((c) => (
          <Chip key={c} size="small" label={c} />
        ))}
      </Stack>
    )
  }

  return (
    <Stack spacing={1} sx={{ width: '100%' }}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="body2" sx={{ width: 90 }}>
          Speed {speed.toFixed(2)}
        </Typography>
        <Slider
          size="small"
          min={0.5}
          max={1.5}
          step={0.05}
          value={speed}
          onChange={(_, v) => setSpeed(v)}
          onChangeCommitted={(_, v) => onChange({ speed: v })}
          sx={{ flex: 1 }}
          aria-label="speed"
        />
      </Stack>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="body2" sx={{ width: 90 }}>
          Share {share.toFixed(2)}
        </Typography>
        <Slider
          size="small"
          min={0.25}
          max={2}
          step={0.25}
          value={share}
          onChange={(_, v) => setShare(v)}
          onChangeCommitted={(_, v) => onChange({ targetShare: v })}
          sx={{ flex: 1 }}
          aria-label="target share"
        />
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel id={`role-${participant.id}`}>Role</InputLabel>
          <Select labelId={`role-${participant.id}`} label="Role" value={profile.role || 'cook'} onChange={(e) => onChange({ role: e.target.value })}>
            {ROLES.map((r) => (
              <MenuItem key={r} value={r}>
                {r}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {CAPABILITIES.map((c) => {
          const on = caps.includes(c)
          return (
            <Chip
              key={c}
              label={c}
              color={on ? 'primary' : 'default'}
              variant={on ? 'filled' : 'outlined'}
              onClick={() => onChange({ capabilities: on ? caps.filter((x) => x !== c) : [...caps, c] })}
            />
          )
        })}
      </Stack>
    </Stack>
  )
}

function ParticipantsEditor({ session, ownParticipantId, isHost, name, onNameChange, onUpdateParticipant, onAddPlaceholder, onRemovePlaceholder }) {
  const participants = session?.participants || []
  return (
    <Stack spacing={2}>
      <List disablePadding>
        {participants.map((p) => {
          const own = p.id === ownParticipantId
          const canEdit = own || isHost
          return (
            <ListItem key={p.id} divider sx={{ flexDirection: 'column', alignItems: 'stretch', gap: 1 }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                {own ? (
                  <TextField size="small" label="your name" value={name} onChange={(e) => onNameChange(e.target.value)} />
                ) : (
                  <Typography sx={{ fontWeight: 500 }}>{p.name || p.id}</Typography>
                )}
                {p.id === HOST_ID && <Chip label="Host" color="secondary" size="small" />}
                {p.placeholder && <Chip label="Expected" size="small" variant="outlined" />}
                {!p.placeholder && !p.connected && <Chip label="Offline" size="small" variant="outlined" />}
                <Chip label={p.isSpectator ? 'Spectator' : 'Participant'} color={p.isSpectator ? 'default' : 'primary'} size="small" />
                {canEdit && !p.placeholder && (
                  <Button size="small" onClick={() => onUpdateParticipant(p.id, { isSpectator: !p.isSpectator })}>
                    {p.isSpectator ? 'Join session' : 'Leave session'}
                  </Button>
                )}
                {isHost && p.placeholder && (
                  <IconButton size="small" aria-label="remove expected participant" onClick={() => onRemovePlaceholder(p.id)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                )}
              </Stack>
              <ProfileEditor participant={p} canEdit={canEdit} onChange={(profile) => onUpdateParticipant(p.id, { profile })} />
            </ListItem>
          )
        })}
      </List>
      {isHost && (
        <Button startIcon={<AddIcon />} onClick={() => onAddPlaceholder({})}>
          Add expected participant
        </Button>
      )}
    </Stack>
  )
}

// ---------- inventory ----------

function InventoryEditor({ inventory, onChange }) {
  const [local, setLocal] = useState(inventory)
  useEffect(() => setLocal(inventory), [inventory])
  const emit = useDebounced(onChange)
  if (!local) return <Typography color="text.secondary">Loading inventory…</Typography>

  const updateTool = (type, patch) => {
    const tools = local.tools.map((t) => (t.type === type ? { ...t, ...patch } : t))
    setLocal({ ...local, tools })
    const tool = tools.find((t) => t.type === type)
    emit({ tools: [tool] })
  }
  const updateAppliance = (type, patch) => {
    const appliances = local.appliances.map((a) => (a.type === type ? { ...a, ...patch } : a))
    setLocal({ ...local, appliances })
    emit({ appliances: [appliances.find((a) => a.type === type)] })
  }
  const updateStation = (type, patch) => {
    const stations = local.stations.map((s) => (s.type === type ? { ...s, ...patch } : s))
    setLocal({ ...local, stations })
    emit({ stations: [stations.find((s) => s.type === type)] })
  }
  const num = (v, fallback = 0) => {
    const n = parseInt(v, 10)
    return Number.isNaN(n) ? fallback : Math.max(0, n)
  }

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2">Appliances</Typography>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Type</TableCell>
            <TableCell align="right">Slots</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {(local.appliances || []).map((a) => (
            <TableRow key={a.type}>
              <TableCell>{a.type}</TableCell>
              <TableCell align="right">
                <TextField size="small" type="number" inputProps={{ min: 0, 'aria-label': `${a.type} slots` }} value={a.slots} onChange={(e) => updateAppliance(a.type, { slots: num(e.target.value) })} sx={{ width: 80 }} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography variant="subtitle2">Stations</Typography>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Type</TableCell>
            <TableCell align="right">Count</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {(local.stations || []).map((s) => (
            <TableRow key={s.type}>
              <TableCell>{s.type}</TableCell>
              <TableCell align="right">
                <TextField size="small" type="number" inputProps={{ min: 0, 'aria-label': `${s.type} count` }} value={s.count} onChange={(e) => updateStation(s.type, { count: num(e.target.value) })} sx={{ width: 80 }} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography variant="subtitle2">Tools</Typography>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Type</TableCell>
            <TableCell align="right">Count</TableCell>
            <TableCell align="right">Capacity</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {(local.tools || []).map((t) => (
            <TableRow key={t.type}>
              <TableCell>{t.type}</TableCell>
              <TableCell align="right">
                <TextField size="small" type="number" inputProps={{ min: 0, 'aria-label': `${t.type} count` }} value={t.count} onChange={(e) => updateTool(t.type, { count: num(e.target.value) })} sx={{ width: 80 }} />
              </TableCell>
              <TableCell align="right">
                {t.capacity ? (
                  <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="flex-end">
                    <TextField
                      size="small"
                      type="number"
                      inputProps={{ min: 0, step: 'any', 'aria-label': `${t.type} capacity` }}
                      value={t.capacity.number}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value)
                        if (!Number.isNaN(n)) updateTool(t.type, { capacity: { ...t.capacity, number: n } })
                      }}
                      sx={{ width: 80 }}
                    />
                    <Typography variant="body2">{t.capacity.unit}</Typography>
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    –
                  </Typography>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Stack>
  )
}

// ---------- policy ----------

function PolicyEditor({ policy, onChange, readOnly }) {
  const [weights, setWeights] = useState(policy?.weights || {})
  useEffect(() => setWeights(policy?.weights || {}), [policy])
  if (!policy) return null
  if (readOnly) {
    return (
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip size="small" variant="outlined" label={`cleaning: ${policy.cleaning}`} />
        <Chip size="small" variant="outlined" label={`end-of-session cleaning: ${policy.endOfSessionCleaning ? 'on' : 'off'}`} />
        <Chip size="small" variant="outlined" label={`mise en place: ${policy.miseEnPlace ? 'on' : 'off'}`} />
      </Stack>
    )
  }
  return (
    <Stack spacing={2}>
      <FormControl size="small" sx={{ maxWidth: 240 }}>
        <InputLabel id="cleaning-label">Cleaning</InputLabel>
        <Select labelId="cleaning-label" label="Cleaning" value={policy.cleaning || 'shared'} onChange={(e) => onChange({ cleaning: e.target.value })}>
          <MenuItem value="shared">shared</MenuItem>
          <MenuItem value="dedicated">dedicated</MenuItem>
          <MenuItem value="deferred">deferred</MenuItem>
        </Select>
      </FormControl>
      <FormControlLabel
        control={<Switch checked={!!policy.endOfSessionCleaning} onChange={(e) => onChange({ endOfSessionCleaning: e.target.checked })} />}
        label="Clean up at the end of the session"
      />
      <FormControlLabel
        control={<Switch checked={!!policy.miseEnPlace} onChange={(e) => onChange({ miseEnPlace: e.target.checked })} />}
        label="Mise en place (measure everything first)"
      />
      <Typography variant="subtitle2">Weights</Typography>
      {WEIGHTS.map((w) => (
        <Stack key={w} direction="row" spacing={2} alignItems="center">
          <Typography variant="body2" sx={{ width: 90 }}>
            {w} {weights[w] ?? 0}
          </Typography>
          <Slider
            size="small"
            min={0}
            max={20}
            step={1}
            value={weights[w] ?? 0}
            onChange={(_, v) => setWeights({ ...weights, [w]: v })}
            onChangeCommitted={(_, v) => onChange({ weights: { ...weights, [w]: v } })}
            sx={{ flex: 1 }}
            aria-label={`weight ${w}`}
          />
        </Stack>
      ))}
    </Stack>
  )
}

// ---------- the tab ----------

export default function HostSettings({
  session,
  plan,
  ownParticipantId,
  isHost,
  mock,
  name,
  onNameChange,
  baseUrl,
  onUpdateParticipant,
  onAddPlaceholder,
  onRemovePlaceholder,
  onUpdateDishes,
  onUpdateInventory,
  onUpdatePolicy,
  onStart,
  onRestart,
}) {
  const [recipes, setRecipes] = useState([])
  const [defaultInventory, setDefaultInventory] = useState(null)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    let cancelled = false
    getRecipes(mock)
      .then((r) => !cancelled && setRecipes(r))
      .catch((e) => !cancelled && setLoadError(e.message))
    getDefaultInventory(mock)
      .then((i) => !cancelled && setDefaultInventory(i))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mock])

  const inventory = useMemo(() => session?.inventory || defaultInventory, [session, defaultInventory])
  const isDraft = !session || session.status === 'draft'
  const cooks = (session?.participants || []).filter((p) => !p.isSpectator)
  const title = (session?.dishes || []).map((d) => d.title || d.recipeId).join(' + ') || 'Flow Recipe'

  return (
    <Box paddingBottom={9}>
      <Stack spacing={2}>
        <Typography variant="h6">
          {title}
          {session && (
            <Chip size="small" sx={{ ml: 1 }} color={session.status === 'running' ? 'primary' : 'default'} label={session.status} />
          )}
        </Typography>
        {loadError && (
          <Typography color="error" variant="body2">
            {loadError}
          </Typography>
        )}

        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Dishes
            </Typography>
            {session ? (
              <DishesEditor dishes={session.dishes} recipes={recipes} onChange={onUpdateDishes} readOnly={!isHost || !isDraft} />
            ) : (
              'Connecting...'
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Participants
            </Typography>
            {session ? (
              <ParticipantsEditor
                session={session}
                ownParticipantId={ownParticipantId}
                isHost={isHost}
                name={name}
                onNameChange={onNameChange}
                onUpdateParticipant={onUpdateParticipant}
                onAddPlaceholder={onAddPlaceholder}
                onRemovePlaceholder={onRemovePlaceholder}
              />
            ) : (
              'Connecting...'
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Policy
            </Typography>
            <PolicyEditor policy={session?.policy} onChange={onUpdatePolicy} readOnly={!isHost} />
          </CardContent>
        </Card>

        {isHost && (
          <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="h6">Inventory</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <InventoryEditor inventory={inventory} onChange={onUpdateInventory} />
            </AccordionDetails>
          </Accordion>
        )}

        {isHost && (
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Session control
              </Typography>
              <Typography sx={{ mb: 2 }}>
                Status: {session?.status || 'connecting'}
                {plan?.dishes?.length > 0 && isDraft && ` · planned serve ${plan.dishes.map((d) => fmtClock(d.plannedServe)).join(', ')}`}
              </Typography>
              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                <Button variant="contained" color="primary" startIcon={<PlayArrowIcon />} disabled={!isDraft || cooks.length < 1} onClick={onStart}>
                  {isDraft ? 'Start session' : 'Session started'}
                </Button>
                <Button variant="outlined" startIcon={<RestartAltIcon />} onClick={onRestart}>
                  Restart
                </Button>
              </Stack>
              <Divider sx={{ my: 2 }} />
              <Stack spacing={0.5}>
                {session?.dishes?.[0] && (
                  <Link href={`${baseUrl}?recipe=${session.dishes[0].recipeId}`}>New session with recipe: {session.dishes[0].title || session.dishes[0].recipeId}</Link>
                )}
                <Link component={RouterLink} to="/demo" variant="body2">
                  Open demo (simulated cooks, no server needed)
                </Link>
              </Stack>
            </CardContent>
          </Card>
        )}
      </Stack>
    </Box>
  )
}
