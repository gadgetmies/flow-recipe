// Default kitchen inventory and helpers. Counts are per tool TYPE; recipes reference types, not instances.

export const TOOL_TYPES = [
  // carriers and containers
  { type: 'bowl', count: 4, capacity: { number: 4, unit: 'l' } },
  { type: 'large-bowl', count: 1, capacity: { number: 8, unit: 'l' } },
  { type: 'cup', count: 6, capacity: { number: 0.3, unit: 'l' } },
  { type: 'jug', count: 1, capacity: { number: 1, unit: 'l' } },
  { type: 'plate', count: 6, capacity: null },
  { type: 'serving-plate', count: 2, capacity: null },
  { type: 'baking-sheet', count: 4, capacity: { number: 16, unit: 'bun' } },
  { type: 'baking-tin', count: 1, capacity: { number: 1, unit: 'cake' } },
  { type: 'cake-mould', count: 1, capacity: { number: 1, unit: 'cake' } },
  { type: 'square-dish', count: 1, capacity: null },
  { type: 'shallow-dish', count: 1, capacity: null },
  { type: 'cooling-rack', count: 2, capacity: { number: 32, unit: 'bun' } },
  { type: 'mixing-glass', count: 1, capacity: { number: 2, unit: 'drink' } },
  { type: 'rocks-glass', count: 6, capacity: { number: 1, unit: 'drink' } },
  // hand tools
  { type: 'whisk', count: 1, capacity: null },
  { type: 'spatula', count: 2, capacity: null },
  { type: 'frosting-spatula', count: 1, capacity: null },
  { type: 'spoon', count: 6, capacity: null },
  { type: 'fork', count: 6, capacity: null },
  { type: 'knife', count: 2, capacity: null },
  { type: 'pastry-brush', count: 1, capacity: null },
  { type: 'grater', count: 1, capacity: null },
  { type: 'peeler', count: 1, capacity: null },
  { type: 'sieve', count: 1, capacity: null },
  { type: 'strainer', count: 1, capacity: null },
  { type: 'bar-spoon', count: 1, capacity: null },
  { type: 'fruit-baller', count: 1, capacity: null },
  { type: 'kitchen-scale', count: 1, capacity: null },
  { type: 'precision-scale', count: 1, capacity: null },
  { type: 'towel', count: 3, capacity: null },
  // consumables modelled as tools with large counts
  { type: 'parchment-paper', count: 20, capacity: null },
  { type: 'cling-film', count: 20, capacity: null },
  { type: 'cover', count: 3, capacity: null },
]

export function defaultInventory() {
  return {
    tools: TOOL_TYPES.map((t) => ({ ...t, capacity: t.capacity ? { ...t.capacity } : null })),
    appliances: [
      { type: 'oven', slots: 2, modes: true, modeSwitchSeconds: 600 },
      { type: 'microwave', slots: 1, modes: false, modeSwitchSeconds: 0 },
      { type: 'hob', slots: 4, modes: false, modeSwitchSeconds: 0 },
    ],
    stations: [
      { type: 'sink', count: 1, area: null },
      { type: 'counter', count: 2, area: 40 },
    ],
    holding: [
      { type: 'fridge', slots: 6, keeps: 'cold', maxHold: 24 * 3600 },
      { type: 'freezer', slots: 2, keeps: 'cold', maxHold: 30 * 24 * 3600 },
    ],
    cleaning: { rinseSeconds: 20, washSeconds: 90, dishwasher: null },
  }
}

/** Merge overrides into a base inventory by type. Overrides may set count/slots to 0 to remove. */
export function mergeInventory(base, overrides = {}) {
  const out = JSON.parse(JSON.stringify(base))
  const mergeList = (listName, keyName = 'type') => {
    if (!overrides[listName]) return
    for (const o of overrides[listName]) {
      const i = out[listName].findIndex((x) => x[keyName] === o[keyName])
      if (i >= 0) out[listName][i] = { ...out[listName][i], ...o }
      else out[listName].push({ ...o })
    }
  }
  mergeList('tools'); mergeList('appliances'); mergeList('stations'); mergeList('holding')
  if (overrides.cleaning) out.cleaning = { ...out.cleaning, ...overrides.cleaning }
  return out
}

export function toolCount(inventory, type) {
  const t = inventory.tools.find((x) => x.type === type)
  return t ? t.count : 0
}

export function toolCapacity(inventory, type) {
  const t = inventory.tools.find((x) => x.type === type)
  return t && t.capacity ? t.capacity : null
}
