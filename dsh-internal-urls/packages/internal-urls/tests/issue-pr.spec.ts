/**
 * issue:// / pr:// — URL parsing, diff splitting, and handler resolution against
 * an injected fake `gh` CLI (no network, no gh binary).
 */

import { describe, expect, it } from 'vitest'
import { parseInternalUrl } from '../src/parse.ts'
import { gitRemoteToRepo } from '../src/gh.ts'
import type { ResolveContext } from '../src/types.ts'
import type { GitHubCli } from '../src/issue-pr.ts'
import { IssueProtocolHandler, PrProtocolHandler, parseIssuePrUrl, splitPrDiff } from '../src/issue-pr.ts'

/** A fake `gh` CLI: string payloads feed `output`, anything else feeds `json`. */
class FakeCli implements GitHubCli {
  jsonCalls: string[][] = []
  outputCalls: string[][] = []
  private readonly jsonQueue: unknown[] = []
  private readonly outputQueue: string[] = []
  constructor(payloads: unknown[]) {
    for (const payload of payloads) {
      if (typeof payload === 'string') this.outputQueue.push(payload)
      else this.jsonQueue.push(payload)
    }
  }
  async json(_cwd: string, args: readonly string[]): Promise<unknown> {
    this.jsonCalls.push([...args])
    return this.jsonQueue.shift() ?? null
  }
  async output(_cwd: string, args: readonly string[]): Promise<string> {
    this.outputCalls.push([...args])
    return this.outputQueue.shift() ?? ''
  }
}

const context: ResolveContext = { cwd: '/ws', sessionKey: 's1' }

const UNIFIED_DIFF = `diff --git a/packages/a/src/one.ts b/packages/a/src/one.ts
index abc..def 100644
--- a/packages/a/src/one.ts
+++ b/packages/a/src/one.ts
@@ -1,3 +1,4 @@
 export const one = 1
+export const extra = 2
 export const uno = 1
@@ -9,1 +10,1 @@
-export const old = 1
+export const neuf = 9
diff --git a/packages/b/src/two.ts b/packages/b/src/two.ts
new file mode 100644
index 000..111 100644
--- /dev/null
+++ b/packages/b/src/two.ts
@@ -0,0 +1,2 @@
+export const two = 2
+export const trois = 3
diff --git a/packages/c/src/three.ts b/packages/c/src/three.ts
deleted file mode 100644
index 222..000 100644
--- a/packages/c/src/three.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const three = 3
`

