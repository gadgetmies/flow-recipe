// Minimal, tolerant HTML tooling for recipe pages (no DOM dependency): entity decoding, a forgiving tree builder,
// text rendering and readable-text extraction. It is not a conforming HTML5 parser; it only has to survive real
// recipe sites well enough to find JSON-LD, microdata and the main text.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', frac12: '½', frac14: '¼', frac34: '¾', frac13: '⅓',
  frac23: '⅔', frac15: '⅕', frac18: '⅛', frac38: '⅜', frac58: '⅝', frac78: '⅞', times: '×', divide: '÷',
  plusmn: '±', minus: '−', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§',
  para: '¶', micro: 'µ', sup1: '¹', sup2: '²', sup3: '³', ordm: 'º', ordf: 'ª', iexcl: '¡', iquest: '¿', shy: '',
  zwnj: '', zwj: '', lrm: '', rlm: '', prime: '′', Prime: '″', larr: '←', rarr: '→', check: '✓',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù',
  uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß', oelig: 'œ', scaron: 'š', zcaron: 'ž',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù',
  Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', OElig: 'Œ', Scaron: 'Š', Zcaron: 'Ž',
}

/** Decode HTML character references (named, decimal, hex). Unknown names are left as they are. */
export function decodeEntities(s) {
  if (s === null || s === undefined) return ''
  return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m
      if (code === 160) return ' '
      try {
        return String.fromCodePoint(code)
      } catch {
        return m
      }
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body]
    const lower = body.toLowerCase()
    if (m.endsWith(';') && Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) return NAMED_ENTITIES[lower]
    return m
  })
}

/** Collapse whitespace (incl. non-breaking spaces) to single spaces and trim. */
export function collapse(s) {
  return String(s || '').replace(/[\s ​]+/g, ' ').trim()
}

// ---------------------------------------------------------------------------------------------------------------
// Tree builder

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen', 'command'])
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template', 'iframe', 'noembed', 'noframes'])
// Opening one of these closes an open element of the listed names (implicit end tags).
const AUTO_CLOSE = {
  li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'],
  option: ['option'], p: ['p'],
}
const BLOCK_CLOSES_P = new Set(['div', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'blockquote', 'pre', 'form', 'figure', 'main', 'hr', 'dl', 'fieldset'])

/**
 * Parse HTML into a light tree: { type: 'element', name, attrs, children, parent } / { type: 'text', text } /
 * { type: 'comment', text }. Tolerant: unmatched end tags are ignored, unclosed elements are closed at the end.
 */
const MAX_DEPTH = 256

export function parseHtml(html) {
  const src = String(html || '')
  const root = { type: 'element', name: '#document', attrs: {}, children: [], parent: null, depth: 0 }
  let cur = root
  let i = 0
  const n = src.length
  const pushText = (text) => {
    if (!text) return
    const last = cur.children[cur.children.length - 1]
    if (last && last.type === 'text') last.text += text
    else cur.children.push({ type: 'text', text })
  }
  const closeTo = (name) => {
    let el = cur
    while (el && el !== root && el.name !== name) el = el.parent
    if (el && el !== root) cur = el.parent
  }
  const isOpen = (names, stopAt) => {
    let el = cur
    while (el && el !== root) {
      if (names.includes(el.name)) return el
      if (stopAt && stopAt.includes(el.name)) return null
      el = el.parent
    }
    return null
  }

  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      pushText(src.slice(i))
      break
    }
    if (lt > i) pushText(src.slice(i, lt))
    i = lt
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      const stop = end < 0 ? n : end
      cur.children.push({ type: 'comment', text: src.slice(i + 4, stop) })
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i)
      pushText(src.slice(i + 9, end < 0 ? n : end))
      i = end < 0 ? n : end + 3
      continue
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') {
      const end = src.indexOf('>', i)
      i = end < 0 ? n : end + 1
      continue
    }
    const endTag = src[i + 1] === '/'
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(src.slice(i, i + 100))
    if (!m) {
      pushText('<')
      i += 1
      continue
    }
    const name = m[1].toLowerCase()
    // Find the end of the tag, respecting quoted attribute values.
    let j = i + m[0].length
    let quote = null
    while (j < n) {
      const c = src[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
      j++
    }
    const inner = src.slice(i + m[0].length, j)
    i = j + 1
    if (endTag) {
      if (name === 'p' && !isOpen(['p'])) continue
      closeTo(name)
      continue
    }
    const attrs = parseAttributes(inner)
    const selfClosing = /\/\s*$/.test(inner)
    if (AUTO_CLOSE[name]) {
      const stop = name === 'li' ? ['ul', 'ol'] : name === 'dt' || name === 'dd' ? ['dl'] : name === 'td' || name === 'th' ? ['tr', 'table'] : name === 'tr' ? ['table', 'tbody', 'thead'] : null
      const open = isOpen(AUTO_CLOSE[name], stop || ['div', 'section', 'article', 'body'])
      if (open) cur = open.parent
    }
    if (BLOCK_CLOSES_P.has(name)) {
      const p = isOpen(['p'], ['div', 'section', 'article', 'li', 'td', 'body'])
      if (p) cur = p.parent
    }
    const el = { type: 'element', name, attrs, children: [], parent: cur, depth: cur.depth + 1 }
    cur.children.push(el)
    // Pathologically deep nesting would overflow the recursive walkers: past MAX_DEPTH, elements become siblings.
    if (VOID.has(name) || selfClosing) continue
    if (el.depth >= MAX_DEPTH && !RAW_TEXT.has(name)) continue
    if (RAW_TEXT.has(name)) {
      const re = new RegExp(`</${name}\\s*>`, 'i')
      const rest = src.slice(i)
      const mm = re.exec(rest)
      const raw = mm ? rest.slice(0, mm.index) : rest
      if (raw) el.children.push({ type: 'text', text: raw, raw: true })
      i = mm ? i + mm.index + mm[0].length : n
      continue
    }
    cur = el
  }
  return root
}

