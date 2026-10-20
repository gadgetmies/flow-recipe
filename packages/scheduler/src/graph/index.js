// Phases A+B: RecipeModel[] + Catalogue + Session → Graph (README §5).

export { buildGraph, topologicalOrder, operationWithDefaults, dishHold } from './build.js'
export { expandTasks, rules as expansionRules } from './expand.js'
export { propagateQuantities, streamUnit, orderTasks } from './quantities.js'
export { computeDurations, computeTaskDurations } from './timing.js'
export { renderInstructions } from './instructions.js'

function esc(s) {
  return String(s).replace(/"/g, '\\"')
}

/**
 * Graphviz DOT rendering of a graph for debugging: tasks as boxes (sinks as doublecircles), edges labelled by
 * kind and lag, buffers as dotted edges.
 * @param {object} graph Graph
 * @returns {string}
 */
export function graphToDot(graph) {
  const lines = ['digraph G {', '  rankdir=LR;', '  node [shape=box, fontsize=10];']
  for (const id of graph.order.length > 0 ? graph.order : Object.keys(graph.tasks)) {
    const t = graph.tasks[id]
    const label = `${t.id}\\n${t.units} ${t.unitStream ?? 'x'} | a=${Math.round(t.active)} p=${Math.round(t.passive)}`
    const shape = t.kind === 'sink' ? ', shape=doublecircle' : ''
    lines.push(`  "${esc(id)}" [label="${esc(label)}"${shape}];`)
  }
  for (const e of graph.edges) {
    const label = e.kind === 'stream' ? `stream ${e.lag}/${e.ffLag}` : e.kind === 'maxlag' ? `≤ ${e.hold}s` : ''
    const style = e.kind === 'maxlag' ? ', style=dashed, color=red' : e.kind === 'stream' ? ', color=blue' : ''
    lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}" [label="${esc(label)}"${style}];`)
  }
  for (const b of graph.buffers) {
    const label = b.carrier ? `${b.carrier} ×${b.carriers} (${b.capacity})` : `counter (${b.capacity})`
    lines.push(`  "${esc(b.from)}" -> "${esc(b.to)}" [label="${esc(label)}", style=dotted, color=gray];`)
  }
  lines.push('}')
  return lines.join('\n')
}
export { applyIngredientHandling, ingredientStorage, DEFAULT_STORAGE_HOLD_SECONDS, MEASURING_OPERATIONS } from './mise.js'
