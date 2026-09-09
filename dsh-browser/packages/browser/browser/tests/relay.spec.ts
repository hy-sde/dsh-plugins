/**
 * Relay server unit tests: HTTP discovery surface, `/ext` → `/cdp` readiness
 * transition, and the bridge's version/target emulation — without a real
 * Chrome (the extension leg is exercised over raw websockets).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startRelayServer, type RelayServer } from '../src/relay/server.ts'
import { resolveRelayKind, DEFAULT_RELAY_URL } from '../src/relay/kind.ts'
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