function parseAttributes(s) {
  const attrs = {}
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m
  while ((m = re.exec(s))) {
    const name = m[1].toLowerCase()
    if (name in attrs) continue
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : ''
    attrs[name] = decodeEntities(v)
  }
  return attrs
}

/** Depth-first walk over element nodes; return false from fn to skip the subtree. */
export function walk(node, fn) {
  for (const c of node.children || []) {
    if (c.type !== 'element') continue
    if (fn(c) === false) continue
    walk(c, fn)
  }
}

export function findAll(node, pred) {
  const out = []
  walk(node, (el) => {
    if (pred(el)) out.push(el)
  })
  return out
}

export function findFirst(node, pred) {
  let found = null
  walk(node, (el) => {
    if (found) return false
    if (pred(el)) {
      found = el
      return false
    }
  })
  return found
}

/** Raw (undecoded) text inside an element, e.g. a script body. */
export function rawText(el) {
  let s = ''
  for (const c of el.children || []) {
    if (c.type === 'text') s += c.text
    else if (c.type === 'element') s += rawText(c)
  }
  return s
}

// ---------------------------------------------------------------------------------------------------------------
// Text rendering

const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tr', 'ul', 'caption', 'tbody', 'thead', 'tfoot'])
const SKIP_ALWAYS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'object', 'embed', 'video', 'audio', 'map', 'head', 'select', 'button', 'input', 'textarea', 'picture', 'img', 'source', 'link', 'meta'])

/**
 * Render an element (or a fragment of HTML) as readable text: block elements break lines, list items get "- ",
 * headings get blank lines around them, whitespace is collapsed per line, duplicate blank lines removed.
 * @param {object|string} node element from parseHtml, or an HTML string
 * @param {{ skip?: (el) => boolean }} [options]
 */
export function htmlToText(node, { skip } = {}) {
  const root = typeof node === 'string' ? parseHtml(node) : node
  let out = ''
  const newlines = (n) => {
    let have = 0
    for (let k = out.length - 1; k >= 0 && have < n; k--) {
      const c = out[k]
      if (c === '\n') have++
      else if (c === ' ' || c === '\t') continue
      else break
    }
    if (out.length === 0) return
    out += '\n'.repeat(Math.max(0, n - have))
  }
  const rec = (el, pre) => {
    for (const c of el.children || []) {
      if (c.type === 'text') {
        if (c.raw) continue
        const t = decodeEntities(c.text)
        out += pre ? t : t.replace(/[\s\u00a0]+/g, ' ')
        continue
      }
      if (c.type !== 'element') continue
      if (SKIP_ALWAYS.has(c.name)) continue
      if (skip && skip(c)) continue
      if (c.attrs && (c.attrs.hidden !== undefined || c.attrs['aria-hidden'] === 'true')) continue
      if (/display\s*:\s*none/i.test((c.attrs && c.attrs.style) || '')) continue
      if (c.name === 'br') {
        out += '\n'
        continue
      }
      const block = BLOCK.has(c.name)
      const heading = /^h[1-6]$/.test(c.name)
      if (block) newlines(heading ? 2 : 1)
      if (c.name === 'li') out += '- '
      if (c.name === 'td' || c.name === 'th') out += ' '
      rec(c, pre || c.name === 'pre')
      if (block) newlines(heading ? 2 : 1)
    }
  }
  rec(root, false)
  return tidyText(out)
}

