// Import page (route /import): turn a recipe page (or pasted text) into a scheduler recipe with the help of an LLM.
// Source → progress (server job, polled) → review (converted amounts, steps, schedule check, XML) → saved.
// `?mock=1` simulates the server with ./mockImport.js.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Container,
  CssBaseline,
  IconButton,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  ThemeProvider,
  Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import AddIcon from '@mui/icons-material/Add'
import theme from '../theme'
import { isMockMode } from '../config'
import {
  checkRecipe,
  convertRecipe,
  forgetImportJob,
  getImportJob,
  getLlmInfo,
  IMPORT_TIMING,
  loadLlmConfig,
  loadUploadToken,
  saveLlmConfig,
  saveRecipe,
  saveUploadToken,
  setRecipeId,
  setRecipeTitle,
  startImport,
} from './importApi'
import { initialLlmValue, resolveLlm } from './LlmSettings'
import SourceForm, { emptySource } from './SourceForm'
import ImportProgress from './ImportProgress'
import RecipeReview from './RecipeReview'

const STEPS = [
  { key: 'source', label: 'Source' },
  { key: 'progress', label: 'Import' },
  { key: 'review', label: 'Review' },
  { key: 'saved', label: 'Save' },
]

const MAX_POLL_FAILURES = 5

function TokenPrompt({ onSave }) {
  const [value, setValue] = useState('')
  return (
    <Alert severity="warning">
      <Stack spacing={1}>
        <Typography variant="body2">This server only accepts new recipes with an upload token. Ask whoever runs it for the token.</Typography>
        <Stack direction="row" spacing={1}>
          <TextField size="small" type="password" label="Upload token" value={value} onChange={(e) => setValue(e.target.value)} sx={{ flex: 1 }} />
          <Button variant="outlined" onClick={() => onSave(value.trim())} disabled={!value.trim()}>
            Use
          </Button>
        </Stack>
      </Stack>
    </Alert>
  )
}

const scrollTop = () => {
  try {
    window.scrollTo({ top: 0 })
  } catch (e) {
    // jsdom
  }
}

