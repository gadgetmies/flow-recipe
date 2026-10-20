// Step 3 of the import: what the AI made of the recipe. Title and id, ingredients with converted amounts, the steps
// with their unit streams, the scheduler's dry run, problems, the XML, and the Save action.

import { useRef, useState } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Link,
  List,
  ListItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import SaveIcon from '@mui/icons-material/Save'
import SwapHorizIcon from '@mui/icons-material/SwapHoriz'
import GroupsIcon from '@mui/icons-material/Groups'
import PersonIcon from '@mui/icons-material/Person'
import ViewWeekIcon from '@mui/icons-material/ViewWeek'
import MenuBookIcon from '@mui/icons-material/MenuBook'
import { isValidRecipeId } from './importApi'
import {
  chainStageNames,
  conversionFor,
  conversionTooltip,
  dedupeDiagnostics,
  fmtAmount,
  fmtHold,
  fmtLongDuration,
  fromLabel,
  hostOf,
  planRuns,
  plural,
  sourceTotalSeconds,
  streamLabel,
} from './format'
import XmlEditor from './XmlEditor'

function ConvertedChip({ change }) {
  if (!change || (change.to && fmtAmount(change.to) === fmtAmount(change.from, { fraction: true }))) return null
  return (
    <Tooltip title={conversionTooltip(change)} enterTouchDelay={0} arrow>
      <Chip size="small" variant="outlined" icon={<SwapHorizIcon />} label={fromLabel(change)} sx={{ height: 22, '& .MuiChip-label': { px: 0.75 } }} />
    </Tooltip>
  )
}

function SectionCard({ title, children, action }) {
  return (
    <Card>
      <CardContent>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="h6">{title}</Typography>
          {action}
        </Stack>
        {children}
      </CardContent>
    </Card>
  )
}

function Ingredients({ ingredients, conversions }) {
  if (!ingredients?.length) return <Typography color="text.secondary">No ingredients found.</Typography>
  return (
    <List dense disablePadding>
      {ingredients.map((ing, i) => (
        <ListItem key={ing.id || i} divider={i < ingredients.length - 1} disableGutters sx={{ alignItems: 'flex-start', py: 1 }}>
          <Typography sx={{ flex: 1, pr: 1, pt: 0.25 }}>{ing.name || ing.id}</Typography>
          <Stack spacing={0.5} alignItems="flex-end">
            {(ing.amounts?.length ? ing.amounts : [null]).map((a, j) => {
              const change = a ? conversionFor(conversions, a.taskId, ing.id) : null
              return (
                <Stack key={j} direction="row" spacing={1} alignItems="center" justifyContent="flex-end" flexWrap="wrap" useFlexGap>
                  <ConvertedChip change={change} />
                  <Typography sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{a ? fmtAmount(a) : '—'}</Typography>
                </Stack>
              )
            })}
          </Stack>
        </ListItem>
      ))}
    </List>
  )
}

function Steps({ tasks, conversions }) {
  if (!tasks?.length) return <Typography color="text.secondary">No steps found.</Typography>
  // measuring is shown with the ingredients; the steps list starts where the cooking does
  const measures = tasks.filter((t) => t.operation === 'measure').length
  const shown = tasks.filter((t) => t.operation !== 'measure')
  return (
    <>
    {measures > 0 && (
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Plus {measures} measuring {measures === 1 ? 'step' : 'steps'}, shown with the ingredients.
      </Typography>
    )}
    <Box component="ol" sx={{ listStyle: 'none', p: 0, m: 0 }}>
      {shown.map((t, i) => {
        const stream = streamLabel(t)
        const change = conversionFor(conversions, t.id)
        return (
          <Box component="li" key={t.id || i} sx={{ display: 'flex', gap: 1.5, py: 1, borderBottom: i < shown.length - 1 ? 1 : 0, borderColor: 'divider' }}>
            <Box
              sx={{
                flex: '0 0 26px',
                height: 26,
                borderRadius: '50%',
                bgcolor: stream ? 'secondary.main' : 'grey.300',
                color: stream ? 'secondary.contrastText' : 'text.primary',
                fontSize: 13,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {i + 1}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography>{t.title || t.operation}</Typography>
              {typeof t.instructions === 'string' && t.instructions.trim() && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                  {t.instructions.trim()}
                </Typography>
              )}
              <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }} flexWrap="wrap" useFlexGap>
                <Chip size="small" variant="outlined" label={t.operation} sx={{ height: 22 }} />
                {stream && <Chip size="small" color="secondary" label={stream} sx={{ height: 22 }} />}
                {change && !change.ingredientId && <ConvertedChip change={{ ...change }} />}
              </Stack>
            </Box>
          </Box>
        )
      })}
    </Box>
    </>
  )
}

function TimeRow({ icon, label, value }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 0.75 }}>
      {icon}
      <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
        {label}
      </Typography>
      <Typography sx={{ fontWeight: 600 }}>{value}</Typography>
    </Stack>
  )
}

