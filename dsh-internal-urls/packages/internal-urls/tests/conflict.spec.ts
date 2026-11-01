/**
 * Conflict detection/resolution: scanning, history id reuse, splice, tokens,
 * and the `conflict://` handler against a fake file bridge.
 */

import { describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { parseInternalUrl } from '../src/parse.ts'
import { InternalUrlRouter } from '../src/router.ts'
import {
  ConflictHistory,
  ConflictProtocolHandler,
  expandContentTokens,
  formatConflictSummary,
  formatConflictWarning,
  parseConflictUri,
  reconcileRegisteredConflicts,
  renderConflictRegion,
  scanConflictsInContent,
  scanConflictLines,
  spliceConflict,
  trimToCodepointBoundary,
} from '../src/conflict.ts'
import type { ConflictBlock, ConflictFileBridge, ConflictEntry } from '../src/conflict.ts'

const TWO_WAY = [
  '<<<<<<< HEAD',
  'const a = 1',
  '=======',
  'const a = 2',
  '>>>>>>> feature/x',
]
const THREE_WAY = [
  '<<<<<<< HEAD',
  'const a = 1',
  '||||||| base',
  'const a = 0',
  '=======',
  'const a = 2',
  '>>>>>>> feature/x',
]

function makeFile(blocks: string[][], context: string[] = ['export {}']): string {
  return [...context, ...blocks.flat(), ...context].join('\n')
}

describe('scanConflictLines', () => {
  it('detects a complete two-way block with line numbers', () => {
    const blocks = scanConflictLines(TWO_WAY, 10)
    expect(blocks).toHaveLength(1)
    const block = blocks[0]!
    expect(block.startLine).toBe(10)
    expect(block.separatorLine).toBe(12)
    expect(block.endLine).toBe(14)
    expect(block.oursLines).toEqual(['const a = 1'])
    expect(block.theirsLines).toEqual(['const a = 2'])
    expect(block.baseLines).toBeUndefined()
    expect(block.oursLabel).toBe('HEAD')
    expect(block.theirsLabel).toBe('feature/x')
  })

  it('detects a diff3 block with base', () => {
    const [block] = scanConflictsInContent(THREE_WAY.join('\n'))
    expect(block?.baseLines).toEqual(['const a = 0'])
    expect(block?.baseLine).toBe(3)
  })

  it('ignores lines that merely start with a marker prefix', () => {
    expect(scanConflictsInContent('<< x\n=======\n>> y')).toHaveLength(0)
    expect(scanConflictsInContent('const s = "<<<<<<<"')).toHaveLength(0)
  })

  it('drops unclosed blocks', () => {
    expect(scanConflictsInContent('<<<<<<< HEAD\nx\n=======\ny')).toHaveLength(0)
  })

  it('handles CRLF line endings', () => {
    const [block] = scanConflictsInContent(TWO_WAY.map(l => `${l}\r`).join('\n'))
    expect(block?.oursLines).toEqual(['const a = 1'])
  })
})

describe('ConflictHistory', () => {
  it('reuses ids for identical content at the same position and assigns sequential ids otherwise', () => {
    const history = new ConflictHistory()
    const abs = '/ws/a.ts'
    const e1 = history.register({ startLine: 1, separatorLine: 3, endLine: 5, oursLines: ['x'], theirsLines: [], absolutePath: abs, displayPath: 'a.ts' })
    const e1again = history.register({ startLine: 1, separatorLine: 3, endLine: 5, oursLines: ['x'], theirsLines: [], absolutePath: abs, displayPath: 'renamed.ts' })
    // The same block re-surfaced: the id is reused and the display path refreshes.
    expect(e1again.id).toBe(e1.id)
    expect(history.get(e1.id)?.displayPath).toBe('renamed.ts')
    // A different block at the same position gets its own id; the old one retires.
    const e1changed = history.register({ startLine: 1, separatorLine: 3, endLine: 5, oursLines: ['y'], theirsLines: [], absolutePath: abs, displayPath: 'renamed.ts' })
    expect(e1changed.id).not.toBe(e1.id)
    expect(history.get(e1.id)).toBeUndefined()
    const e2 = history.register({ startLine: 9, separatorLine: 11, endLine: 13, oursLines: ['x'], theirsLines: [], absolutePath: abs, displayPath: 'renamed.ts' })
    expect(e2.id).toBe(e1changed.id + 1)
    history.invalidate(e1changed.id)
    expect(history.get(e1changed.id)).toBeUndefined()
    expect(history.get(e2.id)).toBeDefined()
  })
})

describe('ConflictHistory.reconcilePath', () => {
  function makeBlock(startLine: number, overrides: Partial<ConflictBlock> = {}): ConflictBlock {
    const block = scanConflictsInContent(TWO_WAY.join('\n'))[0]!
    return { ...block, ...overrides, startLine, separatorLine: startLine + 2, endLine: startLine + 4 }
  }

  it('keeps ids for unchanged blocks, refreshing shifted coordinates', () => {
    const history = new ConflictHistory()
    const abs = '/ws/a.ts'
    const entry = history.register({ ...makeBlock(3), absolutePath: abs, displayPath: 'a.ts' })
    history.reconcilePath(abs, { blocks: [makeBlock(5)] })
    const refreshed = history.get(entry.id)
    expect(refreshed?.startLine).toBe(5)
    expect(refreshed?.endLine).toBe(9)
  })

  it('retires changed and vanished blocks', () => {
    const history = new ConflictHistory()
    const abs = '/ws/a.ts'
    const kept = history.register({ ...makeBlock(3), absolutePath: abs, displayPath: 'a.ts' })
    const changed = history.register({ ...makeBlock(10), oursLines: ['rewritten'], absolutePath: abs, displayPath: 'a.ts' })
    history.reconcilePath(abs, { blocks: [makeBlock(3)] })
    expect(history.get(kept.id)).toBeDefined()
    expect(history.get(changed.id)).toBeUndefined()
  })

  it('keeps blocks whose recorded region the read column-cut', () => {
    const history = new ConflictHistory()
    const abs = '/ws/wide.ts'
    // A windowed read registered this block with its wide line cut to the
    // column cap plus the read pipeline's truncation suffix.
    const entry = history.register({
      ...makeBlock(3),
      oursLines: [`${'x'.repeat(240)}... (line truncated to 240 chars)`],
      absolutePath: abs,
      displayPath: 'wide.ts',
    })
    // A live scan can never match a cut region (wide lines are dropped), so
    // without the exemption reconciliation would retire the still-live block.
    history.reconcilePath(abs, { blocks: [] })
    expect(history.get(entry.id)).toBeDefined()
  })

  it('keeps blocks at or past a capped scan boundary', () => {
    const history = new ConflictHistory()
    const abs = '/ws/a.ts'
    const entry = history.register({ ...makeBlock(20), absolutePath: abs, displayPath: 'a.ts' })
    // A capped scan saw none of the block; it cannot disprove it.
    history.reconcilePath(abs, { blocks: [], truncatedAtLine: 10 })
    expect(history.get(entry.id)).toBeDefined()
  })
})

describe('reconcileRegisteredConflicts', () => {
  class FsBridge {
    files = new Map<string, string>()
    async readFile(path: string): Promise<string> {
      const content = this.files.get(path)
      if (content === undefined) throw new FsError(`not found: ${path}`, 'FS_NOT_FOUND')
      return content
    }
    async writeFile(path: string, content: string): Promise<void> {
      this.files.set(path, content)
    }
  }

  function registerScanned(history: ConflictHistory, bridge: FsBridge, path: string): ConflictEntry[] {
    const blocks = scanConflictsInContent(bridge.files.get(path) ?? '')
    return blocks.map(block => history.register({ ...block, absolutePath: path, displayPath: 'a.ts' }))
  }

  it('keeps ids across line shifts and retires changed blocks', async () => {
    const bridge = new FsBridge()
    const path = '/ws/a.ts'
    bridge.files.set(path, makeFile([TWO_WAY, THREE_WAY]))
    const history = new ConflictHistory()
    const entries = registerScanned(history, bridge, path)
    // External edit: first block resolved, second shifted up.
    bridge.files.set(path, makeFile([], ['export {}']).replace('export {}\nexport {}', 'const a = 9\n') + THREE_WAY.join('\n') + '\nexport {}')
    await reconcileRegisteredConflicts(history, bridge)
    expect(history.get(entries[0]!.id)).toBeUndefined()
    const shifted = history.get(entries[1]!.id)
    expect(shifted?.separatorLine).toBe(entries[1]!.separatorLine - 5) // block 1 (5 lines) replaced by 1 line + context rewrite
  })

  it('retires every id of a deleted file', async () => {
    const bridge = new FsBridge()
    const path = '/ws/a.ts'
    bridge.files.set(path, makeFile([TWO_WAY]))
    const history = new ConflictHistory()
    registerScanned(history, bridge, path)
    bridge.files.delete(path)
    await reconcileRegisteredConflicts(history, bridge)
    expect(history.entries()).toHaveLength(0)
  })

  it('reconciles a BOM-prefixed CRLF file', async () => {
    const bridge = new FsBridge()
    const path = '/ws/a.ts'
    bridge.files.set(path, makeFile([TWO_WAY]))
    const history = new ConflictHistory()
    const entries = registerScanned(history, bridge, path)
    bridge.files.set(path, '\uFEFF// header\r\nexport {}\r\n' + TWO_WAY.join('\r\n') + '\r\nexport {}\r\n')
    await reconcileRegisteredConflicts(history, bridge)
    const refreshed = history.get(entries[0]!.id)
    expect(refreshed?.startLine).toBe(3) // BOM stripped, header line above
  })
})

describe('reconcileRegisteredConflicts with a capped bridge', () => {
  /** Bridge honoring the optional capped read and counting both paths. */
  class CappedBridge {
    files = new Map<string, string>()
    cappedCalls = 0
    fullCalls = 0
    async readFile(path: string): Promise<string> {
      this.fullCalls += 1
      const content = this.files.get(path)
      if (content === undefined) throw new FsError(`not found: ${path}`, 'FS_NOT_FOUND')
      return content
    }
    async readFileCapped(path: string, maxLength: number): Promise<{ text: string; truncatedAtLine?: number }> {
      this.cappedCalls += 1
      const full = await this.readFile(path)
      this.fullCalls -= 1 // the inner full read is this capped read's fetch
      if (full.length <= maxLength) return { text: full }
      const text = full.slice(0, maxLength)
      return { text, truncatedAtLine: text.split('\n').length }
    }
    async writeFile(path: string, content: string): Promise<void> {
      this.files.set(path, content)
    }
  }

  /** Scan `path`'s current content and register every block under it. */
  function registerBlocks(history: ConflictHistory, files: Map<string, string>, path: string): ConflictEntry[] {
    const blocks = scanConflictsInContent(files.get(path) ?? '')
    return blocks.map(block => history.register({ ...block, absolutePath: path, displayPath: path }))
  }

  it('prefers the capped read and preserves blocks past the cap', async () => {
    const bridge = new CappedBridge()
    const path = '/ws/a.ts'
    // Filler pushes the file past CONFLICT_SCAN_MAX_BYTES (10 MiB): the capped
    // read truncates mid-filler, so the block sits past truncatedAtLine and
    // reconciliation must leave it registered.
    const filler = Array.from({ length: 10_241 }, () => `${'x'.repeat(1023)}\n`).join('')
    bridge.files.set(path, filler + TWO_WAY.join('\n') + '\n')
    const history = new ConflictHistory()
    const entries = registerBlocks(history, bridge.files, path)
    await reconcileRegisteredConflicts(history, bridge)
    expect(bridge.cappedCalls).toBe(1)
    expect(bridge.fullCalls).toBe(0)
    expect(history.get(entries[0]!.id)).not.toBeUndefined()
  })

  it('still reconciles pre-cap blocks through the capped read', async () => {
    const bridge = new CappedBridge()
    const path = '/ws/a.ts'
    bridge.files.set(path, makeFile([TWO_WAY]))
    const history = new ConflictHistory()
    const entries = registerBlocks(history, bridge.files, path)
    bridge.files.set(path, '// header\n' + TWO_WAY.join('\n') + '\n')
    await reconcileRegisteredConflicts(history, bridge)
    const refreshed = history.get(entries[0]!.id)
    expect(refreshed?.startLine).toBe(2)
  })

  it('retires every id when the capped read reports the file missing', async () => {
    const bridge = new CappedBridge()
    const path = '/ws/a.ts'
    bridge.files.set(path, makeFile([TWO_WAY]))
    const history = new ConflictHistory()
    const entries = registerBlocks(history, bridge.files, path)
    bridge.files.delete(path)
    await reconcileRegisteredConflicts(history, bridge)
    expect(history.get(entries[0]!.id)).toBeUndefined()
  })
})

describe('trimToCodepointBoundary', () => {
  const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

  it('drops a bare lead byte cut at the cap', () => {
    // oh-my-pi reviewer proof: the prefix ends right after the lead byte of
    // '中' (E4 B8 AD), with no continuation bytes in the prefix.
    const trimmed = trimToCodepointBoundary(new Uint8Array([0x61, 0x62, 0x63, 0xe4]))
    expect(decode(trimmed)).toBe('abc')
  })

  it('keeps a complete trailing multi-byte character', () => {
    // The sibling proof: back-walking alone over-trimmed this valid tail.
    const bytes = new Uint8Array([0x61, 0x62, 0x63, 0xe4, 0xb8, 0xad])
    expect(decode(trimToCodepointBoundary(bytes))).toBe('abc中')
  })

  it('drops a sequence cut mid-continuation', () => {
    const trimmed = trimToCodepointBoundary(new Uint8Array([0x61, 0x62, 0x63, 0xe4, 0xb8]))
    expect(decode(trimmed)).toBe('abc')
  })

  it('keeps pure ASCII and complete 4-byte tails untouched', () => {
    expect(decode(trimToCodepointBoundary(new Uint8Array([0x61, 0x62, 0x63])))).toBe('abc')
    const emoji = new Uint8Array([0x61, 0xf0, 0x9f, 0x98, 0x80])
    expect(decode(trimToCodepointBoundary(emoji))).toBe('a\u{1F600}')
    expect(trimToCodepointBoundary(new Uint8Array()).length).toBe(0)
  })

  it('leaves invalid lead bytes for the fatal decoder to report', () => {
    // 0xFF is invalid UTF-8 anywhere; trimming it would mask a real error.
    const bytes = new Uint8Array([0x61, 0xff])
    expect(trimToCodepointBoundary(bytes)).toBe(bytes)
  })
})

describe('parseConflictUri', () => {
  it('parses ids, scopes, and wildcard', () => {
    expect(parseConflictUri('conflict://3')).toEqual({ id: 3 })
    expect(parseConflictUri('conflict://3/theirs')).toEqual({ id: 3, scope: 'theirs' })
    expect(parseConflictUri('file.ts:conflict://3')).toEqual({ id: 3 })
    expect(parseConflictUri('conflict://*')).toEqual({ id: '*' })
    expect(parseConflictUri('/abs/file.ts')).toBeNull()
    expect(parseConflictUri('pr://1')).toBeNull()
  })

  it('rejects invalid ids/scopes with friendly messages', () => {
    expect(() => parseConflictUri('conflict://abc')).toThrow(/Invalid conflict URI/)
    expect(() => parseConflictUri('conflict://3/nope')).toThrow(/ours.*theirs.*base/)
    expect(() => parseConflictUri('conflict://*/ours')).toThrow(/wildcard/)
  })
})

let makeEntryId = 900
function makeEntry(absPath: string, startLine: number, displayPath = absPath): ConflictEntry {
  // A canonical two-way block renumbered to `startLine`.
  const block = scanConflictsInContent(TWO_WAY.join('\n'))[0]!
  const shifted = {
    ...block,
    id: makeEntryId++,
    startLine,
    separatorLine: startLine + 2,
    endLine: startLine + 4,
    oursLines: [...block.oursLines],
    theirsLines: [...block.theirsLines],
  }
  return { ...shifted, absolutePath: absPath, displayPath }
}

describe('spliceConflict', () => {
  it('replaces the recorded block with the resolution', () => {
    const text = makeFile([TWO_WAY]) // 1 ctx + 5 markers + 1 ctx = 7 lines
    const entry = makeEntry('/ws/a.ts', 3)
    const { text: spliced } = spliceConflict(text, entry, 'const a = 2 // resolved')
    expect(spliced).toContain('const a = 2 // resolved')
    expect(spliced).not.toContain('<<<<<<<')
    expect(spliced.split('\n')).toHaveLength(3) // 1 ctx + resolution + 1 ctx
  })

  it('locates shifted blocks by content when line numbers moved', () => {
    const text = '// header\n\n' + makeFile([TWO_WAY])
    const entry = makeEntry('/ws/a.ts', 3) // stale line numbers
    const { text: spliced } = spliceConflict(text, entry, 'x')
    expect(spliced).not.toContain('<<<<<<<')
  })

  it('rejects when the recorded block disappeared', () => {
    const entry = makeEntry('/ws/a.ts', 3)
    expect(() => spliceConflict('no conflict here', entry, 'x')).toThrow(/no longer present/)
  })

  it('trims whole-boundary echo lines that restate the wrapper', () => {
    const text = makeFile([TWO_WAY], ['function f() {', '  const a = 1', '}'])
    const entry = makeEntry('/ws/a.ts', 4) // block starts at line 4 here
    const { text: spliced, trimmedLeading, trimmedTrailing } = spliceConflict(
      text,
      entry,
      'function f() {\n  const a = 1\n}\n  return 2 // resolved\n',
    )
    // The model restated the entire wrapper: all 3 leading echo lines are dropped.
    expect(trimmedLeading).toBe(3)
    expect(trimmedTrailing).toBe(0)
    expect(spliced).toContain('  return 2 // resolved')
    expect(spliced).not.toContain('<<<<<<<')
  })

  it('reframes replacement lines with CRLF when the file uses CRLF', () => {
    const crlf = TWO_WAY.map(l => `${l}\r`)
    const text = makeFile([crlf], ['export {}'])
    const entry = makeEntry('/ws/a.ts', 3)
    const expanded = expandContentTokens('@theirs', entry)
    const { text: spliced } = spliceConflict(text, entry, expanded)
    expect(spliced).toContain('const a = 2\r')
  })
})

describe('expandContentTokens', () => {
  it('expands @ours, @theirs, @base, @both against recorded sections', () => {
    const entry = makeEntry('/ws/a.ts', 3)
    entry.oursLines = ['ours line']
    entry.theirsLines = ['theirs line', 'theirs two']
    entry.baseLines = ['base line']
    expect(expandContentTokens('@ours', entry)).toBe('ours line')
    expect(expandContentTokens('@theirs', entry)).toBe('theirs line\ntheirs two')
    expect(expandContentTokens('@both', entry)).toBe('ours line\ntheirs line\ntheirs two')
    expect(expandContentTokens('@base', entry)).toBe('base line')
    expect(expandContentTokens('keep @ours inline', entry)).toBe('keep @ours inline')
  })

  it('throws @base for two-way conflicts', () => {
    const entry = makeEntry('/ws/a.ts', 3)
    delete entry.baseLines
    expect(entry.baseLines).toBeUndefined()
    expect(() => expandContentTokens('@base', entry)).toThrow(/no base section/)
  })
})

describe('renderConflictRegion', () => {
  it('renders single sides and full block with markers', () => {
    const history = new ConflictHistory()
    const entry = history.register({
      startLine: 3,
      separatorLine: 5,
      endLine: 7,
      oursLabel: 'HEAD',
      theirsLabel: 'feature/x',
      oursLines: ['a'],
      theirsLines: ['b'],
      absolutePath: '/ws/a.ts',
      displayPath: 'a.ts',
    })
    expect(renderConflictRegion(entry, 'ours')).toEqual({ lines: ['a'], startLine: 4 })
    expect(renderConflictRegion(entry, 'theirs')).toEqual({ lines: ['b'], startLine: 6 })
    const full = renderConflictRegion(entry, undefined)
    expect(full.lines).toEqual(['<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> feature/x'])
  })
})

describe('ConflictProtocolHandler', () => {
  class FakeBridge implements ConflictFileBridge {
    files = new Map<string, string>()
    reads = 0
    async readFile(path: string): Promise<string> {
      this.reads++
      const content = this.files.get(path)
      if (content === undefined) throw new Error(`not found: ${path}`)
      return content
    }
    async writeFile(path: string, content: string): Promise<void> {
      this.files.set(path, content)
    }
  }

  function setup(blocks: string[][], context = ['export {}']) {
    const bridge = new FakeBridge()
    const path = '/ws/a.ts'
    bridge.files.set(path, makeFile(blocks, context))
    const history = new ConflictHistory()
    const handler = new ConflictProtocolHandler({ historyFor: () => history, bridge })
    // Route through the real resolver registry, exactly as the tools do.
    const router = new InternalUrlRouter()
    router.register(handler)
    const read = (raw: string) => router.resolve(raw, { sessionKey: 's' })
    const write = (raw: string, content: string) => router.write(raw, content, { sessionKey: 's' })
    // Simulate the read tool registering the blocks it surfaced.
    const blocksScanned = scanConflictsInContent(bridge.files.get(path) ?? '')
    const entries = blocksScanned.map(block => history.register({ ...block, absolutePath: path, displayPath: 'a.ts' }))
    return { bridge, history, router, path, entries, read, write }
  }

  it('resolves a registered block and its sides', async () => {
    const { entries, read } = setup([TWO_WAY])
    const id = entries[0]!.id

    const full = await read(`conflict://${id}`)
    expect(full.content).toContain('<<<<<<< HEAD')
    expect(full.content).toContain('const a = 2')
    // The router stamps immutability from the handler (conflict is writable).
    expect(full.immutable).toBe(false)
    expect(full.notes?.[0]).toContain(`Conflict #${id}`)

    const ours = await read(`conflict://${id}/ours`)
    expect(ours.content).toBe('const a = 1')

    const theirs = await read(`conflict://${id}/theirs`)
    expect(theirs.content).toBe('const a = 2')
  })

  it('wildcard read lists every registered block', async () => {
    const { entries, read } = setup([TWO_WAY, THREE_WAY])
    expect(entries).toHaveLength(2)
    const listed = await read('conflict://*')
    expect(listed.content).toContain('#1')
    expect(listed.content).toContain('#2')
    expect(listed.content).toContain('3-way')
  })

  it('reports unknown ids with the registered set', async () => {
    const { entries, read } = setup([TWO_WAY])
    await expect(read(`conflict://${entries[0]!.id + 99}`)).rejects.toThrow(/not registered/)
    await expect(read('conflict://*')).resolves.toBeTruthy()
  })

  it('write resolves a block, splicing @theirs and invalidating the history', async () => {
    const { bridge, entries, write, read } = setup([TWO_WAY])
    const id = entries[0]!.id
    await write(`conflict://${id}`, '@theirs')
    const text = bridge.files.get('/ws/a.ts') ?? ''
    expect(text).toContain('const a = 2')
    expect(text).not.toContain('<<<<<<<')
    await expect(read(`conflict://${id}`)).rejects.toThrow(/not registered/)
  })

  it('write with <path>:conflict:// prefix still resolves', async () => {
    const { entries, bridge, write, read } = setup([TWO_WAY])
    const id = entries[0]!.id
    await write(`/ws/a.ts:conflict://${id}`, '@ours')
    expect(bridge.files.get('/ws/a.ts') ?? '').not.toContain('<<<<<<<')
    await expect(read(`conflict://${id}`)).rejects.toThrow(/not registered/)
  })

  it('bulk conflict://* accepts one shared resolution', async () => {
    const { bridge, write, read } = setup([TWO_WAY, THREE_WAY])
    await write('conflict://*', '@ours')
    const text = bridge.files.get('/ws/a.ts') ?? ''
    expect(text).not.toContain('<<<<<<<')
    const listed = await read('conflict://*')
    expect(listed.content).toContain('No conflicts registered')
  })

  it('bulk conflict://* accepts per-id lines "N: @side"', async () => {
    const bridge = new FakeBridge()
    const path = '/ws/a.ts'
    bridge.files.set(path, makeFile([TWO_WAY, THREE_WAY]))
    const history = new ConflictHistory()
    const scanned = scanConflictsInContent(bridge.files.get(path) ?? '')
    const entries = scanned.map(block => history.register({ ...block, absolutePath: path, displayPath: 'a.ts' }))
    const handler = new ConflictProtocolHandler({ historyFor: () => history, bridge })
    await handler.write(parseInternalUrl('conflict://*'), `${entries[0]!.id}: @ours\n${entries[1]!.id}: @theirs`, { sessionKey: 's' })
    const text = bridge.files.get(path) ?? ''
    expect(text).toContain('const a = 1') // ours from block 1
    expect(text).toContain('const a = 2') // theirs from block 2
    expect(text).not.toContain('<<<<<<<')
    expect(history.entries()).toHaveLength(0)
  })

  it('rejects scope writes and unknown-id writes', async () => {
    const { entries, write } = setup([TWO_WAY])
    await expect(write(`conflict://${entries[0]!.id}/theirs`, '@theirs')).rejects.toThrow(/read-only/)
    await expect(write('conflict://99', '@theirs')).rejects.toThrow(/not registered/)
  })

  it('complains when nothing is registered', async () => {
    const bridge = new FakeBridge()
    const handler = new ConflictProtocolHandler({ historyFor: () => new ConflictHistory(), bridge })
    await expect(handler.write(parseInternalUrl('conflict://*'), '@ours', { sessionKey: 's' })).rejects.toThrow(/nothing to resolve/)
  })

  it('read retires a stale id when the file changed underneath it', async () => {
    const { bridge, path, history, read } = setup([TWO_WAY, THREE_WAY])
    bridge.files.set(path, 'const done = true\n')
    await expect(read('conflict://1')).rejects.toThrow(/not registered/)
    expect(history.entries()).toHaveLength(0)
  })

  it('read keeps the id of an unchanged block that shifted', async () => {
    const { bridge, path, entries, read } = setup([TWO_WAY])
    const id = entries[0]!.id
    bridge.files.set(path, '// new header\n' + makeFile([TWO_WAY]))
    const region = await read(`conflict://${id}`)
    expect(region.content).toContain('<<<<<<< HEAD')
  })

  it('bulk write skips blocks retired by reconciliation', async () => {
    const { bridge, path, write } = setup([TWO_WAY, THREE_WAY])
    // An external resolution removes the first block; the second shifts up.
    bridge.files.set(path, makeFile([TWO_WAY, THREE_WAY]).replace(TWO_WAY.join('\n') + '\n', 'const a = 9\n'))
    await write('conflict://*', '@theirs')
    const after = bridge.files.get(path) ?? ''
    expect(after).toContain('const a = 9')
    expect(after).toContain('const a = 2')
    expect(after).not.toContain('<<<<<<<')
  })

  it('keeps the next id resolvable after an earlier splice', async () => {
    const { bridge, path, entries, write } = setup([TWO_WAY, THREE_WAY])
    await write(`conflict://${entries[0]!.id}`, '@ours')
    await write(`conflict://${entries[1]!.id}`, '@theirs')
    const after = bridge.files.get(path) ?? ''
    expect(after).toContain('const a = 1')
    expect(after).toContain('const a = 2')
    expect(after).not.toContain('<<<<<<<')
  })
})

describe('formatting', () => {
  it('formatConflictWarning explains ids and the resolution protocol', () => {
    const history = new ConflictHistory()
    const entry = history.register({ startLine: 1, separatorLine: 3, endLine: 5, oursLabel: 'HEAD', theirsLabel: 'f/x', oursLines: ['a'], theirsLines: ['b'], absolutePath: '/ws/a.ts', displayPath: 'a.ts' })
    const warning = formatConflictWarning([entry])
    expect(warning).toContain('⚠ 1 unresolved conflict detected')
    expect(warning).toContain('#1')
    expect(warning).toContain('`conflict://<N>`')
    expect(warning).toContain('@theirs')
    expect(warning).toContain('conflict://*')
  })

  it('formatConflictSummary lists ids and 3-way mark', () => {
    const history = new ConflictHistory()
    history.register({ startLine: 1, separatorLine: 3, endLine: 5, baseLine: 2, oursLines: [], baseLines: ['b'], theirsLines: [], absolutePath: '/ws/a.ts', displayPath: 'a.ts' })
    history.register({ startLine: 8, separatorLine: 10, endLine: 12, oursLines: [], theirsLines: [], absolutePath: '/ws/a.ts', displayPath: 'a.ts' })
    const summary = formatConflictSummary(history.entries(), '/ws/a.ts')
    expect(summary).toContain('2 unresolved conflicts')
    expect(summary).toContain('#1')
    expect(summary).toContain('(3-way)')
  })
})
