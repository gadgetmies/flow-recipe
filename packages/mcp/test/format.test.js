import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount, trimDeep, isValidRecipeId, isServerRecipeId, sniffRecipeAttributes, formatDuration, kebab } from '../src/format.js'

test('parseAmount reads recipe amounts', () => {
  assert.equal(parseAmount(2), 2)
  assert.equal(parseAmount('1.5'), 1.5)
  assert.equal(parseAmount('1,5'), 1.5)
  assert.equal(parseAmount('1 1/2'), 1.5)
  assert.equal(parseAmount('1½'), 1.5)
  assert.equal(parseAmount('¾'), 0.75)
  assert.equal(parseAmount('2-3'), 2.5)
  assert.equal(parseAmount('lots'), null)
  assert.equal(parseAmount(''), null)
})

test('trimDeep caps strings and arrays but keeps listed keys', () => {
  const out = trimDeep({ text: 'x'.repeat(50), xml: 'y'.repeat(50), list: [1, 2, 3, 4] }, { maxString: 10, maxArray: 2, keep: ['xml'] })
  assert.match(out.text, /^x{10}… \[40 more characters\]$/)
  assert.equal(out.xml.length, 50)
  assert.deepEqual(out.list, [1, 2, '… 2 more items'])
})

test('ids, attributes, durations', () => {
  assert.ok(isValidRecipeId('chocolate-chip-cookies'))
  assert.ok(!isValidRecipeId('../etc/passwd'))
  assert.ok(!isValidRecipeId('Buns'))
  assert.ok(isServerRecipeId('My_Recipe-2') && isServerRecipeId('a'.repeat(100)))
  assert.ok(!isServerRecipeId('../etc/passwd') && !isServerRecipeId('a'.repeat(101)) && !isServerRecipeId('-x'))
  assert.deepEqual(sniffRecipeAttributes('<recipe version="2" id=\'buns\'>\n<title>Buns</title>'), { version: '2', id: 'buns', title: 'Buns' })
  assert.equal(formatDuration(5400), '1 h 30 min')
  assert.equal(formatDuration(600), '10 min')
  assert.equal(kebab('Crème Brûlée & Friends!'), 'creme-brulee-and-friends')
})