function ScheduleCheck({ plan, tasks, hasErrors, source }) {
  if (!plan) {
    return (
      <SectionCard title="Schedule check">
        <Typography color="text.secondary">
          {hasErrors ? 'Fix the problems above to run the schedule check.' : 'The scheduler did not try this recipe yet. Re-check to run it.'}
        </Typography>
      </SectionCard>
    )
  }
  const runs = planRuns(plan)
  const chains = plan.chains || []
  const sourceTotal = sourceTotalSeconds(source)
  const diagnostics = dedupeDiagnostics(plan.diagnostics)
  return (
    <SectionCard title="Schedule check" action={<Chip size="small" color={plan.ok ? 'success' : 'error'} label={plan.ok ? 'plans fine' : 'cannot plan'} />}>
      <Stack spacing={2}>
        {plan.error && <Alert severity="error">{plan.error}</Alert>}
        {runs.length > 0 && (
          <Box>
            <Typography variant="subtitle2">Estimated time, start to serve</Typography>
            <Paper variant="outlined" sx={{ px: 1.5, py: 0.5, mt: 0.5 }}>
              {runs.map((r) => (
                <TimeRow
                  key={r.participants}
                  icon={r.participants > 1 ? <GroupsIcon fontSize="small" color="action" /> : <PersonIcon fontSize="small" color="action" />}
                  label={`with ${r.participants} ${r.participants === 1 ? 'cook' : 'cooks'}`}
                  value={`about ${fmtLongDuration(r.makespanSeconds)}`}
                />
              ))}
              {sourceTotal && (
                <>
                  <Divider />
                  <TimeRow icon={<MenuBookIcon fontSize="small" color="action" />} label="the recipe page says" value={fmtLongDuration(sourceTotal)} />
                </>
              )}
            </Paper>
            {Number.isFinite(plan.activeSeconds) && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Hands-on work: about {fmtLongDuration(plan.activeSeconds)}
                {Number.isFinite(plan.tasks) ? ` · ${plan.tasks} scheduled tasks` : ''}
              </Typography>
            )}
          </Box>
        )}
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <ViewWeekIcon fontSize="small" color="action" />
            <Typography variant="subtitle2">
              {chains.length ? `${chains.length} ${chains.length === 1 ? 'pipeline' : 'pipelines'} found` : 'No pipelines'}
            </Typography>
          </Stack>
          {chains.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No step works piece by piece, so the cooks cannot pass items along. That is fine for one-pot recipes.
            </Typography>
          )}
          {chains.map((c, i) => (
            <Box key={c.chainId || i} sx={{ mb: 1 }}>
              <Typography variant="body2">
                {chainStageNames(c, tasks).join(' → ')}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {[c.units ? `${c.units} ${plural(c.unit || c.stream || 'units', c.units)}` : null, c.organisation].filter(Boolean).join(' · ')}
              </Typography>
            </Box>
          ))}
        </Box>
        {diagnostics.length > 0 && (
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {diagnostics.map((d, i) => (
              <Typography key={i} component="li" variant="body2" color="text.secondary">
                {d}
              </Typography>
            ))}
          </Box>
        )}
      </Stack>
    </SectionCard>
  )
}

