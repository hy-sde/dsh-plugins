/**
 * Model-facing `browser` tool over the host `ctx.browser` service.
 *
 * Port of omp/oh-my-pi's browser tool surface (actions open / close / run,
 * app backends launch / cdp_url / relay, ARIA-snapshot observations) — see
 * LICENSE. The tool is
 * a thin, stateless driver: it resolves the kind, delegates to `ctx.browser`,
 * and returns an observation (title, url, ARIA snapshot) plus the paths of
 * any written screenshots the model can re-read with the image tools.
 * @module @hy-sde-org/dsh-tool-browser/browser
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { normalizeWaitUntil } from '@hy-sde-org/dsh-browser'
import type { BrowserService, BrowserKind, BrowserConfig, PageObservation } from '@hy-sde-org/dsh-browser'

/** Tool configuration; all values optional (service defaults apply). */
export interface BrowserToolConfig {
  /** Working directory; defaults to the session workspace. */
  cwd?: string
  /** Max characters of the ARIA snapshot returned (default 20000). */
  maxAriaChars?: number
  /** Directory for written screenshots (default: a temp dir under the session cwd). */
  screenshotDir?: string
  /** Default wait condition for `open` (default `load`). */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
  /** Default timeout in seconds (default 30). */
  timeoutSeconds?: number
}

/**
 * Browser Run Args.
 *
 */
export interface BrowserRunArgs {
  action: 'open' | 'close' | 'run' | 'state'
  name?: string
  url?: string
  app?: {
    path?: string
    cdp_url?: string
    relay?: boolean
  }
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
  code?: string
  timeout?: number
  all?: boolean
  kill?: boolean
  screenshot?: boolean
  screenshot_path?: string
}

/**
 * Browser Run Value.
 *
 */
export interface BrowserRunValue {
  action: BrowserRunArgs['action']
  name: string
  observation?: PageObservation
  screenshots?: string[]
  result?: string
}

/**
 * Session-header cwd first, then the configured root, else process cwd.
 * @param exec - the executing tool context.
 * @param configured - the configured browser root, when set.
 * @param argPath - a caller-supplied path argument, when set.
 * @returns the resolved working directory.
 */
export function resolveCwd(exec: ToolExecution, configured: string | undefined, argPath: string | undefined): string {
  const base = exec.agent?.session.header.cwd
  const root = typeof base === 'string' && base.length > 0 ? base : (configured ?? process.cwd())
  if (!argPath) return root
  return argPath.startsWith('/') ? argPath : resolve(root, argPath)
}

/**
 * Trim Aria.
 *
 * @param aria - The aria parameter.
 * @param maxChars - The maxchars parameter.
 * @returns - The result of the operation.
 */
export function trimAria(aria: string, maxChars: number): string {
  if (aria.length <= maxChars) return aria
  return `${aria.slice(0, maxChars)}\n… (truncated to ${maxChars} chars)`
}

/**
 * Apply Browser Tool.
 *
 * @param ctx - The ctx parameter.
 * @param config - The config parameter.
 */
