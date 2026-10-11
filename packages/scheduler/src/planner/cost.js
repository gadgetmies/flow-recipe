// Switching cost (spec §3.7) and assignment cost (spec §5.5 step 4c).

/** Setup seconds for a participant moving from context a to context b. */
export function switchSeconds(a, b, matrix) {
  if (!b) return 0
  if (!a) return matrix.any
  if (a.dish === b.dish && a.station === b.station && (a.tool || null) === (b.tool || null) && a.task === b.task) return matrix.sameContext
  let s = matrix.any
  if (a.dish === b.dish && a.station === b.station) s += matrix.sameDishSameStation
  else if (a.dish === b.dish) s += matrix.sameDishOtherStation
  else s += matrix.otherDish
  if (a.station === 'sink' || a.soil === 'wash') s += matrix.afterCleaning
  return s
}

/** True when two contexts count as the same for the switch count in the objective. */
export function sameContext(a, b) {
  if (!a || !b) return false
  return a.dish === b.dish && a.station === b.station && (a.tool || null) === (b.tool || null)
}

/**
 * Cost of giving task `task` to participant `p` at time t. Lower is better.
 * loads: { [id]: tedium-weighted active seconds so far }, meanLoad: average over cooks.
 */
export function assignmentCost({ p, task, setup, loads, expected, policy, isCleaning, continuesChain }) {
  const w = policy.weights
  const exp = Math.max(1, expected[p.id] || 1)
  const rel = ((loads[p.id] || 0) - exp) / exp // >0 overloaded relative to their fair share
  let cost = setup
  cost += w.fair * 60 * rel
  cost += 30 * (1 / p.speed - 1) * (task.active || 0) / 60
  if (isCleaning && policy.cleaning === 'dedicated' && p.role !== 'cleaner') cost += 600
  if (!isCleaning && policy.cleaning === 'dedicated' && p.role === 'cleaner') cost += 120
  if (continuesChain) cost -= 20
  cost += 10 * (p.timers ? p.timers.length : 0)
  return cost
}
