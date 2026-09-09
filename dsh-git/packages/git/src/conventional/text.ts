/**
 * Unicode scalar helpers.
 * Direct port of omp's `commit/conventional/text.ts`.
 * @module @hy-sde-org/dsh-git/conventional/text
 */

/**
 * Count Unicode scalar values, matching Python string length semantics.
 * @param text - the string to measure.
 * @returns the number of Unicode scalar values (not UTF-16 code units).
 */
export function codePointLength(text: string): number {
  let length = 0
  for (let index = 0; index < text.length; length += 1) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    index += codePoint > 0xffff ? 2 : 1
  }
  return length
}

/**
 * Slice by Unicode scalar offsets rather than UTF-16 code units.
 * @param text - the string to slice.
 * @param start - inclusive scalar offset.
 * @param end - exclusive scalar offset (default: to end of string).
 * @returns the sliced substring.
 */
export function sliceCodePoints(text: string, start: number, end?: number): string {
  const normalizedStart = Math.max(0, Math.trunc(start))
  const normalizedEnd = end === undefined ? Number.POSITIVE_INFINITY : Math.max(normalizedStart, Math.trunc(end))
  let ordinal = 0
  let startOffset = text.length
  let endOffset = text.length
  for (let index = 0; index < text.length; ) {
    if (ordinal === normalizedStart) startOffset = index
    if (ordinal === normalizedEnd) {
      endOffset = index
      break
    }
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    index += codePoint > 0xffff ? 2 : 1
    ordinal += 1
  }
  if (normalizedStart === ordinal) startOffset = text.length
  return text.slice(startOffset, endOffset)
}