export function applyBrowserTool(ctx: Context, config: BrowserToolConfig = {}): void {
  const browser = ctx.browser
  const maxAriaChars = config.maxAriaChars ?? 20_000
  const defaultWaitUntil = normalizeWaitUntil(config.waitUntil) ?? 'load'
  const defaultTimeout = config.timeoutSeconds ?? 30
  // screenshotRoot is session-relative; see execute for the resolved base

  ctx.tools.register(defineTool({
    name: 'browser',
    description:
      'Drive a real browser over Chrome DevTools Protocol: open URLs, evaluate JS in a tab, snapshot the page as an ARIA '
      + 'ref tree, and close tabs. Three backends: launch a stealth-patched browser binary (app.path), attach to an existing '
      + 'CDP endpoint (app.cdp_url), or relay into the user\'s own Chrome tabs via the local dsh browser relay + companion '
      + 'extension (app.relay). ARIA snapshots carry [ref=eN] ids that stay valid until the next snapshot; click/type via '
      + 'CSS selectors keep working. Screenshots are written to disk as PNG paths the model can re-read. Returned observation '
      + 'is the current title, url and ref tree, so prefer it over re-reading when no screenshot is needed.',
    parameters: {
      action: {
        type: 'string',
        enum: ['open', 'close', 'run', 'state'],
        required: true,
        description: 'open navigates, run evaluates `code` in the tab, state returns the current observation, close closes tab(s).',
      },
      name: { type: 'string', description: "tab id (default 'main') — several tabs can stay open at once" },
      url: { type: 'string', description: 'URL to open and navigate to (action=open only)' },
      app: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'browser binary path to spawn (default resolves a system Chrome/Edge' },
          cdp_url: { type: 'string', description: 'existing CDP endpoint (http://127.0.0.1:9222) to attach to' },
          relay: { type: 'boolean', description: 'drive the user\'s own tabs via the local relay + extension' },
        },
        description: 'Which backend to use; defaults to spawning a stealth-patched browser.',
      },
      wait_until: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'],
        description: 'Navigation wait condition (default load).',
      },
      code: { type: 'string', description: 'JavaScript expression or IIFE body to evaluate in the tab (action=run only)' },
      timeout: { type: 'integer', description: `Per-call timeout in seconds (default ${defaultTimeout}).` },
      all: { type: 'boolean', description: 'close every tab (action=close only)' },
      kill: { type: 'boolean', description: 'also kill spawned-app browsers (action=close only)' },
      screenshot: {
        type: 'boolean',
        description: 'write a PNG of the tab to disk and return its path (open/run; uses screenshot_path or a temp file)',
      },
      screenshot_path: { type: 'string', description: 'target PNG file for screenshot=yes' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['open', 'close', 'run', 'state'] },
          name: { type: 'string', required: true },
          observation: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', required: true },
              url: { type: 'string', required: true },
              aria: { type: 'string', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          screenshots: { type: 'array', items: { type: 'string' } },
          result: { type: 'string' },
        },
      },
      render: (_args, value: BrowserRunValue) => [{
        type: 'text',
        text: renderBrowserValue(value, maxAriaChars),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args: BrowserRunArgs, exec) {
      const kind: BrowserKind = browser.resolveKind({
        ...(args.app?.path !== undefined ? { path: args.app.path } : {}),
        ...(args.app?.cdp_url !== undefined ? { cdpUrl: args.app.cdp_url } : {}),
        ...(args.app?.relay !== undefined ? { relay: args.app.relay } : {}),
      })
      const cwd = resolveCwd(exec, config.cwd, undefined)
      const screenshotRoot = config.screenshotDir ?? resolve(cwd, '.dsh-browser')
      const name = args.name ?? 'main'
      // Host-plane `ctx.browser` is shared across sessions: namespace the tab
      // key per session so concurrent sessions never steer each other's tabs.
      const sessionId = exec.agent?.session.id
      const namespace = typeof sessionId === 'string' && sessionId.length > 0
        ? sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12) || 'anon'
        : 'anon'
      const serviceName = `${namespace}|${name}`
      const timeoutMs = (args.timeout ?? defaultTimeout) * 1000

      try {
        if (args.action === 'open') {
          if (!args.url) throw new Error('open requires an `url`')
          if (kind.kind === 'relay') await browser.ensureRelay()
          const observation = await browser.open(serviceName, args.url, {
            kind,
            cwd,
            waitUntil: (normalizeWaitUntil(args.wait_until) ?? defaultWaitUntil),
            timeoutMs,
          })
          const value: BrowserRunValue = { action: 'open', name, observation: { ...observation, aria: trimAria(observation.aria, maxAriaChars) } }
          if (args.code) {
            value.result = stringifyResult(await browser.run(serviceName, args.code, { kind, cwd, timeoutMs }))
          }
          await maybeScreenshot(browser, serviceName, kind, cwd, args, value, screenshotRoot)
          return value as never
        }

        if (args.action === 'run') {
          if (!args.code) throw new Error('run requires `code`')
          const value: BrowserRunValue = { action: 'run', name, result: stringifyResult(await browser.run(serviceName, args.code, { kind, cwd, timeoutMs })) }
          try {
            const observation = await browser.observe(serviceName, { kind, cwd })
            value.observation = { ...observation, aria: trimAria(observation.aria, maxAriaChars) }
          } catch {
            // observation is best-effort after a run that may have navigated away
          }
          await maybeScreenshot(browser, serviceName, kind, cwd, args, value, screenshotRoot)
          return value as never
        }

        if (args.action === 'close') {
          await browser.close(serviceName, {
            kind,
            cwd,
            ...(args.all !== undefined ? { all: args.all } : {}),
            ...(args.kill !== undefined ? { kill: args.kill } : {}),
          })
          return { action: 'close', name, result: 'closed' } as never
        }

        // state
        const value: BrowserRunValue = { action: 'state', name }
        try {
          const observation = await browser.observe(serviceName, { kind, cwd })
          value.observation = { ...observation, aria: trimAria(observation.aria, maxAriaChars) }
        } catch (error) {
          value.result = `error: ${error instanceof Error ? error.message : String(error)}`
        }
        return value as never
      } catch (error) {
        return {
          action: args.action,
          name,
          result: `error: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }))
}

async function maybeScreenshot(
  browser: BrowserService,
  name: string,
  kind: BrowserKind,
  cwd: string,
  args: BrowserRunArgs,
  value: BrowserRunValue,
  screenshotRoot: string,
): Promise<void> {
  if (!args.screenshot) return
  await mkdir(screenshotRoot, { recursive: true })
  const destination = args.screenshot_path ? resolve(screenshotRoot, args.screenshot_path) : join(screenshotRoot, `browser-${name}-${Date.now()}.png`)
  const { path } = await browser.screenshot(name, destination, { kind, cwd, fullPage: false })
  value.screenshots = [...(value.screenshots ?? []), path]
}

/**
 * Stringify Result.
 *
 * @param result - The result parameter.
 * @returns - The result of the operation.
 */
export function stringifyResult(result: unknown): string {
  if (result === undefined) return 'undefined'
  if (typeof result === 'string') return result
  if (typeof result === 'number' || typeof result === 'boolean') return String(result)
  return JSON.stringify(result, null, 2)
}

function renderBrowserValue(value: BrowserRunValue, maxAriaChars: number): string {
  const parts: string[] = []
  if (value.observation) {
    const { title, url, aria } = value.observation
    parts.push(`[browser ${value.action} tab=${value.name}]`, `title: ${title}`, `url: ${url}`)
    if (aria) parts.push(`aria snapshot:\n${trimAria(aria, maxAriaChars)}`)
  } else {
    parts.push(`[browser ${value.action} tab=${value.name}]`)
  }
  if (value.result !== undefined) parts.push(`result: ${value.result}`)
  if (value.screenshots?.length) parts.push(`screenshots: ${value.screenshots.join(', ')}`)
  return parts.join('\n')
}

export type { BrowserConfig }
