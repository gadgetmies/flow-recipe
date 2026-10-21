import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ImportPage from './ImportPage'
import { ensureRecipeRef, getRecipeId, getRecipeTitle, IMPORT_TIMING, LLM_STORAGE_KEY, setRecipeId, setRecipeTitle } from './importApi'
import { dedupeDiagnostics, fmtAmount, fmtJobDetail, fromLabel, planRuns, sourceTotalSeconds, streamLabel, suggestedServeInMinutes } from './format'
import { MOCK_XML } from './mockImport.fixture'
import ImportProgress, { stepsFor } from './ImportProgress'

jest.setTimeout(20000)

const saved = { ...IMPORT_TIMING }

beforeEach(() => {
  window.scrollTo = jest.fn()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/import?mock=1')
  // a fast simulated job
  IMPORT_TIMING.pollMs = 20
  IMPORT_TIMING.mockStageMs = 30
})

afterAll(() => Object.assign(IMPORT_TIMING, saved))

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/import?mock=1']}>
      <Routes>
        <Route path="/import" element={<ImportPage />} />
        <Route path="/" element={<div>main app</div>} />
      </Routes>
    </MemoryRouter>
  )
}

test('format helpers', () => {
  expect(fmtAmount({ number: 250, unit: 'g' })).toBe('250 g')
  expect(fromLabel({ from: { number: 2, unit: 'cup' } })).toBe('from 2 cups')
  expect(fromLabel({ from: { number: 2.25, unit: 'cup' } })).toBe('from 2¼ cups')
  expect(streamLabel({ units: 24, unitStream: 'cookie' })).toBe('× 24 cookies')
  expect(streamLabel({ units: 1, unitStream: null })).toBeNull()
  expect(stepsFor('checking', 1, false, false).map((s) => s.key)).toEqual(['fetching', 'generating', 'converting', 'checking'])
  expect(stepsFor('repairing', 2, false, true).map((s) => s.label)).toContain('Fix what the check found')
  expect(stepsFor('fetching', 1, false, true)[0].label).toBe('Read the pasted text')
  expect(planRuns({ makespanSeconds: 60 })).toEqual([{ participants: 1, makespanSeconds: 60 }])
  const xml = setRecipeId(setRecipeTitle(MOCK_XML, 'Cookies & cream'), 'cookies-2')
  expect(xml).toContain('<title>Cookies &amp; cream</title>')
  expect(xml).toMatch(/<recipe version="2" id="cookies-2"/)
  expect(getRecipeTitle(xml)).toBe('Cookies & cream')
  expect(getRecipeId(xml)).toBe('cookies-2')
  expect(getRecipeTitle(setRecipeTitle(xml, ''))).toBe('')
  expect(ensureRecipeRef('<recipe version="2" id="x">', 'https://a.example/r?a=1&b=2')).toBe('<recipe version="2" id="x" ref="https://a.example/r?a=1&amp;b=2">')
  expect(ensureRecipeRef(MOCK_XML, 'https://other.example/')).toBe(MOCK_XML)
  expect(fmtAmount({ number: 2, unit: 'pieces' })).toBe('× 2')
  expect(sourceTotalSeconds({ times: { total: 5400 } })).toBe(5400)
  expect(sourceTotalSeconds({ times: { prep: 600, cook: 1200 } })).toBe(1800)
  expect(sourceTotalSeconds({ url: null })).toBeNull()
  expect(suggestedServeInMinutes({ runs: [{ participants: 1, makespanSeconds: 3960 }, { participants: 3, makespanSeconds: 2640 }] })).toBe(80)
  expect(
    dedupeDiagnostics([
      "1 cook: [TOOL_NOT_IN_INVENTORY] Tool type 'cutting-board' is not in the inventory.",
      "1 cook: [TOOL_NOT_IN_INVENTORY] Tool type 'cutting-board' is not in the inventory",
      "3 cooks: [TOOL_NOT_IN_INVENTORY] Tool type 'cutting-board' is not in the inventory.",
      { message: 'The oven is the bottleneck' },
    ])
  ).toEqual(["Tool type 'cutting-board' is not in the inventory.", 'The oven is the bottleneck.'])
})

