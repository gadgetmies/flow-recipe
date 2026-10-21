// "AI model" card of the import page: use the server's configured LLM, or the user's own provider + API key (kept in
// this browser only, sent only to our server's import endpoint with the request).

import { useState } from 'react'
import {
  Alert,
  Box,
  Card,
  CardContent,
  Checkbox,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import Visibility from '@mui/icons-material/Visibility'
import VisibilityOff from '@mui/icons-material/VisibilityOff'
import LockIcon from '@mui/icons-material/Lock'
import SmartToyIcon from '@mui/icons-material/SmartToy'

export const DEFAULT_PROVIDERS = ['anthropic', 'openai', 'openai-compatible', 'ollama']

const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', model: 'claude-sonnet-5-5', needsKey: true, needsUrl: false, keyHint: 'sk-ant-…' },
  openai: { label: 'OpenAI', model: 'gpt-4o', needsKey: true, needsUrl: false, keyHint: 'sk-…' },
  'openai-compatible': { label: 'OpenAI-compatible (custom URL)', model: '', needsKey: false, needsUrl: true, keyHint: 'if the service needs one' },
  ollama: { label: 'Ollama', model: 'llama3.1', needsKey: false, needsUrl: false, keyHint: '' },
}

export const providerLabel = (p) => PROVIDERS[p]?.label || p

/** Initial value: the remembered own configuration if any, else the server's model when there is one. */
export function initialLlmValue(saved) {
  return {
    mode: saved ? 'own' : 'server',
    own: { provider: 'anthropic', model: '', apiKey: '', baseUrl: '', ...(saved || {}) },
    remember: !!saved,
  }
}

/** Which configuration an import would use: `{ ready, llm, reason }`; `llm` is the request's `llm` (undefined → server default). */
export function resolveLlm(info, value) {
  const useOwn = value.mode === 'own' || !info?.server
  if (!useOwn) return { ready: true, llm: undefined }
  const { provider, model, apiKey, baseUrl } = value.own
  const meta = PROVIDERS[provider] || {}
  if (!provider) return { ready: false, reason: 'Choose a provider.' }
  if (meta.needsKey && !apiKey.trim()) return { ready: false, reason: 'Enter your API key, or use the server default.' }
  if (meta.needsUrl && !baseUrl.trim()) return { ready: false, reason: 'Enter the base URL of the service.' }
  const llm = { provider }
  if (model.trim()) llm.model = model.trim()
  if (apiKey.trim()) llm.apiKey = apiKey.trim()
  if (baseUrl.trim()) llm.baseUrl = baseUrl.trim()
  return { ready: true, llm }
}

