/**
 * Cross-extension custom session entry type constants.
 *
 * Custom session entries are the durable branch state that extensions write
 * with `pi.appendEntry`. Consumers in other extensions (mode detection, usage
 * aggregation) must read the same constant the producer writes, so the
 * constants live here instead of inside one extension.
 */

/** Custom session entry type recording Plan Mode activation state. */
export const PLAN_STATE_ENTRY_TYPE = "plan-mode-state";
