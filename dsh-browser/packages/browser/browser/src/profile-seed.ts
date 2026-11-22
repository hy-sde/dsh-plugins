import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

/** Chromium profile subdirectory holding the JSON `Preferences` store. */
const PREFERENCES_FILE = path.join('Default', 'Preferences')

/**
 * Create an empty Chromium profile directory under the OS temp dir and seed
 * its automation-safe preferences. The seed is best-effort (a failure is
 * contained here); the caller owns removing the directory after the browser
 * closes.
 * @returns the absolute path of the created profile directory.
 */
export async function openSeededProfileDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-chromium-'))
  await seedProfilePreferences(dir)
  return dir
}

/**
 * Pin automation-safe preferences in a Chromium profile this host owns.
 * Password leak detection answers a password form submit with a tab-modal
 * "Change your password" dialog; while it is open Chromium drops
 * `Input.dispatchMouseEvent` input for the tab, and a hidden browser offers
 * no way to close it. A page's `window.print()` opens Chrome's print preview,
 * which holds the page's script until someone closes it, so input, navigation
 * and most evaluations stall; with printing off, `print()` returns at once
 * and `Page.printToPDF` still works (oh-my-pi ffbd1976f7). Chromium reads
 * `Preferences` only at startup and rewrites it from memory, so call this
 * before a Chromium process starts on the profile. Best-effort: the
 * preferences only suppress dialogs, so a failure never blocks the launch.
 * @param userDataDir - profile directory to seed (created when missing).
 */
export async function seedProfilePreferences(userDataDir: string): Promise<void> {
  try {
    const file = path.join(userDataDir, PREFERENCES_FILE)
    let prefs: Record<string, unknown> = {}
    try {
      prefs = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    } catch (error) {
      if (!isMissingOrInvalid(error)) throw error
    }
    const profile = isRecord(prefs.profile) ? prefs.profile : {}
    const printing = isRecord(prefs.printing) ? prefs.printing : {}
    if (profile.password_manager_leak_detection === false && printing.enabled === false) return
    profile.password_manager_leak_detection = false
    printing.enabled = false
    prefs.profile = profile
    prefs.printing = printing
    await fs.mkdir(path.dirname(file), { recursive: true })
    const staged = `${file}.dsh-${process.pid}`
    await fs.writeFile(staged, JSON.stringify(prefs))
    await fs.rename(staged, file)
  } catch {
    // Best effort: the preferences only suppress dialogs a person could close
    // by hand, so a lost seed must never fail the launch it precedes.
  }
}

function isMissingOrInvalid(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
