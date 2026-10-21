// Server URL resolution, unchanged from v1.
export const SERVER_URL =
  process.env.REACT_APP_SERVER_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001')

export const HOST_ID = '0'

/** Query params of the current page (works with BrowserRouter and MemoryRouter alike). */
export function getQueryParams() {
  const params = new URLSearchParams(window.location.search)
  return {
    session: params.get('session'),
    recipe: params.get('recipe'),
    mock: params.get('mock'),
  }
}

export function isMockMode() {
  const m = getQueryParams().mock
  if (m === null) return process.env.REACT_APP_PAGES === 'true' && !process.env.REACT_APP_SERVER_URL
  return m !== '0' && m !== 'false'
}