export default function ImportPage() {
  const mock = useMemo(() => isMockMode(), [])
  const mockSuffix = mock ? '?mock=1' : ''

  const [step, setStep] = useState('source')
  const [source, setSource] = useState(emptySource)
  const [llmInfo, setLlmInfo] = useState(null)
  const [llmInfoError, setLlmInfoError] = useState(null)
  const [llmValue, setLlmValue] = useState(() => initialLlmValue(loadLlmConfig()))
  const [token, setToken] = useState(() => loadUploadToken())
  const [needsToken, setNeedsToken] = useState(false)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const [jobId, setJobId] = useState(null)
  const [job, setJob] = useState(null)
  const [startedAt, setStartedAt] = useState(Date.now())
  const pollFailures = useRef(0)

  const [result, setResult] = useState(null)
  const [xml, setXml] = useState('')
  const [checkedXml, setCheckedXml] = useState('')
  const [check, setCheck] = useState(null)
  const [conversions, setConversions] = useState([])
  const [title, setTitle] = useState('')
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const [convertMessage, setConvertMessage] = useState(null)
  const [reviewError, setReviewError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(null)

  // which LLM the server offers
  useEffect(() => {
    let cancelled = false
    getLlmInfo(mock)
      .then((info) => !cancelled && setLlmInfo(info))
      .catch((e) => !cancelled && setLlmInfoError(e.message))
    return () => {
      cancelled = true
    }
  }, [mock])

  // remember the user's own LLM configuration only when asked to
  useEffect(() => {
    saveLlmConfig(llmValue.remember ? llmValue.own : null)
  }, [llmValue])

  const llmState = resolveLlm(llmInfo, llmValue)

  const showReview = useCallback((r) => {
    setResult(r)
    setXml(r.xml)
    setCheckedXml(r.xml)
    setCheck(r.check)
    setConversions(r.conversions || [])
    setTitle(r.check?.title || r.source?.title || '')
    setId(r.id || r.check?.id || '')
    setConvertMessage(null)
    setReviewError(null)
    setStep('review')
    scrollTop()
  }, [])

  // poll the job while it runs
  useEffect(() => {
    if (step !== 'progress' || !jobId) return undefined
    let cancelled = false
    let timer = null
    const poll = async () => {
      try {
        const j = await getImportJob(jobId, mock)
        if (cancelled) return
        pollFailures.current = 0
        setJob(j)
        if (j.status === 'done' && j.result) {
          showReview(j.result)
          return
        }
        if (j.status === 'error') return
      } catch (e) {
        if (cancelled) return
        pollFailures.current += 1
        if (e.status === 404 || pollFailures.current >= MAX_POLL_FAILURES) {
          setJob((prev) => ({
            ...(prev || {}),
            status: 'error',
            stage: prev?.stage === 'fetching' ? 'lost' : prev?.stage,
            error: e.status === 404 ? 'The import job was lost (the server may have restarted). Please try again.' : e.message,
          }))
          return
        }
      }
      timer = setTimeout(poll, IMPORT_TIMING.pollMs)
    }
    timer = setTimeout(poll, Math.min(300, IMPORT_TIMING.pollMs))
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [step, jobId, mock, showReview])

  const begin = async (src = source) => {
    setError(null)
    setSubmitting(true)
    const body = { precisionScale: !!src.precisionScale }
    if (src.mode === 'url') body.url = src.url.trim()
    else body.text = src.text
    const servings = parseInt(src.servings, 10)
    if (servings > 0) body.servings = servings
    if (src.notes.trim()) body.notes = src.notes.trim()
    if (llmState.llm) body.llm = llmState.llm
    try {
      const { jobId: newJobId } = await startImport(body, { mock, token })
      pollFailures.current = 0
      setJob({ status: 'running', stage: 'fetching', attempts: 1 })
      setStartedAt(Date.now())
      setJobId(newJobId)
      setStep('progress')
      scrollTop()
    } catch (e) {
      if (e.status === 401) {
        setNeedsToken(true)
        setError('The server needs an upload token for imports.')
      } else if (e.status === 400 && /llm/i.test(e.message)) {
        setError('The server has no AI model configured. Choose “My own API key” under AI model, or ask the server owner to set one up.')
        setLlmValue((v) => ({ ...v, mode: 'own' }))
      } else {
        setError(e.message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const cancel = () => {
    if (jobId) forgetImportJob(jobId, mock)
    setJobId(null)
    setJob(null)
    setStep('source')
  }

  const pasteInstead = () => {
    cancel()
    setSource((s) => ({ ...s, mode: 'text' }))
  }

  const recheck = async (text = xml) => {
    setBusy(true)
    setReviewError(null)
    try {
      const c = await checkRecipe(text, { precisionScale: source.precisionScale, mock })
      setCheck(c)
      setCheckedXml(text)
      if (c.title && !title) setTitle(c.title)
    } catch (e) {
      setReviewError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const convert = async () => {
    setBusy(true)
    setReviewError(null)
    try {
      const r = await convertRecipe(xml, { precisionScale: source.precisionScale, mock })
      const changes = r.changes || []
      setXml(r.xml)
      setConversions((prev) => [...prev.filter((c) => !changes.some((n) => n.taskId === c.taskId)), ...changes])
      setConvertMessage(
        [changes.length ? `${changes.length} ${changes.length === 1 ? 'amount' : 'amounts'} converted.` : 'Everything is already metric.', ...(r.warnings || [])].join(' ')
      )
      setBusy(false)
      await recheck(r.xml)
    } catch (e) {
      setReviewError(e.message)
      setBusy(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setReviewError(null)
    const finalXml = setRecipeId(setRecipeTitle(xml, title.trim()), id)
    try {
      const r = await saveRecipe({ xml: finalXml, id }, { mock, token })
      setXml(finalXml)
      setSaved({ id: r.id || id, title: r.title || title })
      setStep('saved')
      scrollTop()
    } catch (e) {
      if (e.status === 401) setNeedsToken(true)
      if (e.status === 409) setReviewError(`The id “${id}” is already taken. Choose another id and save again.`)
      else if (e.status === 422 && e.data?.check) {
        setCheck(e.data.check)
        setReviewError('The server found problems in the recipe; see above.')
      } else setReviewError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const importAnother = () => {
    setSource((s) => ({ ...emptySource(), mode: s.mode, precisionScale: s.precisionScale }))
    setResult(null)
    setSaved(null)
    setJobId(null)
    setJob(null)
    setStep('source')
    scrollTop()
  }

  const tokenPrompt = needsToken ? (
    <TokenPrompt
      onSave={(t) => {
        saveUploadToken(t)
        setToken(t)
        setNeedsToken(false)
        setError(null)
        setReviewError(null)
      }}
    />
  ) : null

  const stepIndex = STEPS.findIndex((s) => s.key === step)
  const sourceLabel = source.mode === 'url' ? source.url : 'Pasted text'

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="sm" sx={{ minHeight: '100vh', py: 2 }}>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center">
            <IconButton component={RouterLink} to={`/${mockSuffix}`} aria-label="back to the app" edge="start">
              <ArrowBackIcon />
            </IconButton>
            <Typography variant="h5" component="h1">
              Import a recipe
            </Typography>
          </Stack>

          <Stepper activeStep={stepIndex} alternativeLabel sx={{ '& .MuiStepLabel-label': { mt: 0.5, fontSize: 13 } }}>
            {STEPS.map((s) => (
              <Step key={s.key} completed={stepIndex > STEPS.indexOf(s) || step === 'saved'}>
                <StepLabel>{s.label}</StepLabel>
              </Step>
            ))}
          </Stepper>

          {step === 'source' && (
            <>
              <Typography variant="body2" color="text.secondary">
                Paste a link to a recipe. An AI model rewrites it for the cooking planner, with metric amounts, and the planner checks that
                it can schedule it for several cooks. You review it before saving.
              </Typography>
              {tokenPrompt}
              <SourceForm
                source={source}
                onSourceChange={setSource}
                llmInfo={llmInfo}
                llmInfoError={llmInfoError}
                llmValue={llmValue}
                onLlmChange={setLlmValue}
                llmState={llmState}
                onSubmit={() => begin()}
                submitting={submitting}
                error={error}
              />
            </>
          )}

          {step === 'progress' && (
            <ImportProgress
              job={job}
              fromText={source.mode === 'text'}
              sourceLabel={sourceLabel}
              startedAt={startedAt}
              onCancel={cancel}
              onRetry={() => begin()}
              onPasteText={pasteInstead}
            />
          )}

          {step === 'review' && result && (
            <RecipeReview
              result={result}
              check={check}
              conversions={conversions}
              xml={xml}
              onXmlChange={setXml}
              dirty={xml !== checkedXml}
              title={title}
              onTitleChange={setTitle}
              id={id}
              onIdChange={setId}
              busy={busy}
              onRecheck={() => recheck()}
              onConvert={convert}
              convertMessage={convertMessage}
              onSave={save}
              saving={saving}
              saveError={
                reviewError || tokenPrompt ? (
                  <Stack spacing={1}>
                    {reviewError && <Alert severity="error">{reviewError}</Alert>}
                    {tokenPrompt}
                  </Stack>
                ) : null
              }
            />
          )}

          {step === 'saved' && saved && (
            <Card>
              <CardContent>
                <Stack spacing={2} alignItems="center" sx={{ textAlign: 'center', py: 2 }}>
                  <CheckCircleIcon color="success" sx={{ fontSize: 56 }} />
                  <Typography variant="h5">Saved “{saved.title}”</Typography>
                  <Typography color="text.secondary">
                    It is now in the recipe list of every new session (id <code>{saved.id}</code>).
                  </Typography>
                  <Box sx={{ width: '100%' }}>
                    <Button
                      component={RouterLink}
                      to={`/?recipe=${encodeURIComponent(saved.id)}${mock ? '&mock=1' : ''}`}
                      variant="contained"
                      size="large"
                      fullWidth
                      startIcon={<PlayArrowIcon />}
                    >
                      Start a session with this recipe
                    </Button>
                  </Box>
                  <Button startIcon={<AddIcon />} onClick={importAnother}>
                    Import another
                  </Button>
                </Stack>
              </CardContent>
            </Card>
          )}
        </Stack>
      </Container>
    </ThemeProvider>
  )
}
