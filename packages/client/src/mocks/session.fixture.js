// SessionView fixture (server API.md). Times are epoch ms relative to `base`.

const M = 60_000

export const DEFAULT_PROFILE = {
  speed: 1,
  capabilities: ['knife', 'hot-pan', 'oven'],
  role: 'cook',
  targetShare: 1,
  maxConcurrentTimers: 2,
}

export const DEFAULT_POLICY = {
  weights: { fair: 10, idle: 8, switch: 3, interrupt: 5, robust: 2, span: 1, stable: 4 },
  switchMatrix: { sameContext: 0, sameDishSameStation: 15, sameDishOtherStation: 30, otherDish: 60, afterCleaning: 30, any: 10 },
  minChunkSeconds: 180,
  maxIdleStretchSeconds: 480,
  slackBufferFraction: 0.1,
  slackBufferMinSeconds: 120,
  hotHoldSeconds: 600,
  coldHoldSeconds: 1200,
  cleaning: 'shared',
  endOfSessionCleaning: true,
  miseEnPlace: false,
  leadSeconds: 30,
  reactionSeconds: 30,
  ackTimeoutSeconds: 15,
  replanThresholdSeconds: 90,
  replanDebounceSeconds: 10,
  stabilityHorizonSeconds: 900,
  searchBudgetMs: 400,
  replanBudgetMs: 120,
  seed: 1,
}

export const DEFAULT_INVENTORY = {
  tools: [
    { type: 'bowl', count: 4, capacity: { number: 4, unit: 'l' } },
    { type: 'large-bowl', count: 1, capacity: { number: 8, unit: 'l' } },
    { type: 'cup', count: 6, capacity: { number: 0.3, unit: 'l' } },
    { type: 'jug', count: 1, capacity: { number: 1, unit: 'l' } },
    { type: 'plate', count: 6, capacity: null },
    { type: 'serving-plate', count: 2, capacity: null },
    { type: 'baking-sheet', count: 4, capacity: { number: 16, unit: 'bun' } },
    { type: 'baking-tin', count: 1, capacity: { number: 1, unit: 'cake' } },
    { type: 'cooling-rack', count: 2, capacity: { number: 32, unit: 'bun' } },
    { type: 'mixing-glass', count: 1, capacity: { number: 2, unit: 'drink' } },
    { type: 'rocks-glass', count: 6, capacity: { number: 1, unit: 'drink' } },
    { type: 'whisk', count: 1, capacity: null },
    { type: 'spatula', count: 2, capacity: null },
    { type: 'spoon', count: 6, capacity: null },
    { type: 'fork', count: 6, capacity: null },
    { type: 'knife', count: 2, capacity: null },
    { type: 'pastry-brush', count: 1, capacity: null },
    { type: 'grater', count: 1, capacity: null },
    { type: 'sieve', count: 1, capacity: null },
    { type: 'strainer', count: 1, capacity: null },
    { type: 'bar-spoon', count: 1, capacity: null },
    { type: 'kitchen-scale', count: 1, capacity: null },
    { type: 'towel', count: 3, capacity: null },
    { type: 'parchment-paper', count: 20, capacity: null },
  ],
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

export const RECIPES_FIXTURE = [
  { id: 'buns', title: 'Buns', serving: { temperature: 'hot', hold: 600 } },
  { id: 'negroni', title: 'Rum Negroni', serving: { temperature: 'cold', hold: 300 } },
  { id: 'bday-cake', title: 'Birthday cake', serving: null },
  { id: 'sandwich', title: 'Sandwich', serving: null },
]

/** Plan/session base time: a minute boundary ten minutes ago, so the "now" line sits inside the plan. */
export function defaultBase(now = Date.now()) {
  return Math.floor(now / M) * M - 10 * M
}

export function makeSessionFixture(base = defaultBase()) {
  return {
    id: 'mock-session',
    status: 'draft',
    createdAt: base - 5 * M,
    startTime: base,
    dishes: [
      { id: 'buns', recipeId: 'buns', title: 'Buns', scale: 2, serveTime: base + 90 * M, earlyTolerance: 0, lateTolerance: 300_000 },
      { id: 'negroni', recipeId: 'negroni', title: 'Rum Negroni', scale: 4, serveTime: base + 15 * M, earlyTolerance: 120_000, lateTolerance: 600_000 },
    ],
    inventory: JSON.parse(JSON.stringify(DEFAULT_INVENTORY)),
    policy: { ...DEFAULT_POLICY, weights: { ...DEFAULT_POLICY.weights } },
    participants: [
      { id: '0', name: 'Alice', isSpectator: false, connected: true, placeholder: false, profile: { ...DEFAULT_PROFILE } },
      { id: 'p1', name: 'Bob', isSpectator: false, connected: true, placeholder: false, profile: { ...DEFAULT_PROFILE, speed: 0.9, capabilities: ['knife', 'oven'] } },
      { id: 'placeholder-1', name: 'Cook 3', isSpectator: false, connected: false, placeholder: true, profile: { ...DEFAULT_PROFILE, speed: 1.1, capabilities: ['knife', 'hot-pan', 'oven'] } },
    ],
  }
}

const sessionFixture = makeSessionFixture()
export default sessionFixture