describe('parseIssuePrUrl', () => {
  it('parses list, single, repo-qualified, and diff forms', () => {
    expect(parseIssuePrUrl(parseInternalUrl('issue://'), 'issue')).toMatchObject({ kind: 'list', limit: 30, state: 'open' })
    const single = parseIssuePrUrl(parseInternalUrl('issue://123'), 'issue')
    expect(single).toMatchObject({ kind: 'single', number: 123, comments: true })
    const repoList = parseIssuePrUrl(parseInternalUrl('pr://owner/repo?state=closed&limit=5&author=me'), 'pr')
    expect(repoList).toMatchObject({ kind: 'list', repo: 'owner/repo', state: 'closed', limit: 5, author: 'me' })
    const fq = parseIssuePrUrl(parseInternalUrl('issue://owner/repo/42?comments=0'), 'issue')
    expect(fq).toMatchObject({ kind: 'single', repo: 'owner/repo', number: 42, comments: false })
    const diff = parseIssuePrUrl(parseInternalUrl('pr://owner/repo/7/diff/2'), 'pr')
    expect(diff).toMatchObject({ kind: 'pr-diff', repo: 'owner/repo', number: 7, mode: 'slice', index: 2 })
    const all = parseIssuePrUrl(parseInternalUrl('pr://777/diff/all'), 'pr')
    expect(all).toMatchObject({ kind: 'pr-diff', number: 777, mode: 'all' })
  })

  it('rejects invalid states, numbers, and diff sub-paths', () => {
    expect(() => parseIssuePrUrl(parseInternalUrl('issue://?state=bogus'), 'issue')).toThrow(/Invalid issue:\/\/ list state/)
    // merged IS legal for pr lists:
    expect(parseIssuePrUrl(parseInternalUrl('pr://?state=merged'), 'pr')).toMatchObject({ kind: 'list', state: 'merged' })
    expect(() => parseIssuePrUrl(parseInternalUrl('issue://abc'), 'issue')).toThrow(/Invalid issue:\/\/ number/)
    expect(() => parseIssuePrUrl(parseInternalUrl('pr://x'), 'pr')).toThrow(/Invalid pr:\/\/ number/)
    // A single-part pr:// path is a repo-qualified list (owner: first segment).
    expect(parseIssuePrUrl(parseInternalUrl('pr://1/bogus'), 'pr')).toMatchObject({ kind: 'list', repo: '1/bogus' })
    expect(() => parseIssuePrUrl(parseInternalUrl('pr://1/diff/bogus'), 'pr')).toThrow(/Invalid pr:\/\/ diff sub-path/)
    expect(() => parseIssuePrUrl(parseInternalUrl('issue://1/diff'), 'issue')).toThrow(/do not have a diff/)
  })
  it('parses GitHub Enterprise host-prefixed forms', () => {
    // Dotted hosts prefix every shape: <host>/<owner>/<repo>[/N][/diff...].
    const gheList = parseIssuePrUrl(parseInternalUrl('pr://ghe.example.com/owner/repo'), 'pr')
    expect(gheList).toMatchObject({ kind: 'list', repo: 'ghe.example.com/owner/repo', state: 'open' })
    const gheSingle = parseIssuePrUrl(parseInternalUrl('issue://ghe.example.com/owner/repo/42?comments=0'), 'issue')
    expect(gheSingle).toMatchObject({ kind: 'single', repo: 'ghe.example.com/owner/repo', number: 42, comments: false })
    const gheDiff = parseIssuePrUrl(parseInternalUrl('pr://ghe.example.com/owner/repo/7/diff/2'), 'pr')
    expect(gheDiff).toMatchObject({ kind: 'pr-diff', repo: 'ghe.example.com/owner/repo', number: 7, mode: 'slice', index: 2 })
    // Single-label hosts are recognized only in the numbered form.
    expect(() => parseIssuePrUrl(parseInternalUrl('pr://ghe/owner/repo'), 'pr')).toThrow(/Invalid pr:\/\/ number: repo/)
    const shortSingle = parseIssuePrUrl(parseInternalUrl('issue://ghe/owner/repo/3'), 'issue')
    expect(shortSingle).toMatchObject({ kind: 'single', repo: 'ghe/owner/repo', number: 3 })
    // A dotted host with no repo segments is rejected before shape handling.
    expect(() => parseIssuePrUrl(parseInternalUrl('issue://ghe.example.com'), 'issue')).toThrow(/issue:\/\/<host>\/<owner>\/<repo>/)
    expect(() => parseIssuePrUrl(parseInternalUrl('pr://ghe.example.com/owner'), 'pr')).toThrow(/pr:\/\/<host>\/<owner>\/<repo>/)
  })
})

describe('splitPrDiff', () => {
  it('splits by diff --git headers and computes per-file stats', () => {
    const files = splitPrDiff(UNIFIED_DIFF)
    expect(files).toHaveLength(3)
    expect(files[0]).toMatchObject({ path: 'packages/a/src/one.ts', additions: 2, deletions: 1, changeType: 'modified' })
    expect(files[1]).toMatchObject({ path: 'packages/b/src/two.ts', additions: 2, deletions: 0, changeType: 'added' })
    expect(files[2]).toMatchObject({ path: 'packages/c/src/three.ts', additions: 0, deletions: 1, changeType: 'deleted' })
    // Slices are contiguous and cover each file completely.
    const lines = UNIFIED_DIFF.split('\n')
    expect(lines.slice(files[0]!.startOffset, files[0]!.endOffset).join('\n')).toContain('one.ts')
    expect(lines.slice(files[1]!.startOffset, files[1]!.endOffset).join('\n')).toContain('two.ts')
    // Slices never overlap.
    expect(files[1]!.startOffset).toBeGreaterThanOrEqual(files[0]!.endOffset)
  })
})

describe('gitRemoteToRepo', () => {
  it('parses the common GitHub remote shapes', () => {
    expect(gitRemoteToRepo('https://github.com/deepseek-ai/deepseek-harness.git')).toBe('deepseek-ai/deepseek-harness')
    expect(gitRemoteToRepo('git@github.com:deepseek-ai/oh-my-pi.git')).toBe('deepseek-ai/oh-my-pi')
    expect(gitRemoteToRepo('ssh://git@github.com/a/b')).toBe('a/b')
    expect(gitRemoteToRepo('deepseek-ai/deepseek-harness')).toBe('deepseek-ai/deepseek-harness')
    expect(gitRemoteToRepo('https://gitlab.com/x/y')).toBeUndefined()
    expect(gitRemoteToRepo('')).toBeUndefined()
  })
})

