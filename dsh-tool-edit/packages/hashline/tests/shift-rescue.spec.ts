import { describe, expect, it } from 'vitest'
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher, type Snapshot } from '../src/index.ts'

const PATH = 'a.ts'

/** Store whose version history is unreadable, as an aged-out or custom store may be. */
class NoHistoryStore extends InMemorySnapshotStore {
  override versions(): Snapshot[] {
    return []
  }
}

const V0 = [
  'alpha bravo charlie one',
  'delta echo foxtrot two',
  'golf hotel india three',
  'juliet kilo lima four',
  'mike november oscar five',
  'papa quebec romeo six',
  '',
].join('\n')

describe('Patcher shift-consistent anchor rescue', () => {
  it('rescues a replacement anchor renumbered by an earlier shifting edit', async () => {
    // Read v0 lines 3-5 (tag minted), then insert two rows after line 1.
    // The write renumbers every later line: "juliet kilo lima four" moved
    // 4 → 6. The follow-up edit anchors it at 8 — its NEW number, which the
    // original read never displayed — and the payload carries that line's
    // current content, proving which line the op means.
    const fs = new InMemoryFilesystem([[PATH, V0]])
    const snapshots = new InMemorySnapshotStore()
    const tag0 = snapshots.record(PATH, V0, [1, 2, 3, 4, 5])
    const patcher = new Patcher({ fs, snapshots })

    const first = await patcher.apply(Patch.parse(`[${PATH}#${tag0}]\nPUT >1:\n+INSERTED ALPHA ROW A\n+INSERTED BRAVO ROW B`))
    const tag1 = first.sections[0]?.fileHash
    expect(tag1).toMatch(/^[0-9A-F]{4}$/)
    // The model range-reads the written file: lines 1-3 are now seen.
    snapshots.record(PATH, fs.get(PATH) as string, [1, 2, 3])

    const result = await patcher.apply(Patch.parse(`[${PATH}#${tag1}]\nPUT 6-6:\n+juliet kilo lima four (revised)`))

    expect(result.sections[0]?.op).toBe('update')
    expect(fs.get(PATH)).toBe(
      [
        'alpha bravo charlie one',
        'INSERTED ALPHA ROW A',
        'INSERTED BRAVO ROW B',
        'delta echo foxtrot two',
        'golf hotel india three',
        'juliet kilo lima four (revised)',
        'mike november oscar five',
        'papa quebec romeo six',
        '',
      ].join('\n'),
    )
  })

  it('still rejects a stale-numbered anchor whose payload names a different line', async () => {
    // Same history, but the payload carries OLD line 6's content ("mike …",
    // now at 9): the model targeted the line as it was numbered BEFORE the
    // shift. No retained version displays line 6's current content, and the
    // payload contradicts it — the stale anchor stays rejected.
    const fs = new InMemoryFilesystem([[PATH, V0]])
    const snapshots = new InMemorySnapshotStore()
    const tag0 = snapshots.record(PATH, V0, [1, 2, 3, 4, 5])
    const patcher = new Patcher({ fs, snapshots })

    const first = await patcher.apply(Patch.parse(`[${PATH}#${tag0}]\nPUT >1:\n+INSERTED ALPHA ROW A\n+INSERTED BRAVO ROW B`))
    const tag1 = first.sections[0]?.fileHash
    snapshots.record(PATH, fs.get(PATH) as string, [1, 2, 3])

    let message: string | undefined
    try {
      await patcher.apply(Patch.parse(`[${PATH}#${tag1}]\nPUT 6-6:\n+mike november oscar five (revised)`))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/never displayed/)
    expect(fs.get(PATH)).toBe(
      [
        'alpha bravo charlie one',
        'INSERTED ALPHA ROW A',
        'INSERTED BRAVO ROW B',
        'delta echo foxtrot two',
        'golf hotel india three',
        'juliet kilo lima four',
        'mike november oscar five',
        'papa quebec romeo six',
        '',
      ].join('\n'),
    )
  })

  it('rejects a rescue whose anchored content repeats in the file', async () => {
    // Both copies of the repeated row are displayed lines, so the images
    // check passes — but repeated content cannot name which copy an anchor
    // meant, so the rescue declines and the guard rejects as before.
    const v0 = ['header one', 'unique marker line alpha', 'repeated payload row for test', 'repeated payload row for test', 'tail line five', ''].join('\n')
    const fs = new InMemoryFilesystem([[PATH, v0]])
    const snapshots = new InMemorySnapshotStore()
    const tag0 = snapshots.record(PATH, v0, [1, 2, 3, 4, 5])
    const patcher = new Patcher({ fs, snapshots })

    const first = await patcher.apply(Patch.parse(`[${PATH}#${tag0}]\nPUT >1:\n+INSERTED ROW AT TOP`))
    const tag1 = first.sections[0]?.fileHash
    snapshots.record(PATH, fs.get(PATH) as string, [1, 2])

    let message: string | undefined
    try {
      await patcher.apply(Patch.parse(`[${PATH}#${tag1}]\nPUT 5-5:\n+repeated payload row for test (revised)`))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/never displayed/)
  })

  it('rescues a shifted range only when the payload carries both ends', async () => {
    // Deleting line 2 shifts later lines UP: old 3-4 now sit at 2-3. The
    // model's stale range `PUT 2-3` names content from BELOW the intended
    // span ("bravo…" is gone; its tail "charlie…" is now the head), so the
    // tail check fails and the edit rejects…
    const v0 = ['alpha row one', 'bravo row two', 'charlie row three', 'delta row four', 'echo row five', ''].join('\n')
    const fs = new InMemoryFilesystem([[PATH, v0]])
    const snapshots = new InMemorySnapshotStore()
    const tag0 = snapshots.record(PATH, v0, [1, 2, 3, 4, 5])
    const patcher = new Patcher({ fs, snapshots })

    const first = await patcher.apply(Patch.parse(`[${PATH}#${tag0}]\nPUT 2-2:`))
    const tag1 = first.sections[0]?.fileHash
    snapshots.record(PATH, fs.get(PATH) as string, [1, 2])

    let message: string | undefined
    try {
      await patcher.apply(Patch.parse(`[${PATH}#${tag1}]\nPUT 2-3:\n+bravo row two\n+charlie row three`))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/never displayed/)

    // …while the correctly-renumbered range carries both current ends and
    // applies without a re-read.
    const result = await patcher.apply(Patch.parse(`[${PATH}#${tag1}]\nPUT 2-3:\n+charlie row three (kept)\n+delta row four`))
    expect(result.sections[0]?.op).toBe('update')
    expect(fs.get(PATH)).toBe('alpha row one\ncharlie row three (kept)\ndelta row four\necho row five\n')
  })

  it('rejects payload evidence glued into a longer token', async () => {
    // The payload's row merely has the anchored line as an identifier prefix
    // ("…four" vs "…fourx"): token-boundary rules keep that from counting as
    // carried content, so the stale-shaped edit rejects.
    const fs = new InMemoryFilesystem([[PATH, V0]])
    const snapshots = new InMemorySnapshotStore()
    const tag0 = snapshots.record(PATH, V0, [1, 2, 3, 4, 5])
    const patcher = new Patcher({ fs, snapshots })

    const first = await patcher.apply(Patch.parse(`[${PATH}#${tag0}]\nPUT >1:\n+INSERTED ALPHA ROW A\n+INSERTED BRAVO ROW B`))
    const tag1 = first.sections[0]?.fileHash
    snapshots.record(PATH, fs.get(PATH) as string, [1, 2, 3])

    let message: string | undefined
    try {
      await patcher.apply(Patch.parse(`[${PATH}#${tag1}]\nPUT 6-6:\n+juliet kilo lima fourx`))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/never displayed/)
  })

  it('does not rescue pure inserts, which carry no replaced content', async () => {
    // An insertion's payload is new content; it cannot evidence which line
    // the anchor means. Even though line 6 images a displayed line, the
    // unseen anchor rejects.
    const fs = new InMemoryFilesystem([[PATH, V0]])
    const snapshots = new InMemorySnapshotStore()
    const tag0 = snapshots.record(PATH, V0, [1, 2, 3, 4, 5])
    const patcher = new Patcher({ fs, snapshots })

    const first = await patcher.apply(Patch.parse(`[${PATH}#${tag0}]\nPUT >1:\n+INSERTED ALPHA ROW A\n+INSERTED BRAVO ROW B`))
    const tag1 = first.sections[0]?.fileHash
    snapshots.record(PATH, fs.get(PATH) as string, [1, 2, 3])

    let message: string | undefined
    try {
      await patcher.apply(Patch.parse(`[${PATH}#${tag1}]\nPUT >6:\n+brand new shiny row here`))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/never displayed/)
  })

  it('degrades to plain rejection when the store keeps no version history', async () => {
    const fs = new InMemoryFilesystem([[PATH, V0]])
    const snapshots = new NoHistoryStore()
    const tag0 = snapshots.record(PATH, V0, [1, 2, 3, 4, 5])
    const patcher = new Patcher({ fs, snapshots })

    const first = await patcher.apply(Patch.parse(`[${PATH}#${tag0}]\nPUT >1:\n+INSERTED ALPHA ROW A\n+INSERTED BRAVO ROW B`))
    const tag1 = first.sections[0]?.fileHash
    snapshots.record(PATH, fs.get(PATH) as string, [1, 2, 3])

    let message: string | undefined
    try {
      await patcher.apply(Patch.parse(`[${PATH}#${tag1}]\nPUT 6-6:\n+juliet kilo lima four (revised)`))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/never displayed/)
  })

  it('never rescues on the drift path, whose anchors index the tagged snapshot', async () => {
    // The tag names v0; the live file is v0 shifted by two rows. Line 6's
    // current content ("juliet kilo lima four") images seen v0 line 4 and
    // the payload carries it — the no-drift rescue would accept — but
    // drift-path anchors remap through the TAGGED text, so the guard
    // rejects rather than guessing across numberings.
    const v1 = [
      'alpha bravo charlie one',
      'INSERTED ALPHA ROW A',
      'INSERTED BRAVO ROW B',
      'delta echo foxtrot two',
      'golf hotel india three',
      'juliet kilo lima four',
      'mike november oscar five',
      'papa quebec romeo six',
      '',
    ].join('\n')
    const fs = new InMemoryFilesystem([[PATH, v1]])
    const snapshots = new InMemorySnapshotStore()
    const tag0 = snapshots.record(PATH, V0, [1, 2, 3, 4, 5])
    const patcher = new Patcher({ fs, snapshots })

    let message: string | undefined
    try {
      await patcher.apply(Patch.parse(`[${PATH}#${tag0}]\nPUT 6-6:\n+juliet kilo lima four (revised)`))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/never displayed/)
    expect(fs.get(PATH)).toBe(v1)
  })

  it('hints the uniform shift when a rejected anchor was displayed elsewhere', async () => {
    // A pure cut has no payload to evidence the anchor against, so the shift
    // rescue declines — but every unseen line's content was displayed by the
    // pre-insert read at exactly one shifted offset. The rejection should say
    // so: "juliet kilo lima four" moved 4 → 6 when two rows went in above it.
    const fs = new InMemoryFilesystem([[PATH, V0]])
    const snapshots = new InMemorySnapshotStore()
    const tag0 = snapshots.record(PATH, V0, [1, 2, 3, 4, 5])
    const patcher = new Patcher({ fs, snapshots })

    const first = await patcher.apply(Patch.parse(`[${PATH}#${tag0}]\nPUT >1:\n+INSERTED ALPHA ROW A\n+INSERTED BRAVO ROW B`))
    const tag1 = first.sections[0]?.fileHash
    snapshots.record(PATH, fs.get(PATH) as string, [1, 2, 3])

    let message: string | undefined
    try {
      await patcher.apply(Patch.parse(`[${PATH}#${tag1}]\nCUT 6-6`))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/never displayed/)
    expect(message).toMatch(/displayed at line\(s\) 4/)
    expect(message).toMatch(/shifted the numbering by \+2/)
    const v1 = 'alpha bravo charlie one\nINSERTED ALPHA ROW A\nINSERTED BRAVO ROW B\ndelta echo foxtrot two\ngolf hotel india three\njuliet kilo lima four\nmike november oscar five\npapa quebec romeo six\n'
    expect(fs.get(PATH)).toBe(v1)
  })

  it('adds no shift hint when the unseen lines tell no uniform-offset story', async () => {
    // Merging rows 2-3 removes "golf…"; line 4's content ("mike…") was never
    // displayed by any retained version (the first read saw only rows 1-3),
    // so no version can explain it with one uniform offset — the plain
    // rejection must carry no shift note. The patcher records content only;
    // the tool layer records seen lines, so the test simulates that step
    // (the carried unchanged row 1 plus the edit's own body row 2).
    const fs = new InMemoryFilesystem([[PATH, V0]])
    const snapshots = new InMemorySnapshotStore()
    const tag0 = snapshots.record(PATH, V0, [1, 2, 3])
    const patcher = new Patcher({ fs, snapshots })

    const first = await patcher.apply(Patch.parse(`[${PATH}#${tag0}]\nPUT 2.=3:\n+delta echo foxtrot two (merged)`))
    const tag1 = first.sections[0]?.fileHash as string
    snapshots.recordSeenLines(PATH, tag1, [1, 2])

    let message: string | undefined
    try {
      await patcher.apply(Patch.parse(`[${PATH}#${tag1}]\nCUT 4-4`))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/never displayed/)
    expect(message).not.toMatch(/shifted the numbering/)
    const v1 = 'alpha bravo charlie one\ndelta echo foxtrot two (merged)\njuliet kilo lima four\nmike november oscar five\npapa quebec romeo six\n'
    expect(fs.get(PATH)).toBe(v1)
  })
})
