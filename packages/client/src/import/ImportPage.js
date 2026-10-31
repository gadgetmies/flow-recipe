// Import page (route /import): turn a recipe page (or pasted text) into a scheduler recipe with the help of an LLM.
// Source → progress (server job, polled) → review (converted amounts, steps, schedule check, XML) → saved.
// With Claude (the Flow Recipe connector) the progress step is a handoff instead: the request waits on the server, the
// user continues in Claude, and the draft Claude submits comes back here for the same review.
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
  cancelClaudeImport,
  checkRecipe,
  convertRecipe,
  deleteRecipe,
  ensureRecipeRef,
  forgetImportJob,
  getClaudeImport,
  getImportJob,
  getLlmInfo,
  getRecipeId,
  getRecipeTitle,
  IMPORT_TIMING,
  listRecipes,
  loadClaudeRequest,
  loadLlmConfig,
  loadLlmMode,
  loadUploadToken,
  saveClaudeRequest,
  saveLlmConfig,
  saveLlmMode,
  saveRecipe,
  saveUploadToken,
  setRecipeId,
  setRecipeTitle,
  startClaudeImport,
  startImport,
} from './importApi'
import { initialLlmValue, resolveLlm } from './LlmSettings'
import SourceForm, { emptySource } from './SourceForm'
import ImportProgress from './ImportProgress'
import RecipeReview from './RecipeReview'
import ImportedRecipes from './ImportedRecipes'
import ClaudeHandoff from './ClaudeHandoff'
import { suggestedServeInMinutes } from './format'

const STEPS = [
  { key: 'source', label: 'Source' },
  { key: 'progress', label: 'Import' },
  { key: 'review', label: 'Review' },
  { key: 'saved', label: 'Save' },
]

const MAX_POLL_FAILURES = 5

