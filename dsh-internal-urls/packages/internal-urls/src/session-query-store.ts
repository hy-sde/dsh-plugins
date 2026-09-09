/**
 * Adapter from the published `@deepseek-ai/dsh-session-query` service mounted
 * as `ctx.sessionQuery` (an optional peer of this package) to the agent
 * handler's {@link AgentOutputStore} seam. The handler resolves the store
 * lazily at resolve time, so deployments without the session-query service
 * keep working and surface the handler's corrective "outputs unavailable"
 * error instead of a registration failure.
 *
 * Confirmed against the published `@deepseek-ai/dsh-session-query@0.0.1-rc.1`
 * (node_modules/.d.ts + lib/index.js):
 * - `listSessions(signal?)` → `SessionRecord[]` with `header`, `live`,
 *   `persisted` (the seam needs only `header`).
 * - `readSession(sessionId)` → `SessionLogSnapshot { session, events }`.
 *   Note: `inheritedEventCount` is NOT exposed by 0.0.1-rc.1 (it appears in
 *   later versions). The handler folds the complete log exactly like the fork,
 *   selecting the last non-empty assistant message — seeded parent prefix
 *   events only ever win when the child itself produced no message.
 * `filterSessions(...)` also exists on the service but is not needed: agent
 * output ids are corpus-global child session ids, not cwd-scoped paths.
 * @module @hy-sde-org/dsh-internal-urls/session-query-store
 */

import type { AgentOutputStore, AgentSessionEvent, AgentSessionHeader } from './agent-protocol.ts'

/**
 * Structural subset of the published `SessionQueryService` the adapter calls.
 * Kept structural (no `@deepseek-ai/dsh-session-query` import) so this package
 * typechecks and runs with or without the optional peer installed.
 */
export interface SessionQueryServiceLike {
  listSessions(signal?: AbortSignal): Promise<ReadonlyArray<{ header: AgentSessionHeader }>>
  readSession(sessionId: string): Promise<{ session: AgentSessionHeader; events: AgentSessionEvent[] }>
}

/**
 * Wrap a mounted session-query service into the handler's output-store seam.
 * @param service - `ctx.sessionQuery` value (the published service), or
 *   `undefined` when the optional peer is not mounted.
 * @returns the seam implementation, or `undefined` when no service is mounted.
 */
export function sessionQueryOutputStore(service: SessionQueryServiceLike | undefined): AgentOutputStore | undefined {
  if (service === undefined) return undefined
  return {
    async listSessions(signal) {
      const records = await service.listSessions(signal)
      return records.map(record => ({ header: record.header }))
    },
    async readSession(sessionId) {
      return service.readSession(sessionId)
    },
  }
}
