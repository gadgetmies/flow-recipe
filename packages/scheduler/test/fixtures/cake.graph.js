// Small hand-built graph used by planner and online tests: measure ×2 → mix → bake (oven, critical) → take-out → frost → serve
// A tiny hand-built graph: measure → mix (bowl reserved) → bake (oven, passive, critical) → take-out → serve
export function cakeGraph(serveTime) {
  const base = (id, extra) => ({
    id, dishId: 'cake', recipeTaskId: id, operation: id, title: id, instructions: `do ${id}`, units: 1, unitStream: null, batch: null,
    active: 60, passive: 0, timeModel: 'fixed', perUnit: 0, attention: 'attended', checkInterval: null, checkDuration: null,
    divisible: 'none', minChunk: 180, maxPeople: 1, speedup: 1, preemptible: 'anywhere', resumeCost: 20, completion: null,
    context: { dish: 'cake', station: 'counter', tool: null }, tedium: 1, requires: [], tools: [], appliance: null, returnsTools: [],
    hold: Number.POSITIVE_INFINITY, outputs: [{ id: `${id}-out`, amount: 1, unit: null }], inputs: [], kind: 'work', serveWindow: null, ...extra,
  })
  const tasks = {
    'cake:measure-flour': base('cake:measure-flour', { operation: 'measure', title: 'Measure flour', active: 60, outputs: [{ id: 'flour', amount: 1 }], tools: [{ type: 'bowl', qty: 1, mode: 'reserved', soil: 'rinse' }] }),
    'cake:measure-sugar': base('cake:measure-sugar', { operation: 'measure', title: 'Measure sugar', active: 60, outputs: [{ id: 'sugar', amount: 1 }], tools: [{ type: 'bowl', qty: 1, mode: 'reserved', soil: 'rinse' }] }),
    'cake:mix': base('cake:mix', { operation: 'mix', title: 'Mix batter', active: 300, inputs: [{ ref: 'flour' }, { ref: 'sugar' }], outputs: [{ id: 'batter', amount: 1, unit: null }], tools: [{ type: 'bowl', qty: 1, mode: 'reserved', soil: 'wash' }], hold: 1800 }),
    'cake:preheat': base('cake:preheat', { operation: 'preheat-oven', title: 'Preheat oven', active: 30, passive: 600, completion: { urgency: 'relaxed', early: 0, late: 600, duration: 0 }, context: { dish: 'cake', station: 'oven', tool: null }, appliance: { type: 'oven', slots: 1, mode: '180c' }, outputs: [{ id: 'oven-hot', amount: 1 }], attention: 'unattended' }),
    'cake:bake': base('cake:bake', { operation: 'put-into-oven', title: 'Put cake into oven', active: 30, passive: 1500, completion: { urgency: 'critical', early: 0, late: 60, duration: 30 }, inputs: [{ ref: 'batter' }, { ref: 'oven-hot' }], outputs: [{ id: 'baking', amount: 1 }], context: { dish: 'cake', station: 'oven', tool: null }, appliance: { type: 'oven', slots: 1, mode: '180c' }, attention: 'unattended', preemptible: 'never' }),
    'cake:take-out': base('cake:take-out', { operation: 'take-out-of-oven', title: 'Take cake out', active: 30, inputs: [{ ref: 'baking' }], outputs: [{ id: 'cake-done', amount: 1 }], context: { dish: 'cake', station: 'oven', tool: null }, preemptible: 'never' }),
    'cake:frost': base('cake:frost', { operation: 'spread', title: 'Frost cake', active: 120, inputs: [{ ref: 'cake-done' }], outputs: [{ id: 'frosted', amount: 1 }], tools: [{ type: 'bowl', qty: 1, mode: 'active', soil: 'rinse' }], hold: 900 }),
    'cake:serve': base('cake:serve', { operation: 'serve', title: 'Serve cake', active: 0, kind: 'sink', inputs: [{ ref: 'frosted' }], outputs: [], serveWindow: { earliest: serveTime, latest: serveTime + 300000 } }),
  }
  const edges = [
    { from: 'cake:measure-flour', to: 'cake:mix', kind: 'fs', lag: 0, ffLag: 0, hold: null, unitStream: null },
    { from: 'cake:measure-sugar', to: 'cake:mix', kind: 'fs', lag: 0, ffLag: 0, hold: null, unitStream: null },
    { from: 'cake:mix', to: 'cake:bake', kind: 'fs', lag: 0, ffLag: 0, hold: null, unitStream: null },
    { from: 'cake:mix', to: 'cake:bake', kind: 'maxlag', lag: 0, ffLag: 0, hold: 1800, unitStream: null },
    { from: 'cake:preheat', to: 'cake:bake', kind: 'fs', lag: 0, ffLag: 0, hold: null, unitStream: null },
    { from: 'cake:bake', to: 'cake:take-out', kind: 'fs', lag: 0, ffLag: 0, hold: null, unitStream: null },
    { from: 'cake:take-out', to: 'cake:frost', kind: 'fs', lag: 0, ffLag: 0, hold: null, unitStream: null },
    { from: 'cake:frost', to: 'cake:serve', kind: 'fs', lag: 0, ffLag: 0, hold: null, unitStream: null },
    { from: 'cake:frost', to: 'cake:serve', kind: 'maxlag', lag: 0, ffLag: 0, hold: 900, unitStream: null },
  ]
  return {
    tasks, order: Object.keys(tasks), edges, buffers: [],
    dishes: [{ id: 'cake', recipeId: 'cake', title: 'Cake', serveTime, earlyTolerance: 0, lateTolerance: 300000, temperature: 'hot', hold: 900, sinkId: 'cake:serve' }],
    diagnostics: [],
  }
}

