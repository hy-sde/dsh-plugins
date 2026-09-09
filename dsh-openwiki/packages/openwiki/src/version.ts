/**
 * Producer-actor identity for the ported OpenWiki engine.
 *
 * Mirrors the upstream `openwiki/<version>` actor convention so generated
 * provenance and verification stamps remain stable and interoperable.
 * @module @hy-sde-org/dsh-openwiki
 */

/** Engine version reflected in generated provenance. */
export const OPENWIKI_VERSION = '0.4.3'

/** OKF provenance actor for engine-owned finalization passes. */
export const OPENWIKI_PRODUCER_ACTOR = `openwiki/${OPENWIKI_VERSION}`
