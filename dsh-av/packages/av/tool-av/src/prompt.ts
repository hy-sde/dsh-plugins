/**
 * Static system-prompt section for the Automic Vault tools: a compact contract
 * card so the model audits, reports, and hands remediation to the human —
 * never releases secret values or auto-runs hardening.
 * @module @hy-sde-org/dsh-tool-av/prompt
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

/** Plugin configuration contributed by the prompt section. */
export interface AvPromptConfig {
  /** Disable the prompt section entirely (default false). */
  enabled?: boolean
}

const SECTION_NAME = 'av:tools'
const SECTION_ORDER = 130

const TEXT = [
  'Automic Vault tools (`av_scan`, `av_doctor`, `av_catalog`, `av_list`): audit the Mac for exposed dev-tool credentials, verify hardening, and list saved secret names. Always read-only — no tool output contains a Secret Value, and `av_list` returns names only.',
  'When you find an exposure or an unhealthy hardener, report the finding with its remediation and the exact terminal command (e.g. `av harden gh`). Running hardening, storing secrets, or injecting into a command stays a human decision in a terminal the user controls; never attempt to bypass or auto-approve a gate.',
  'If the `av` CLI is missing, the tools report an installation hint (`brew install --cask automic-vault/isotopes/automic-vault`); mention it rather than retrying.',
].join('\n')

/**
 * Build the av-tools prompt section.
 * @param config - section configuration.
 * @returns the {@link PromptSection} to register.
 */
export function buildAvPromptSection(config: AvPromptConfig = {}): PromptSection {
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: config.enabled === false ? '' : TEXT,
  }
}
