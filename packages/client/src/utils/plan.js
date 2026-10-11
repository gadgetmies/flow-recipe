// Pure helpers over the Plan / SessionView shapes (scheduler README §6, server API.md).

export const ACTIONABLE_KINDS = ['work', 'cleaning', 'appointment', 'check', 'setup', 'resume', 'blocked']

export function isIdle(item) {
  return item.kind === 'idle'
}

export function laneFor(plan, participantId) {
  return plan?.lanes?.find((l) => l.participantId === participantId) || null
}

/** Lane items in time order, idle items dropped. */
export function laneItems(lane) {
  return (lane?.items || []).filter((i) => !isIdle(i)).slice().sort((a, b) => a.start - b.start)
}

/** All non-idle items across lanes with their lane's participantId attached, sorted by start. */
export function allItems(plan) {
  return (plan?.lanes || [])
    .flatMap((lane) => laneItems(lane).map((item) => ({ ...item, participantId: lane.participantId })))
    .sort((a, b) => a.start - b.start)
}

export function findItem(plan, uuid) {
  for (const lane of plan?.lanes || []) {
    const item = lane.items.find((i) => i.uuid === uuid)
    if (item) return { ...item, participantId: lane.participantId }
  }
  return null
}

/** The first item on a lane that is not done: started/paused beats planned. */
export function currentItem(lane) {
  const items = laneItems(lane)
  return items.find((i) => i.status === 'started' || i.status === 'paused') || items.find((i) => i.status !== 'done') || null
}

export function allDone(plan) {
  const items = allItems(plan)
  return items.length > 0 && items.every((i) => i.status === 'done')
}

export function participantName(session, participantId) {
  const p = session?.participants?.find((x) => x.id === participantId)
  return p?.name || (participantId === '0' ? 'Host' : participantId)
}

export function dishTitle(session, dishId) {
  return session?.dishes?.find((d) => d.id === dishId)?.title || dishId
}

/** Units left for a per-unit item, taking reported progress into account. */
export function unitsLeft(item) {
  if (!item?.units) return null
  const total = item.units.to - item.units.from + 1
  return Math.max(0, total - (item.progress || 0))
}

export function unitsLabel(item, stream = 'units') {
  if (!item?.units) return null
  return `${stream} ${item.units.from}–${item.units.to} of ${item.units.of}`
}

/** Diff entry for one participant, or null. */
export function diffFor(plan, participantId) {
  return plan?.diff?.find((d) => d.participantId === participantId) || null
}

export function describeChange(change) {
  const { field, from, to, reason } = change
  const why = reason ? `: ${reason}` : ''
  if (field === 'next' || field === 'nextTask' || field === 'title') return `Your next task changed from ${from} to ${to}${why}`
  if (field === 'start' || field === 'end') {
    const f = typeof from === 'number' ? new Date(from).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : from
    const t = typeof to === 'number' ? new Date(to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : to
    return `${field === 'start' ? 'Start' : 'End'} moved from ${f} to ${t}${why}`
  }
  if (field === 'participantId' || field === 'holder') return `Reassigned from ${from} to ${to}${why}`
  return `${field}: ${from} → ${to}${why}`
}

export function diagnosticSeverity(diag) {
  const code = String(diag?.code || '').toUpperCase()
  if (/LATE|INFEAS|MISS|ERROR|FAIL|OVER|CONFLICT/.test(code)) return 'error'
  if (/WARN|RISK|INTERRUPT|TIGHT|BLOCK|REMOVED|REDISTRIB/.test(code)) return 'warning'
  return 'info'
}

export const KIND_COLORS = {
  work: '#e91e63',
  cleaning: '#607d8b',
  check: '#00897b',
  resume: '#8e24aa',
  setup: '#3f51b5',
  blocked: '#9e9e9e',
  idle: 'transparent',
  appointment: '#ffb300',
  appointmentCritical: '#d32f2f',
  appointmentTimed: '#ffb300',
  done: '#1ee9a5',
}

export function itemColor(item) {
  if (item.kind === 'appointment') {
    return item.urgency === 'critical' ? KIND_COLORS.appointmentCritical : KIND_COLORS.appointmentTimed
  }
  return KIND_COLORS[item.kind] || KIND_COLORS.work
}

export function kindLabel(item) {
  if (item.kind === 'appointment') return item.urgency === 'critical' ? 'critical appointment' : 'appointment'
  return item.kind
}
