// Step 2 of the import: the job's stages while the server fetches, asks the AI, converts units and test-plans.

import { useEffect, useState } from 'react'
import { Alert, AlertTitle, Box, Button, Card, CardContent, Chip, LinearProgress, Stack, Step, StepContent, StepLabel, Stepper, Typography } from '@mui/material'
import ContentPasteIcon from '@mui/icons-material/ContentPaste'
import ReplayIcon from '@mui/icons-material/Replay'
import BlockIcon from '@mui/icons-material/Block'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import { fmtDuration } from '../utils/time'
import { fmtJobDetail, hostOf } from './format'

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
  return job?.stage === 'fetching' || /fetch|forbidden|\b40[1-9]\b|\b429\b|blocked|robot|captcha/i.test(job?.error || '')
}

/** The error text without the importer's own "paste the recipe text instead" advice, which the card already gives. */
function fetchErrorText(error) {
  return String(error || '')
    .replace(/\s*\(the site may block automated requests; paste the recipe text instead\)/i, '')
    .trim()
}

function isKeyProblem(job) {
  return /api key|unauthori[sz]ed|401|invalid.*key|authentication/i.test(job?.error || '')
}

export default function ImportProgress({ job, fromText, sourceLabel, sourceUrl, startedAt, onCancel, onRetry, onPasteText }) {
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
  // 'queued' (before the first report) shows the first step; 'done' (the result is being prepared) shows all done
  const active = stage === 'done' ? steps.length : Math.max(0, steps.findIndex((s) => s.key === stage))
  const round = Math.max(1, (job?.attempts || 2) - 1)

  if (failed) {
    const fetchProblem = !fromText && isFetchProblem(job)
    if (fetchProblem) {
      const host = hostOf(sourceUrl) || 'The site'
      return (
        <Stack spacing={2}>
          <Card>
            <CardContent>
              <Stack spacing={2}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <BlockIcon color="warning" />
                  <Typography variant="h6">{host} did not let us read the page</Typography>
                </Stack>
                <Typography>
                  Many recipe sites block automatic downloads. Copy the recipe from the page yourself: open it, select the title,
                  ingredients and steps, copy them and paste them in the next step. We keep the link as the recipe&apos;s source.
                </Typography>
                <Button variant="contained" size="large" startIcon={<ContentPasteIcon />} onClick={onPasteText} fullWidth>
                  Paste the recipe text
                </Button>
                {sourceUrl && (
                  <Button href={sourceUrl} target="_blank" rel="noreferrer" startIcon={<OpenInNewIcon />} fullWidth variant="outlined">
                    Open the recipe page
                  </Button>
                )}
                <Button onClick={onRetry} startIcon={<ReplayIcon />}>
                  Try the link again
                </Button>
              </Stack>
            </CardContent>
          </Card>
          {job.error && (
            <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-word', px: 1 }}>
              Details: {fetchErrorText(job.error)}
            </Typography>
          )}
        </Stack>
      )
    }
    return (
      <Stack spacing={2}>
        <Alert severity="error">
          <AlertTitle>The import failed</AlertTitle>
          {job.error}
        </Alert>
        <Card>
          <CardContent>
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
          </CardContent>
        </Card>
      </Stack>
    )
  }

  // the repair step already says which round it is
  const detail = stage === 'repairing' ? null : fmtJobDetail(job?.detail)
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
                  {detail && s.key === stage && (
                    <Typography variant="body2" sx={{ mt: 0.5, wordBreak: 'break-word' }}>
                      {detail}
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
