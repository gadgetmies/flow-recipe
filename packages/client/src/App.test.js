import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'

beforeEach(() => {
  window.localStorage.clear()
  // mock mode: the fixtures are served, no socket is opened
  window.history.replaceState({}, '', '/?mock=1')
  window.localStorage.setItem('global-settings', JSON.stringify({ defaultName: 'Tester' }))
  window.localStorage.setItem('mock-session', JSON.stringify({ participantId: '0', name: 'Tester', isSpectator: false }))
})

test('renders the app with the Settings tab', async () => {
  render(
    <MemoryRouter initialEntries={['/?mock=1']}>
      <App />
    </MemoryRouter>
  )
  expect(await screen.findByText('Settings')).toBeInTheDocument()
  expect(await screen.findByText(/Buns \+ Rum Negroni/)).toBeInTheDocument()
})

test('renders the task list from the mock plan', async () => {
  window.localStorage.setItem('mock-session', JSON.stringify({ participantId: '0', name: 'Tester', isSpectator: false, tab: 'cooking' }))
  render(
    <MemoryRouter initialEntries={['/?mock=1']}>
      <App />
    </MemoryRouter>
  )
  expect(await screen.findByText('Instructions')).toBeInTheDocument()
  expect((await screen.findAllByText('Roll buns')).length).toBeGreaterThan(0)
})

test('host can start the mock session and complete a task', async () => {
  const { fireEvent } = require('@testing-library/react')
  render(
    <MemoryRouter initialEntries={['/?mock=1']}>
      <App />
    </MemoryRouter>
  )
  fireEvent.click(await screen.findByText('Start session'))
  expect(await screen.findByText('Session started')).toBeInTheDocument()
  fireEvent.click(screen.getByText('Tasks'))
  const start = await screen.findByText('Start')
  fireEvent.click(start)
  expect(await screen.findByText('Pause')).toBeInTheDocument()
  fireEvent.click(screen.getByText('Done, next!'))
  expect((await screen.findAllByText('done')).length).toBeGreaterThan(0)
})
