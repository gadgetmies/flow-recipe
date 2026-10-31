import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export function fixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

/** Start a local HTTP server on 127.0.0.1 with a request handler; resolves { url, close, requests }. */
export async function startServer(handler) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body }
      requests.push(entry)
      Promise.resolve(handler(req, res, entry)).catch((e) => {
        res.statusCode = 500
        res.end(String(e))
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}
