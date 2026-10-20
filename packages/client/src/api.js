// REST helpers (server API.md). In mock mode they resolve to the fixtures so no server is needed.
import { SERVER_URL } from './config'
import { RECIPES_FIXTURE, DEFAULT_INVENTORY, makeSessionFixture } from './mocks/session.fixture'
import { makePlanFixture } from './mocks/plan.fixture'

async function getJson(path) {
  const response = await fetch(`${SERVER_URL}${path}`)
  if (!response.ok) throw new Error(`${path}: ${response.status} ${response.statusText}`)
  return response.json()
}

export async function getRecipes(mock = false) {
  if (mock) return RECIPES_FIXTURE
  return getJson('/api/recipes')
}

export async function getDefaultInventory(mock = false) {
  if (mock) return JSON.parse(JSON.stringify(DEFAULT_INVENTORY))
  return getJson('/api/inventory/default')
}

export async function getSession(sessionId, mock = false) {
  if (mock) return { session: makeSessionFixture(), plan: makePlanFixture() }
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}`)
}
