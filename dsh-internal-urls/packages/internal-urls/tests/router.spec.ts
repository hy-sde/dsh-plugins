/**
 * The resolver registry: registration, routing gates, and unknown-scheme errors.
 */

import { describe, expect, it } from 'vitest'
import { InternalUrlRouter } from '../src/router.ts'
import type { InternalResource, ProtocolHandler, ParsedInternalUrl, ResolveContext } from '../src/types.ts'

const always = <T>(value: T) => () => Promise.resolve(value)

function handler(scheme: string, content: string, opts?: { writable?: boolean }): ProtocolHandler {
  return {
    scheme,
    immutable: !opts?.writable,
    // omp-style handler factory; conditional fields keep exactOptionalPropertyTypes happy.
    ...opts?.writable ? { write: async (_url: ParsedInternalUrl, _content: string): Promise<void> => undefined } : {},
    resolve: (_url: ParsedInternalUrl, _ctx?: ResolveContext): Promise<InternalResource> =>
      Promise.resolve({ url: `${scheme}://x`, content, contentType: 'text/plain', size: content.length }),
  }
}

describe('InternalUrlRouter', () => {
  it('registers and unregisters handlers; disposer removes only its own', () => {
    const router = new InternalUrlRouter()
    const first = handler('demo', 'one')
    const second = handler('demo', 'two')
    const dispose = router.register(first)
    expect(router.canHandle('demo://x')).toBe(true)
    // Explicit replacement wins; the old disposer must not resurrect it.
    router.register(second)
    dispose()
    expect(router.getHandler('demo')?.resolve === second.resolve).toBe(true)
    router.unregister('demo')
    expect(router.canHandle('demo://x')).toBe(false)
  })

  it('rejects invalid schemes at registration', () => {
    const router = new InternalUrlRouter()
    expect(() => router.register(handler('not a scheme', 'x'))).toThrow(/invalid scheme/)
  })

  it('canHandle routes only registered hierarchical schemes', async () => {
    const router = new InternalUrlRouter()
    router.register(handler('conflict', 'x', { writable: true }))
    expect(router.canHandle('conflict://1/theirs')).toBe(true)
    expect(router.canHandle('/abs/conflict/x')).toBe(false)
    expect(router.canHandle('conflict:x')).toBe(false)
    expect(router.canHandle('nope://1')).toBe(false)
    expect(router.canHandle('issue://8')).toBe(false)
  })

  it('resolves through the registered handler and stamps immutability', async () => {
    const router = new InternalUrlRouter()
    router.register(handler('pr', 'the body', { writable: false }))
    const resolved = await router.resolve('pr://owner/repo/7')
    expect(resolved.content).toBe('the body')
    expect(resolved.immutable).toBe(true)
    expect(resolved.url).toBe('pr://x')
  })

  it('rejects unknown schemes with the supported list', async () => {
    const router = new InternalUrlRouter()
    router.register(handler('conflict', 'x'))
    await expect(router.resolve('folio://9')).rejects.toThrow(/Unknown protocol: folio:\/\//)
    await expect(router.resolve('folio://9')).rejects.toThrow(/conflict:\/\//)
  })

  it('rejects writes to read-only handlers', async () => {
    const router = new InternalUrlRouter()
    router.register(handler('pr', 'body'))
    await expect(router.write('pr://owner/repo/7', 'x')).rejects.toThrow(/read-only/)
  })

  it('dispatches writes to writable handlers', async () => {
    const router = new InternalUrlRouter()
    let written: string | undefined
    router.register({
      scheme: 'conflict',
      immutable: false,
      resolve: always({ url: 'conflict://1', content: 'block', contentType: 'text/plain' }),
      write: async (_url, content) => { written = content },
    })
    await router.write('conflict://1', '@ours')
    expect(written).toBe('@ours')
  })

  it('completes only when the handler implements complete', async () => {
    const router = new InternalUrlRouter()
    router.register({
      scheme: 'local',
      immutable: false,
      resolve: always({ url: 'local://a', content: '', contentType: 'text/plain' }),
      complete: async () => [{ value: 'a' }, { value: 'b' }],
    })
    expect(await router.complete('local', 'b', undefined)).toHaveLength(2)
    router.register(handler('conflict', 'x'))
    expect(await router.complete('conflict', 'q', undefined)).toBeNull()
  })

  it('routes the <path>:conflict:// selector form through the conflict handler', async () => {
    const router = new InternalUrlRouter()
    let seen = ''
    router.register({
      scheme: 'conflict',
      immutable: false,
      resolve: async (url) => {
        seen = url.rawHref
        return { url: url.href, content: 'block', contentType: 'text/plain' }
      },
      write: async () => undefined,
    })
    expect(router.canHandle('/ws/a.ts:conflict://1')).toBe(true)
    const resource = await router.resolve('/ws/a.ts:conflict://1')
    expect(seen).toBe('/ws/a.ts:conflict://1')
    expect(resource.immutable).toBe(false)
    await router.write('/ws/a.ts:conflict://1', '@ours')
    // A non-conflict prefix is not a conflict reference and does not route.
    expect(router.canHandle('a.ts:pr://1')).toBe(false)
    await expect(router.resolve('a.ts:pr://1')).rejects.toThrow(/Not an internal URL/)
  })
})
