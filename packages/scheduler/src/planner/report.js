// Lane reports, fairness, shopping list (spec §4.2, §5.8).

import { sameContext } from './cost.js'
import { normaliseAmount } from '../units.js'

export function laneReports(items, participants, loads, expected, policy) {
  const byP = new Map(participants.map((p) => [p.id, []]))
  for (const it of items) if (byP.has(it.participantId) && it.kind !== 'blocked') byP.get(it.participantId).push(it)
  const busy = (pid, s, e) => (byP.get(pid) || []).some((it) => it.start < e && s < it.end)
  const reports = {}
  for (const p of participants) {
    const list = (byP.get(p.id) || []).slice().sort((a, b) => a.start - b.start)
    let switches = 0
    for (let i = 1; i < list.length; i++) if (!sameContext(list[i - 1].context, list[i].context)) switches++
    let longest = 0
    for (let i = 1; i < list.length; i++) {
      const gapS = list[i - 1].end, gapE = list[i].start
      if (gapE - gapS <= 0) continue
      const othersBusy = participants.some((q) => q.id !== p.id && busy(q.id, gapS, gapE))
      if (othersBusy) longest = Math.max(longest, gapE - gapS)
    }
    reports[p.id] = {
      load: Math.round(loads[p.id] || 0),
      expectedLoad: Math.round(expected[p.id] || 0),
      switches,
      longestLopsidedIdle: Math.round(longest),
      timersHeld: p.timers ? p.timers.length : 0,
    }
  }
  return reports
}

export function fairnessIndex(loads, expected) {
  let f = 0
  for (const id of Object.keys(expected)) {
    const e = Math.max(1, expected[id])
    const rel = (loads[id] || 0) / e - 1
    f += rel * rel
  }
  return Math.round(f * 1000) / 1000
}

/** Shopping list from measure tasks of every dish, scaled. */
export function shoppingList(session) {
  const acc = {}
  for (const d of session.dishes || []) {
    const recipe = d.recipe
    if (!recipe) continue
    const ingredients = new Map((recipe.ingredients || []).map((i) => [i.id, i]))
    for (const task of recipe.tasks || []) {
      const tasks = task.operation === 'join' ? task.steps || [] : [task]
      for (const tk of tasks) {
        if (tk.operation !== 'measure' || !tk.options || !tk.options.amount) continue
        const amt = tk.options.amount
        for (const inp of tk.inputs || []) {
          const ing = ingredients.get(inp.ref)
          if (!ing) continue
          const n = normaliseAmount({ number: (amt.number || 0) * (d.scale || 1), unit: amt.unit || '' })
          const key = `${ing.name}|${n.unit}`
          if (!acc[key]) acc[key] = { name: ing.name, amount: 0, unit: n.unit }
          acc[key].amount += n.number
        }
      }
    }
  }
  return Object.values(acc).map((x) => ({ ...x, amount: Math.round(x.amount * 100) / 100 })).sort((a, b) => a.name.localeCompare(b.name))
}
