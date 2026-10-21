// Lazy loading of the heavy/optional dependencies so the MCP server starts (and can report a useful error) even when
// a workspace package is missing or broken.

let importerPromise = null
let conversionsPromise = null
let schedulerPromise = null
let xmldomPromise = null

export class DependencyError extends Error {
  constructor(name, cause) {
    super(`Could not load ${name}: ${cause?.message || cause}`)
    this.name = 'DependencyError'
    this.hint = 'Run `yarn install` in the flow-recipe repository root and make sure the workspace packages exist.'
  }
}

function load(name, loader) {
  return loader().catch(error => {
    throw new DependencyError(name, error)
  })
}

export function importer() {
  importerPromise ||= load('@flow-recipe/importer', () => import('@flow-recipe/importer'))
  importerPromise.catch(() => (importerPromise = null))
  return importerPromise
}

export function conversions() {
  conversionsPromise ||= load('@flow-recipe/scheduler/conversions', () => import('@flow-recipe/scheduler/conversions'))
  conversionsPromise.catch(() => (conversionsPromise = null))
  return conversionsPromise
}

export function scheduler() {
  schedulerPromise ||= load('@flow-recipe/scheduler', () => import('@flow-recipe/scheduler'))
  schedulerPromise.catch(() => (schedulerPromise = null))
  return schedulerPromise
}

export function xmldom() {
  xmldomPromise ||= load('@xmldom/xmldom', () => import('@xmldom/xmldom'))
  xmldomPromise.catch(() => (xmldomPromise = null))
  return xmldomPromise
}

/** The operation catalogue (name → operation), parsed once. */
let cataloguePromise = null
export function catalogue() {
  cataloguePromise ||= (async () => {
    const [{ loadOperationsXml }, { loadCatalogue }, { DOMParser }] = await Promise.all([importer(), scheduler(), xmldom()])
    return loadCatalogue(await loadOperationsXml(), { DOMParser })
  })()
  cataloguePromise.catch(() => (cataloguePromise = null))
  return cataloguePromise
}
