/**
 * `chrome.debugger.getTargets()` reports `attached: true` for DevTools and
 * other extensions too (port of oh-my-pi 0a282bedf6): a naive
 * `target.attached && tabId !== undefined` hello makes the relay skip tabs it
 * could actually drive. Only the extension's own attachment answers a
 * `chrome.debugger.sendCommand` probe, so `ownedDebuggerTabs` keeps exactly
 * those. The bundled `src/assets/background.js.txt` mirrors this module.
 */

import { describe, expect, it } from 'vitest'
import { ownedDebuggerTabs } from '../src/relay/debugger-ownership.ts'

describe('ownedDebuggerTabs', () => {
  it('reports only tabs the extension’s own debugger is attached to', async () => {
    const probed: number[] = []
    const owned = await ownedDebuggerTabs(
      [
        { attached: true, tabId: 1 }, // DevTools or another extension holds this one.
        { attached: true, tabId: 2 }, // The extension's own attachment.
        { attached: false, tabId: 3 },
        { attached: true }, // A worker or other target without a tab.
      ],
      async (tabId) => {
        probed.push(tabId)
        if (tabId === 1) throw new Error('Debugger is not attached to the tab with id: 1.')
        return { targetInfo: { targetId: 'page-2' } }
      },
    )
    expect(owned).toEqual([2])
    expect(probed).toEqual([1, 2])
  })
})
