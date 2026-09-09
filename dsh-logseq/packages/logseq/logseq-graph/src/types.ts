/**
 * Wire-shape entities the wiki-graph service projects from CLI JSON. All plain
 * JSON values so the same shapes cross the host API wire untouched. Mirrored
 * structurally by `@deepseek-ai/dsh-host-apiproxy`'s `wiki` domain (which owns
 * the zod Wire<> validation); these interfaces are the service's own contract.
 */

/** A tag reference (class entity) attached to a page/block. */
export interface TagRef {
  id: number
  name: string | null
  title: string | null
}

/** One block node in a page tree (recursive children). */
export interface BlockNode {
  id: number
  uuid: string | null
  /** Raw block text (may embed `key:: value` property lines and [[refs]]). */
  content: string
  order: string | null
  createdAt: number | null
  updatedAt: number | null
  tags: TagRef[]
  children: BlockNode[]
}

/** Page root of `wiki.getPage` (db/page + nested block tree). */
export interface PageRoot {
  id: number
  name: string | null
  title: string
  uuid: string | null
  createdAt: number | null
  updatedAt: number | null
  tags: TagRef[]
  /** Property refs (user.property/<name>-<hash>) mapped to their value-blocks id. */
  props: Record<string, number>
  children: BlockNode[]
}

/** One linked-reference block (a foreign block that references this page). */
export interface LinkedBlock {
  id: number
  content: string
  pageName: string | null
  pageTitle: string | null
  pageId: number | null
  updatedAt: number | null
}

/** Flat page row (`wiki.listPages`; excludes built-ins unless requested). */
export interface PageRow {
  id: number
  title: string | null
  updatedAt: number | null
  createdAt: number | null
}

/** Flat tag row (`wiki.listTags`; user tags, name available after tag id lookup is resolved by the CLI). */
export interface TagRow {
  id: number
  name: string | null
  title: string | null
}

/** Flat property row (`wiki.listProperties`). */
export interface PropertyRow {
  id: number
  name: string | null
  title: string | null
}

/** Generic search hit (`wiki.search`). */
export interface SearchItem {
  id: number
  title: string
  /** Page the hit lives on, when the row carries one (else null). */
  pageName: string | null
}

/** One db-worker-node server row (`wiki.server`). */
export interface ServerRow {
  id: number | null
  name: string | null
  url: string | null
  status: string
  graph: string | null
  port: number | null
}
