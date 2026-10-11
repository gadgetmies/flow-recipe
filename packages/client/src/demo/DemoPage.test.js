import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import DemoPage, { recipesFromHash } from './DemoPage'

beforeEach(() => {
  // mock mode: the bundled recipes are used, nothing is fetched
  window.history.replaceState({}, '', '/demo?mock=1')
})

test('recipesFromHash accepts bare tokens only', () => {
  expect(recipesFromHash('#buns,tiramisu')).toEqual(['buns', 'tiramisu'])
  expect(recipesFromHash('#tomato-soup')).toEqual(['tomato-soup'])
  expect(recipesFromHash('')).toBeNull()
  expect(recipesFromHash('#<script>')).toBeNull()
  expect(recipesFromHash('#a b')).toBeNull()
})

test('plans the preselected recipes in the browser and steps the simulation', async () => {
  render(
    <MemoryRouter initialEntries={['/demo#buns,tiramisu']}>
      <DemoPage />
    </MemoryRouter>
  )
  expect(await screen.findByText('bundled recipes')).toBeInTheDocument()
  // deep link preselects buns + tiramisu: their serve time inputs are shown
  expect(screen.getByLabelText('Serve Buns')).toHaveValue('18:00')
  expect(screen.getByLabelText(/Serve Simplified Tiramisu/)).toHaveValue('18:10')
  expect(screen.queryByLabelText('Serve Rum Negroni')).not.toBeInTheDocument()

  fireEvent.click(screen.getByText('Plan'))

  // the draft plan: dish rows with lateness chips, fairness, lanes
  expect(await screen.findByText('Draft plan')).toBeInTheDocument()
  expect(screen.getByText('Dishes')).toBeInTheDocument()
  expect(screen.getByText('Fairness')).toBeInTheDocument()
  expect(screen.getByText('Lanes')).toBeInTheDocument()
  expect(screen.getAllByText(/on time|early|late/).length).toBeGreaterThan(0)
  // the live view with one card per participant (names appear on the lane labels too)
  expect(screen.getByText('Live')).toBeInTheDocument()
  expect(screen.getAllByText('Ada').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Bea').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Cal').length).toBeGreaterThan(0)
  expect(screen.getByText('Press Play or Step.')).toBeInTheDocument()

  const step = screen.getByText('Step')
  for (let i = 0; i < 4; i++) fireEvent.click(step)

  const log = screen.getByTestId('demo-log')
  const lines = within(log).getAllByText(/starts:|dawdles before:|done:|replan:|INTERRUPT|handles appointment:/)
  expect(lines.length).toBeGreaterThan(0)
  expect(screen.queryByText('Press Play or Step.')).not.toBeInTheDocument()
  // the metrics strip
  expect(screen.getByText('replans')).toBeInTheDocument()
  expect(screen.getByText('Dish status')).toBeInTheDocument()
})
