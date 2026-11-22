import { describe, expect, it } from 'vitest'
import { crc32 } from '../src/ar/checksums.ts'
import { Rar4Decoder } from '../src/ar/rar/rar4-decoder.ts'

// The fixture sweep only exercises store-mode rar4 members, so the RarVM filter
// path has no real-file harness. These specs hand-pack minimal LZ streams (one
// Huffman table, a filter symbol, then literals) and drive the decoder directly.

/** MSB-first bit packer matching the order the decoder's Bits reader consumes. */
class BitWriter {
  #bytes: number[] = []
  #current = 0
  #bit = 0

  write(value: number, count: number): void {
    for (let position = count - 1; position >= 0; position--) {
      this.#current = (this.#current << 1) | ((value >>> position) & 1)
      if (++this.#bit === 8) {
        this.#bytes.push(this.#current)
        this.#current = 0
        this.#bit = 0
      }
    }
  }

  toUint8Array(): Uint8Array {
    if (this.#bit !== 0) this.#bytes.push(this.#current << (8 - this.#bit))
    return new Uint8Array(this.#bytes)
  }
}

/** Encodes a RarVM readData operand: a 2-bit prefix selects the fixed-width tail. */
function writeVmData(writer: BitWriter, value: number): void {
  if (value <= 0x0f) {
    writer.write(0b00, 2)
    writer.write(value, 4)
  } else if (value <= 0xff) {
    writer.write(0b01, 2)
    writer.write(value >>> 4, 4)
    writer.write(value & 0x0f, 4)
  } else if (value <= 0xffff) {
    writer.write(0b10, 2)
    writer.write(value, 16)
  } else {
    writer.write(0b11, 2)
    writer.write(value >>> 16, 16)
    writer.write(value & 0xffff, 16)
  }
}

/** Writes the Huffman code for one length-table entry (lengths 0-3 cover this stream). */
function writeLengthSymbol(writer: BitWriter, length: number): void {
  if (length === 0) writer.write(0b0, 1)
  else if (length === 1) writer.write(0b10, 2)
  else if (length === 2) writer.write(0b110, 3)
  else writer.write(0b111, 3)
}

// identifyFilter recognizes unrar's standard filters by program length + CRC-32
// alone (the VM program is never executed; applyFilters implements delta
// natively), so a synthetic 29-byte program with the standard delta CRC
// 0x0e06077d selects filter type 6 without embedding unrar VM bytecode.
const DELTA_PROGRAM_CRC = 0x0e06077d
const DELTA_PROGRAM = new Uint8Array(29)
DELTA_PROGRAM.set([0x32, 0x9a, 0x98, 0xdf], 25)

// Huffman lengths: symbol 256 ends the block, 257 opens a filter, 65 is the
// literal 'A', 258 is unused padding; every other symbol stays at length 0.
const LITERAL = 65
const TABLE_SIZE = 404 // 299 main + 60 distance + 17 low-distance + 28 length
const BLOCK_BYTES = 4

function buildDeltaFilterStream(channels: number): Uint8Array {
  const vm = new BitWriter()
  writeVmData(vm, 0) // filter start
  writeVmData(vm, BLOCK_BYTES) // filter block size
  vm.write(0b0000001, 7) // register mask: r0 only
  writeVmData(vm, channels) // r0: delta channel count
  writeVmData(vm, DELTA_PROGRAM.byteLength) // program size
  for (const byte of DELTA_PROGRAM) vm.write(byte, 8)
  const code = vm.toUint8Array()

  const writer = new BitWriter()
  writer.write(0, 1) // not a PPMd block
  writer.write(0, 1) // do not keep previous lengths
  for (const length of [1, 2, 3, 3, ...new Array<number>(16).fill(0)]) writer.write(length, 4)
  const lengths = new Array<number>(TABLE_SIZE).fill(0)
  lengths[LITERAL] = 3
  lengths[256] = 1
  lengths[257] = 2
  lengths[258] = 3
  for (const length of lengths) writeLengthSymbol(writer, length)
  writer.write(0b10, 2) // symbol 257: read filter
  writer.write(0x37, 8) // firstByte: explicit block size, register mask, 16-bit size escape
  writer.write(code.byteLength, 16)
  for (const byte of code) writer.write(byte, 8)
  for (let index = 0; index < BLOCK_BYTES; index++) writer.write(0b110, 3) // literals 'AAAA'
  writer.write(0b0, 1) // symbol 256
  writer.write(0b0, 1) // end the block without a new table
  return writer.toUint8Array()
}

function decodeDelta(channels: number): Uint8Array {
  return new Rar4Decoder().decode(buildDeltaFilterStream(channels), BLOCK_BYTES, 1024, false, 29)
}

describe('rar4 delta filters', () => {
  it('recognizes the synthetic delta program by its CRC-32', () => {
    expect(crc32(DELTA_PROGRAM)).toBe(DELTA_PROGRAM_CRC)
  })

  it('applies delta filters with channel counts inside the unrar 1-1024 range', () => {
    expect(decodeDelta(1)).toEqual(new Uint8Array([0xbf, 0x7e, 0x3d, 0xfc]))
    expect(decodeDelta(2)).toEqual(new Uint8Array([0xbf, 0xbf, 0x7e, 0x7e]))
    expect(decodeDelta(1024)).toEqual(new Uint8Array([0xbf, 0xbf, 0xbf, 0xbf]))
  })

  it('rejects out-of-range delta channel counts as corrupt', () => {
    for (const channels of [0, 1025, 0x80000000]) {
      expect(() => decodeDelta(channels)).toThrow('invalid delta filter channel count')
    }
  })
})
