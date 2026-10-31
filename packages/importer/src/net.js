// The SSRF guard shared by every outbound request the importer (and the server) makes on behalf of a user:
// address classification (IPv4, IPv6 incl. IPv4-mapped/-compatible, NAT64, 6to4, Teredo), URL validation and a
// fetch() replacement built on node:http/https whose DNS lookup is checked at connect time, so the address that
// was validated is the address that is connected to (no DNS-rebinding window between check and connect).

import dns from 'node:dns'
import { lookup as dnsLookupPromise } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'

/** Error with a machine-readable `code` (invalid-url, blocked-address, dns, http-status, not-html, timeout, network, aborted). */
export class SourceError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'SourceError'
    this.code = code
    Object.assign(this, extra)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Address classification

function ipv4Parts(ip) {
  const p = String(ip).split('.')
  if (p.length !== 4) return null
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN))
  return n.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? n : null
}

function isPrivateV4([a, b, c]) {
  if (a === 0 || a === 10 || a === 127) return true // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 169 && b === 254) return true // link local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast, reserved 240/4, broadcast
  return false
}

/** IPv6 text → eight 16-bit groups, or null. Accepts '::' compression and a trailing dotted IPv4 part. */
export function parseIPv6(text) {
  let s = String(text || '').trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (!s || s.length > 64) return null
  const dotted = /(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (dotted) {
    const v4 = ipv4Parts(dotted[2])
    if (!v4) return null
    s = s.slice(0, s.length - dotted[2].length) + `${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = (h) => (h ? h.split(':') : [])
  const head = part(halves[0])
  const tail = halves.length === 2 ? part(halves[1]) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

function v4FromGroups(hi, lo) {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255]
}

/**
 * True for addresses a server must not fetch on a user's behalf: loopback, private, link-local, CGNAT,
 * unspecified, documentation/benchmark/reserved, multicast, unique-local and site-local IPv6, and IPv6 forms that
 * embed such an IPv4 address (IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96, SIIT ::ffff:0:0:0/96, NAT64
 * 64:ff9b::/96, 6to4 2002::/16). Teredo (2001::/32), local NAT64 (64:ff9b:1::/48), discard (100::/64) and
 * documentation (2001:db8::/32) are refused as a whole. Anything that is not an IP address is "private" (fail closed).
 */
export function isPrivateAddress(ip) {
  let addr = String(ip || '').trim().toLowerCase()
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1)
  const zone = addr.indexOf('%')
  if (zone >= 0) addr = addr.slice(0, zone)
  const kind = isIP(addr)
  if (kind === 4) {
    const p = ipv4Parts(addr)
    return p ? isPrivateV4(p) : true
  }
  if (kind !== 6) return true
  const g = parseIPv6(addr)
  if (!g) return true
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0)
  if (zeros(0, 8)) return true // ::
  if (zeros(0, 7) && g[7] === 1) return true // ::1
  if (zeros(0, 5) && g[5] === 0xffff) return isPrivateV4(v4FromGroups(g[6], g[7])) // ::ffff:a.b.c.d
  if (zeros(0, 6)) return isPrivateV4(v4FromGroups(g[6], g[7])) // ::a.b.c.d (deprecated IPv4-compatible)
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return isPrivateV4(v4FromGroups(g[6], g[7])) // SIIT
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPrivateV4(v4FromGroups(g[6], g[7])) // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true // local-use NAT64
  if (g[0] === 0x2002) return isPrivateV4(v4FromGroups(g[1], g[2])) // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true // documentation
  if (g[0] === 0x100 && zeros(1, 4)) return true // discard-only
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((g[0] & 0xffc0) === 0xfec0) return true // fec0::/10 site local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true // multicast
  return false
}

export function allowPrivateFromEnv(name = 'FLOW_IMPORT_ALLOW_PRIVATE') {
  return typeof process !== 'undefined' && !!process.env && process.env[name] === '1'
}

/**
 * Validate a URL for fetching: http/https only, no credentials, and (unless allowed) the host must not be or
 * resolve to a private or loopback address. Returns the parsed URL.
 * @param {string} url
 * @param {{ lookup?: Function, allowPrivate?: boolean, resolve?: boolean }} [options] lookup(host, { all: true }) →
 *   [{ address }]; resolve: false checks literal IP hosts only (the pinned fetch checks names at connect time)
 */
export async function assertPublicUrl(url, { lookup = dnsLookupPromise, allowPrivate = allowPrivateFromEnv(), resolve = true } = {}) {
  let parsed
  try {
    parsed = new URL(String(url || '').trim())
  } catch {
    throw new SourceError('invalid-url', `Not a valid URL: ${String(url || '').slice(0, 200)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SourceError('invalid-url', `Only http and https URLs can be imported (got ${parsed.protocol.replace(/:$/, '')})`)
  }
  if (parsed.username || parsed.password) throw new SourceError('invalid-url', 'URLs with credentials are not allowed')
  if (allowPrivate) return parsed
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new SourceError('invalid-url', 'URL has no host')
  let addresses
  if (isIP(host)) addresses = [host]
  else if (!resolve) return parsed
  else {
    try {
      const res = await lookup(host, { all: true, verbatim: true })
      addresses = (Array.isArray(res) ? res : [res]).map((r) => (typeof r === 'string' ? r : r.address))
    } catch (e) {
      throw new SourceError('dns', `Cannot resolve host ${host}: ${e.code || e.message}`)
    }
  }
  if (!addresses.length) throw new SourceError('dns', `Cannot resolve host ${host}`)
  const blocked = addresses.find(isPrivateAddress)
  if (blocked) {
    throw new SourceError('blocked-address', `Refusing to fetch ${host}: it resolves to a private or loopback address (${blocked})`)
  }
  return parsed
}

// ---------------------------------------------------------------------------------------------------------------
// Pinned fetch

/**
 * A dns.lookup-compatible function that refuses private results. Passed to http.request as `lookup`, it runs at
 * connect time, so the validated address is the one the socket connects to.
 */
export function guardedLookup({ allowPrivate = false, lookup = dns.lookup } = {}) {
  return function pinnedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) }
    lookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err)
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: isIP(addresses) }]).filter((a) => a && a.address)
      if (!list.length) return callback(Object.assign(new Error(`Cannot resolve host ${hostname}`), { code: 'ENOTFOUND' }))
      if (!allowPrivate) {
        const bad = list.find((a) => isPrivateAddress(a.address))
        if (bad) {
          return callback(new SourceError('blocked-address', `Refusing to connect to ${hostname}: it resolves to a private or loopback address (${bad.address})`))
        }
      }
      if (opts.all) return callback(null, list.map((a) => ({ address: a.address, family: a.family || isIP(a.address) })))
      return callback(null, list[0].address, list[0].family || isIP(list[0].address))
    })
  }
}

