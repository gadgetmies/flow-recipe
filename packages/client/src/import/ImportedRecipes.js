// "My imported recipes" on the import page: the recipes saved from imports, told apart by source site and id, with a
// confirmed delete (DELETE /api/recipes/:id; built-in recipes are never listed here).

import { useState } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import DeleteIcon from '@mui/icons-material/Delete'
import { hostOf } from './format'

export default function ImportedRecipes({ recipes, onDelete }) {
  const [confirm, setConfirm] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState(null)
  const imported = (recipes || []).filter((r) => r.source === 'imported')
  if (!imported.length) return null

  const titleCounts = new Map()
  for (const r of recipes) titleCounts.set(r.title, (titleCounts.get(r.title) || 0) + 1)

  const doDelete = async () => {
    setDeleting(true)
    setError(null)
    try {
      await onDelete(confirm.id)
      setConfirm(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Accordion disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="h6">My imported recipes</Typography>
            <Chip size="small" variant="outlined" label={imported.length} />
          </Stack>
        </AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>
          <List dense disablePadding>
            {imported.map((r, i) => {
              const host = hostOf(r.sourceUrl)
              const duplicate = titleCounts.get(r.title) > 1
              return (
                <ListItem
                  key={r.id}
                  disableGutters
                  divider={i < imported.length - 1}
                  secondaryAction={
                    <IconButton edge="end" aria-label={`delete ${r.title} (${r.id})`} onClick={() => setConfirm(r)}>
                      <DeleteIcon />
                    </IconButton>
                  }
                >
                  <ListItemText
                    primary={
                      <>
                        {r.title}
                        {duplicate && <Chip size="small" color="warning" variant="outlined" label="same title" sx={{ ml: 1, height: 20 }} />}
                      </>
                    }
                    secondary={[host || 'pasted text', `id ${r.id}`].join(' · ')}
                  />
                </ListItem>
              )
            })}
          </List>
        </AccordionDetails>
      </Accordion>
      <Dialog open={!!confirm} onClose={() => !deleting && setConfirm(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete “{confirm?.title}”?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The recipe <code>{confirm?.id}</code>
            {hostOf(confirm?.sourceUrl) ? ` imported from ${hostOf(confirm?.sourceUrl)}` : ''} is removed from this server for everyone. This
            cannot be undone.
          </DialogContentText>
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)} disabled={deleting}>
            Keep it
          </Button>
          <Button color="error" variant="contained" onClick={doDelete} disabled={deleting} startIcon={<DeleteIcon />}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
