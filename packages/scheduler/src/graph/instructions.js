// Instruction text for task instances. Uses `instructionText` from catalogue/instructions.js when that module is
// present at runtime (it is written concurrently), else a plain "Title: input names" fallback.

let external = null
try {
  const mod = await import('../catalogue/instructions.js')
  external = typeof mod.instructionText === 'function' ? mod.instructionText : null
} catch {
  external = null
}

function refName(ref, recipe, tasks) {
  const ing = recipe?.ingredients?.find((i) => i.id === ref)
  if (ing) return ing.name
  const tool = recipe?.tools?.find((t) => t.id === ref)
  if (tool) return tool.name ?? tool.id
  for (const t of tasks) for (const o of t.outputs ?? []) if (o.id === ref) return o.name ?? o.id
  return ref
}

function fallback(task, recipe, catalogue, tasks) {
  if (task.operation === 'join' && Array.isArray(task.steps) && task.steps.length > 0) {
    return task.steps.map((s) => fallback(s, recipe, catalogue, tasks)).join('. ')
  }
  const title = catalogue?.[task.operation]?.title ?? task.operation
  const names = (task.inputs ?? []).map((i) => refName(i.ref, recipe, tasks))
  return names.length > 0 ? `${title}: ${names.join(', ')}` : title
}

/**
 * Render the instruction text of a recipe task.
 * @param {object} task RecipeModel task (possibly expanded)
 * @param {object} recipe RecipeModel
 * @param {object} catalogue Catalogue
 * @param {Array} [tasks] the expanded task list used to resolve output names (defaults to recipe.tasks)
 */
export function renderInstructions(task, recipe, catalogue, tasks = recipe?.tasks ?? []) {
  if (external) {
    try {
      const text = external(task, { ...recipe, tasks }, catalogue)
      if (typeof text === 'string' && text.trim()) return text
    } catch {
      // fall through to the local renderer
    }
  }
  return fallback(task, recipe, catalogue, tasks)
}
