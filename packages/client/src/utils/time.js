const pad = (n) => String(n).padStart(2, '0')

/** Epoch ms → "HH:MM" local time. */
export function fmtClock(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '--:--'
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Seconds → "m:ss" or "h:mm:ss". Negative values are clamped to 0. */
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/** Seconds → "12 min", "1 h 05 min", "45 s". */
export function fmtMinutes(seconds) {
  const s = Math.round(seconds || 0)
  if (Math.abs(s) < 60) return `${s} s`
  const sign = s < 0 ? '-' : ''
  const a = Math.abs(s)
  const h = Math.floor(a / 3600)
  const m = Math.round((a % 3600) / 60)
  return h > 0 ? `${sign}${h} h ${pad(m)} min` : `${sign}${m} min`
}

/** Countdown from now to `ms`, as "m:ss"; "0:00" once passed. */
export function fmtCountdown(ms, now = Date.now()) {
  return fmtDuration((ms - now) / 1000)
}

/** "HH:MM" (from an <input type="time">) → epoch ms today (or tomorrow if `allowTomorrow` and already passed). */
export function timeInputToMs(value, reference = Date.now()) {
  if (!value) return null
  const [h, m] = value.split(':').map(Number)
  const d = new Date(reference)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

export function msToTimeInput(ms) {
  if (!ms) return ''
  return fmtClock(ms)
}
