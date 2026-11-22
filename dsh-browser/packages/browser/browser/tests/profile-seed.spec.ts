/**
 * The seeded profile is the only lever against dialogs a hidden browser
 * cannot close: password leak detection and print preview both hold the page
 * (input drops, `window.print()` never returns) until someone dismisses them
 * (oh-my-pi ffbd1976f7).
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openSeededProfileDir, seedProfilePreferences } from '../src/profile-seed.ts'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-profile-seed-test-'))
  dirs.push(dir)
  return dir
}

async function readPreferences(userDataDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(userDataDir, 'Default', 'Preferences'), 'utf8')) as Record<string, unknown>
}

afterAll(async () => {
  await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('seedProfilePreferences', () => {
  it('lands both automation-safe preferences in a fresh profile', async () => {
    const dir = await tempDir()
    await seedProfilePreferences(dir)
    expect(await readPreferences(dir)).toEqual({
      profile: { password_manager_leak_detection: false },
      printing: { enabled: false },
    })
  })

  it('keeps a reused profile\'s other preferences while adding the seeds', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'Default', 'Preferences')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({
      intl: { accept_languages: 'en-US' },
      profile: { exit_type: 'Normal' },
      printing: { print_preview_sticky_settings: '{}' },
    }))
    await seedProfilePreferences(dir)
    expect(await readPreferences(dir)).toEqual({
      intl: { accept_languages: 'en-US' },
      profile: { exit_type: 'Normal', password_manager_leak_detection: false },
      printing: { print_preview_sticky_settings: '{}', enabled: false },
    })
  })

  it('upgrades a profile seeded before printing was disabled without dropping its seeds', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'Default', 'Preferences')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ profile: { password_manager_leak_detection: false } }))
    await seedProfilePreferences(dir)
    expect(await readPreferences(dir)).toEqual({
      profile: { password_manager_leak_detection: false },
      printing: { enabled: false },
    })
  })

  it('leaves no staged file behind on success', async () => {
    const dir = await tempDir()
    await seedProfilePreferences(dir)
    const others = (await fs.readdir(path.join(dir, 'Default'))).filter(name => name !== 'Preferences')
    expect(others).toEqual([])
  })

  it('never throws when the profile directory is unwritable', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'Default'), 'not a directory')
    await expect(seedProfilePreferences(dir)).resolves.toBeUndefined()
  })
})

describe('openSeededProfileDir', () => {
  it('creates a real temp profile directory whose seed has landed', async () => {
    const dir = await openSeededProfileDir()
    dirs.push(dir)
    const stat = await fs.stat(path.join(dir, 'Default', 'Preferences'))
    expect(stat.isFile()).toBe(true)
    expect(await readPreferences(dir)).toMatchObject({ printing: { enabled: false } })
  })
})