const CLAUDE_ENDED = ['cancelled', 'expired', 'saved']
const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

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

  // an import handed over to Claude before a reload (the phone switched apps) resumes waiting
  const [claudeReq, setClaudeReq] = useState(() => loadClaudeRequest())
  const [claudeState, setClaudeState] = useState(null)
  const [claudeUpdate, setClaudeUpdate] = useState(null)
  const loadedDraftAt = useRef(null)
  const reviewBaseXml = useRef('')

  const [step, setStep] = useState(() => (claudeReq ? 'claude' : 'source'))
  const [source, setSource] = useState(() => (claudeReq ? { ...emptySource(), precisionScale: !!claudeReq.precisionScale } : emptySource()))
  const [llmInfo, setLlmInfo] = useState(null)
  const [llmInfoError, setLlmInfoError] = useState(null)
  const [llmValue, setLlmValue] = useState(() => {
    const v = initialLlmValue(loadLlmConfig())
    return loadLlmMode() === 'claude' ? { ...v, mode: 'claude' } : v
  })
  const [token, setToken] = useState(() => loadUploadToken())
  const [needsToken, setNeedsToken] = useState(false)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const [jobId, setJobId] = useState(null)
  const [job, setJob] = useState(null)
  const [startedAt, setStartedAt] = useState(() => claudeReq?.startedAt || Date.now())
  const pollFailures = useRef(0)
  const refRef = useRef(null)

  const [result, setResult] = useState(null)
  const [xml, setXml] = useState('')
  const [checkedXml, setCheckedXml] = useState('')
  const [check, setCheck] = useState(null)
  const [conversions, setConversions] = useState([])
  // The XML is the single source of truth for the title and the id: the fields show what it says and write into it.
  const title = getRecipeTitle(xml)
  const id = getRecipeId(xml)
  const [recipes, setRecipes] = useState([])
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

  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )
  const refreshRecipes = useCallback(() => {
    listRecipes({ mock })
      .then((list) => mounted.current && setRecipes(Array.isArray(list) ? list : []))
      .catch(() => {})
  }, [mock])
  useEffect(() => {
    refreshRecipes()
  }, [refreshRecipes])

  // remember the user's own LLM configuration only when asked to
  useEffect(() => {
    saveLlmConfig(llmValue.remember ? llmValue.own : null)
  }, [llmValue])
  useEffect(() => {
    saveLlmMode(llmValue.mode)
  }, [llmValue.mode])

  const llmState = resolveLlm(llmInfo, llmValue)

  const showReview = useCallback((r, ref) => {
    // the suggested id (free on the server) wins over the one inside the XML; a missing title comes from the check or page
    let x = r.xml || ''
    if (r.id && r.id !== getRecipeId(x)) x = setRecipeId(x, r.id)
    if (!getRecipeTitle(x) && (r.check?.title || r.source?.title)) x = setRecipeTitle(x, r.check?.title || r.source?.title)
    // pasted text from a page that blocked us: keep the page as the recipe's source
    if (ref && !r.source?.url) x = ensureRecipeRef(x, ref)
    setResult(ref && !r.source?.url ? { ...r, source: { ...(r.source || {}), url: ref, pasted: true } } : r)
    reviewBaseXml.current = x
    setXml(x)
    setCheckedXml(x)
    setCheck(r.check)
    setConversions(r.conversions || [])
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
          showReview(j.result, refRef.current)
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

  // ---------- import with Claude ----------

  const forgetClaude = useCallback(() => {
    saveClaudeRequest(null)
    setClaudeReq(null)
    setClaudeState(null)
    setClaudeUpdate(null)
    loadedDraftAt.current = null
  }, [])

  const openClaudeDraft = useCallback(
    (r) => {
      if (!r?.result) return
      loadedDraftAt.current = r.updatedAt || null
      setClaudeUpdate(null)
      showReview(r.result, claudeReq?.ref || null)
    },
    [showReview, claudeReq]
  )

  // Poll the request every 2 s while waiting for Claude, and on the review for an updated draft. Paused while the tab
  // is hidden (the user is in Claude); checks at once when it comes back.
  const requestId = claudeReq?.requestId
  const claudePhase = !requestId ? null : step === 'claude' ? 'waiting' : step === 'review' ? 'review' : null
  useEffect(() => {
    if (!claudePhase) return undefined
    let stopped = false
    let timer = null
    let inflight = false
    let failures = 0
    const schedule = (ms) => {
      if (stopped || timer) return
      timer = setTimeout(poll, ms)
    }
    const poll = async () => {
      timer = null
      if (stopped || inflight || isHidden()) return
      inflight = true
      try {
        const r = await getClaudeImport(requestId, mock)
        inflight = false
        if (stopped) return
        failures = 0
        if (claudePhase === 'waiting') {
          setClaudeState(r)
          if (r.status === 'ready' || CLAUDE_ENDED.includes(r.status)) return
        } else {
          if (r.status === 'ready' && r.result && r.updatedAt !== loadedDraftAt.current) setClaudeUpdate(r)
          if (CLAUDE_ENDED.includes(r.status)) return
        }
      } catch (e) {
        inflight = false
        if (stopped) return
        failures += 1
        if (e.status === 404 || failures >= MAX_POLL_FAILURES) {
          if (claudePhase === 'waiting') {
            setClaudeState({
              status: 'lost',
              error: e.status === 404 ? 'The server does not know this import request any more. Please start again.' : e.message,
            })
          }
          return
        }
      }
      schedule(IMPORT_TIMING.claudePollMs)
    }
    const onVisibility = () => {
      if (!isHidden()) schedule(0)
    }
    document.addEventListener('visibilitychange', onVisibility)
    schedule(claudePhase === 'waiting' ? 0 : IMPORT_TIMING.claudePollMs)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [claudePhase, requestId, mock])

  // "Draft received": show it for a moment, then the review
  useEffect(() => {
    if (step !== 'claude' || claudeState?.status !== 'ready' || !claudeState.result) return undefined
    const t = setTimeout(() => openClaudeDraft(claudeState), IMPORT_TIMING.claudeReadyMs)
    return () => clearTimeout(t)
  }, [step, claudeState, openClaudeDraft])

  const beginWithClaude = async (src, body) => {
    try {
      const r = await startClaudeImport(body, { mock, token })
      const req = {
        requestId: r.requestId,
        prompt: r.prompt,
        claudeUrl: r.claudeUrl,
        url: body.url || null,
        ref: body.ref || null,
        sourceLabel: src.mode === 'text' ? (src.ref ? `Pasted text from ${src.ref}` : 'Pasted text') : null,
        precisionScale: !!body.precisionScale,
        startedAt: Date.now(),
      }
      saveClaudeRequest(req)
      loadedDraftAt.current = null
      setClaudeUpdate(null)
      setClaudeState({ status: 'pending' })
      setClaudeReq(req)
      setStartedAt(req.startedAt)
      setStep('claude')
      scrollTop()
    } catch (e) {
      if (e.status === 401) {
        setNeedsToken(true)
        setError('The server needs an upload token for imports.')
      } else if (e.status === 503) {
        setError('Importing with Claude is not enabled on this server (the host can enable it). Choose another AI model.')
      } else {
        setError(e.message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const cancelClaude = () => {
    if (requestId) cancelClaudeImport(requestId, { mock, token })
    forgetClaude()
    setStep('source')
    scrollTop()
  }

  const begin = async (src = source) => {
    setError(null)
    setSubmitting(true)
    const body = { precisionScale: !!src.precisionScale }
    if (src.mode === 'url') body.url = src.url.trim()
    else {
      body.text = src.text
      // the page the text was copied from; the server may use it as the recipe's `ref`, and the review keeps it either way
      if (src.ref) body.ref = src.ref
    }
    refRef.current = src.mode === 'text' && src.ref ? src.ref : null
    const servings = parseInt(src.servings, 10)
    if (servings > 0) body.servings = servings
    if (src.notes.trim()) body.notes = src.notes.trim()
    if (llmState.claude) return beginWithClaude(src, body)
    forgetClaude()
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
    setSource((s) => ({ ...s, mode: 'text', ref: s.mode === 'url' && s.url.trim() ? s.url.trim() : s.ref }))
  }

  const onTitleChange = (t) => {
    const next = setRecipeTitle(xml, t)
    setXml(next)
    // a title or id change does not need a re-check
    if (xml === checkedXml) setCheckedXml(next)
  }
  const onIdChange = (newId) => {
    const next = setRecipeId(xml, newId)
    setXml(next)
    if (xml === checkedXml) setCheckedXml(next)
  }

  const removeRecipe = async (recipeId) => {
    try {
      await deleteRecipe(recipeId, { mock, token })
    } catch (e) {
      if (e.status === 401) {
        setNeedsToken(true)
        throw new Error('Deleting needs the upload token: enter it above and try again.')
      }
      throw e
    } finally {
      refreshRecipes()
    }
  }

  const recheck = async (text = xml) => {
    setBusy(true)
    setReviewError(null)
    try {
      const c = await checkRecipe(text, { precisionScale: source.precisionScale, mock })
      setCheck(c)
      setCheckedXml(text)
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
    const finalXml = setRecipeTitle(xml, title.trim())
    try {
      const r = await saveRecipe({ xml: finalXml, id, importRequestId: requestId }, { mock, token })
      forgetClaude()
      setXml(finalXml)
      setSaved({ id: r.id || id, title: r.title || title, serveIn: suggestedServeInMinutes(check?.plan) })
      refreshRecipes()
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
    setXml('')
    setCheckedXml('')
    setResult(null)
    setSaved(null)
    setJobId(null)
    setJob(null)
    forgetClaude()
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

  const stepIndex = step === 'claude' ? 1 : STEPS.findIndex((s) => s.key === step)
  const withClaude = step === 'claude' || (!!claudeReq && step === 'review')
  const steps = withClaude ? STEPS.map((s) => (s.key === 'progress' ? { ...s, label: 'Claude' } : s)) : STEPS
  const sourceLabel = source.mode === 'url' ? source.url : source.ref ? `Pasted text from ${source.ref}` : 'Pasted text'
  const duplicateOf = title.trim()
    ? recipes.find((r) => r.id !== id && r.title?.trim().toLowerCase() === title.trim().toLowerCase()) || null
    : null

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
            {steps.map((s, i) => (
              <Step key={s.key} completed={stepIndex > i || step === 'saved'}>
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
              <ImportedRecipes recipes={recipes} onDelete={removeRecipe} />
            </>
          )}

          {step === 'progress' && (
            <ImportProgress
              job={job}
              fromText={source.mode === 'text'}
              sourceLabel={sourceLabel}
              sourceUrl={source.mode === 'url' ? source.url.trim() : null}
              startedAt={startedAt}
              onCancel={cancel}
              onRetry={() => begin()}
              onPasteText={pasteInstead}
            />
          )}

          {step === 'claude' && claudeReq && (
            <ClaudeHandoff
              request={claudeReq}
              state={claudeState}
              startedAt={startedAt}
              onCancel={cancelClaude}
              onReview={() => openClaudeDraft(claudeState)}
              onRestart={() => {
                forgetClaude()
                setStep('source')
              }}
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
              onTitleChange={onTitleChange}
              duplicateOf={duplicateOf}
              id={id}
              onIdChange={onIdChange}
              busy={busy}
              onRecheck={() => recheck()}
              onConvert={convert}
              convertMessage={convertMessage}
              onSave={save}
              saving={saving}
              notice={
                claudeUpdate ? (
                  <Alert
                    severity="info"
                    action={
                      <Button color="inherit" size="small" onClick={() => openClaudeDraft(claudeUpdate)}>
                        Load it
                      </Button>
                    }
                  >
                    Claude sent an updated draft.{xml !== reviewBaseXml.current ? ' Loading it replaces your edits.' : ''}
                  </Alert>
                ) : null
              }
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
                    {saved.serveIn ? ` A new session plans to serve it in about ${saved.serveIn} minutes; you can change that.` : ''}
                  </Typography>
                  <Box sx={{ width: '100%' }}>
                    <Button
                      component={RouterLink}
                      to={`/?recipe=${encodeURIComponent(saved.id)}${saved.serveIn ? `&serveIn=${saved.serveIn}` : ''}${mock ? '&mock=1' : ''}`}
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