test('job details of any shape render as text (the server passes the importer objects through)', () => {
  // the shapes of packages/importer/src/import.js onProgress and packages/server/src/services/importJobs.js
  expect(fmtJobDetail('https://www.example.com/recipes/x')).toBe('Reading example.com')
  expect(fmtJobDetail({ url: 'https://example.com/x' })).toBe('Reading example.com')
  expect(fmtJobDetail({ text: true })).toBeNull()
  expect(fmtJobDetail({ attempt: 1 })).toBeNull()
  expect(fmtJobDetail({ attempt: 2 })).toBe('Attempt 2')
  expect(fmtJobDetail({ attempts: 2, ok: true })).toBeNull()
  expect(fmtJobDetail({ nested: { deep: 1 } })).toBeNull()
  expect(fmtJobDetail(['a'])).toBeNull()
  expect(fmtJobDetail(null)).toBeNull()
  expect(fmtJobDetail('Planning with 1 and 3 cooks')).toBe('Planning with 1 and 3 cooks')

  const details = [
    ['queued', null],
    ['fetching', 'https://example.com/x'],
    ['fetching', { url: 'https://example.com/x' }],
    ['fetching', { text: true }],
    ['generating', { attempt: 1 }],
    ['converting', { attempt: 1 }],
    ['checking', { attempt: 1 }],
    ['repairing', { attempt: 2 }],
    ['checking', { attempt: 2 }],
    ['done', { attempts: 2, ok: true }],
    ['checking', { unexpected: { shape: [1, 2] } }],
  ]
  for (const [stage, detail] of details) {
    const { unmount } = render(
      <ImportProgress job={{ status: 'running', stage, detail, attempts: detail?.attempt || 1 }} sourceLabel="x" startedAt={Date.now()} onCancel={() => {}} />
    )
    expect(screen.getByText('Importing…')).toBeInTheDocument()
    expect(screen.queryAllByText('Attempt 2')).toHaveLength(stage === 'checking' && detail?.attempt === 2 ? 1 : 0)
    unmount()
  }
})

