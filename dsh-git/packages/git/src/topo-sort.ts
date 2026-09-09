/**
 * Dependency-ordered execution of a split-commit plan, with cycle rejection.
 * Direct port of omp's `packages/coding-agent/src/commit/agentic/topo-sort.ts`.
 * @module @hy-sde-org/dsh-git/topo-sort
 */

import type { SplitCommitGroup } from './types.ts'

/**
 * Order the plan's commit groups so every group's declared dependencies are
 * satisfied first. Returns the commit indices in execution order, or a
 * readable error when the dependency graph is invalid — an out-of-range
 * dependency index, or a cycle (which is rejected before anything is written).
 * @param groups - the plan's commit groups (already validated for coverage).
 * @returns indices into {@link groups} in dependency order.
 */
export function computeDependencyOrder(groups: SplitCommitGroup[]): number[] | { error: string } {
  const total = groups.length
  const inDegree = new Array<number>(total).fill(0)
  const edges = Array.from({ length: total }, () => new Set<number>())

  for (let index = 0; index < total; index += 1) {
    const dependencies = groups[index]?.dependencies ?? []
    for (const dependency of dependencies) {
      if (dependency < 0 || dependency >= total) {
        return { error: `Invalid dependency index: ${dependency}` }
      }
      if (!edges[dependency]?.has(index)) {
        edges[dependency]?.add(index)
        inDegree[index] = (inDegree[index] ?? 0) + 1
      }
    }
  }

  const queue: number[] = []
  for (let index = 0; index < total; index += 1) {
    if (inDegree[index] === 0) queue.push(index)
  }

  const order: number[] = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    order.push(current)
    for (const next of edges[current] ?? []) {
      inDegree[next] = (inDegree[next] ?? 0) - 1
      if (inDegree[next] === 0) {
        queue.push(next)
      }
    }
  }

  if (order.length !== total) {
    return { error: 'Circular dependency detected in split commit plan.' }
  }

  return order
}
