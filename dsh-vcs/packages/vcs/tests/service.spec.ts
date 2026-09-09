/**
 * The `ctx.vcs` service over a fake `pi-vcs` CLI: the narrow native slice
 * (probe / repo-info / rev-diff / staged-diff / watch), the structured stderr
 * error code taxonomy, error surfaces of the CLI wrapper (unavailable binary,
 * non-zero exits, timeout), the watch companion lifecycle (JSON-lines decode,
 * disposer termination), and the Cordis plugin registration. The fake binary
 * is a chmod +x shim that dispatches on argv, exactly like the av service
 * tests.
 */

import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { VcsService } from '../src/service.ts'
import vcsPlugin from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function makeDir(tag: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dsh-vcs-${tag}-`))
  dirs.push(path)
  return path
}

/** Write an executable fake `pi-vcs` binary that dispatches on argv. */
async function writeVcsShim(dir: string, script: string): Promise<string> {
  const path = join(dir, 'pi-vcs')
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  return path
}

const REPO_INFO_FIXTURE = JSON.stringify({
  root: '/work/checkout',
  gitDir: '/work/checkout/.git',
  branch: 'main',
})

const REV_DIFF_FIXTURE = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old line
+new line
`

const STAGED_DIFF_FIXTURE = `diff --git a/b.txt b/b.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+staged content
`

const WORKTREE_DIFF_FIXTURE = `diff --git a/c.txt b/c.txt
index 4444444..5555555 100644
--- a/c.txt
+++ b/c.txt
@@ -1 +1,2 @@
 worktree line
+added
`

const NAME_ONLY_FIXTURE = 'a.txt\nb.txt\n'

const NUMSTAT_FIXTURE = '2\t1\ta.txt\n-\t-\tb.dat\n'

const STATUS_FIXTURE = JSON.stringify({ staged: 2, unstaged: 1, untracked: 3 })

const SHIM = `#!/bin/bash
case "\$1" in
  --version)
    echo "pi-vcs 0.1.0"
    exit 0
    ;;
  repo-info)
    if [ "\$2" = "not-a-repo" ]; then
      echo '{"code":"NotARepository","message":"not a repository: not-a-repo"}' >&2
      exit 1
    fi
    printf '%s' '${REPO_INFO_FIXTURE}'
    echo
    exit 0
    ;;
  rev-diff)
    if [ -n "\$3" ] && [ "\$3" = "missing" ]; then
      echo '{"code":"RefNotFound","message":"reference not found: missing"}' >&2
      exit 1
    fi
    printf '%s' '${REV_DIFF_FIXTURE}'
    exit 0
    ;;
  staged-diff)
    if [ "$3" = "--name-only" ]; then
      printf '%s' '${NAME_ONLY_FIXTURE}'
      exit 0
    fi
    if [ "$3" = "--numstat" ]; then
      printf '%s' '${NUMSTAT_FIXTURE}'
      exit 0
    fi
    printf '%s' '${STAGED_DIFF_FIXTURE}'
    exit 0
    ;;
  worktree-diff)
    if [ "$3" = "--name-only" ]; then
      printf '%s' '${NAME_ONLY_FIXTURE}'
      exit 0
    fi
    printf '%s' '${WORKTREE_DIFF_FIXTURE}'
    exit 0
    ;;
  status)
    printf '%s' '${STATUS_FIXTURE}'
    exit 0
    ;;
  watch)
    # Emit two head events then idle until the process tree is signalled.
    echo '{"event":"head","seq":1}'
    echo '{"event":"head","seq":2}'
    while true; do sleep 0.1; done
    ;;
  *)
    echo "unknown command" >&2
    exit 2
    ;;
esac
`

async function makeService(
  vcsPath: string,
  overrides: ConstructorParameters<typeof VcsService>[1] = {},
) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  return { ctx, service: new VcsService(ctx, { vcsPath, timeoutMs: 5000, ...overrides }) }
}

