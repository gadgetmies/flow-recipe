// Step 2 of an import with Claude: the request waits on the server until the user's Claude (with the Flow Recipe
// connector) picks it up and submits a draft. Open Claude with the prepared message (or copy it), then wait here.

import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  LinearProgress,
  Paper,
  Stack,
  Step,
  StepContent,
  StepLabel,
  Stepper,
  Typography,
} from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import CheckIcon from '@mui/icons-material/Check'
import RateReviewIcon from '@mui/icons-material/RateReview'
import ReplayIcon from '@mui/icons-material/Replay'
import { fmtDuration } from '../utils/time'
import { copyText } from './importApi'

/** After this long without Claude picking the request up, say what usually went wrong. */
const NUDGE_AFTER_MS = 90 * 1000

const STAGES = [
  {
    key: 'pending',
    label: 'Send the message in Claude',
    done: 'Claude got the request',
    hint: 'This page checks every few seconds and keeps waiting while you are in Claude.',
  },
  {
    key: 'claimed',
    label: 'Claude writes the recipe',
    hint: 'Claude reads the recipe, writes it for the planner and checks it. This usually takes a few minutes.',
  },
  { key: 'ready', label: 'Draft received', hint: 'Opening the review…' },
]

const stageIndex = (status) => (status === 'ready' || status === 'saved' ? 3 : status === 'claimed' ? 1 : 0)

export function claudeStatusText(status) {
  if (status === 'ready' || status === 'saved') return 'Draft received'
  if (status === 'claimed') return 'Claude has picked it up'
  return 'Waiting for Claude…'
}

const ENDED = {
  cancelled: 'This import was cancelled.',
  expired: 'This import request expired (requests are kept for 24 hours).',
}

export default function ClaudeHandoff({ request, state, startedAt, onCancel, onReview, onRestart }) {
  const [now, setNow] = useState(Date.now())
  const [copied, setCopied] = useState(null) // null | 'ok' | 'failed'
  const promptRef = useRef(null)
  const status = state?.status || 'pending'
  const ended = ENDED[status] || state?.error
  const ready = status === 'ready' || status === 'saved'

  useEffect(() => {
    if (ended || ready) return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ended, ready])

  useEffect(() => {
    if (copied !== 'ok') return undefined
    const t = setTimeout(() => setCopied(null), 2500)
    return () => clearTimeout(t)
  }, [copied])

  const copy = async () => {
    const ok = await copyText(request.prompt)
    setCopied(ok ? 'ok' : 'failed')
    if (!ok && promptRef.current) {
      // let the user copy it by hand
      const range = document.createRange()
      range.selectNodeContents(promptRef.current)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  if (ended) {
    return (
      <Stack spacing={2}>
        <Alert severity={status === 'cancelled' ? 'info' : 'warning'}>
          <AlertTitle>
            {status === 'cancelled' || status === 'expired'
              ? 'The import with Claude ended'
              : 'Lost track of the import'}
          </AlertTitle>
          {ended}
        </Alert>
        <Button variant="contained" size="large" fullWidth startIcon={<ReplayIcon />} onClick={onRestart}>
          Start again
        </Button>
      </Stack>
    )
  }

  const active = stageIndex(status)
  const elapsed = now - startedAt
  // once Claude has the request, the status leads and the handoff card shrinks to a way back to Claude
  const handedOver = status !== 'pending'

  const handoff = handedOver ? (
    <Button
      variant="outlined"
      fullWidth
      href={request.claudeUrl}
      target="_blank"
      rel="noopener noreferrer"
      endIcon={<OpenInNewIcon />}
    >
      Back to Claude
    </Button>
  ) : (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6">Continue in Claude</Typography>
          {request.url ? (
            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
              {request.url}
            </Typography>
          ) : request.sourceLabel ? (
            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
              {request.sourceLabel}
            </Typography>
          ) : null}
          <Typography>
            Claude writes the recipe with the Flow Recipe connector. Open Claude and send the prepared message, then
            come back: the draft shows up here by itself.
          </Typography>
          <Button
            variant="contained"
            size="large"
            fullWidth
            href={request.claudeUrl}
            target="_blank"
            rel="noopener noreferrer"
            endIcon={<OpenInNewIcon />}
          >
            Continue in Claude
          </Button>
          <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'action.hover' }}>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 0.5 }}>
              The message for Claude
            </Typography>
            <Typography
              ref={promptRef}
              variant="body2"
              sx={{ fontFamily: 'monospace', wordBreak: 'break-word', userSelect: 'all' }}
            >
              {request.prompt}
            </Typography>
          </Paper>
          <Button
            variant="text"
            onClick={copy}
            startIcon={copied === 'ok' ? <CheckIcon /> : <ContentCopyIcon />}
            sx={{ alignSelf: 'flex-start' }}
            aria-live="polite"
          >
            {copied === 'ok' ? 'Copied' : 'Copy prompt'}
          </Button>
          {copied === 'failed' && (
            <Typography variant="caption" color="text.secondary">
              Could not copy automatically: the message is selected above, copy it from there.
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  )

  const progress = (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
            <Typography variant="h6" role="status" aria-live="polite">
              {claudeStatusText(status)}
            </Typography>
            {!ready && (
              <Chip size="small" variant="outlined" label={fmtDuration(elapsed / 1000)} aria-label="waiting time" />
            )}
          </Stack>
          {!ready && <LinearProgress aria-label="waiting for Claude" />}
          <Stepper activeStep={active} orientation="vertical">
            {STAGES.map((s, i) => (
              <Step key={s.key}>
                <StepLabel>{i < active && s.done ? s.done : s.label}</StepLabel>
                <StepContent>
                  <Typography variant="body2" color="text.secondary">
                    {s.hint}
                  </Typography>
                </StepContent>
              </Step>
            ))}
          </Stepper>
          {status === 'pending' && elapsed > NUDGE_AFTER_MS && (
            <Alert severity="info">
              Nothing yet? Check that the Flow Recipe connector is turned on for the chat in Claude (the tools menu next
              to the message box), then send the message again.
            </Alert>
          )}
          {ready ? (
            <Box>
              <Button variant="contained" size="large" fullWidth startIcon={<RateReviewIcon />} onClick={onReview}>
                Review the draft
              </Button>
            </Box>
          ) : (
            <Button variant="outlined" onClick={onCancel} fullWidth>
              Cancel
            </Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  )

  return (
    <Stack spacing={2}>
      {handedOver ? progress : handoff}
      {handedOver ? handoff : progress}
    </Stack>
  )
}
