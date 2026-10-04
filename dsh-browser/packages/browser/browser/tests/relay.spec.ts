/**
 * Relay server unit tests: HTTP discovery surface, `/ext` → `/cdp` readiness
 * transition, and the bridge's version/target emulation — without a real
 * Chrome (the extension leg is exercised over raw websockets).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { startRelayServer, type RelayServer } from '../src/relay/server.ts'
import { resolveRelayKind, DEFAULT_RELAY_URL } from '../src/relay/kind.ts'
import { waitForRelayReady } from '../src/relay/probe.ts'
import { normalizeWaitUntil } from '../src/service.ts'
import { parseAriaRefSelector, isAriaRefSelector, buildAriaSnapshotScript } from '../src/aria.ts'

let server: RelayServer
let baseUrl: string

beforeAll(async () => {
  server = await startRelayServer({ port: 0, log: () => {} })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop()
})

describe('relay HTTP discovery', () => {
  it('answers /json/version with 503 until the extension connects', async () => {
    const res = await fetch(`${baseUrl}/json/version`)
    expect(res.status).toBe(503)
  })

  it('lists attachable targets in /json', async () => {
    const res = await fetch(`${baseUrl}/json`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('serves the extension assets for sideloading', async () => {
    const res = await fetch(`${baseUrl}/ext-assets/manifest.json.txt`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"manifest_version"')
  })

  it('transitions to ready once an extension connects', async () => {
    const connected = new Promise<void>((resolve) => {
      const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ext`)
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', userAgent: 'test', browserVersion: '1', tabs: [], attachedTabIds: [] }))
        // Give the bridge a beat to mark the relay ready, then probe.
        setTimeout(() => {
          void (async () => {
            const res = await fetch(`${baseUrl}/json/version`)
            expect(res.status).toBe(200)
            const json = (await res.json()) as { webSocketDebuggerUrl?: string }
            expect(json.webSocketDebuggerUrl).toContain('/cdp')
            ws.close()
            resolve()
          })()
        }, 150)
      })
    })
    await connected
  })

  it('rejects web-page origins on /cdp', async () => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/cdp`, { headers: { origin: 'http://example.com' } })
    await new Promise<void>((resolve) => {
      ws.on('close', (code) => {
        expect(code).toBe(1008)
        resolve()
      })
      ws.on('error', () => {})
    })
  })
})

describe('relay kind resolution', () => {
  it('defaults to the fixed relay endpoint', () => {
    const kind = resolveRelayKind({ settingEnabled: true })
    expect(kind).toEqual({ kind: 'relay', cdpUrl: DEFAULT_RELAY_URL })
  })

  it('applies the URL override and trims trailing slashes', () => {
    const kind = resolveRelayKind({ settingEnabled: true, url: 'http://127.0.0.1:9224/' })
    expect(kind?.cdpUrl).toBe('http://127.0.0.1:9224')
  })

  it('honors the DSH_BROWSER_RELAY env kill switch', () => {
    expect(resolveRelayKind({ settingEnabled: true }, { DSH_BROWSER_RELAY: '0' })).toBeNull()
    expect(resolveRelayKind({ settingEnabled: false }, { DSH_BROWSER_RELAY: '1' })).not.toBeNull()
  })
})

describe('relay protocol marker + readiness probe', () => {
  /** A one-off relay server on an ephemeral port, stopped after `run`. */
  async function withRelay(run: (baseUrl: string) => Promise<void>): Promise<void> {
    const server = await startRelayServer({ port: 0, log: () => {} })
    try {
      await run(`http://127.0.0.1:${server.port}`)
    } finally {
      server.stop()
    }
  }

  /** An HTTP server that answers every request with `status` and `body`. */
  async function withStaticServer(status: number, body: string, run: (url: string) => Promise<void>): Promise<void> {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(body)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    } finally {
      server.close()
    }
  }

  it('marks the 503 /json/version body with dshRelayProtocol', async () => {
    await withRelay(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/json/version`)
      expect(res.status).toBe(503)
      const json = (await res.json()) as Record<string, unknown>
      expect(json.dshRelayProtocol).toBe('1')
      expect(json.error).toBe('relay extension is not connected')
    })
  })

  it('marks the ready 200 /json/version body with dshRelayProtocol', async () => {
    await withRelay(async (baseUrl) => {
      const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ext`)
      try {
        await new Promise<void>((resolve, reject) => {
          ws.on('open', resolve)
          ws.on('error', reject)
        })
        ws.send(JSON.stringify({ t: 'hello', userAgent: 'test', browserVersion: 'Chrome/1', tabs: [], attachedTabIds: [] }))
        // Poll until the hello marked the relay ready, then check the marker.
        for (let i = 0; ; i++) {
          const res = await fetch(`${baseUrl}/json/version`)
          if (res.status === 200) {
            const json = (await res.json()) as Record<string, unknown>
            expect(json.dshRelayProtocol).toBe('1')
            break
          }
          if (i > 100) throw new Error('relay never became ready')
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      } finally {
        ws.close()
      }
    })
  })

  it('waitForRelayReady resolves once /json/version answers 200', async () => {
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits++
      if (hits < 3) {
        res.writeHead(503).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"Browser":"Chrome/1"}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
      await expect(waitForRelayReady(url, { budgetMs: 2000, pollMs: 5 })).resolves.toBeUndefined()
      expect(hits).toBeGreaterThanOrEqual(3)
    } finally {
      server.close()
    }
  })

  it('expires silently against a closed port (fetch errors stay non-fatal)', async () => {
    const start = Date.now()
    await expect(waitForRelayReady('http://127.0.0.1:1', { budgetMs: 100, pollMs: 10 })).resolves.toBeUndefined()
    expect(Date.now() - start).toBeGreaterThanOrEqual(90)
  })

  it('keeps polling on 503 and non-JSON/scalar 200 bodies until the budget expires', async () => {
    for (const body of ['', 'null', '"scalar"']) {
      await withStaticServer(body === '' ? 503 : 200, body, async (url) => {
        await expect(waitForRelayReady(url, { budgetMs: 60, pollMs: 10 })).resolves.toBeUndefined()
      })
    }
  })

  it('returns immediately on an aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const start = Date.now()
    await expect(waitForRelayReady('http://127.0.0.1:1', { signal: controller.signal, pollMs: 5 })).resolves.toBeUndefined()
    expect(Date.now() - start).toBeLessThan(1000)
  })
})