function headerEntries(headers) {
  if (!headers) return []
  if (typeof headers.entries === 'function' && !Array.isArray(headers)) return [...headers.entries()]
  if (Array.isArray(headers)) return headers
  return Object.entries(headers)
}

const NULL_BODY = new Set([101, 103, 204, 205, 304])

/**
 * A fetch()-compatible function (method, headers, string/Buffer body, signal) over node:http/https that:
 * - refuses non-http(s) URLs, URLs with credentials and (unless `allowPrivate`) private or loopback hosts, checked
 *   on the literal host and again on every DNS answer at connect time (DNS-rebinding safe);
 * - never follows redirects (the 3xx response is returned, like `redirect: 'manual'`; callers that follow
 *   redirects call it again per hop, which re-runs the guard);
 * - decompresses gzip / deflate / br bodies.
 * @param {{ allowPrivate?: boolean, lookup?: Function }} [options] lookup = callback-style dns.lookup (tests)
 */
export function createGuardedFetch({ allowPrivate = allowPrivateFromEnv(), lookup } = {}) {
  const pinned = guardedLookup({ allowPrivate, ...(lookup ? { lookup } : {}) })
  return async function guardedFetch(input, init = {}) {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url
    // Literal IPs are checked here; host names are checked at connect time by the pinned lookup.
    const url = await assertPublicUrl(href, { allowPrivate, resolve: false })
    const signal = init.signal
    if (signal && signal.aborted) throw signal.reason || Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    const method = String(init.method || 'GET').toUpperCase()
    const headers = {}
    for (const [k, v] of headerEntries(init.headers)) headers[String(k).toLowerCase()] = String(v)
    if (!headers['accept-encoding']) headers['accept-encoding'] = 'gzip, deflate, br'
    const body = init.body === undefined || init.body === null ? null : typeof init.body === 'string' || Buffer.isBuffer(init.body) || init.body instanceof Uint8Array ? init.body : String(init.body)
    if (body !== null && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const mod = url.protocol === 'https:' ? https : http
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (e) => {
        if (settled) return
        settled = true
        reject(e)
      }
      let req
      try {
        // A private keep-alive agent per request: `agent: false` would send "Connection: close", which no browser
        // does (bot filters notice); the agent and its socket are destroyed once the response is over.
        const agent = new mod.Agent({ keepAlive: true, maxSockets: 1 })
        const dispose = () => agent.destroy()
        req = mod.request(url, { method, headers, lookup: pinned, agent, ...(signal ? { signal } : {}) }, (res) => {
          res.on('close', dispose)
          res.on('error', dispose)
          let stream = res
          const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase()
          const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null
          if (decoder) {
            res.on('error', (e) => decoder.destroy(e))
            stream = res.pipe(decoder)
          }
          const out = new Headers()
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
            const name = res.rawHeaders[i].toLowerCase()
            if (decoder && (name === 'content-encoding' || name === 'content-length')) continue
            try {
              out.append(name, res.rawHeaders[i + 1])
            } catch {
              // skip header values a Headers object rejects
            }
          }
          const status = res.statusCode
          const nullBody = NULL_BODY.has(status) || method === 'HEAD'
          if (nullBody) res.resume()
          try {
            const response = new Response(nullBody ? null : Readable.toWeb(stream), { status, statusText: res.statusMessage || '', headers: out })
            settled = true
            resolve(response)
          } catch (e) {
            res.destroy()
            fail(new Error(`Invalid HTTP response (status ${status}): ${e.message}`))
          }
        })
      } catch (e) {
        fail(e)
        return
      }
      req.on('error', (e) => {
        if (req.agent && typeof req.agent.destroy === 'function') req.agent.destroy()
        fail(e)
      })
      if (body !== null) req.end(body)
      else req.end()
    })
  }
}
