// Full-screen alert when an `interrupt` arrives for me (spec §6.3): title, instructions, deadline countdown, which task
// will be paused, and one "I'm on it" button that emits appointmentAcknowledged.

import { useEffect, useState } from 'react'
import { Button, Dialog, DialogContent, Stack, Typography } from '@mui/material'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import { fmtCountdown } from '../utils/time'
import { findItem, unitsLeft } from '../utils/plan'
import { beep, vibrate } from './Timers'

export default function InterruptAlert({ interrupt, plan, onAcknowledge }) {
  const [now, setNow] = useState(Date.now())
  const open = !!interrupt
  const key = interrupt ? interrupt.appointmentUuid : null

  useEffect(() => {
    if (!open) return undefined
    beep()
    vibrate([300, 100, 300, 100, 300])
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [open, key])

  if (!interrupt) return null

  const paused = interrupt.preempts ? findItem(plan, interrupt.preempts) : null
  const left = paused ? unitsLeft(paused) : null
  const overdue = interrupt.deadline <= now

  return (
    <Dialog open fullScreen PaperProps={{ sx: { bgcolor: '#d32f2f', color: 'white' } }}>
      <DialogContent sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Stack spacing={3} alignItems="center" textAlign="center" sx={{ maxWidth: 520 }}>
          <NotificationsActiveIcon className="wiggle" sx={{ fontSize: 72 }} />
          <Typography variant="h3" component="div" sx={{ fontWeight: 'bold' }}>
            {interrupt.title}
          </Typography>
          <Typography variant="h6">{interrupt.instructions}</Typography>
          <Typography variant="h2" component="div" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {overdue ? 'NOW' : fmtCountdown(interrupt.deadline, now)}
          </Typography>
          {paused ? (
            <Typography variant="body1" sx={{ opacity: 0.9 }}>
              Your current task <b>{paused.title}</b> will be paused
              {left !== null ? ` (resume: ${left} left)` : ''}.
            </Typography>
          ) : (
            <Typography variant="body1" sx={{ opacity: 0.9 }}>
              Nothing to pause, go now.
            </Typography>
          )}
          <Button
            size="large"
            variant="contained"
            sx={{ bgcolor: 'white', color: '#d32f2f', fontSize: '1.5rem', px: 6, py: 2, '&:hover': { bgcolor: '#fee' } }}
            onClick={() => onAcknowledge && onAcknowledge(interrupt)}
          >
            I'm on it
          </Button>
        </Stack>
      </DialogContent>
    </Dialog>
  )
}
