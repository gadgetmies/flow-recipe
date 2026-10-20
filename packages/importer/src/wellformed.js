// A strict XML well-formedness scanner. @xmldom/xmldom is very forgiving (mismatched end tags, unquoted
// attributes and unknown entities only produce warnings), so LLM output is checked here first and every problem is
// reported with its line and column.

const NAME = /^[A-Za-z_:][A-Za-z0-9_:.\-]*/
const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos'])

function position(src, index) {
  let line = 1
  let last = -1
  for (let i = 0; i < index && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) {
      line++
      last = i
    }
  }
  return { line, column: index - last }
}

/**
 * Check that a string is a well-formed XML document.
 * @param {string} xml
 * @param {{ maxErrors?: number }} [options]
 * @returns {Array<{ line: number, column: number, message: string }>} problems, empty when well-formed
 */
export function checkWellFormed(xml, { maxErrors = 10 } = {}) {
  const src = String(xml)
  const errors = []
  const err = (index, message) => {
    if (errors.length < maxErrors) errors.push({ ...position(src, index), message })
  }
  const checkEntities = (text, offset) => {
    const re = /&([^;\s<&]{0,32})(;?)/g
    let m
    while ((m = re.exec(text))) {
      const body = m[1]
      if (!m[2]) {
        err(offset + m.index, `Unescaped '&' (write &amp;)`)
        continue
      }
      if (/^#x[0-9a-fA-F]+$/.test(body) || /^#[0-9]+$/.test(body)) continue
      if (!XML_ENTITIES.has(body)) err(offset + m.index, `Unknown entity '&${body};' (XML only knows &amp; &lt; &gt; &quot; &apos;; write the character itself)`)
    }
  }

  const stack = []
  let rootSeen = false
  let rootClosed = false
  let i = 0
  const n = src.length
  if (src.charCodeAt(0) === 0xfeff) i = 1
  while (i < n && errors.length < maxErrors) {
    const lt = src.indexOf('<', i)
    const textEnd = lt < 0 ? n : lt
    if (textEnd > i) {
      const text = src.slice(i, textEnd)
      if (text.includes('>') && text.includes(']]>')) err(i + text.indexOf(']]>'), "']]>' is not allowed in text")
      if (stack.length === 0) {
        if (text.trim()) err(i + text.search(/\S/), rootClosed ? 'Text after the end of the root element' : 'Text before the root element')
      } else checkEntities(text, i)
    }
    if (lt < 0) break
    i = lt
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2)
      if (end < 0) {
        err(i, 'Unterminated processing instruction')
        break
      }
      if (/^<\?xml[\s?]/.test(src.slice(i, i + 6)) && i > 0 && src.slice(0, i).replace(/^﻿/, '') !== '') {
        err(i, 'The XML declaration must be at the very start of the document')
      }
      i = end + 2
      continue
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      if (end < 0) {
        err(i, 'Unterminated comment')
        break
      }
      if (src.slice(i + 4, end).includes('--')) err(i, "'--' is not allowed inside a comment")
      i = end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', i)) {
      if (!stack.length) err(i, 'CDATA outside the root element')
      const end = src.indexOf(']]>', i)
      if (end < 0) {
        err(i, 'Unterminated CDATA section')
        break
      }
      i = end + 3
      continue
    }
    if (src.startsWith('<!DOCTYPE', i) || src.startsWith('<!doctype', i)) {
      const end = src.indexOf('>', i)
      i = end < 0 ? n : end + 1
      continue
    }
    if (src[i + 1] === '/') {
      const m = NAME.exec(src.slice(i + 2))
      if (!m) {
        err(i, 'Malformed end tag')
        i += 2
        continue
      }
      const name = m[0]
      let j = i + 2 + name.length
      while (j < n && /\s/.test(src[j])) j++
      if (src[j] !== '>') {
        err(j, `Malformed end tag </${name}`)
        const gt = src.indexOf('>', j)
        i = gt < 0 ? n : gt + 1
      } else i = j + 1
      const top = stack[stack.length - 1]
      if (!top) err(i - 1, `End tag </${name}> without a matching start tag`)
      else if (top.name !== name) {
        const p = position(src, top.index)
        err(i - 1, `End tag </${name}> does not match <${top.name}> opened at line ${p.line}`)
        const k = stack.map((s) => s.name).lastIndexOf(name)
        if (k >= 0) stack.length = k
      } else {
        stack.pop()
        if (!stack.length) rootClosed = true
      }
      continue
    }
    // start tag
    const m = NAME.exec(src.slice(i + 1))
    if (!m) {
      err(i, `'<' must start a tag (write &lt; for a literal less-than sign)`)
      i += 1
      continue
    }
    const name = m[0]
    if (rootClosed || (stack.length === 0 && rootSeen)) err(i, `Second root element <${name}> (a document has exactly one root)`)
    let j = i + 1 + name.length
    const seen = new Set()
    let selfClosing = false
    let closed = false
    while (j < n) {
      while (j < n && /\s/.test(src[j])) j++
      if (src[j] === '>') {
        j++
        closed = true
        break
      }
      if (src[j] === '/' && src[j + 1] === '>') {
        j += 2
        selfClosing = true
        closed = true
        break
      }
      if (src[j] === '<') break
      const am = NAME.exec(src.slice(j))
      if (!am) {
        err(j, `Unexpected character '${src[j]}' in tag <${name}>`)
        j++
        continue
      }
      const an = am[0]
      if (j > 0 && !/\s/.test(src[j - 1])) err(j, `Missing whitespace before attribute ${an} in <${name}>`)
      j += an.length
      if (seen.has(an)) err(j - an.length, `Attribute ${an} repeated in <${name}>`)
      seen.add(an)
      while (j < n && /\s/.test(src[j])) j++
      if (src[j] !== '=') {
        err(j, `Attribute ${an} in <${name}> has no value`)
        continue
      }
      j++
      while (j < n && /\s/.test(src[j])) j++
      const q = src[j]
      if (q !== '"' && q !== "'") {
        err(j, `Attribute ${an} in <${name}> must be quoted`)
        while (j < n && !/[\s>]/.test(src[j])) j++
        continue
      }
      const close = src.indexOf(q, j + 1)
      if (close < 0) {
        err(j, `Unterminated attribute value for ${an} in <${name}>`)
        j = n
        break
      }
      const value = src.slice(j + 1, close)
      if (value.includes('<')) err(j + 1 + value.indexOf('<'), `'<' is not allowed in attribute ${an} of <${name}>`)
      checkEntities(value, j + 1)
      j = close + 1
    }
    if (!closed) {
      err(i, `Unterminated start tag <${name}>`)
      i = j
      continue
    }
    if (stack.length === 0) rootSeen = true
    if (!selfClosing) stack.push({ name, index: i })
    else if (stack.length === 0) rootClosed = true
    i = j
  }
  if (!rootSeen && errors.length === 0) err(0, 'No root element (the document is empty or not XML)')
  for (const open of stack.reverse()) {
    if (errors.length >= maxErrors) break
    const p = position(src, open.index)
    errors.push({ line: p.line, column: p.column, message: `<${open.name}> opened at line ${p.line} is never closed` })
  }
  return errors
}
