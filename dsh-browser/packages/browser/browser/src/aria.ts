/**
 * ARIA snapshot + ref resolution for the browser service.
 *
 * Port of omp's `aria/aria-snapshot.ts` (MIT, see LICENSE): the bundled
 * Playwright ARIA-snapshot sources
 * (Apache-2.0, Microsoft) run in the page's MAIN world where their `[ref=eN]`
 * ids live; a snapshot is cheap and addresses elements model-side. The page
 * bundle is Playwright's, so the snapshot dialect matches what Playwright
 * users expect, and the refs stay valid until the next snapshot.
 * @module @hy-sde-org/dsh-browser/aria
 */

import type { Page, ElementHandle } from 'playwright-core'
import { ariaSnapshotBundle } from './aria-bundle.ts'

export interface AriaSnapshotOptions {
  /** Maximum tree depth to render. */
  depth?: number
  /** Append `[box=x,y,w,h]` bounding boxes to each node. */
  boxes?: boolean
}

/** Page-side evaluator built ONCE here, outside the page, so CSP never applies. */
function buildEvaluator(params: string, call: string): (...args: unknown[]) => unknown {
  // oxlint-disable-next-line typescript/no-implied-eval -- ported omp mechanic: the trusted bundle is the eval surface
  return new Function(
    ...params.split(',').map(p => p.trim()),
    `var module = { exports: {} };\n${ariaSnapshotBundle}\nreturn module.exports.${call};`,
  ) as unknown as (...args: unknown[]) => unknown
}

// Playwright's evaluate passes at most ONE argument, so the snapshot request is
// carried in a single payload value (root is always null for document snapshots).
const evaluateAriaSnapshot = buildEvaluator('payload', 'ariaSnapshot(payload.root ?? null, payload.request)')
const evaluateResolveRef = buildEvaluator('ref', 'resolveAriaRef(ref)')

/**
 * Capture a Playwright-format ARIA snapshot of the document (root is reserved
 * for element-scoped snapshots). Always runs in `ai` mode so every node
 * carries a `[ref=eN]` id; resolve those refs to elements with
 * {@link resolveAriaRefElement}. Ids are renumbered from e1 on each call and
 * remain valid until the next snapshot.
 */
export async function captureAriaSnapshot(
  page: Page,
  root: ElementHandle | null,
  options: AriaSnapshotOptions = {},
): Promise<string> {
  const request = { depth: options.depth, boxes: options.boxes }
  return await (page.evaluate(evaluateAriaSnapshot as never, { root, request } as never) as Promise<string>)
}

/**
 * Resolve a `[ref=eN]` id from the latest snapshot to a live element, or null
 * when the ref no longer matches any element. Runs in the main world so it
 * sees the `_ariaRef` expandos the snapshot wrote.
 */
export async function resolveAriaRefElement(
  page: Page,
  ref: string,
): Promise<ElementHandle | null> {
  try {
    const handle = await page.evaluateHandle(evaluateResolveRef as never, ref as never)
    return handle.asElement()
  } catch {
    return null
  }
}

const ARIA_REF_PREFIXES = ['aria-ref=', 'aria-ref/', 'ariaref/']

/** Whether a selector string is an ARIA snapshot ref selector. */
export function isAriaRefSelector(selector: string | undefined): boolean {
  if (!selector) return false
  const trimmed = selector.trim()
  return ARIA_REF_PREFIXES.some(prefix => trimmed.startsWith(prefix))
}

/**
 * Parse an ARIA ref selector (`aria-ref=e5` / `aria-ref/e5` / `ariaref/e5`)
 * to the bare `eN` id, or null when it is not an ARIA ref form.
 */
export function parseAriaRefSelector(selector: string): string | null {
  const trimmed = selector.trim()
  for (const prefix of ARIA_REF_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      const ref = trimmed.slice(prefix.length)
      return /^e\d+$/.test(ref) ? ref : null
    }
  }
  return null
}

/**
 * Build a CSS selector (`[aria-ref=e5]`) from an ARIA snapshot selector form
 * (`aria-ref=e5`), or return undefined when it is not an ARIA ref form.
 */
export function buildAriaSnapshotScript(selector: string | undefined, _options: AriaSnapshotOptions = {}): string | undefined {
  if (!selector) return undefined
  const ref = parseAriaRefSelector(selector)
  return ref ? `[aria-ref=${ref}]` : undefined
}
