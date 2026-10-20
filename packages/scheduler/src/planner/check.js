// Plan invariants (README §6, spec §12). Returns a list of violation strings; empty = sound.

export function checkPlan(plan, graph, { minPassive = 180 } = {}) {
  const errors = []
  const byLane = new Map()
  for (const lane of plan.lanes) {
    const list = lane.items.filter((it) => it.kind !== 'idle' && it.kind !== 'blocked').slice().sort((a, b) => a.start - b.start)
    byLane.set(lane.participantId, list)
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i]
      if (b.start < a.end - 1 && !((a.kind === 'check' && b.preemptible === 'anywhere') || (b.kind === 'check' && a.preemptible === 'anywhere'))) errors.push(`lane ${lane.participantId}: '${a.uuid}' and '${b.uuid}' overlap`)
    }
    for (const it of list) {
      if (!(it.end >= it.start)) errors.push(`item ${it.uuid} ends before it starts`)
    }
  }
  // tool instances never double-booked (by work items that list an instance)
  const byInstance = new Map()
  for (const lane of plan.lanes) for (const it of lane.items) for (const t of it.tools || []) {
    if (!byInstance.has(t.instanceId)) byInstance.set(t.instanceId, [])
    byInstance.get(t.instanceId).push(it)
  }
  const streamPairs = new Set((graph ? graph.edges : []).filter((e) => e.kind === 'stream').map((e) => `${e.from}>${e.to}`))
  for (const [inst, list] of byInstance) {
    list.sort((a, b) => a.start - b.start)
    for (let i = 1; i < list.length; i++) {
      // carriers are shared along a batch chain and between consecutive streaming stages; flag only unrelated simultaneous use
      const a = list[i - 1], b = list[i]
      const related = a.taskId === b.taskId || a.taskId.split('#')[0] === b.taskId.split('#')[0] || streamPairs.has(`${a.taskId}>${b.taskId}`) || streamPairs.has(`${b.taskId}>${a.taskId}`)
      if (!related && a.participantId !== b.participantId && b.start < a.end - 1) {
        errors.push(`tool ${inst} used by '${a.uuid}' and '${b.uuid}' at the same time`)
      }
    }
  }
  // precedence (fs edges) between planned work items
  if (graph) {
    const itemByTask = new Map()
    for (const lane of plan.lanes) for (const it of lane.items) if (it.kind === 'work' || it.kind === 'resume' || (it.kind === 'appointment' && !String(it.uuid).endsWith('@done'))) {
      const prev = itemByTask.get(it.taskId)
      if (!prev) itemByTask.set(it.taskId, { start: it.start, end: it.passiveUntil || it.end })
      else { prev.start = Math.min(prev.start, it.start); prev.end = Math.max(prev.end, it.passiveUntil || it.end) }
    }
    for (const e of graph.edges) {
      if (e.kind !== 'fs' && e.kind !== 'maxlag') continue
      const a = itemByTask.get(e.from), b = itemByTask.get(e.to)
      if (!a || !b) continue
      if (b.start < a.end - 1000) errors.push(`precedence: '${e.to}' starts before '${e.from}' ends`)
    }
  }
  // every critical/timed completion has exactly one appointment item
  if (graph) {
    const appts = new Map()
    for (const lane of plan.lanes) for (const it of lane.items) if (it.kind === 'appointment') appts.set(it.taskId, (appts.get(it.taskId) || 0) + 1)
    for (const t of Object.values(graph.tasks)) {
      if (t.completion && t.passive >= (minPassive || 180) && t.completion.urgency !== 'relaxed') {
        const own = appts.get(t.id) || 0
        const viaSucc = graph.edges.filter((e) => e.from === t.id && e.kind === 'fs').some((e) => appts.get(e.to))
        if (own + (viaSucc ? 1 : 0) === 0 && !plan.diagnostics.some((d) => d.code === 'NO_APPOINTMENT_HOLDER' && d.task === t.id)) {
          errors.push(`task ${t.id} has a ${t.completion.urgency} completion but no appointment`)
        }
      }
    }
  }
  return errors
}