describe('wait-until mapping', () => {
  it('maps puppeteer-style networkidle to playwright networkidle', () => {
    expect(normalizeWaitUntil('networkidle0')).toBe('networkidle')
    expect(normalizeWaitUntil('networkidle2')).toBe('networkidle')
    expect(normalizeWaitUntil('load')).toBe('load')
    expect(normalizeWaitUntil('bogus')).toBeUndefined()
  })
})

describe('aria ref parsing', () => {
  it('recognizes aria-ref selectors', () => {
    expect(isAriaRefSelector('aria-ref=e5')).toBe(true)
    expect(isAriaRefSelector('aria-ref/e5')).toBe(true)
    expect(isAriaRefSelector('input')).toBe(false)
    expect(isAriaRefSelector(undefined)).toBe(false)
  })

  it('parses refs to the bare eN id', () => {
    expect(parseAriaRefSelector('aria-ref=e5')).toBe('e5')
    expect(parseAriaRefSelector('aria-ref/e12')).toBe('e12')
    expect(parseAriaRefSelector('ariaref/e12')).toBe('e12')
    expect(parseAriaRefSelector('aria-ref=nope')).toBeNull()
  })

  it('builds the CSS ref selector', () => {
    expect(buildAriaSnapshotScript('aria-ref=e5')).toBe('[aria-ref=e5]')
    expect(buildAriaSnapshotScript('none')).toBeUndefined()
  })
})
