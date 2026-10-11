#!/usr/bin/env node
// Parses and validates every recipe in packages/server/src/recipes, prints a per-file summary and exits non-zero
// when any recipe has errors. When `xmllint` is on PATH each file is also checked against recipe.xsd.
//
//   node scripts/validate-recipes.js [recipesDir]

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DOMParser } from '@xmldom/xmldom'
import { parseRecipe, validateRecipe } from '../src/recipe/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const recipesDir = resolve(process.argv[2] || join(here, '..', '..', 'server', 'src', 'recipes'))
const operationsPath = join(recipesDir, 'operations.xml')
const schemaPath = join(recipesDir, 'recipe.xsd')

const ELEMENT_NODE = 1

function children(el, name) {
  return Array.from(el.childNodes).filter((n) => n.nodeType === ELEMENT_NODE && (!name || n.nodeName === name))
}

function attr(el, name) {
  return el.hasAttribute(name) ? el.getAttribute(name) : null
}

/** Minimal catalogue reader: only what validateRecipe needs (option metadata and arity). */
function minimalCatalogue(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const catalogue = {}
  for (const op of children(doc.documentElement, 'operation')) {
    const name = attr(op, 'name')
    const options = {}
    const optionsEl = children(op, 'options')[0]
    for (const o of optionsEl ? children(optionsEl, 'option') : []) {
      options[attr(o, 'name')] = {
        required: attr(o, 'required') === 'true',
        type: attr(o, 'type') || 'numeric',
        defaultUnit: attr(o, 'default-unit') || attr(o, 'unit') || null,
      }
    }
    const num = (n, fallback) => (attr(op, n) === null ? fallback : Number(attr(op, n)))
    catalogue[name] = {
      name,
      title: (children(op, 'title')[0] || {}).textContent || name,
      minInputs: num('min-inputs', 0),
      maxInputs: num('max-inputs', null),
      minOutputs: num('min-outputs', 1),
      maxOutputs: num('max-outputs', null),
      requiresTools: attr(op, 'requires-tools') === 'true',
      options,
    }
  }
  return catalogue
}

async function loadTheCatalogue() {
  const xml = readFileSync(operationsPath, 'utf8')
  try {
    const mod = await import('../src/catalogue/index.js')
    if (typeof mod.loadCatalogue === 'function') return { catalogue: mod.loadCatalogue(xml, { DOMParser }), source: 'catalogue/loadCatalogue' }
  } catch (e) {
    console.error(`catalogue module not usable (${e.message}); using the minimal reader`)
  }
  return { catalogue: minimalCatalogue(xml), source: 'minimal reader' }
}

function hasXmllint() {
  const r = spawnSync('xmllint', ['--version'], { encoding: 'utf8' })
  return !r.error && r.status === 0
}

function xmllint(file) {
  const r = spawnSync('xmllint', ['--noout', '--schema', schemaPath, file], { encoding: 'utf8' })
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim()
  return { ok: r.status === 0, output }
}

const { catalogue, source } = await loadTheCatalogue()
const lint = hasXmllint()
console.log(`recipes: ${recipesDir}`)
console.log(`catalogue: ${Object.keys(catalogue).length} operations (${source})`)
console.log(`xmllint: ${lint ? 'available, checking against recipe.xsd' : 'not on PATH, schema check skipped'}`)
console.log('')

const files = readdirSync(recipesDir)
  .filter((f) => f.endsWith('.xml') && f !== 'operations.xml')
  .sort()

let failed = 0
for (const file of files) {
  const path = join(recipesDir, file)
  const id = file.replace(/\.xml$/, '')
  const lines = []
  let ok = true

  if (lint) {
    const r = xmllint(path)
    if (!r.ok) {
      ok = false
      lines.push(`  schema: FAIL`)
      for (const l of r.output.split('\n')) if (l.trim()) lines.push(`    ${l}`)
    } else {
      lines.push('  schema: ok')
    }
  }

  let model = null
  try {
    model = parseRecipe(readFileSync(path, 'utf8'), { DOMParser, id })
  } catch (e) {
    ok = false
    lines.push(`  parse: FAIL ${e.message}`)
  }
  if (model) {
    const result = validateRecipe(model, catalogue)
    const taskCount = model.tasks.reduce((n, t) => n + (t.steps ? t.steps.length : 1), 0)
    lines.push(`  parse: ok (${model.ingredients.length} ingredients, ${model.tools.length} tools, ${taskCount} tasks)`)
    lines.push(`  validate: ${result.valid ? 'ok' : 'FAIL'} (${result.errors.length} errors, ${result.warnings.length} warnings)`)
    for (const e of result.errors) lines.push(`    error: ${e}`)
    for (const w of result.warnings) lines.push(`    warning: ${w}`)
    if (!result.valid) ok = false
  }

  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file}`)
  for (const l of lines) console.log(l)
}

console.log('')
console.log(`${files.length - failed}/${files.length} recipes valid`)
process.exit(failed > 0 ? 1 : 0)
