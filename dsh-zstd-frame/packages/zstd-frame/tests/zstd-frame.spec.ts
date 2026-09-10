import { describe, expect, it } from 'vitest'
import {
  compressZstdFrame, createZstdFrameDecoder, decompressZstdFrame, decompressZstdPrefix, scanZstdFrames,
} from '../src/index.ts'
import { NodePrivateZstdFrameDecoder } from '../src/zstd-private-decoder.ts'
import { PublicZstdFrameDecoder } from '../src/zstd-public-decoder.ts'

describe('JSONL Zstandard frame primitives', () => {
  it('round-trips concatenated checksummed frames through the built-in Node API', async () => {
    const encoded = Buffer.concat([
      await compressZstdFrame('{"type":"session","version":0,"id":"compat","createdAt":1}\n'),
      await compressZstdFrame('{"type":"turn/start","seq":0,"turn":1}\n'),
    ])
    const { frames, tornStart } = scanZstdFrames(encoded)

    expect(tornStart).toBeUndefined()
    expect(frames).toHaveLength(2)
    expect(frames.map(frame => encoded.subarray(frame.start, frame.start + 4).toString('hex')))
      .toEqual(['28b52ffd', '28b52ffd'])
    const decoded = await Promise.all(frames.map(frame => decompressZstdFrame(encoded.subarray(frame.start, frame.end))))
    expect(Buffer.concat(decoded).toString()).toContain('"type":"turn/start"')

    const preferred = createZstdFrameDecoder()
    expect(preferred).toBeInstanceOf(NodePrivateZstdFrameDecoder)
    for (const decoder of [preferred, new PublicZstdFrameDecoder()]) {
      try {
        const plaintext = Array.from(decoder.decode(encoded, frames), chunk => Buffer.from(chunk))
        expect(Buffer.concat(plaintext).toString()).toContain('"type":"turn/start"')
      } finally {
        decoder.close()
      }
    }

    const eventFrame = encoded.subarray(frames[1]!.start, frames[1]!.end)
    const missingChecksumByte = eventFrame.subarray(0, -1)
    expect(scanZstdFrames(missingChecksumByte)).toEqual({ frames: [], tornStart: 0 })
    expect((await decompressZstdPrefix(missingChecksumByte)).toString()).toContain('"type":"turn/start"')
  })

  it('rejects a structurally invalid frame start', () => {
    expect(() => scanZstdFrames(Buffer.from('not a zstd file'))).toThrow(/invalid frame magic/)
  })

  it('honors a complete-frame scan cap', async () => {
    const encoded = Buffer.concat([await compressZstdFrame('a'), await compressZstdFrame('b')])
    const capped = scanZstdFrames(encoded, 1)
    expect(capped.frames).toHaveLength(1)
  })

  it('bounds decompressed output when requested', async () => {
    const encoded = await compressZstdFrame('x'.repeat(4096))
    await expect(decompressZstdFrame(encoded, 64)).rejects.toThrow()
    const bounded = await decompressZstdFrame(encoded, 8192)
    expect(bounded.length).toBe(4096)
  })
})

describe('compressZstdFrame compression-level option', () => {
  it('honors an explicit level through params and stays checksummed', async () => {
    const juicy = [
      '{"type":"assistant/chunk","seq":14,"time":1788151127516,"data":{"turn":1,"step":1,"chunk":{"type":"block-start","index":0,"blockType":"reasoning"}}}',
      ...Array.from({ length: 4096 }, (_, i) => (
        `{"type":"reasoning-chunks","seq0":${16 + i},"time0":1788151127824,"data":{"turn":1,"step":1,"index":0,"dt":[0,1,31,65,44],"texts":[" me understand the task. The"," user is asking about omp (","/Users/hui/Documents/github${i}","3/oh-my-pi framework ported"," to the harness")]}}`
      )),
    ].join('\n') + '\n'
    const fast = await compressZstdFrame(juicy, { level: 1 })
    const slow = await compressZstdFrame(juicy, { level: 19 })
    // Levels are applied through ZSTD_c_compressionLevel params (the
    // shorthand `level` option is ignored by node:zlib's zstd API). On a
    // varied payload the encoded bytes must differ between levels — if the
    // params stopped reaching the codec both frames would be byte-identical.
    // (zstd output is not strictly monotonic in level for highly repetitive
    // payloads, so sizes are not compared.)
    expect(slow.equals(fast)).toBe(false)
    await expect(decompressZstdFrame(slow)).resolves.toEqual(Buffer.from(juicy))
    await expect(decompressZstdFrame(fast)).resolves.toEqual(Buffer.from(juicy))
    // Checksum flag is still set on the frame descriptor (bit 0x04).
    expect((slow.readUInt8(4) & 0x04) !== 0).toBe(true)
  })

  it('omitting the option keeps the default encoding', async () => {
    const payload = '{"type":"session","version":0}\n'
    const withDefault = await compressZstdFrame(payload)
    const without = await compressZstdFrame(payload)
    expect(withDefault.equals(without)).toBe(true)
  })
})