function Problems({ check, onShow }) {
  const errors = check?.errors || []
  const warnings = [...(check?.warnings || []), ...(check?.unitLint || []).filter((l) => l.level === 'warning').map((l) => l.message)]
  const infos = (check?.unitLint || []).filter((l) => l.level !== 'warning').map((l) => l.message)
  return (
    <Stack spacing={1}>
      {errors.length > 0 ? (
        <Alert severity="error">
          <AlertTitle>
            {errors.length} {errors.length === 1 ? 'problem' : 'problems'} to fix before saving
          </AlertTitle>
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {errors.map((e, i) => (
              <li key={i}>
                {e}{' '}
                <Link component="button" type="button" variant="body2" onClick={() => onShow(e)} sx={{ verticalAlign: 'baseline' }}>
                  Show in XML
                </Link>
              </li>
            ))}
          </Box>
        </Alert>
      ) : (
        <Alert severity="success">Ready to save: the recipe is valid and the scheduler can plan it.</Alert>
      )}
      {warnings.length > 0 && (
        <Alert severity="warning">
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </Box>
        </Alert>
      )}
      {infos.length > 0 && (
        <Alert severity="info" icon={false}>
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {infos.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </Box>
        </Alert>
      )}
    </Stack>
  )
}

/** Why Save is disabled, or null. */
export function saveBlocker({ check, dirty, id, title }) {
  if (dirty) return 'You edited the XML: re-check it before saving.'
  if (check?.errors?.length) return 'Fix the problems above (in the XML) and re-check before saving.'
  if (!title?.trim()) return 'Give the recipe a title.'
  if (!isValidRecipeId(id)) return 'The id may only use lowercase letters, digits and dashes.'
  return null
}

export default function RecipeReview({
  result,
  check,
  conversions,
  xml,
  onXmlChange,
  dirty,
  title,
  onTitleChange,
  duplicateOf,
  id,
  onIdChange,
  busy,
  onRecheck,
  onConvert,
  convertMessage,
  onSave,
  saving,
  saveError,
}) {
  const summary = check?.summary || {}
  const serving = summary.serving
  const finals = summary.finalOutputs || []
  const source = result?.source || {}
  const blocker = saveBlocker({ check, dirty, id, title })
  const [xmlOpen, setXmlOpen] = useState(false)
  const xmlRef = useRef(null)
  const xmlBoxRef = useRef(null)

  // "Show in XML" next to an error: open the editor and select the first task/ingredient/tool id the message names
  const showInXml = (message) => {
    setXmlOpen(true)
    const names = [...String(message).matchAll(/["'“‘`]([A-Za-z0-9][A-Za-z0-9_.-]*)["'”’`]/g)].map((m) => m[1])
    let start = -1
    let end = -1
    for (const n of names) {
      const at = xml.indexOf(`id="${n}"`)
      if (at >= 0) {
        start = xml.lastIndexOf('<', at)
        end = at + n.length + 5
        break
      }
    }
    window.setTimeout(() => {
      const el = xmlRef.current
      xmlBoxRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      if (!el || start < 0) return
      try {
        el.focus({ preventScroll: true })
        el.setSelectionRange(start, end)
        const line = xml.slice(0, start).split('\n').length - 1
        el.scrollTop = Math.max(0, line * 18 - 36)
      } catch (e) {
        // jsdom / old browsers
      }
    }, 250)
  }

  return (
    <Stack spacing={2} sx={{ pb: 2 }}>
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <TextField
              label="Title"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              fullWidth
              color={duplicateOf ? 'warning' : undefined}
              focused={duplicateOf ? true : undefined}
              helperText={
                duplicateOf
                  ? `You already have a recipe called “${duplicateOf.title}” (id ${duplicateOf.id}${
                      hostOf(duplicateOf.sourceUrl) ? `, from ${hostOf(duplicateOf.sourceUrl)}` : ''
                    }). A different title makes them easier to tell apart.`
                  : 'Also the <title> in the XML below.'
              }
            />
            <TextField
              label="Recipe id"
              size="small"
              value={id}
              onChange={(e) => onIdChange(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
              error={!isValidRecipeId(id)}
              helperText="Used in links. Lowercase letters, digits and dashes."
              fullWidth
              InputProps={{ spellCheck: false }}
            />
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {finals.map((o) => (
                <Chip key={o.id} size="small" color="primary" label={`Makes ${o.amount ? `${o.amount} ` : ''}${plural(o.unit || o.name, o.amount || 1)}`} />
              ))}
              {serving?.temperature && <Chip size="small" variant="outlined" label={`served ${serving.temperature}`} />}
              {serving?.hold ? <Chip size="small" variant="outlined" label={`keeps ${fmtHold(serving.hold)}`} /> : null}
              {conversions?.length > 0 && <Chip size="small" variant="outlined" icon={<SwapHorizIcon />} label={`${conversions.length} amounts converted`} />}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
              {source.pasted ? (
                <>
                  From pasted text, copied from{' '}
                  <Link href={source.url} target="_blank" rel="noreferrer">
                    {hostOf(source.url) || source.url}
                  </Link>
                </>
              ) : source.url ? (
                <>
                  From{' '}
                  <Link href={source.url} target="_blank" rel="noreferrer">
                    {source.title || source.url}
                  </Link>
                </>
              ) : (
                'From pasted text'
              )}
              {source.structured ? ' · recipe data found on the page' : ''}
              {result?.attempts > 1 ? ` · ${result.attempts} AI attempts` : ''}
              {result?.llm?.model ? ` · ${result.llm.model}` : ''}
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      <Problems check={check} onShow={showInXml} />

      <SectionCard title="Ingredients">
        <Ingredients ingredients={summary.ingredients} conversions={conversions} />
      </SectionCard>

      <SectionCard title="Steps">
        <Steps tasks={summary.tasks} conversions={conversions} />
      </SectionCard>

      <ScheduleCheck plan={check?.plan} tasks={summary.tasks} hasErrors={!!check?.errors?.length} source={source} />

      <Box ref={xmlBoxRef} sx={{ scrollMarginTop: 8 }}>
        <XmlEditor
          xml={xml}
          onChange={onXmlChange}
          dirty={dirty}
          busy={busy}
          onRecheck={onRecheck}
          onConvert={onConvert}
          convertMessage={convertMessage}
          expanded={xmlOpen}
          onExpandedChange={setXmlOpen}
          inputRef={xmlRef}
        />
      </Box>

      <Divider />
      {saveError}
      <Paper elevation={3} sx={{ position: 'sticky', bottom: 8, p: 1.5, zIndex: 2 }}>
        <Button variant="contained" size="large" fullWidth startIcon={<SaveIcon />} disabled={!!blocker || saving || busy} onClick={onSave}>
          {saving ? 'Saving…' : 'Save recipe'}
        </Button>
        {blocker && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1, textAlign: 'center' }}>
            {blocker}
          </Typography>
        )}
      </Paper>
    </Stack>
  )
}