test('imports a recipe in mock mode: source → progress → review → save', async () => {
  renderPage()
  // the server default model is offered
  expect(await screen.findByText('Server default')).toBeInTheDocument()

  // an invalid URL is explained
  fireEvent.change(screen.getByLabelText('Recipe page URL'), { target: { value: 'not a link' } })
  fireEvent.click(screen.getByRole('button', { name: /import recipe/i }))
  expect((await screen.findAllByText(/does not look like a web address/)).length).toBeGreaterThan(0)

  fireEvent.change(screen.getByLabelText('Recipe page URL'), { target: { value: 'https://example.com/cookies' } })
  fireEvent.click(screen.getByRole('button', { name: /import recipe/i }))

  // progress
  expect(await screen.findByText('Importing…')).toBeInTheDocument()
  expect(screen.getByText('Read the recipe page')).toBeInTheDocument()

  // review
  expect(await screen.findByDisplayValue('Chewy Chocolate Chip Cookies', {}, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.getByDisplayValue('chewy-chocolate-chip-cookies')).toBeInTheDocument()
  expect(screen.getByText(/Ready to save/)).toBeInTheDocument()
  expect(screen.getByText('285 g')).toBeInTheDocument()
  expect(screen.getByText('from 2¼ cups')).toBeInTheDocument()
  expect(screen.getAllByText('× 24 cookies').length).toBeGreaterThan(0)
  expect(screen.getByText('Schedule check')).toBeInTheDocument()
  expect(screen.getByText('with 1 cook')).toBeInTheDocument()
  expect(screen.getByText('with 3 cooks')).toBeInTheDocument()
  expect(screen.getByText('about 1 h 6 min')).toBeInTheDocument()
  expect(screen.getByText('about 44 min')).toBeInTheDocument()
  expect(screen.getByText('the recipe page says')).toBeInTheDocument()
  expect(screen.getByText('1 h 15 min')).toBeInTheDocument()
  // measuring steps are folded into the ingredients
  expect(screen.getByText(/measuring steps?, shown with the ingredients/)).toBeInTheDocument()
  expect(screen.getByText('1 pipeline found')).toBeInTheDocument()
  expect(screen.getByText(/Scoop into 40 g balls → Place on the sheets/)).toBeInTheDocument()

  // editing the XML requires a re-check before saving
  fireEvent.click(screen.getByText('Recipe XML'))
  const editor = screen.getByLabelText('recipe XML')
  fireEvent.change(editor, { target: { value: editor.value.replace('</recipe>', '') } })
  expect(screen.getByRole('button', { name: /save recipe/i })).toBeDisabled()
  expect(screen.getByText(/re-check it before saving/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /re-check/i }))
  expect(await screen.findByText(/1 problem to fix before saving/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /save recipe/i })).toBeDisabled()
  fireEvent.change(editor, { target: { value: MOCK_XML } })
  fireEvent.click(screen.getByRole('button', { name: /re-check/i }))
  await waitFor(() => expect(screen.getByRole('button', { name: /save recipe/i })).toBeEnabled())

  // save
  fireEvent.click(screen.getByRole('button', { name: /save recipe/i }))
  expect(await screen.findByText(/Saved “Chewy Chocolate Chip Cookies”/)).toBeInTheDocument()
  const start = screen.getByRole('link', { name: /start a session with this recipe/i })
  expect(start).toHaveAttribute('href', '/?recipe=chewy-chocolate-chip-cookies&serveIn=80&mock=1')
  fireEvent.click(screen.getByRole('button', { name: /import another/i }))
  expect(await screen.findByLabelText('Recipe page URL')).toHaveValue('')
})

test('a blocked site makes pasting the text the next step and keeps the link as the source', async () => {
  renderPage()
  await screen.findByText('Server default')
  fireEvent.change(screen.getByLabelText('Recipe page URL'), { target: { value: 'https://www.blocked.example.com/x' } })
  fireEvent.click(screen.getByRole('button', { name: /import recipe/i }))
  expect(await screen.findByText('blocked.example.com did not let us read the page')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /open the recipe page/i })).toHaveAttribute('href', 'https://www.blocked.example.com/x')
  // the importer's own advice is not repeated in the details
  expect(screen.getByText(/Details: The page returned HTTP 403 Forbidden$/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /paste the recipe text/i }))
  expect(await screen.findByLabelText('Recipe text')).toBeInTheDocument()
  expect(screen.getByText(/The link is kept/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Recipe text'), { target: { value: 'Cookies\n\n2 cups flour\n1 cup butter\n\nMix everything and bake at 350 F.' } })
  fireEvent.click(screen.getByRole('button', { name: /import recipe/i }))
  expect(await screen.findByText(/From pasted text, copied from/, {}, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'blocked.example.com' })).toHaveAttribute('href', 'https://www.blocked.example.com/x')
  fireEvent.click(screen.getByText('Recipe XML'))
  expect(screen.getByLabelText('recipe XML').value).toContain('ref="https://www.blocked.example.com/x"')
})

