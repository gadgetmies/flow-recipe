// Recipe XML vocabulary check. Recipe documents are served back to browsers (GET /api/recipes/:id) and rendered by
// the client, so a stored document must not carry anything a browser could execute or that changes how it is
// rendered: elements from other namespaces (XHTML <script>, SVG, MathML), processing instructions such as
// <?xml-stylesheet?> (XSLT), document type declarations, or elements outside the recipe format.

export const XSI_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance'
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'

/** Every element name of recipe format v2 (recipe.xsd), plus the v1 <batch> the parser explains itself. */
export const RECIPE_ELEMENTS = new Set([
  'recipe', 'title', 'serving', 'ingredients', 'ingredient', 'properties', 'property', 'tools', 'tool', 'tasks', 'task',
  'join', 'inputs', 'input', 'outputs', 'output', 'options', 'option', 'numeric-value', 'text-content', 'instructions',
  'batch',
])

const ELEMENT_NODE = 1
const ATTRIBUTE_NODE = 2
const PROCESSING_INSTRUCTION_NODE = 7
const DOCUMENT_TYPE_NODE = 10

/**
 * Problems that make a parsed recipe document unsafe or foreign. Empty when the document only uses the recipe
 * vocabulary (no namespace; xmlns:xsi / xsi:* and xml:* attributes allowed) and no processing instruction other than
 * the XML declaration.
 * @param {Document} doc a DOM document (@xmldom/xmldom or browser)
 * @param {{ maxErrors?: number }} [options]
 * @returns {string[]}
 */
export function recipeVocabularyErrors(doc, { maxErrors = 10 } = {}) {
  const errors = []
  const push = (msg) => {
    if (errors.length < maxErrors && !errors.includes(msg)) errors.push(msg)
  }
  if (!doc) return ['No document']
  for (let i = 0; i < doc.childNodes.length; i++) {
    const n = doc.childNodes[i]
    if (n.nodeType === PROCESSING_INSTRUCTION_NODE && String(n.nodeName).toLowerCase() !== 'xml') {
      push(`Processing instruction <?${n.nodeName} …?> is not allowed in a recipe`)
    }
    if (n.nodeType === DOCUMENT_TYPE_NODE) push('A DOCTYPE declaration is not allowed in a recipe')
  }
  // Iterative walk (no recursion: deep documents must not overflow the stack).
  const stack = doc.documentElement ? [doc.documentElement] : []
  while (stack.length && errors.length < maxErrors) {
    const el = stack.pop()
    if (el.nodeType === PROCESSING_INSTRUCTION_NODE) {
      push(`Processing instruction <?${el.nodeName} …?> is not allowed in a recipe`)
      continue
    }
    if (el.nodeType !== ELEMENT_NODE) continue
    const name = el.localName || el.nodeName
    if (el.namespaceURI || el.prefix || String(el.nodeName).includes(':')) {
      push(`Element <${el.nodeName}>${el.namespaceURI ? ` (namespace ${el.namespaceURI})` : ''} is not part of the recipe format; recipes use elements without a namespace only`)
    } else if (!RECIPE_ELEMENTS.has(name)) {
      push(`Element <${el.nodeName}> is not part of the recipe format (allowed: ${[...RECIPE_ELEMENTS].filter((e) => e !== 'batch').join(', ')})`)
    }
    const attrs = el.attributes || []
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i]
      if (!a || (a.nodeType !== undefined && a.nodeType !== ATTRIBUTE_NODE)) continue
      const an = String(a.name || a.nodeName)
      if (an === 'xmlns') {
        push(`<${el.nodeName}> declares a default namespace (xmlns="${String(a.value).slice(0, 100)}"); recipes have no namespace`)
      } else if (an.startsWith('xmlns:')) {
        if (a.value !== XSI_NAMESPACE) push(`<${el.nodeName}> declares namespace ${an}="${String(a.value).slice(0, 100)}"; only xmlns:xsi is allowed`)
      } else if (an.includes(':')) {
        const ns = a.namespaceURI
        if (ns !== XSI_NAMESPACE && ns !== XML_NAMESPACE && ns !== XMLNS_NAMESPACE) push(`Attribute ${an} on <${el.nodeName}> is not allowed (only xsi:* and xml:* prefixed attributes)`)
      }
    }
    for (let i = el.childNodes.length - 1; i >= 0; i--) {
      const c = el.childNodes[i]
      if (c.nodeType === ELEMENT_NODE || c.nodeType === PROCESSING_INSTRUCTION_NODE) stack.push(c)
    }
  }
  return errors
}
