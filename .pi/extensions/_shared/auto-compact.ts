/**
 * Shared auto-compact configuration.
 *
 * Single source of truth for the auto-compact extension's compaction policy so
 * that the /context diagnostics can display the same buffer the extension
 * actually uses, instead of Pi's native (disabled) compaction settings.
 *
 * Note: pi loads each extension as its own module instance (jiti with
 * `moduleCache: false`), so this module must stay stateless — constants only.
 * State cannot be shared between extensions.
 */

/** Compact when context usage reaches this fraction of the model window. */
export const COMPACT_THRESHOLD = 0.8;

/** Headroom kept for the response: the fraction of the window below the threshold. */
export const COMPACT_RESERVE_FRACTION = 1 - COMPACT_THRESHOLD;
