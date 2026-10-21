#!/usr/bin/env node
// Check a recipe XML file and print the CheckResult as JSON.
//
//   node packages/importer/bin/check.js recipe.xml [--precision-scale] [--convert] [--out converted.xml]
//                                                  [--id my-recipe] [--no-plan] [--compact]
//
//   --convert          convert units to metric first (metricizeRecipeXml) and write the converted XML back to the
//                      file (or to --out); the JSON then has { conversion: { changes, warnings, written }, check }
//   --precision-scale  the cook has a 0.1 g scale (small amounts in grams instead of tsp/tbsp)
//   --no-plan          skip the scheduler dry run
//   -                  read the XML from stdin (with --convert and no --out, the XML is included in the JSON)
//
// Exit code: 0 when the check has no errors, 1 when it has errors, 2 for usage or I/O problems.

import { readFileSync, writeFileSync } from 'node:fs'
import { XMLSerializer } from '@xmldom/xmldom'
import { checkRecipeXml, conversions, QuietDOMParser, CONVERSIONS_MISSING } from '../src/check.js'

function usage(message) {
  if (message) process.stderr.write(`${message}\n`)
  process.stderr.write('usage: check.js <recipe.xml | -> [--precision-scale] [--convert] [--out FILE] [--id ID] [--no-plan] [--compact]\n')
  process.exit(2)
}

const args = process.argv.slice(2)
const opts = { precisionScale: false, convert: false, out: null, id: undefined, plan: true, compact: false, file: null }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--precision-scale' || a === '--precisionScale') opts.precisionScale = true
  else if (a === '--convert') opts.convert = true
  else if (a === '--out') opts.out = args[++i] || usage('--out needs a file name')
  else if (a === '--id') opts.id = args[++i] || usage('--id needs a value')
  else if (a === '--no-plan') opts.plan = false
  else if (a === '--compact') opts.compact = true
  else if (a === '-h' || a === '--help') usage()
  else if (a.startsWith('--')) usage(`unknown option ${a}`)
  else if (opts.file === null) opts.file = a
  else usage(`unexpected argument ${a}`)
}
if (!opts.file) usage('no file given')

let xml
try {
  xml = opts.file === '-' ? readFileSync(0, 'utf8') : readFileSync(opts.file, 'utf8')
} catch (e) {
  usage(`cannot read ${opts.file}: ${e.message}`)
}

const output = {}
if (opts.convert) {
  const conv = conversions()
  if (!conv) {
    output.conversion = { error: CONVERSIONS_MISSING, changes: [], warnings: [], written: null }
  } else {
    try {
      const res = conv.metricizeRecipeXml(xml, { DOMParser: QuietDOMParser, XMLSerializer, precisionScale: opts.precisionScale })
      xml = res.xml
      let written = null
      const target = opts.out || (opts.file !== '-' ? opts.file : null)
      if (target) {
        writeFileSync(target, xml)
        written = target
      }
      output.conversion = { changes: res.changes || [], warnings: res.warnings || [], written }
      if (!written) output.conversion.xml = xml
    } catch (e) {
      output.conversion = { error: `Unit conversion failed: ${e.message}`, changes: [], warnings: [], written: null }
    }
  }
}

const check = checkRecipeXml(xml, { precisionScale: opts.precisionScale, id: opts.id, planCheck: opts.plan })
const result = opts.convert ? { ...output, check } : check
process.stdout.write(`${JSON.stringify(result, null, opts.compact ? 0 : 2)}\n`)
process.exitCode = check.ok ? 0 : 1