function OwnLlmForm({ providers, own, remember, onOwnChange, onRememberChange }) {
  const [showKey, setShowKey] = useState(false)
  const meta = PROVIDERS[own.provider] || {}
  return (
    <Stack spacing={2}>
      <FormControl fullWidth size="small">
        <InputLabel id="llm-provider-label">Provider</InputLabel>
        <Select labelId="llm-provider-label" label="Provider" value={own.provider} onChange={(e) => onOwnChange({ provider: e.target.value })}>
          {providers.map((p) => (
            <MenuItem key={p} value={p}>
              {providerLabel(p)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <TextField
        size="small"
        label="Model"
        value={own.model}
        placeholder={meta.model || 'model name'}
        helperText={meta.model ? `Leave empty for ${meta.model}` : 'The model name the service expects'}
        onChange={(e) => onOwnChange({ model: e.target.value })}
        fullWidth
      />
      {own.provider !== 'ollama' && (
        <TextField
          size="small"
          label="API key"
          type={showKey ? 'text' : 'password'}
          value={own.apiKey}
          placeholder={meta.keyHint}
          autoComplete="off"
          onChange={(e) => onOwnChange({ apiKey: e.target.value })}
          fullWidth
          InputProps={{
            spellCheck: false,
            endAdornment: (
              <InputAdornment position="end">
                <IconButton aria-label={showKey ? 'hide API key' : 'show API key'} edge="end" onClick={() => setShowKey((s) => !s)}>
                  {showKey ? <VisibilityOff /> : <Visibility />}
                </IconButton>
              </InputAdornment>
            ),
          }}
        />
      )}
      {(meta.needsUrl || own.provider === 'ollama') && (
        <TextField
          size="small"
          label="Base URL"
          value={own.baseUrl}
          placeholder={own.provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://…/v1'}
          helperText="As reachable from this app's server (localhost means the server, not your phone)."
          onChange={(e) => onOwnChange({ baseUrl: e.target.value })}
          fullWidth
        />
      )}
      <Box>
        <FormControlLabel control={<Checkbox checked={remember} onChange={(e) => onRememberChange(e.target.checked)} />} label="Remember on this device" />
        <Typography variant="caption" color="text.secondary" component="p" sx={{ ml: 4, mt: -0.5 }}>
          {remember ? 'Saved in this browser only. Uncheck to forget it.' : 'Not saved: you will need to enter it again next time.'}
        </Typography>
      </Box>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <LockIcon fontSize="small" color="action" sx={{ mt: 0.25 }} />
        <Typography variant="body2" color="text.secondary">
          Your key is sent only to this app's server, together with this import request. The server passes it to the provider for this
          import and does not store or log it.
        </Typography>
      </Stack>
    </Stack>
  )
}

export default function LlmSettings({ info, infoError, value, onChange }) {
  const providers = info?.providers?.length ? info.providers : DEFAULT_PROVIDERS
  const server = info?.server
  const setOwn = (patch) => onChange({ ...value, own: { ...value.own, ...patch } })
  const setRemember = (remember) => onChange({ ...value, remember })

  return (
    <Card>
      <CardContent>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <SmartToyIcon color="secondary" />
          <Typography variant="h6">AI model</Typography>
        </Stack>
        {!info && !infoError && <Typography color="text.secondary">Checking which AI model is available…</Typography>}
        {infoError && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Could not ask the server which AI model it has ({infoError}). You can still use your own key.
          </Alert>
        )}
        {(info || infoError) && (
          <Stack spacing={2}>
            {server ? (
              <RadioGroup value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value })}>
                <FormControlLabel
                  value="server"
                  control={<Radio />}
                  label={
                    <Box>
                      <Typography>Server default</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {providerLabel(server.provider)}
                        {server.model ? ` · ${server.model}` : ''}
                      </Typography>
                    </Box>
                  }
                />
                <FormControlLabel value="own" control={<Radio />} label="My own API key" />
              </RadioGroup>
            ) : (
              <Alert severity="info">
                <Typography variant="body2" sx={{ fontWeight: 500, mb: 0.5 }}>
                  No AI model is set up on this server yet.
                </Typography>
                <Typography variant="body2" component="div">
                  There are two ways to import:
                  <Box component="ol" sx={{ pl: 2.5, my: 0.5 }}>
                    <li>
                      <b>Server default:</b> ask whoever runs this app to set up an AI model on the server.
                    </li>
                    <li>
                      <b>Your own key:</b> enter an API key from Anthropic or OpenAI (or a local Ollama) below.
                    </li>
                  </Box>
                </Typography>
                <Box component="details" sx={{ mt: 0.5, '& summary': { cursor: 'pointer', typography: 'caption' } }}>
                  <summary>For the server admin</summary>
                  <Typography variant="caption" component="p" sx={{ mt: 0.5 }}>
                    Set <code>FLOW_LLM_PROVIDER</code> and <code>FLOW_LLM_API_KEY</code> (optionally <code>FLOW_LLM_MODEL</code>) in the
                    server&apos;s environment and restart it.
                  </Typography>
                </Box>
              </Alert>
            )}
            {(value.mode === 'own' || !server) && (
              <OwnLlmForm providers={providers} own={value.own} remember={value.remember} onOwnChange={setOwn} onRememberChange={setRemember} />
            )}
          </Stack>
        )}
      </CardContent>
    </Card>
  )
}
