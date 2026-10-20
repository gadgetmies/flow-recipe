// Step 2 of the import: the job's stages while the server fetches, asks the AI, converts units and test-plans.

import { useEffect, useState } from 'react'
import { Alert, AlertTitle, Box, Button, Card, CardContent, Chip, LinearProgress, Stack, Step, StepContent, StepLabel, Stepper, Typography } from '@mui/material'
import ContentPasteIcon from '@mui/icons-material/ContentPaste'
import ReplayIcon from '@mui/icons-material/Replay'
import { fmtDuration } from '../utils/time'

const LABELS = {
  fetching: 'Read the recipe page',
  generating: 'Write the recipe for the scheduler',
  repairing: 'Fix what the check found',
  converting: 'Convert to metric units',
  checking: 'Check and test-plan',
}

const HINTS = {
  fetching: 'Downloading the page and looking for the recipe data.',
  generating: 'The AI model is writing the recipe. This usually takes 20–60 seconds.',
  repairing: 'The first version had problems; the AI model is correcting them.',
  converting: 'Cups, ounces and °F become grams, millilitres and °C.',
  checking: 'Validating the recipe and planning it with 1 and 3 cooks.',
}

/** The steps to show: the repair step appears once a repair round has started. */
export function stepsFor(stage, attempts, repaired, fromText) {
  const steps = ['fetching', 'generating']
  if (repaired || stage === 'repairing' || attempts > 1) steps.push('repairing')
  steps.push('converting', 'checking')
  return steps.map((key) => ({ key, label: key === 'fetching' && fromText ? 'Read the pasted text' : LABELS[key] }))
}

function isFetchProblem(job) {
  return job?.stage === 'fetching' || /fetch|forbidden|403|blocked|robot|captcha|timed? ?out/i.test(job?.error || '')
}

function isKeyProblem(job) {
  return /api key|unauthori[sz]ed|401|invalid.*key|authentication/i.test(job?.error || '')
}

export default function ImportProgress({ job, fromText, sourceLabel, startedAt, onCancel, onRetry, onPasteText }) {
  const [now, setNow] = useState(Date.now())
  const [repaired, setRepaired] = useState(false)
  const failed = job?.status === 'error'
  const stage = job?.stage || 'fetching'

  useEffect(() => {
    if (failed) return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [failed])
  useEffect(() => {
    if (stage === 'repairing') setRepaired(true)
  }, [stage])

  const steps = stepsFor(stage, job?.attempts || 1, repaired, fromText)
  const active = Math.max(0, steps.findIndex((s) => s.key === stage))
  const round = Math.max(1, (job?.attempts || 2) - 1)

  if (failed) {
    const fetchProblem = !fromText && isFetchProblem(job)
    return (
      <Stack spacing={2}>
        <Alert severity="error">
          <AlertTitle>{fetchProblem ? 'The site did not let us read the page' : 'The import failed'}</AlertTitle>
          {job.error}
        </Alert>
        <Card>
          <CardContent>
            {fetchProblem ? (
              <Stack spacing={2}>
                <Typography>
                  Some recipe sites block automatic downloads. Open the page on your phone, select the title, ingredients and steps, copy
                  them, and paste the text here instead.
                </Typography>
                <Button variant="contained" size="large" startIcon={<ContentPasteIcon />} onClick={onPasteText} fullWidth>
                  Paste the text instead
                </Button>
                <Button onClick={onRetry} startIcon={<ReplayIcon />}>
                  Try the link again
                </Button>
              </Stack>
            ) : (
              <Stack spacing={2}>
                <Typography>
                  {isKeyProblem(job)
                    ? 'The AI provider did not accept the API key. Check the key and the provider under “AI model”.'
                    : 'You can try again; the AI model sometimes needs a second go. Adding a note for the AI can help too.'}
                </Typography>
                <Button variant="contained" size="large" startIcon={<ReplayIcon />} onClick={onRetry} fullWidth>
                  Try again
                </Button>
                <Button onClick={onCancel}>Change the source or settings</Button>
              </Stack>
            )}
          </CardContent>
        </Card>
      </Stack>
    )
  }

  return (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
            <Typography variant="h6">Importing…</Typography>
            <Chip size="small" variant="outlined" label={fmtDuration((now - startedAt) / 1000)} aria-label="elapsed time" />
          </Stack>
          {sourceLabel && (
            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
              {sourceLabel}
            </Typography>
          )}
          <LinearProgress aria-label="import progress" />
          <Stepper activeStep={active} orientation="vertical">
            {steps.map((s) => (
              <Step key={s.key}>
                <StepLabel optional={s.key === 'repairing' ? <Typography variant="caption">round {round}</Typography> : null}>{s.label}</StepLabel>
                <StepContent>
                  <Typography variant="body2" color="text.secondary">
                    {HINTS[s.key]}
                  </Typography>
                  {job?.detail && job.detail !== s.label && (
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                      {job.detail}
                    </Typography>
                  )}
                </StepContent>
              </Step>
            ))}
          </Stepper>
          <Box>
            <Button variant="outlined" onClick={onCancel} fullWidth>
              Cancel
            </Button>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  )
}