test('the title field and the XML <title> stay one value', async () => {
  renderPage()
  await screen.findByText('Server default')
  fireEvent.change(screen.getByLabelText('Recipe page URL'), { target: { value: 'https://example.com/cookies' } })
  fireEvent.click(screen.getByRole('button', { name: /import recipe/i }))
  const titleField = await screen.findByDisplayValue('Chewy Chocolate Chip Cookies', {}, { timeout: 3000 })
  fireEvent.click(screen.getByText('Recipe XML'))
  const editor = screen.getByLabelText('recipe XML')

  // the field writes into the XML, without needing a re-check
  fireEvent.change(titleField, { target: { value: 'Cookies & more' } })
  expect(editor.value).toContain('<title>Cookies &amp; more</title>')
  expect(screen.getByRole('button', { name: /save recipe/i })).toBeEnabled()

  // an XML edit shows in the field and is what gets saved
  fireEvent.change(editor, { target: { value: editor.value.replace(/<title>[^<]*<\/title>/, '<title>Edited in XML</title>') } })
  expect(screen.getByLabelText('Title')).toHaveValue('Edited in XML')
  fireEvent.click(screen.getByRole('button', { name: /re-check/i }))
  await waitFor(() => expect(screen.getByRole('button', { name: /save recipe/i })).toBeEnabled())
  // the id field writes the root id too (the earlier test saved the suggested id already)
  fireEvent.change(screen.getByLabelText('Recipe id'), { target: { value: 'edited-cookies' } })
  expect(editor.value).toMatch(/<recipe version="2" id="edited-cookies"/)
  fireEvent.click(screen.getByRole('button', { name: /save recipe/i }))
  expect(await screen.findByText(/Saved “Edited in XML”/)).toBeInTheDocument()
})

test('imported recipes are told apart and can be deleted after confirming', async () => {
  renderPage()
  fireEvent.click(await screen.findByText('My imported recipes'))
  expect(screen.getByText('recipetineats.com · id beef-stew')).toBeInTheDocument()
  expect(screen.getByText('bbcgoodfood.com · id beef-stew-2')).toBeInTheDocument()
  expect(screen.getAllByText('same title')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'delete Beef stew (beef-stew-2)' }))
  expect(await screen.findByText('Delete “Beef stew”?')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
  await waitFor(() => expect(screen.queryByText('Delete “Beef stew”?')).not.toBeInTheDocument())
  fireEvent.click(await screen.findByRole('button', { name: 'delete Beef stew (beef-stew-2)' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(screen.queryByText('bbcgoodfood.com · id beef-stew-2')).not.toBeInTheDocument())
  expect(screen.queryByText('same title')).not.toBeInTheDocument()
})

test('without a server LLM the two options are explained and the own key is masked and remembered', async () => {
  window.history.replaceState({}, '', '/import?mock=1&nollm=1')
  renderPage()
  expect(await screen.findByText('No AI model is set up on this server yet.')).toBeInTheDocument()
  expect(screen.getByText(/Server default:/)).toBeInTheDocument()
  expect(screen.getByText(/Your own key:/)).toBeInTheDocument()
  expect(screen.getByText(/sent only to this app's server/)).toBeInTheDocument()
  const key = screen.getByLabelText('API key')
  expect(key).toHaveAttribute('type', 'password')
  fireEvent.click(screen.getByLabelText('show API key'))
  expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'text')
  // nothing can be imported until a key is entered
  expect(screen.getByRole('button', { name: /import recipe/i })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-test' } })
  fireEvent.click(screen.getByLabelText('Remember on this device'))
  await waitFor(() => expect(JSON.parse(window.localStorage.getItem(LLM_STORAGE_KEY))).toMatchObject({ provider: 'anthropic', apiKey: 'sk-ant-test' }))
  fireEvent.click(screen.getByLabelText('Remember on this device'))
  await waitFor(() => expect(window.localStorage.getItem(LLM_STORAGE_KEY)).toBeNull())

  fireEvent.click(screen.getByRole('button', { name: /paste text/i }))
  fireEvent.change(screen.getByLabelText('Recipe text'), { target: { value: 'Cookies\n\n2 cups flour\n1 cup butter\n\nMix everything and bake at 350 F.' } })
  fireEvent.click(screen.getByRole('button', { name: /import recipe/i }))
  expect(await screen.findByText('Read the pasted text')).toBeInTheDocument()
  expect(await screen.findByText(/From pasted text/, {}, { timeout: 3000 })).toBeInTheDocument()
  expect(screen.getByLabelText('Title')).toHaveValue('Chewy Chocolate Chip Cookies')
})