describe('IssueProtocolHandler', () => {
  it('lists issues through the fake cli and renders the listing', async () => {
    const cli = new FakeCli([
      [
        { number: 41, title: 'first', state: 'OPEN', author: { login: 'alice' }, labels: [{ name: 'bug' }] },
        { number: 42, title: 'second', state: 'OPEN', author: { login: 'bob' }, labels: [] },
      ],
    ])
    const handler = new IssueProtocolHandler({ cli, defaultRepo: async () => 'deepseek-ai/repo' })
    const resource = await handler.resolve(parseInternalUrl('issue://deepseek-ai/repo?state=open&limit=3'), context)
    expect(resource.content).toContain('# Issues in deepseek-ai/repo')
    expect(resource.content).toContain('#41')
    expect(resource.content).toContain('first')
    expect(resource.immutable).toBeUndefined() // stamped by the router, not the handler
    expect(cli.jsonCalls[0]).toContain('--state')
  })

  it('renders a single issue without comments when requested', async () => {
    const cli = new FakeCli([
      { number: 7, title: 'the title', state: 'OPEN', author: { login: 'ada' }, body: 'the body\nsecond line', comments: [{ author: { login: 'bob' }, body: 'a comment' }] },
    ])
    const handler = new IssueProtocolHandler({ cli, defaultRepo: async () => 'deepseek-ai/repo' })
    const resource = await handler.resolve(parseInternalUrl('issue://deepseek-ai/repo/7?comments=0'), context)
    expect(resource.content).toContain('# Issue #7: the title')
    expect(resource.content).toContain('by @ada')
    expect(resource.content).not.toContain('a comment')
    expect(cli.jsonCalls[0]).not.toContain('comments')
  })

  it('derives the repo from cwd via defaultRepo for short forms', async () => {
    const cli = new FakeCli([
      { number: 3, title: 't', state: 'OPEN', author: null, body: 'b' },
    ])
    let asked = false
    const handler = new IssueProtocolHandler({
      cli,
      defaultRepo: async () => { asked = true; return 'deepseek-ai/repo' },
    })
    const resource = await handler.resolve(parseInternalUrl('issue://3'), context)
    expect(asked).toBe(true)
    expect(resource.content).toContain('deepseek-ai/repo')
  })

  it('explains when no default repo can be derived', async () => {
    const cli = new FakeCli([])
    const handler = new IssueProtocolHandler({ cli, defaultRepo: async () => undefined })
    await expect(handler.resolve(parseInternalUrl('issue://3'), context)).rejects.toThrow(/could not resolve a default repo/)
  })
})

describe('PrProtocolHandler', () => {
  it('renders a pull request and advertises its diff URL', async () => {
    const cli = new FakeCli([
      { number: 1428, title: 'capybara', state: 'OPEN', isDraft: false, author: { login: 'ada' }, body: 'desc', baseRefName: 'main', headRefName: 'feat/x' },
    ])
    const handler = new PrProtocolHandler({ cli, defaultRepo: async () => 'deepseek-ai/repo' })
    const resource = await handler.resolve(parseInternalUrl('pr://1428'), context)
    expect(resource.content).toContain('# Pull Request #1428: capybara')
    expect(resource.content).toContain('main ← feat/x')
    expect(resource.notes?.some(n => n.includes('pr://deepseek-ai/repo/1428/diff'))).toBe(true)
  })

  it('diff list enumerates files with per-file URLs', async () => {
    const cli = new FakeCli([UNIFIED_DIFF])
    const handler = new PrProtocolHandler({ cli, defaultRepo: async () => 'deepseek-ai/repo' })
    const resource = await handler.resolve(parseInternalUrl('pr://deepseek-ai/repo/7/diff'), context)
    expect(resource.content).toContain('1. packages/a/src/one.ts')
    expect(resource.content).toContain('+2 -1')
    expect(resource.content).toContain('pr://deepseek-ai/repo/7/diff/1')
    expect(resource.content).toContain('[added]')
  })

  it('diff/all returns the raw unified text', async () => {
    const cli = new FakeCli([UNIFIED_DIFF])
    const handler = new PrProtocolHandler({ cli, defaultRepo: async () => 'deepseek-ai/repo' })
    const resource = await handler.resolve(parseInternalUrl('pr://deepseek-ai/repo/7/diff/all'), context)
    expect(resource.content).toBe(UNIFIED_DIFF)
  })

  it('diff slice returns one file chunk; out-of-range index throws', async () => {
    const outOfRange = new PrProtocolHandler({ cli: new FakeCli([UNIFIED_DIFF]), defaultRepo: async () => 'deepseek-ai/repo' })
    await expect(outOfRange.resolve(parseInternalUrl('pr://deepseek-ai/repo/7/diff/9'), context)).rejects.toThrow(/out of range/)

    const cli = new FakeCli([UNIFIED_DIFF])
    const handler = new PrProtocolHandler({ cli, defaultRepo: async () => 'deepseek-ai/repo' })
    const resource = await handler.resolve(parseInternalUrl('pr://deepseek-ai/repo/7/diff/2'), context)
    expect(resource.content).toContain('new file mode')
    expect(resource.content).toContain('export const two = 2')
  })
})
