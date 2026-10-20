// Phase C (spec §5.3): latest finish / latest start from the serve windows (backward), earliest start (forward),
// release times from freshness holds, and the anchored / floating classification.
//
// All times here are SECONDS relative to an origin `t0` (epoch ms) chosen by the caller; durations come from the
// graph (seconds). Serve windows in the graph are epoch ms and are converted with the same origin.

const INF = Number.POSITIVE_INFINITY

function toRel(ms, t0) {
  return (ms - t0) / 1000
}

/**
 * Compute windows for every task.
 * @param {object} graph Graph (README §5)
 * @param {number} t0 origin in epoch ms (session.now or startTime)
 * @param {object} opts { slackBuffer: seconds subtracted from every latest finish (robustness),
 *   frozen: { [taskId]: { start, end } } relative seconds of done / in-progress tasks (online mode): their forward
 *   pass uses the actual start and end instead of the catalogue estimate and they never count as infeasible }
 * @returns {{ windows: Object<string, Window>, criticalPathInfeasible: boolean, suggestedStart: number }}
 *  Window = { ES, LF, LS, r, anchored, duration, slack }
 */
export function computeWindows(graph, t0, opts = {}) {
  const slack = opts.slackBuffer || 0
  const frozen = opts.frozen || {}
  const tasks = graph.tasks
  const order = graph.order
  const succ = new Map()
  const pred = new Map()
  for (const id of order) { succ.set(id, []); pred.set(id, []) }
  for (const e of graph.edges) {
    if (!succ.has(e.from) || !pred.has(e.to)) continue
    succ.get(e.from).push(e)
    pred.get(e.to).push(e)
  }

  const dur = (id) => {
    const t = tasks[id]
    return (t.active || 0) + (t.passive || 0)
  }

  // Backward pass
  const LF = {}
  const LS = {}
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    const t = tasks[id]
    let lf = INF
    if (t.kind === 'sink' && t.serveWindow) {
      lf = toRel(t.serveWindow.latest, t0)
    }
    for (const e of succ.get(id)) {
      if (e.kind === 'fs' || e.kind === 'maxlag') lf = Math.min(lf, LS[e.to])
      else if (e.kind === 'stream') lf = Math.min(lf, LF[e.to] - (e.ffLag || 0))
    }
    if (lf !== INF && t.kind !== 'sink') lf -= slack
    LF[id] = lf
    let ls = lf === INF ? INF : lf - dur(id)
    for (const e of succ.get(id)) {
      if (e.kind === 'stream') ls = Math.min(ls, LS[e.to] - (e.lag || 0))
    }
    LS[id] = ls
  }

  // Forward pass (resource-free), origin = 0
  const ES = {}
  const fwdDur = (id) => (frozen[id] ? Math.max(0, frozen[id].end - frozen[id].start) : dur(id))
  for (const id of order) {
    if (frozen[id]) { ES[id] = frozen[id].start; continue }
    let es = 0
    for (const e of pred.get(id)) {
      if (e.kind === 'fs' || e.kind === 'maxlag') es = Math.max(es, ES[e.from] + fwdDur(e.from))
      else if (e.kind === 'stream') es = Math.max(es, ES[e.from] + (e.lag || 0))
    }
    ES[id] = es
  }

  // Release times from freshness: a producer with finite hold may not start earlier than LS − hold.
  const windows = {}
  let infeasible = false
  let minLS = INF
  for (const id of order) {
    const t = tasks[id]
    let r = -INF
    const hold = t.hold === undefined || t.hold === null ? INF : t.hold
    // release: a producer with a finite hold may not start more than `hold` before its latest start; a task can ask to
    // be released even later (`releaseLead`, e.g. taking things out of the fridge just in time)
    const lead = Number.isFinite(t.releaseLead) ? Math.min(t.releaseLead, hold) : hold
    if (Number.isFinite(lead) && Number.isFinite(LS[id])) r = LS[id] - lead
    const anchored = Number.isFinite(r)
    const w = { ES: ES[id], LF: LF[id], LS: LS[id], r, anchored, duration: dur(id), slack: Number.isFinite(LS[id]) ? LS[id] - ES[id] : INF }
    windows[id] = w
    if (!frozen[id] && Number.isFinite(LS[id]) && ES[id] > LS[id] + 1e-9) infeasible = true
    if (t.kind !== 'sink' && Number.isFinite(LS[id])) minLS = Math.min(minLS, LS[id])
  }

  return { windows, criticalPathInfeasible: infeasible, suggestedStart: minLS === INF ? 0 : minLS }
}

/** Tighten a consumer's latest start once its producer is placed (spec §5.5 step 2). */
export function tightenForHold(window, producerEnd, hold) {
  if (!Number.isFinite(hold)) return window
  const ls = Math.min(window.LS, producerEnd + hold)
  if (ls === window.LS) return window
  return { ...window, LS: ls, LF: ls + window.duration }
}
