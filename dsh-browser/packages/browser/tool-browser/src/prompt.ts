/**
 * Static system-prompt section for the browser tool: a compact contract card
 * so the model uses the three backends correctly and leads with ARIA refs
 * instead of expensive screenshots.
 * @module @hy-sde-org/dsh-tool-browser/prompt
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

/** Plugin configuration contributed by the prompt section. */
export interface BrowserPromptConfig {
  /** Disable the prompt section entirely (default false). */
  enabled?: boolean
}

const SECTION_NAME = 'browser:tools'
const SECTION_ORDER = 128

const TEXT = [
  'Browser (port of omp\'s browser tool): `browser` action=open navigates a real browser (stealth-patched launch by default; `app.cdp_url` attaches to an existing CDP endpoint; `app.relay` drives the user\'s own Chrome tabs via the local dsh relay + companion extension). action=run evaluates JS in the tab; action=state re-observes without navigating; action=close/{all,kill} closes tabs and kills spawned browsers.',
  'Observations return a Playwright ARIA snapshot: `[ref=eN]` ids address elements and stay valid until the next snapshot; prefer click-by-CSS-selector or a fresh snapshot after DOM changes. Set `screenshot: yes` only when pixels matter — snapshots are cheap, screenshots are not.',
].join('\n')

/**
 * Build the browser-tools prompt section.
 * @param config - section configuration.
 * @returns the {@link PromptSection} to register.
 */
export function buildBrowserPromptSection(config: BrowserPromptConfig = {}): PromptSection {
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: config.enabled === false ? '' : TEXT,
  }
}