/** Collapse spaces within lines, drop empty-line runs and lines that are just bullets. */
export function tidyText(s) {
  const lines = String(s || '').split(/\r?\n/).map((l) => collapse(l)).map((l) => (l === '-' ? '' : l))
  const out = []
  for (const l of lines) {
    if (!l && (!out.length || out[out.length - 1] === '')) continue
    out.push(l)
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

const NOISE_TAGS = new Set(['nav', 'footer', 'aside', 'form', 'header'])
const NOISE_PATTERN = /(^|[\s_-])(comments?|comment-list|respond|share|sharing|social|newsletter|subscribe|related|recommend|advert|ads?|ad-slot|sponsor|promo|cookie|consent|gdpr|popup|modal|sidebar|widget|breadcrumbs?|menu|navbar|nav|footer|masthead|site-header|skip-link|rating-form|print-button|jump-to)($|[\s_-])/i

function isNoise(el) {
  if (NOISE_TAGS.has(el.name)) {
    // A <header> inside an article often carries the recipe title: keep those.
    if (el.name === 'header' && hasAncestor(el, (a) => a.name === 'article' || a.name === 'main')) return false
    return true
  }
  const role = (el.attrs.role || '').toLowerCase()
  if (['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alert'].includes(role)) return true
  const ident = `${el.attrs.class || ''} ${el.attrs.id || ''}`
  if (!ident.trim()) return false
  // Never drop something that is obviously the recipe itself.
  if (/recipe|ingredient|instruction|direction|method|step/i.test(ident)) return false
  return NOISE_PATTERN.test(ident)
}

function hasAncestor(el, pred) {
  let p = el.parent
  while (p) {
    if (p.type === 'element' && pred(p)) return true
    p = p.parent
  }
  return false
}

/**
 * Readable main text of a page: picks the recipe container, <article> or <main> with the most text (else <body>),
 * strips scripts, styles, navigation, footers, comment sections, ads and HTML comments; ≤ maxChars characters.
 */
export function readableText(root, { maxChars = 30000 } = {}) {
  const body = findFirst(root, (el) => el.name === 'body') || root
  const candidates = findAll(body, (el) => {
    if (el.name === 'article' || el.name === 'main') return true
    const ident = `${el.attrs.class || ''} ${el.attrs.id || ''}`
    return /(^|[\s_-])(wprm-recipe-container|tasty-recipes|recipe-card|recipe-content|recipe-body|mv-create-card|easyrecipe|recipe)($|[\s_-])/i.test(ident) && ['div', 'section', 'article'].includes(el.name)
  })
  let best = null
  let bestLen = 0
  for (const c of candidates) {
    const t = htmlToText(c, { skip: isNoise })
    // Prefer containers that mention ingredients; otherwise the longest.
    const score = t.length * (/ingredient/i.test(t) ? 2 : 1)
    if (score > bestLen) {
      best = t
      bestLen = score
    }
  }
  const bodyText = htmlToText(body, { skip: isNoise })
  // A tiny <article> (teaser) is not the main text.
  let text = best && best.length > Math.min(800, bodyText.length * 0.25) ? best : bodyText
  if (text.length > maxChars) text = text.slice(0, maxChars).replace(/\s+\S*$/, '') + '\n…'
  return text
}

/** <meta> content by name/property (first match). */
export function metaContent(root, ...keys) {
  const wanted = keys.map((k) => k.toLowerCase())
  const el = findFirst(root, (e) => e.name === 'meta' && wanted.includes(String(e.attrs.property || e.attrs.name || e.attrs.itemprop || '').toLowerCase()) && e.attrs.content)
  return el ? collapse(el.attrs.content) : null
}
