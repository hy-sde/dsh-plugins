/**
 * Handle-based session-persistence helpers shared by the subagent test suites.
 * Adapted to the PUBLISHED `@deepseek-ai/dsh-session-persistence` API
 * (`inspect` returns the validated header + complete logical event log), which
 * the fork's handle-based `open`/`read`/`close` shape predates.
 */

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** Read one stored session's header and complete event log through the backend. */
export async function loadStoredSession(
  persistence: SessionPersistence,
  id: SessionId,
): Promise<{ meta: SessionHeader; inheritedEventCount: SessionLogOffset; events: readonly SessionEvent[] }> {
  const inspection = await persistence.inspect(id)
  return {
    meta: inspection.meta,
    inheritedEventCount: inspection.inheritedEventCount,
    events: inspection.events,
  }
}

/** Author one stored session directly against the backend: create, then append. */
export async function seedStoredSession(
  persistence: SessionPersistence,
  header: SessionHeader,
  events: readonly SessionEvent[],
  inheritedEventCount?: SessionLogOffset,
): Promise<void> {
  await persistence.create(header, inheritedEventCount)
  if (events.length > 0) await persistence.append(header.id, events)
}