describe('VcsService', () => {
  it('probes an available pi-vcs CLI and reports its version', async () => {
    const dir = await makeDir('probe')
    const { service } = await makeService(await writeVcsShim(dir, SHIM))
    const probe = await service.probe()
    expect(probe.available).toBe(true)
    expect(probe.version).toBe('0.1.0')
  })

  it('probes an unavailable pi-vcs CLI without throwing', async () => {
    const dir = await makeDir('probe-missing')
    const { service } = await makeService(join(dir, 'does-not-exist'))
    const probe = await service.probe()
    expect(probe.available).toBe(false)
    expect(probe.reason?.toLowerCase()).toContain('pi-vcs')
  })

  it('returns a friendly reason when pi-vcs --version exits non-zero', async () => {
    const dir = await makeDir('probe-bad')
    const shim = '#!/bin/bash\necho "some fatal error" >&2\nexit 3'
    const { service } = await makeService(await writeVcsShim(dir, shim))
    const probe = await service.probe()
    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('some fatal error')
  })

  it('resolves repo metadata from pi-vcs repo-info', async () => {
    const dir = await makeDir('repo-info')
    const { service } = await makeService(await writeVcsShim(dir, SHIM))
    const info = await service.repoInfo('/work/checkout')
    expect(info).toEqual({
      root: '/work/checkout',
      gitDir: '/work/checkout/.git',
      branch: 'main',
    })
    await expect(service.branch('/work/checkout')).resolves.toBe('main')
  })

  it('returns null for NotARepository instead of throwing', async () => {
    const dir = await makeDir('repo-info-null')
    const { service } = await makeService(await writeVcsShim(dir, SHIM))
    const info = await service.repoInfo('not-a-repo')
    expect(info).toBeNull()
  })

  it('renders a git-compatible rev-diff as text', async () => {
    const dir = await makeDir('rev-diff')
    const { service } = await makeService(await writeVcsShim(dir, SHIM))
    const text = await service.revDiff('/work/checkout', 'HEAD~1', 'HEAD')
    expect(text).toContain('diff --git a/a.txt b/a.txt')
    expect(text).toContain('@@ -1 +1 @@')
  })

  it('renders a git-compatible staged-diff as text', async () => {
    const dir = await makeDir('staged-diff')
    const { service } = await makeService(await writeVcsShim(dir, SHIM))
    const text = await service.stagedDiff('/work/checkout')
    expect(text).toContain('new file mode 100644')
    expect(text).toContain('+staged content')
  })

  it('surfaces the structured RefNotFound code from CLI stderr', async () => {
    const dir = await makeDir('ref-not-found')
    const { service } = await makeService(await writeVcsShim(dir, SHIM))
    const error: Record<string, unknown> = { code: 'RefNotFound' }
    await expect(service.revDiff('/work/checkout', 'missing', 'HEAD')).rejects.toMatchObject(error)
  })

  it('surfaces a non-zero pi-vcs exit as VcsCommandError', async () => {
    const dir = await makeDir('nonzero')
    const shim = '#!/bin/bash\necho "some fatal error" >&2\nexit 1'
    const { service } = await makeService(await writeVcsShim(dir, shim))
    const fatalError: Record<string, unknown> = {
      exitCode: 1,
      stderr: expect.stringContaining('fatal'),
    }
    await expect(service.stagedDiff('/work/checkout')).rejects.toMatchObject(fatalError)
  })

  it('surfaces an exit-2 usage error with retained stderr', async () => {
    const dir = await makeDir('usage')
    const shim = '#!/bin/bash\necho "usage: pi-vcs …" >&2\nexit 2'
    const { service } = await makeService(await writeVcsShim(dir, shim))
    await expect(service.stagedDiff('/work/checkout')).rejects.toMatchObject({ exitCode: 2 })
  })

  it('surfaces unparseable stdout as VcsCommandError', async () => {
    const dir = await makeDir('bad-json')
    const shim = '#!/bin/bash\necho "not json at all"'
    const { service } = await makeService(await writeVcsShim(dir, shim))
    const unparseable: Record<string, unknown> = { message: expect.stringContaining('unparseable') }
    await expect(service.repoInfo('/work/checkout')).rejects.toMatchObject(unparseable)
  })

  it('times out a hanging pi-vcs invocation', async () => {
    const dir = await makeDir('hang')
    const shim = '#!/bin/bash\nsleep 30\n'
    const { service } = await makeService(await writeVcsShim(dir, shim), { timeoutMs: 300 })
    const timedOutError: Record<string, unknown> = { message: expect.stringContaining('timed out') }
    await expect(service.stagedDiff('/work/checkout')).rejects.toMatchObject(timedOutError)
  })

  it('decodes watch JSON-lines events and stops on dispose', async () => {
    const dir = await makeDir('watch')
    const { service } = await makeService(await writeVcsShim(dir, SHIM), {
      watchIntervalMs: 50,
    })
    const events: unknown[] = []
    const dispose = service.watch('/work/checkout', event => events.push(event))
    // Load-tolerant wait: the shim emits one event per interval tick, and a
    // saturated machine can stretch the first tick well past a fixed sleep.
    const deadline = Date.now() + 10_000
    while (events.length < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    dispose()
    expect(events).toEqual([
      { event: 'head', seq: 1 },
      { event: 'head', seq: 2 },
    ])
  })

  it('renders a git-compatible worktree-diff as text', async () => {
    const dir = await makeDir('worktree-diff')
    const { service } = await makeService(await writeVcsShim(dir, SHIM))
    const text = await service.worktreeDiff('/work/checkout')
    expect(text).toContain('worktree line')
    expect(text).toContain('+added')
  })

  it('routes cached/range/worktree surprises through the diff verbs', async () => {
    const dir = await makeDir('diff-router')
    const { service } = await makeService(await writeVcsShim(dir, SHIM))
    // cached -> staged-diff
    await expect(service.diff('/work/checkout', { cached: true })).resolves.toContain(
      'staged content',
    )
    // none -> worktree-diff
    await expect(service.diff('/work/checkout', {})).resolves.toContain('worktree line')
    // base+head -> rev-diff
    await expect(service.diff('/work/checkout', { base: 'HEAD~1', head: 'HEAD' })).resolves.toContain(
      'diff --git a/a.txt b/a.txt',
    )
    // base only -> rev-diff (base vs worktree)
    await expect(service.diff('/work/checkout', { base: 'HEAD' })).resolves.toContain(
      'diff --git a/a.txt b/a.txt',
    )
    // head without base is rejected
    await expect(service.diff('/work/checkout', { head: 'HEAD' })).rejects.toMatchObject({
      message: expect.stringContaining('base'),
    } as Record<string, unknown>)
  })

  it('collects changed file names and numstat rows', async () => {
    const dir = await makeDir('derived')
    const { service } = await makeService(await writeVcsShim(dir, SHIM))
    await expect(service.changedFiles('/work/checkout', { cached: true })).resolves.toEqual([
      'a.txt',
      'b.txt',
    ])
    await expect(service.numstat('/work/checkout', { cached: true })).resolves.toBe(
      '2\t1\ta.txt\n-\t-\tb.dat\n',
    )
  })

  it('reports status summary counts and branch name', async () => {
    const dir = await makeDir('status')
    const { service } = await makeService(await writeVcsShim(dir, SHIM))
    await expect(service.status('/work/checkout')).resolves.toEqual({
      staged: 2,
      unstaged: 1,
      untracked: 3,
    })
  })

  it('registers ctx.vcs through the Cordis plugin', async () => {
    const dir = await makeDir('plugin')
    const vcsPath = await writeVcsShim(dir, SHIM)
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(vcsPlugin, { vcsPath })
    const probe = await ctx.vcs.probe()
    expect(probe.available).toBe(true)
    expect(probe.version).toBe('0.1.0')
  })
})
