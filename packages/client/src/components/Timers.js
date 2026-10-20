// Countdowns for the own lane's timers (plan items with `timer`), beep/vibrate when due, plus the help FAB from v1.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Fab } from '@mui/material'
import WavingHandIcon from '@mui/icons-material/WavingHand'
import { fmtDuration } from '../utils/time'
import { laneItems, participantName } from '../utils/plan'

const LOOKAHEAD_MS = 30 * 60_000

export function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.value = 0.2
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.35)
    osc.onended = () => ctx.close && ctx.close()
  } catch (e) {
    // audio unavailable
  }
}

export function vibrate(pattern = [200, 100, 200]) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(pattern)
  } catch (e) {
    // ignore
  }
}

/** Timers derived from a lane: { uuid, title, end, item }, only for items that are not done. */
export function timersForLane(lane, now) {
  return laneItems(lane)
    .filter((item) => item.timer && item.status !== 'done')
    .map((item) => ({
      uuid: item.uuid,
      title: item.timer.title,
      end: item.actualStart && item.kind !== 'appointment' ? item.actualStart + item.timer.durationSeconds * 1000 : item.timer.firesAt,
      item,
    }))
    .filter((t) => t.item.status === 'started' || t.item.status === 'paused' || t.end - now < LOOKAHEAD_MS)
    .sort((a, b) => a.end - b.end)
}

export default function Timers({ lane, session, ownParticipantId, isHost, helpRequests = [], onAskForHelp, onScrollTo, onTimerDue }) {
  const [now, setNow] = useState(Date.now())
  const [dismissed, setDismissed] = useState([])
  const firedRef = useRef(new Set())
  const helpRequested = helpRequests.includes(ownParticipantId)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const timers = useMemo(() => timersForLane(lane, now).filter((t) => !dismissed.includes(t.uuid)), [lane, now, dismissed])

  useEffect(() => {
    for (const t of timers) {
      if (t.end <= now && !firedRef.current.has(t.uuid)) {
        firedRef.current.add(t.uuid)
        beep()
        vibrate()
        if (onTimerDue) onTimerDue(t.item)
      }
    }
  }, [timers, now, onTimerDue])

  const dismiss = useCallback((uuid) => setDismissed((d) => [...d, uuid]), [])

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 70,
        right: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        zIndex: 3,
      }}
    >
      {timers.map(({ title, end, uuid }) => {
        const timeLeft = Math.max(0, (end - now) / 1000)
        const due = timeLeft === 0
        return (
          <div
            key={`timer-${uuid}`}
            className={due ? 'wiggle' : ''}
            role="button"
            style={{
              width: '7.5em',
              background: due ? '#f99' : 'white',
              borderRadius: 6,
              marginBottom: '0.5em',
              padding: '0.5em',
              boxShadow: '2px 2px 10px rgba(0, 0, 0, 0.2)',
              textAlign: 'center',
              cursor: 'pointer',
            }}
            onClick={() => {
              if (due) dismiss(uuid)
              else if (onScrollTo) onScrollTo(uuid)
            }}
          >
            <div style={{ fontSize: '75%' }}>{title}</div>
            <div>
              {due ? (
                <>
                  <div>Ready!</div>
                  <div style={{ fontSize: '75%' }}>Click to clear</div>
                </>
              ) : (
                fmtDuration(timeLeft)
              )}
            </div>
          </div>
        )
      })}
      {helpRequests
        .filter((id) => id !== ownParticipantId)
        .map((id) => (
          <Fab key={`help-${id}`} color="primary" aria-label="help requested" className="wiggle" variant="extended" sx={{ margin: 1 }}>
            <WavingHandIcon sx={{ mr: 1 }} />
            {participantName(session, id)}
          </Fab>
        ))}
      {!isHost && onAskForHelp && (
        <Fab
          color={helpRequested ? 'primary' : 'default'}
          aria-label="ask for help"
          onClick={(e) => {
            e.currentTarget.blur()
            onAskForHelp(!helpRequested)
          }}
          className={helpRequested ? 'wiggle' : ''}
        >
          <WavingHandIcon />
        </Fab>
      )}
    </div>
  )
}
