export * from './units.js'
export * from './inventory.js'
export * from './recipe/index.js'
export * from './catalogue/index.js'
export * from './graph/index.js'
export * from './planner/index.js'
export * from './online/index.js'
export * from './sim/index.js'
export * from './conversions/index.js'

import { parseRecipe } from './recipe/index.js'
import { loadCatalogue } from './catalogue/index.js'
import { buildGraph } from './graph/index.js'
import { plan } from './planner/index.js'
import { defaultInventory } from './inventory.js'

/**
 * Convenience: parse recipes and the catalogue, build the graph and plan in one call (README §9).
 * @param {object} args { recipes: { [id]: xml }, operationsXml, session, DOMParser, planOptions }
 */
export function planSession({ recipes, operationsXml, session, DOMParser, planOptions = {} }) {
  const catalogue = loadCatalogue(operationsXml, { DOMParser })
  const models = {}
  for (const [id, xml] of Object.entries(recipes)) models[id] = parseRecipe(xml, { DOMParser, id })
  const dishes = (session.dishes || []).map((d, i) => {
    const recipe = d.recipe || models[d.recipeId]
    if (!recipe) throw new Error(`Recipe '${d.recipeId}' not provided`)
    return { ...d, id: d.id || `${d.recipeId}${i > 0 ? `-${i + 1}` : ''}`, recipe }
  })
  const full = { ...session, dishes, inventory: session.inventory || defaultInventory() }
  const graph = buildGraph(full, catalogue)
  const result = plan(graph, full, planOptions)
  return { catalogue, graph, plan: result, session: full }
}
