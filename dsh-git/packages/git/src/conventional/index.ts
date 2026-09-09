/**
 * Conventional-commit vocabulary, normalization, and validation.
 * TS port of omp's unified `commit/conventional/` service's deterministic
 * surface — the vocabulary (`commit-types`), Unicode/message normalization
 * (`normalization`, `text`), and the llm-git validation rules (`validation`)
 * with their data tables (`*-data`). The LLM-generation halves (inference,
 * map-reduce, prompt rendering, cache) are not ported: the fork's commit
 * tools author the plan between two tool calls instead of running a hidden
 * model session.
 * @module @hy-sde-org/dsh-git/conventional
 */

export * from './types.ts'
export * from './commit-types.ts'
export * from './commit-types-data.ts'
export * from './normalization.ts'
export * from './text.ts'
export * from './validation.ts'
export * from './validation-data.ts'
