/**
 * Repository layout constants for the ported OpenWiki engine.
 * @module @hy-sde-org/dsh-openwiki/config
 */

/** Generated wiki directory name inside the target repository. */
export const OPEN_WIKI_DIR = 'openwiki'

/** Durable page-manifest path below the repository root. */
export const PAGE_MANIFEST_PATH = `${OPEN_WIKI_DIR}/.page-manifest.json`

/** Durable last-update metadata path below the repository root. */
export const UPDATE_METADATA_PATH = `${OPEN_WIKI_DIR}/.last-update.json`
