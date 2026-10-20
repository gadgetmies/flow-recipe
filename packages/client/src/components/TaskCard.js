// One plan item as a card: title, dish chip, instructions, planned window, hand-offs, tools, units, and the action
// buttons that emit events (taskStarted / taskDone / taskPaused / taskProgress / appointmentAcknowledged).
// `readOnly` hides the buttons (the demo), `now` replaces the wall clock for countdowns (the demo's simulated clock).

import { useEffect, useState } from 'react'
import { Box, Button, Card, CardContent, Chip, LinearProgress, Stack, Typography } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import PauseIcon from '@mui/icons-material/Pause'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import AlarmIcon from '@mui/icons-material/Alarm'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import { fmtClock, fmtCountdown, fmtMinutes } from '../utils/time'
import { dishTitle, itemColor, kindLabel, participantName, unitsLeft } from '../utils/plan'

function StatusChip({ status }) {
  const color = status === 'done' ? 'success' : status === 'started' ? 'primary' : status === 'paused' ? 'warning' : 'default'
  return <Chip size="small" label={status} color={color} variant={status === 'planned' ? 'outlined' : 'filled'} />
}

export default function TaskCard({
  item,
  session,
  ownParticipantId,
  laneParticipantId,
  isCurrent = false,
  expanded = true,
  canAct: canActProp = false,
  actAs = null,
  onToggle,
  onEvent,
  timerDue = null,
  readOnly = false,
  now: nowProp = null,
}) {
  const [wallClock, setWallClock] = useState(Date.now())
  const now = nowProp ?? wallClock
  const hasTimer = !!item.timer
  useEffect(() => {
    if (!expanded || nowProp !== null || (!hasTimer && !item.passiveUntil)) return undefined
    const id = setInterval(() => setWallClock(Date.now()), 1000)
    return () => clearInterval(id)
  }, [expanded, hasTimer, item.passiveUntil, nowProp])

  const canAct = canActProp && !readOnly
  const isDone = item.status === 'done'
  const isStarted = item.status === 'started'
  const isPaused = item.status === 'paused'
  const isAppointment = item.kind === 'appointment'
  const isBlocked = item.kind === 'blocked'
  const perUnit = !!item.units
  const unitStream = item.context?.tool && /bun|cake|drink/.test(item.context.tool) ? item.context.tool : item.units && item.dishId ? dishTitle(session, item.dishId).toLowerCase() : 'units'
  const left = unitsLeft(item)
  const total = item.units ? item.units.to - item.units.from + 1 : 0
  const progress = Math.min(total, item.progress || 0)
  const laneName = laneParticipantId && laneParticipantId !== ownParticipantId ? participantName(session, laneParticipantId) : null
  const extra = actAs ? { actAs } : {}
  const emit = (type, more = {}) => onEvent && onEvent(type, item.uuid, { ...extra, ...more })
  const firesAt = item.timer ? (item.actualStart && item.kind !== 'appointment' ? item.actualStart + item.timer.durationSeconds * 1000 : item.timer.firesAt) : null
  const timerOverdue = firesAt !== null && firesAt <= now

  const header = (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: itemColor(item), flex: 'none' }} />
      <Typography variant={expanded ? 'h5' : 'subtitle1'} component="div" sx={{ flex: 1, minWidth: 0 }}>
        {item.kind === 'resume' && left !== null ? `${item.title}: ${left} left` : item.title} {isCurrent && '👈'}
        {isDone && <CheckCircleIcon sx={{ verticalAlign: 'middle', ml: 1, color: 'success.main' }} />}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {fmtClock(item.start)}–{fmtClock(item.end)}
      </Typography>
      <StatusChip status={item.status} />
    </Stack>
  )

  return (
    <Card id={`task-${item.uuid}`} sx={{ opacity: isDone ? 0.6 : isCurrent || expanded ? 1 : 0.75, scrollMarginTop: 60 }}>
      <CardContent onClick={!expanded && onToggle ? onToggle : undefined} sx={{ cursor: !expanded && onToggle ? 'pointer' : 'default' }}>
        {header}
        {expanded && (
          <Stack spacing={1.5} sx={{ mt: 1.5 }}>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip size="small" label={kindLabel(item)} sx={{ bgcolor: itemColor(item), color: 'white' }} />
              {item.dishId && <Chip size="small" variant="outlined" label={dishTitle(session, item.dishId)} />}
              {laneName && <Chip size="small" color="secondary" variant="outlined" label={laneName} />}
              {item.urgency && item.kind !== 'appointment' && <Chip size="small" variant="outlined" label={item.urgency} />}
              {item.context?.station && <Chip size="small" variant="outlined" label={item.context.station} />}
            </Stack>

            {isBlocked ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <HourglassEmptyIcon color="disabled" />
                <Typography>
                  Waiting for {item.context?.tool ? `a free ${item.context.tool}` : 'an input'}
                  {item.inputsFrom.length > 0 && ` from ${item.inputsFrom.map((h) => participantName(session, h.participantId)).join(', ')}`}
                </Typography>
              </Stack>
            ) : null}

            {item.instructions && <Typography sx={{ whiteSpace: 'pre-line' }}>{item.instructions}</Typography>}

            <Typography variant="subtitle2" color="text.secondary">
              Planned {fmtClock(item.start)}–{fmtClock(item.end)} ({fmtMinutes((item.end - item.start) / 1000)})
              {item.window && ` · window ${fmtClock(item.window.earliest)}–${fmtClock(item.window.latest)}`}
            </Typography>

            {item.inputsFrom.filter((h) => h.participantId !== laneParticipantId).length > 0 && (
              <Box>
                <Typography variant="subtitle2">Get:</Typography>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {item.inputsFrom
                    .filter((h) => h.participantId !== laneParticipantId)
                    .map((h, i) => (
                      <li key={`${h.outputId}-${i}`}>
                        {h.outputId} from <b>{participantName(session, h.participantId)}</b>
                        {h.byTime && ` (by ${fmtClock(h.byTime)})`}
                      </li>
                    ))}
                </ul>
              </Box>
            )}
            {item.outputsTo.filter((h) => h.participantId !== laneParticipantId).length > 0 && (
              <Box>
                <Typography variant="subtitle2">Hand to:</Typography>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {item.outputsTo
                    .filter((h) => h.participantId !== laneParticipantId)
                    .map((h, i) => (
                      <li key={`${h.outputId}-${i}`}>
                        {h.outputId} to <b>{participantName(session, h.participantId)}</b>
                        {h.byTime && ` (by ${fmtClock(h.byTime)})`}
                      </li>
                    ))}
                </ul>
              </Box>
            )}

            {item.tools.length > 0 && (
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
                <Typography variant="subtitle2">Tools:</Typography>
                {item.tools.map((tool, i) => (
                  <Chip key={`${tool.instanceId}-${i}`} size="small" label={tool.instanceId || tool.type} />
                ))}
              </Stack>
            )}

            {perUnit && (
              <Box>
                <Typography variant="subtitle2">
                  {unitStream} {item.units.from}–{item.units.to} of {item.units.of}
                  {progress > 0 && ` · ${progress}/${total} done`}
                </Typography>
                <LinearProgress variant="determinate" value={total ? (progress / total) * 100 : 0} sx={{ mt: 0.5 }} />
                {canAct && !isDone && (isStarted || isPaused) && (
                  <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
                    <Button size="small" variant="outlined" disabled={progress <= 0} onClick={() => emit('taskProgress', { units: progress - 1 })}>
                      −1
                    </Button>
                    <Typography variant="body2">{progress}</Typography>
                    <Button size="small" variant="outlined" disabled={progress >= total} onClick={() => emit('taskProgress', { units: progress + 1 })}>
                      +1
                    </Button>
                    <Button size="small" variant="outlined" disabled={progress >= total} onClick={() => emit('taskProgress', { units: Math.min(total, progress + 5) })}>
                      +5
                    </Button>
                  </Stack>
                )}
              </Box>
            )}

            {item.timer && !isDone && (
              <Stack direction="row" spacing={1} alignItems="center">
                <AlarmIcon color={timerOverdue ? 'error' : 'action'} />
                <Typography variant="h6" color={timerOverdue ? 'error' : 'text.primary'}>
                  {item.timer.title}: {timerOverdue ? 'now!' : fmtCountdown(firesAt, now)}
                </Typography>
                {timerDue && <Chip size="small" color="error" label="due" />}
              </Stack>
            )}
            {item.passiveUntil && isStarted && !item.timer && (
              <Typography variant="body2" color="text.secondary">
                Passive until {fmtClock(item.passiveUntil)}
              </Typography>
            )}

            {!isDone && canAct && (
              <Stack direction="row" spacing={1} justifyContent="center" flexWrap="wrap" useFlexGap>
                {isAppointment ? (
                  <>
                    {!isStarted && (
                      <Button variant="contained" color="warning" onClick={() => emit('appointmentAcknowledged')}>
                        Acknowledge
                      </Button>
                    )}
                    <Button variant="contained" startIcon={<CheckCircleIcon />} onClick={() => emit('taskDone')}>
                      Done
                    </Button>
                  </>
                ) : isBlocked ? (
                  <Button variant="outlined" onClick={() => emit('taskDone')}>
                    Input arrived, continue
                  </Button>
                ) : (
                  <>
                    {!isStarted && (
                      <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={() => emit('taskStarted')}>
                        {isPaused ? 'Resume' : 'Start'}
                      </Button>
                    )}
                    {isStarted && item.preemptible !== 'never' && (
                      <Button variant="outlined" startIcon={<PauseIcon />} onClick={() => emit('taskPaused')}>
                        Pause
                      </Button>
                    )}
                    <Button variant="contained" color={isStarted ? 'primary' : 'inherit'} startIcon={<CheckCircleIcon />} onClick={() => emit('taskDone')}>
                      {actAs ? 'Mark done' : 'Done, next!'}
                    </Button>
                  </>
                )}
              </Stack>
            )}
          </Stack>
        )}
      </CardContent>
    </Card>
  )
}
