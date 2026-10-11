// The Gantt view of the plan: one row per lane, absolute time axis, a moving "now" line, items coloured by kind and
// status. Tapping an item selects it. Horizontally scrollable; auto-centres on the own current item. The clock is the
// wall clock unless a `now` prop is given (the demo passes its simulated clock; the view then follows that line).

import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { fmtClock } from '../utils/time'
import { itemColor, KIND_COLORS, participantName } from '../utils/plan'

const LANE_HEIGHT = 34
const AXIS_HEIGHT = 18
const LABEL_WIDTH = 88
const PX_PER_MIN = 10

function fillFor(item) {
  if (item.kind === 'idle') return 'transparent'
  if (item.status === 'done') return KIND_COLORS.done
  if (item.kind === 'blocked') return 'url(#hatch)'
  return itemColor(item)
}

function opacityFor(item) {
  if (item.status === 'done') return 0.9
  if (item.status === 'started') return 1
  if (item.status === 'paused') return 0.5
  return 0.65
}

export default function PlanLanes({
  plan,
  session,
  ownParticipantId,
  selectedUuid,
  onSelect,
  fixed = true,
  showNow = true,
  now: nowProp = null,
}) {
  const scrollRef = useRef(null)
  const [wallClock, setWallClock] = useState(Date.now())
  const now = nowProp ?? wallClock

  useEffect(() => {
    if (!showNow || nowProp !== null) return undefined
    const id = setInterval(() => setWallClock(Date.now()), 1000)
    return () => clearInterval(id)
  }, [showNow, nowProp])

  const lanes = useMemo(() => plan?.lanes || [], [plan])
  const allItems = useMemo(() => lanes.flatMap((l) => l.items), [lanes])

  const t0 = useMemo(() => {
    const starts = allItems.map((i) => i.start)
    const s = Math.min(plan?.startTime ?? Infinity, ...starts)
    return Number.isFinite(s) ? Math.floor(s / 60_000) * 60_000 - 60_000 : now
  }, [allItems, plan, now])
  const t1 = useMemo(() => {
    const ends = allItems.map((i) => i.end)
    const e = Math.max(plan?.endTime ?? -Infinity, ...ends)
    return Number.isFinite(e) ? Math.ceil(e / 60_000) * 60_000 + 60_000 : t0 + 60 * 60_000
  }, [allItems, plan, t0])

  const x = (ms) => ((ms - t0) / 60_000) * PX_PER_MIN
  const width = Math.max(300, x(t1))
  const height = AXIS_HEIGHT + lanes.length * LANE_HEIGHT

  const spanMin = (t1 - t0) / 60_000
  const tickEvery = spanMin > 240 ? 30 : spanMin > 120 ? 15 : spanMin > 45 ? 10 : 5
  const ticks = []
  for (let ms = t0; ms <= t1; ms += tickEvery * 60_000) {
    const minutes = new Date(ms).getMinutes()
    if (minutes % tickEvery === 0) ticks.push(ms)
  }

  // auto-centre on the own current item (first non-done item on the own lane) when it changes
  const ownLane = lanes.find((l) => l.participantId === ownParticipantId)
  const ownCurrent = ownLane?.items.find((i) => i.kind !== 'idle' && i.status !== 'done')
  const centreKey = ownCurrent ? ownCurrent.uuid : selectedUuid || null
  const centreX = ownCurrent ? x((ownCurrent.start + ownCurrent.end) / 2) : null
  useEffect(() => {
    const el = scrollRef.current
    if (!el || centreX === null) return
    el.scrollLeft = Math.max(0, centreX - el.clientWidth / 2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreKey])

  // with an external clock, keep the now line in view (scroll when it leaves the visible window)
  const nowX = x(now)
  useEffect(() => {
    const el = scrollRef.current
    if (nowProp === null || !el || !showNow) return
    const margin = 24
    if (nowX < el.scrollLeft + margin || nowX > el.scrollLeft + el.clientWidth - margin) {
      el.scrollLeft = Math.max(0, nowX - el.clientWidth / 3)
    }
  }, [nowProp, nowX, showNow])

  if (lanes.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          No plan yet.
        </Typography>
      </Box>
    )
  }

  const nowVisible = showNow && now >= t0 && now <= t1

  const body = (
    <Box sx={{ display: 'flex', alignItems: 'stretch', width: '100%' }}>
      <Box sx={{ width: LABEL_WIDTH, flex: 'none', pt: `${AXIS_HEIGHT}px` }}>
        {lanes.map((lane) => {
          const own = lane.participantId === ownParticipantId
          return (
            <Box
              key={lane.participantId}
              sx={{
                height: LANE_HEIGHT,
                display: 'flex',
                alignItems: 'center',
                pr: 1,
                fontSize: 12,
                fontWeight: own ? 700 : 400,
                color: own ? 'primary.main' : 'text.primary',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
              }}
              title={participantName(session, lane.participantId)}
            >
              {participantName(session, lane.participantId)}
            </Box>
          )
        })}
      </Box>
      <div ref={scrollRef} style={{ overflowX: 'auto', flex: 1 }} className="hide-scrollbar">
        <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} style={{ display: 'block' }}>
          <defs>
            <pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="#e0e0e0" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="#9e9e9e" strokeWidth="2" />
            </pattern>
          </defs>
          {/* own lane highlight */}
          {lanes.map((lane, i) =>
            lane.participantId === ownParticipantId ? (
              <rect
                key={`own-${lane.participantId}`}
                x={0}
                y={AXIS_HEIGHT + i * LANE_HEIGHT}
                width={width}
                height={LANE_HEIGHT}
                fill="rgba(233, 30, 99, 0.08)"
              />
            ) : null
          )}
          {/* axis */}
          {ticks.map((ms) => (
            <g key={ms}>
              <line x1={x(ms)} y1={AXIS_HEIGHT - 4} x2={x(ms)} y2={height} stroke="#eee" />
              <text x={x(ms) + 2} y={AXIS_HEIGHT - 6} fontSize={10} fill="#666">
                {fmtClock(ms)}
              </text>
            </g>
          ))}
          {/* items */}
          {lanes.map((lane, laneIndex) =>
            lane.items.map((item) => {
              if (item.kind === 'idle') return null
              const ix = x(item.start)
              const w = Math.max(3, x(item.end) - ix - 1)
              const y = AXIS_HEIGHT + laneIndex * LANE_HEIGHT + 4
              const h = LANE_HEIGHT - 8
              const selected = item.uuid === selectedUuid
              return (
                <g
                  key={item.uuid}
                  id={`lane-item-${item.uuid}`}
                  onClick={() => onSelect && onSelect(item, lane.participantId)}
                  style={{ cursor: onSelect ? 'pointer' : 'default' }}
                >
                  <title>
                    {`${item.title} (${item.kind}${item.urgency ? ', ' + item.urgency : ''}, ${item.status}) ${fmtClock(item.start)}–${fmtClock(item.end)}`}
                  </title>
                  <rect
                    x={ix}
                    y={y}
                    width={w}
                    height={h}
                    rx={item.kind === 'appointment' || item.kind === 'check' ? h / 2 : 5}
                    fill={fillFor(item)}
                    opacity={opacityFor(item)}
                    stroke={selected ? '#111' : item.status === 'started' ? '#111' : item.kind === 'blocked' ? '#9e9e9e' : 'none'}
                    strokeWidth={selected ? 2.5 : 1.5}
                    strokeDasharray={item.status === 'paused' ? '4 2' : undefined}
                  />
                  {w > 28 && (
                    <text x={ix + 4} y={y + h / 2 + 4} fontSize={10} fill={item.status === 'done' ? '#124' : '#fff'} style={{ pointerEvents: 'none' }}>
                      {item.title.slice(0, Math.max(1, Math.floor(w / 6)))}
                    </text>
                  )}
                </g>
              )
            })
          )}
          {/* now line */}
          {nowVisible && (
            <g>
              <line x1={nowX} y1={0} x2={nowX} y2={height} stroke="#d32f2f" strokeWidth={2} />
              <text x={nowX + 3} y={10} fontSize={9} fill="#d32f2f">
                now
              </text>
            </g>
          )}
        </svg>
      </div>
    </Box>
  )

  if (!fixed) return <Box sx={{ width: '100%' }}>{body}</Box>

  return (
    <Box
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        pb: 7,
        pt: 1,
        px: 1,
        background: 'white',
        borderTop: '1px solid #eee',
        boxShadow: 3,
        zIndex: 2,
      }}
    >
      {body}
    </Box>
  )
}

export { LANE_HEIGHT, AXIS_HEIGHT, PX_PER_MIN }
