// Text rendering helpers for plans (CLI and tests).

export function fmt(ms) {
  const d = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** Text rendering of a plan's lanes (for the CLI and tests). */
export function renderLanes(plan, { width = 100 } = {}) {
  const t0 = plan.startTime, t1 = plan.endTime || Math.max(...plan.lanes.flatMap((l) => l.items.map((it) => it.end)))
  const span = Math.max(1, t1 - t0)
  const col = (ms) => Math.min(width - 1, Math.max(0, Math.floor(((ms - t0) / span) * width)))
  const lines = []
  lines.push(`${fmt(t0)}${' '.repeat(Math.max(0, width - 10))}${fmt(t1)}`)
  for (const lane of plan.lanes) {
    const row = Array(width).fill(' ')
    for (const it of lane.items) {
      const a = col(it.start), b = Math.max(a, col(it.end) - 1)
      const ch = it.kind === 'appointment' ? '!' : it.kind === 'cleaning' ? '~' : it.kind === 'blocked' ? '.' : it.kind === 'check' ? '?' : it.kind === 'resume' ? '>' : it.status === 'done' ? '#' : '='
      for (let i = a; i <= b; i++) row[i] = ch
      if (it.passiveUntil) { const c = col(it.passiveUntil) - 1; for (let i = b + 1; i <= c && i < width; i++) if (row[i] === ' ') row[i] = '-' }
    }
    lines.push(`${String(lane.participantId).padEnd(10).slice(0, 10)} ${row.join('')}`)
  }
  lines.push('legend: = work  # done  ! appointment  ~ cleaning  . blocked  ? check  > resume  - passive (timer)')
  return lines.join('\n')
}
