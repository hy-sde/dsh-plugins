/**
 * Minimal mock-adapter helpers ported from the DeepSeek Harness agent-loop
 * test kit (`packages/core/agent-loop/tests/mock-adapter.ts`) — MIT, see
 * THIRD-PARTY-NOTICES.md. Only the helpers the report tool suite needs are
 * carried over; the scripted `MockAdapter` driver is unnecessary here.
 *
 * @module @hy-sde-org/dsh-tool-subagent-report/tests/mock-adapter
 */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** Helpers to write scripted responses tersely. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
