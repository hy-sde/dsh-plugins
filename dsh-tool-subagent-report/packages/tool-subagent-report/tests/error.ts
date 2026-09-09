/**
 * Typed failures shared by subagent service and provider operations.
 * Ported from `@deepseek-ai/dsh-subagent` (`packages/subagent/subagent/src/error.ts`)
 * — MIT, see THIRD-PARTY-NOTICES.md — for the local test seam.
 *
 * @module @hy-sde-org/dsh-tool-subagent-report/tests/error
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Typed failure for the subagent seam. */
export class SubagentError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}
