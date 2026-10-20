// Step 1 of the import: where the recipe comes from (URL or pasted text), the measuring options and the AI model.

import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Collapse,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import LinkIcon from '@mui/icons-material/Link'
import ContentPasteIcon from '@mui/icons-material/ContentPaste'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import LlmSettings from './LlmSettings'

export const emptySource = () => ({ mode: 'url', url: '', text: '', precisionScale: false, servings: '', notes: '' })

export function isHttpUrl(s) {
  try {
    const u = new URL(s.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch (e) {
    return false
  }
}

/** Why the form cannot be submitted yet, or null. */
export function sourceProblem(source) {
  if (source.mode === 'url') {
    if (!source.url.trim()) return 'Paste the link to a recipe page.'
    if (!isHttpUrl(source.url)) return 'That does not look like a web address (it should start with https://).'
  } else if (source.text.trim().length < 40) {
    return 'Paste the recipe text: the ingredients and the steps.'
  }
  return null
}

export default function SourceForm({ source, onSourceChange, llmInfo, llmInfoError, llmValue, onLlmChange, llmState, onSubmit, submitting, error }) {
  const [showOptions, setShowOptions] = useState(!!(source.servings || source.notes))
  const [touched, setTouched] = useState(false)
  const set = (patch) => onSourceChange({ ...source, ...patch })
  const problem = sourceProblem(source)
  const blocker = problem || (!llmState.ready ? llmState.reason || 'Set up an AI model first.' : null)

  const submit = (e) => {
    e.preventDefault()
    setTouched(true)
    if (!blocker && !submitting) onSubmit()
  }

  return (
    <Box component="form" onSubmit={submit} noValidate>
      <Stack spacing={2}>
        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="h6">Recipe</Typography>
              <ToggleButtonGroup
                exclusive
                fullWidth
                size="small"
                color="primary"
                value={source.mode}
                onChange={(_, mode) => mode && set({ mode })}
                aria-label="recipe source"
              >
                <ToggleButton value="url">
                  <LinkIcon fontSize="small" sx={{ mr: 1 }} />
                  From a link
                </ToggleButton>
                <ToggleButton value="text">
                  <ContentPasteIcon fontSize="small" sx={{ mr: 1 }} />
                  Paste text
                </ToggleButton>
              </ToggleButtonGroup>

              {source.mode === 'url' ? (
                <TextField
                  label="Recipe page URL"
                  type="url"
                  inputMode="url"
                  value={source.url}
                  placeholder="https://…"
                  onChange={(e) => set({ url: e.target.value })}
                  onBlur={() => source.url && setTouched(true)}
                  error={touched && !!problem}
                  helperText={touched && problem ? problem : 'Most recipe sites work. The page is read by this app’s server.'}
                  fullWidth
                  autoFocus
                  InputProps={{ spellCheck: false }}
                />
              ) : (
                <TextField
                  label="Recipe text"
                  multiline
                  minRows={6}
                  maxRows={16}
                  value={source.text}
                  placeholder={'Title\n\nIngredients\n2 cups flour\n…\n\nSteps\n1. …'}
                  onChange={(e) => set({ text: e.target.value })}
                  error={touched && !!problem}
                  helperText={touched && problem ? problem : 'Copy the title, the ingredients and the steps from the page or a cookbook.'}
                  fullWidth
                />
              )}

              <Box>
                <FormControlLabel
                  control={<Switch checked={source.precisionScale} onChange={(e) => set({ precisionScale: e.target.checked })} />}
                  label="I have a precision scale (0.1 g)"
                />
                <Typography variant="caption" color="text.secondary" component="p">
                  {source.precisionScale
                    ? 'Small amounts of salt, spices, yeast and baking powder are weighed in grams too.'
                    : 'Amounts are converted to grams and millilitres; small amounts of spices stay as teaspoons.'}
                </Typography>
              </Box>

              <Button
                size="small"
                onClick={() => setShowOptions((s) => !s)}
                endIcon={showOptions ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                sx={{ alignSelf: 'flex-start' }}
              >
                More options
              </Button>
              <Collapse in={showOptions} unmountOnExit>
                <Stack spacing={2}>
                  <TextField
                    label="Servings (optional)"
                    type="number"
                    inputProps={{ min: 1, max: 200, inputMode: 'numeric' }}
                    value={source.servings}
                    onChange={(e) => set({ servings: e.target.value })}
                    helperText="Scale the recipe to this many servings."
                    sx={{ maxWidth: 220 }}
                  />
                  <TextField
                    label="Notes for the AI (optional)"
                    multiline
                    minRows={2}
                    value={source.notes}
                    placeholder="e.g. we have two ovens; skip the glaze"
                    onChange={(e) => set({ notes: e.target.value })}
                    fullWidth
                  />
                </Stack>
              </Collapse>
            </Stack>
          </CardContent>
        </Card>

        <LlmSettings info={llmInfo} infoError={llmInfoError} value={llmValue} onChange={onLlmChange} />

        {error && <Alert severity="error">{error}</Alert>}

        <Box>
          <Button
            type="submit"
            variant="contained"
            size="large"
            fullWidth
            startIcon={<AutoAwesomeIcon />}
            disabled={submitting || (touched && !!blocker) || (!llmState.ready && !!llmInfo)}
          >
            {submitting ? 'Starting…' : 'Import recipe'}
          </Button>
          {blocker && (touched || !llmState.ready) && (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1, textAlign: 'center' }}>
              {touched ? blocker : llmState.reason || blocker}
            </Typography>
          )}
        </Box>
      </Stack>
    </Box>
  )
}
