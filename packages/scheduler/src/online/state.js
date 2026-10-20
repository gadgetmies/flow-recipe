// Online state (README §7): session + graph + catalogue + the current plan + the event log.

import * as graphModule from '../graph/index.js'
import { plan } from '../planner/index.js'

/**
 * Create the online state with an offline draft plan.
 * @param {object} session Session (README §4)
 * @param {object} catalogue Catalogue (README §3); may be null when `graph` is given
 * @param {object} [opts] { graph?: Graph } a prebuilt graph; otherwise buildGraph(session, catalogue) is used
 * @returns {{ session, graph, catalogue, plan, events: Array, frozen: Object, lastReason: string|null }}
 */
export function createState(session, catalogue, opts = {}) {
  let graph = opts.graph || null
  if (!graph) {
    if (typeof graphModule.buildGraph !== 'function') throw new Error('createState: no graph given and buildGraph is not available in src/graph')
    if (!catalogue) throw new Error('createState: a catalogue is required to build the graph')
    graph = graphModule.buildGraph(session, catalogue)
  }
  const draft = plan(graph, session, { mode: 'offline', status: 'draft' })
  return { session, graph, catalogue: catalogue || null, plan: draft, events: [], frozen: {}, lastReason: null }
}
