// Collapsible editor for the generated recipe XML, with "Re-check" and "Convert units".

import { Accordion, AccordionDetails, AccordionSummary, Alert, Button, Chip, Stack, TextField, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import FactCheckIcon from '@mui/icons-material/FactCheck'
import ScaleIcon from '@mui/icons-material/Scale'

export default function XmlEditor({ xml, onChange, dirty, busy, onRecheck, onConvert, convertMessage, expanded, onExpandedChange, inputRef }) {
  const controlled = expanded !== undefined && onExpandedChange
  return (
    <Accordion disableGutters {...(controlled ? { expanded, onChange: (_, open) => onExpandedChange(open) } : {})}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="h6">Recipe XML</Typography>
          {dirty ? <Chip size="small" color="warning" label="edited" /> : <Chip size="small" variant="outlined" label="advanced" />}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Fix things the AI got wrong directly in the XML, then re-check. The title and id fields above follow the XML. The format is described in RECIPE.spec.md.
          </Typography>
          <TextField
            multiline
            minRows={12}
            maxRows={28}
            value={xml}
            onChange={(e) => onChange(e.target.value)}
            fullWidth
            inputRef={inputRef}
            inputProps={{ 'aria-label': 'recipe XML', spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' }}
            InputProps={{ sx: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.5, alignItems: 'flex-start' } }}
          />
          {convertMessage && <Alert severity="info">{convertMessage}</Alert>}
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button variant={dirty ? 'contained' : 'outlined'} startIcon={<FactCheckIcon />} onClick={onRecheck} disabled={busy}>
              Re-check
            </Button>
            <Button variant="outlined" startIcon={<ScaleIcon />} onClick={onConvert} disabled={busy}>
              Convert units
            </Button>
          </Stack>
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}
