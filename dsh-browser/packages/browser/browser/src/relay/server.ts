/**
 * HTTP + WebSocket server for the browser relay (Node port of omp's
 * `server.ts`, which used Bun's server API — MIT, see LICENSE).
 *
 * Impersonates Chrome's CDP discovery endpoint so any CDP client (Playwright
 * `connectOverCDP`) can connect with a plain browser URL:
 * - `GET /json/version` → 200 with `webSocketDebuggerUrl` once the extension
 *   is connected, 503 before that (clients keep polling).
 * - `GET /json` / `/json/list` → attachable page targets (debugging aid).
 * - `WS /cdp` → downstream CDP clients (Playwright/puppeteer).
 * - `WS /ext` → the Chrome MV3 extension (token-gated when configured).
 * - `GET /ext-assets/*` → the unpacked companion extension files, so a user
 *   can sideload `chrome://extensions` → Developer mode → Load unpacked on
 *   `<origin>/ext-assets/{manifest.json,background.js,options.html,options.js}`
 *   (dev convenience; served from the package source tree).
 *
 * Binds loopback only: anything that can reach this port can drive the user's
 * logged-in browser — start it deliberately.
 * @module @hy-sde-org/dsh-browser/relay/server
 */

import * as http from 'node:http'
import { readFile } from 'node:fs/promises'
import { WebSocketServer, WebSocket } from 'ws'
import { RelayBridge, type RelaySocket } from './bridge.ts'

export interface RelayServerOptions {
  port: number
  /** Shared secret the extension must present as `?token=`; unset disables the check. */
  token?: string
  /** Group tabs the agent actively drives under one per-window Chrome tab group (default on). */
  group?: boolean | { title: string; color: string }
  log?: (message: string, data?: Record<string, unknown>) => void
}

/** A running relay server. */
export interface RelayServer {
  bridge: RelayBridge
  port: number
  stop(): void
}

const WS_KEEPALIVE_MS = 30_000
/** Screenshots travel base64-encoded through both websocket legs. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024
/** Default appearance of the browser tab group. */
const DEFAULT_GROUP = { title: 'dsh', color: 'cyan' } as const

interface RelayWSSocket extends WebSocket {
  role?: 'cdp' | 'ext'
  connId?: number
}

class BridgeSocket implements RelaySocket {
  constructor(private readonly ws: RelayWSSocket) {}

  send(text: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text)
  }

  close(): void {
    this.ws.close()
  }
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
}

/** Start the relay server on 127.0.0.1; port 0 picks an ephemeral port. */
export async function startRelayServer(opts: RelayServerOptions): Promise<RelayServer> {
  const log = opts.log ?? (() => {})
  const group = opts.group === false ? null : opts.group === true || opts.group === undefined ? DEFAULT_GROUP : opts.group
  const bridge = new RelayBridge({ log, group })

  const baseUrl = `http://127.0.0.1:${opts.port}`
  const assetsDir = new URL('../assets/', import.meta.url)

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', baseUrl)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (path.startsWith('/ext-assets/')) {
      const fileName = path.slice('/ext-assets/'.length).split('/').pop() ?? ''
      void readFile(new URL(fileName, assetsDir)).then(
        (content) => {
          const index = fileName.lastIndexOf('.')
          const ext = index >= 0 ? fileName.slice(index) : ''
          res.writeHead(200, { 'content-type': ASSET_CONTENT_TYPES[ext] ?? 'application/octet-stream' }).end(content)
        },
        () => res.writeHead(404).end('Not found'),
      )
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed')
      return
    }
    if (path === '/json/version') {
      if (!bridge.ready) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'relay extension is not connected' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(bridge.versionInfo(`ws://127.0.0.1:${opts.port}/cdp`)))
      return
    }
    if (path === '/json' || path === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(bridge.listTargets()))
      return
    }
    res.writeHead(404).end('Not found')
  })

  const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD_BYTES })
  wss.on('connection', (rawSocket, req) => {
    const socket = rawSocket as RelayWSSocket
    const url = new URL(req.url ?? '/', baseUrl)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (path === '/cdp') {
      // Native CDP clients send no Origin; reject web-page origins so a page
      // can't drive the relay through the user's browser.
      const origin = req.headers.origin
      if (origin && origin.startsWith('http')) {
        socket.close(1008, 'Forbidden')
        return
      }
      socket.role = 'cdp'
      socket.connId = bridge.cdpConnected(new BridgeSocket(socket))
      socket.on('message', (data) => {
        const text = decodeMessage(data)
        if (socket.connId !== undefined) bridge.cdpMessage(socket.connId, text)
      })
      socket.on('close', () => {
        if (socket.connId !== undefined) bridge.cdpClosed(socket.connId)
      })
      return
    }
    if (path === '/ext') {
      const origin = req.headers.origin
      if (origin && !origin.startsWith('chrome-extension://')) {
        socket.close(1008, 'Forbidden')
        return
      }
      if (opts.token && url.searchParams.get('token') !== opts.token) {
        socket.close(1008, 'Unauthorized')
        return
      }
      socket.role = 'ext'
      const bridgeSocket = new BridgeSocket(socket)
      bridge.extConnected(bridgeSocket)
      socket.on('message', (data) => {
        bridge.extMessage(bridgeSocket, decodeMessage(data))
      })
      socket.on('close', () =>{  bridge.extClosed(bridgeSocket) })
      return
    }
    socket.close(1008, 'Not found')
  })

  const keepalive = setInterval(() => {
    for (const client of wss.clients) (client as RelayWSSocket).ping()
  }, WS_KEEPALIVE_MS)
  keepalive.unref()

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void =>{  reject(error) }
    server.once('error', onError)
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : opts.port
  log('relay listening', { port: actualPort })

  return {
    bridge,
    port: actualPort,
    stop() {
      clearInterval(keepalive)
      wss.close()
      for (const client of wss.clients) client.terminate()
      server.close()
    },
  }
}

export type { ExtToRelayMessage, RelayRpcRequest, RelayToExtMessage, TabSnapshot } from './protocol.ts'
export { RelayBridge } from './bridge.ts'

/** Decode a raw websocket payload for message dispatch. */
function decodeMessage(data: Buffer | ArrayBuffer | Buffer[] | string): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString()
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  return data.map(part => (Buffer.isBuffer(part) ? part.toString() : String(part))).join('')
}
