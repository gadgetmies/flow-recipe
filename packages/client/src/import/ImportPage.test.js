import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ImportPage from './ImportPage'
import { IMPORT_TIMING, LLM_STORAGE_KEY, setRecipeId, setRecipeTitle } from './importApi'
import { fmtAmount, fromLabel, planRuns, streamLabel } from './format'
import { MOCK_XML } from './mockImport.fixture'
import { stepsFor } from './ImportProgress'

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
  expect(screen.getByText('1 cook')).toBeInTheDocument()
  expect(screen.getByText('3 cooks')).toBeInTheDocument()
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
  expect(start).toHaveAttribute('href', '/?recipe=chewy-chocolate-chip-cookies&mock=1')
  fireEvent.click(screen.getByRole('button', { name: /import another/i }))
  expect(await screen.findByLabelText('Recipe page URL')).toHaveValue('')
})

test('a blocked site suggests pasting the text', async () => {
  renderPage()
  await screen.findByText('Server default')
  fireEvent.change(screen.getByLabelText('Recipe page URL'), { target: { value: 'https://blocked.example.com/x' } })
  fireEvent.click(screen.getByRole('button', { name: /import recipe/i }))
  expect(await screen.findByText('The site did not let us read the page')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /paste the text instead/i }))
  expect(await screen.findByLabelText('Recipe text')).toBeInTheDocument()
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
  const review = await screen.findByText(/From pasted text/, {}, { timeout: 3000 })
  expect(within(review.closest('.MuiCardContent-root')).getByDisplayValue('Chewy Chocolate Chip Cookies')).toBeInTheDocument()
})
