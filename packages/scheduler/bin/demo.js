#!/usr/bin/env node
// CLI demo: plan and simulate several participants preparing several recipes.
//
//   node bin/demo.js --recipes buns,tiramisu,negroni --participants 4 --serve 18:00,18:10,17:50 --sheets 2 --seed 7
//
// Prints the draft plan, runs the simulation through the online mode and prints the final lanes and metrics.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMParser } from '@xmldom/xmldom'
import { parseRecipe } from '../src/recipe/index.js'
import { loadCatalogue } from '../src/catalogue/index.js'
import { buildGraph } from '../src/graph/index.js'
import { plan } from '../src/planner/index.js'
import { defaultInventory, mergeInventory } from '../src/inventory.js'
import { simulate, renderLanes, fmt } from '../src/sim/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const recipesDir = path.resolve(here, '../../server/src/recipes')

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const has = (name) => process.argv.includes(`--${name}`)

const recipeIds = arg('recipes', 'buns,tiramisu,negroni').split(',').map((s) => s.trim()).filter(Boolean)
const nParticipants = Number(arg('participants', 4))
const serveArg = arg('serve', '')
const seed = Number(arg('seed', 42))
const sheets = arg('sheets', null)
const cleaning = arg('cleaning', 'shared')
const verbose = has('verbose')
const noSim = has('plan-only')

const day = new Date()
const base = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 18, 0, 0)
const serveTimes = serveArg ? serveArg.split(',').map((s) => { const [h, m] = s.split(':').map(Number); return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m || 0, 0) }) : recipeIds.map((_, i) => base + i * 10 * 60000)

const operationsXml = fs.readFileSync(path.join(recipesDir, 'operations.xml'), 'utf8')
const catalogue = loadCatalogue(operationsXml, { DOMParser })
const names = ['Ada', 'Bea', 'Cal', 'Dee', 'Eli', 'Fay']
const participants = Array.from({ length: nParticipants }, (_, i) => ({ id: i === 0 ? '0' : `p${i + 1}`, name: names[i] || `P${i + 1}`, speed: 1, role: i === nParticipants - 1 && cleaning === 'dedicated' ? 'cleaner' : 'cook' }))

let inventory = defaultInventory()
if (sheets) inventory = mergeInventory(inventory, { tools: [{ type: 'baking-sheet', count: Number(sheets) }] })

const dishes = recipeIds.map((id, i) => {
  const xml = fs.readFileSync(path.join(recipesDir, `${id}.xml`), 'utf8')
  const recipe = parseRecipe(xml, { DOMParser, id })
  return { id, recipeId: id, recipe, scale: 1, serveTime: serveTimes[i] ?? serveTimes[serveTimes.length - 1], earlyTolerance: 0, lateTolerance: 300000 }
})

const session = { id: 'demo', startTime: null, now: null, dishes, participants, inventory, policy: { seed, cleaning } }

console.log(`Recipes: ${recipeIds.join(', ')} | participants: ${participants.map((p) => p.name).join(', ')} | serve: ${serveTimes.map(fmt).join(', ')}`)
const graph = buildGraph(session, catalogue)
console.log(`Graph: ${Object.keys(graph.tasks).length} tasks, ${graph.edges.length} edges, ${graph.buffers.length} buffers`)
for (const d of graph.diagnostics || []) console.log(`  graph: [${d.code}] ${d.message}`)

const t = Date.now()
const draft = plan(graph, session, { mode: 'offline', status: 'draft' })
console.log(`\nDraft plan (${Date.now() - t} ms): start ${fmt(draft.startTime)}, end ${fmt(draft.endTime)}, fairness ${draft.report.fairness}, switches ${draft.report.switches}`)
for (const d of draft.dishes) console.log(`  ${d.title}: target ${fmt(d.serveTarget)}, planned ${d.plannedServe ? fmt(d.plannedServe) : '—'}, spread ${Math.round(d.spread / 60)} min${d.late ? `, LATE by ${Math.round(d.late / 60)} min` : ''}`)
for (const d of draft.diagnostics) console.log(`  [${d.code}] ${d.message}`)
console.log(renderLanes(draft))
for (const lane of draft.lanes) {
  const p = participants.find((x) => x.id === lane.participantId)
  console.log(`\n${p ? p.name : lane.participantId}: load ${Math.round(lane.report.load / 60)} min (expected ${Math.round(lane.report.expectedLoad / 60)}), switches ${lane.report.switches}, lopsided idle ${Math.round(lane.report.longestLopsidedIdle / 60)} min`)
  for (const it of lane.items) console.log(`  ${fmt(it.start)}–${fmt(it.end)} ${it.kind.padEnd(11)} ${it.title}${it.units ? ` [${it.units.from}–${it.units.to}/${it.units.of}]` : ''}${it.passiveUntil ? ` (timer → ${fmt(it.passiveUntil)})` : ''}${it.inputsFrom.length ? ` ← ${it.inputsFrom.map((x) => x.participantId).join(',')}` : ''}`)
}

if (noSim) process.exit(0)

console.log('\nSimulation')
const sessionStarted = { ...session, startTime: draft.startTime }
const result = simulate({ session: sessionStarted, catalogue, graph, seed, speedNoise: Number(arg('noise', 0.25)), lateStartProbability: Number(arg('late', 0.1)), verbose })
if (!verbose) for (const line of result.log.filter((l) => /INTERRUPT|replan/.test(l)).slice(0, 40)) console.log('  ' + line)
console.log(renderLanes(result.finalPlan))
console.log('\nMetrics', JSON.stringify(result.metrics, null, 2))
