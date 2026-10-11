// Operation catalogue: operations.xml → Catalogue, the duration model and instruction text (README §3).
// The XML itself is not embedded: the server serves it and the test reads ../../server/src/recipes/operations.xml.

export { loadCatalogue, DEFAULT_CHECK_INTERVAL, DEFAULT_CHECK_DURATION } from './load.js'
export { durations, activeSeconds, passiveSeconds } from './durations.js'
export { instructionText, formatAmount } from './instructions.js'
