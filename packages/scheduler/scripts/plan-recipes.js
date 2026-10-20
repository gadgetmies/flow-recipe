// Dev tool: plan real recipes end to end. node scripts/plan-recipes.js buns,tiramisu 3 [items]
import fs from 'node:fs'
import path from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { planSession } from '../src/index.js'
import { renderLanes, fmt } from '../src/sim/render.js'
const dir = '/home/user/flow-recipe/packages/server/src/recipes/'
const ids = (process.argv[2] || 'buns,tiramisu,negroni').split(',')
const recipes = Object.fromEntries(ids.map((id) => [id, fs.readFileSync(path.join(dir, `${id}.xml`), 'utf8')]))
const operationsXml = fs.readFileSync(path.join(dir, 'operations.xml'), 'utf8')
const serve = Date.UTC(2026, 9, 11, 18, 0, 0)
const n = Number(process.argv[3] || 3)
const session = { id: 's', dishes: ids.map((id, i) => ({ id, recipeId: id, scale: 1, serveTime: serve + i * 10 * 60000, lateTolerance: 300000 })), participants: Array.from({ length: n }, (_, i) => ({ id: i === 0 ? '0' : `p${i + 1}`, name: `P${i + 1}` })), policy: {} }
const t = Date.now()
const { graph, plan } = planSession({ recipes, operationsXml, session, DOMParser })
console.log(`${ids.join('+')} ×${n}: ${Object.keys(graph.tasks).length} tasks, ${Date.now() - t} ms, start ${fmt(plan.startTime)} end ${fmt(plan.endTime)}, fairness ${plan.report.fairness}, switches ${plan.report.switches}`)
for (const d of plan.dishes) console.log(`  ${d.title}: target ${fmt(d.serveTarget)} planned ${d.plannedServe ? fmt(d.plannedServe) : '—'} spread ${Math.round(d.spread / 60)} late ${d.late}`)
for (const d of plan.diagnostics) console.log(`  [${d.code}] ${d.message}`)
console.log(renderLanes(plan, { width: 100 }))
if (process.argv[4] === 'items') for (const lane of plan.lanes) { console.log(lane.participantId, JSON.stringify(lane.report)); for (const it of lane.items) console.log('   ', fmt(it.start), fmt(it.end), it.kind.padEnd(11), it.title, '|', (it.instructions || '').slice(0, 70)) }
