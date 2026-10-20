// Step 3 of the import: what the AI made of the recipe. Title and id, ingredients with converted amounts, the steps
// with their unit streams, the scheduler's dry run, problems, the XML, and the Save action.

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
import { fmtMinutes } from '../utils/time'
import { isValidRecipeId } from './importApi'
import { chainStageNames, conversionFor, conversionTooltip, fmtAmount, fmtHold, fromLabel, planRuns, plural, streamLabel } from './format'
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
  return (
    <Box component="ol" sx={{ listStyle: 'none', p: 0, m: 0 }}>
      {tasks.map((t, i) => {
        const stream = streamLabel(t)
        const change = conversionFor(conversions, t.id)
        return (
          <Box component="li" key={t.id || i} sx={{ display: 'flex', gap: 1.5, py: 1, borderBottom: i < tasks.length - 1 ? 1 : 0, borderColor: 'divider' }}>
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
  )
}

function ScheduleCheck({ plan, tasks }) {
  if (!plan) {
    return (
      <SectionCard title="Schedule check">
        <Typography color="text.secondary">The scheduler did not try this recipe yet. Re-check to run it.</Typography>
      </SectionCard>
    )
  }
  const runs = planRuns(plan)
  const chains = plan.chains || []
  return (
    <SectionCard title="Schedule check" action={<Chip size="small" color={plan.ok ? 'success' : 'error'} label={plan.ok ? 'plans fine' : 'cannot plan'} />}>
      <Stack spacing={2}>
        {plan.error && <Alert severity="error">{plan.error}</Alert>}
        {runs.length > 0 && (
          <Stack direction="row" spacing={1}>
            {runs.map((r) => (
              <Paper key={r.participants} variant="outlined" sx={{ flex: 1, p: 1.5, textAlign: 'center' }}>
                <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center">
                  {r.participants > 1 ? <GroupsIcon fontSize="small" color="action" /> : <PersonIcon fontSize="small" color="action" />}
                  <Typography variant="body2" color="text.secondary">
                    {r.participants} {r.participants === 1 ? 'cook' : 'cooks'}
                  </Typography>
                </Stack>
                <Typography variant="h6">{fmtMinutes(r.makespanSeconds)}</Typography>
              </Paper>
            ))}
          </Stack>
        )}
        {Number.isFinite(plan.activeSeconds) && (
          <Typography variant="body2" color="text.secondary">
            Hands-on work: {fmtMinutes(plan.activeSeconds)}
            {Number.isFinite(plan.tasks) ? ` · ${plan.tasks} scheduled tasks` : ''}
          </Typography>
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
        {plan.diagnostics?.length > 0 && (
          <Stack spacing={0.5}>
            {plan.diagnostics.map((d, i) => (
              <Typography key={i} variant="body2" color="text.secondary">
                • {typeof d === 'string' ? d : d.message || JSON.stringify(d)}
              </Typography>
            ))}
          </Stack>
        )}
      </Stack>
    </SectionCard>
  )
}

function Problems({ check }) {
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
              <li key={i}>{e}</li>
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

  return (
    <Stack spacing={2} sx={{ pb: 2 }}>
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <TextField label="Title" value={title} onChange={(e) => onTitleChange(e.target.value)} fullWidth />
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
              {source.url ? (
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

      <Problems check={check} />

      <SectionCard title="Ingredients">
        <Ingredients ingredients={summary.ingredients} conversions={conversions} />
      </SectionCard>

      <SectionCard title="Steps">
        <Steps tasks={summary.tasks} conversions={conversions} />
      </SectionCard>

      <ScheduleCheck plan={check?.plan} tasks={summary.tasks} />

      <XmlEditor xml={xml} onChange={onXmlChange} dirty={dirty} busy={busy} onRecheck={onRecheck} onConvert={onConvert} convertMessage={convertMessage} />

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
