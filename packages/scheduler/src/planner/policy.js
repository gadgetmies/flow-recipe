// Session policy defaults (spec §11) and merge helper.

export const DEFAULT_POLICY = Object.freeze({
  weights: { fair: 10, idle: 8, switch: 3, interrupt: 5, robust: 2, span: 1, stable: 4, late: 10, violation: 1000 }, // late: per second past the serve window; violation: per hard-constraint violation (spec §5.6)
  switchMatrix: { sameContext: 0, sameDishSameStation: 15, sameDishOtherStation: 30, otherDish: 60, afterCleaning: 30, any: 10 },
  minChunkSeconds: 180,
  maxIdleStretchSeconds: 480,
  slackBufferFraction: 0.1,
  slackBufferMinSeconds: 120,
  hotHoldSeconds: 600,
  coldHoldSeconds: 1200,
  cleaning: 'shared',
  endOfSessionCleaning: true,
  miseEnPlace: false,
  floatWindowSeconds: 3600,
  minAppointmentPassiveSeconds: 180,
  leadSeconds: 30,
  reactionSeconds: 30,
  ackTimeoutSeconds: 15,
  replanThresholdSeconds: 90,
  replanDebounceSeconds: 10,
  stabilityHorizonSeconds: 900,
  searchBudgetMs: 1500, // safety cap only: searchIterations normally ends the search, which keeps plans deterministic per seed
  replanBudgetMs: 600,
  searchIterations: 100, // Phase F stops at this many moves or at the wall-clock budget, whichever comes first (the plan is deterministic when the cap is what stops it)
  replanIterations: 30,
  seed: 1,
})

/** Deep-merge a partial policy over the defaults. */
export function mergePolicy(partial = {}) {
  const out = { ...DEFAULT_POLICY, weights: { ...DEFAULT_POLICY.weights }, switchMatrix: { ...DEFAULT_POLICY.switchMatrix } }
  for (const [k, v] of Object.entries(partial || {})) {
    if (v === undefined || v === null) continue
    if (k === 'weights' || k === 'switchMatrix') out[k] = { ...out[k], ...v }
    else out[k] = v
  }
  return out
}

export const DEFAULT_PARTICIPANT = Object.freeze({
  speed: 1,
  capabilities: null,
  role: 'cook',
  targetShare: 1,
  maxConcurrentTimers: 2,
  availability: null,
  placeholder: false,
})

export function normaliseParticipant(p) {
  const out = { ...DEFAULT_PARTICIPANT, ...p }
  if (!(out.speed > 0)) out.speed = 1
  if (!(out.targetShare >= 0)) out.targetShare = 1
  if (!(out.maxConcurrentTimers >= 1)) out.maxConcurrentTimers = 2
  return out
}
