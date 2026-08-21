/**
 * Shared compaction policy constants.
 *
 * Single source of truth for the auto-compact extension's compaction policy so
 * the /context diagnostics and the /model selector's reduction guard use the
 * same threshold the extension enforces, instead of Pi's native (disabled)
 * compaction settings.
 *
 * Note: pi loads each extension as its own module instance (jiti with
 * `moduleCache: false`), so this module must stay stateless — constants only.
 * State cannot be shared between extensions.
 */

/** Compact when context usage reaches this fraction of the model window. */
export const COMPACT_THRESHOLD = 0.8;

/** Headroom kept for the response: the fraction of the window below the threshold. */
export const COMPACT_RESERVE_FRACTION = 1 - COMPACT_THRESHOLD;

/** Compaction summary instructions: a loss-aware handoff that keeps the task going. */
export const SEMANTIC_COMPACTION_FOCUS = `
Create a loss-aware handoff for continuing the task.

Prioritize:
- The latest user objective, requirements, corrections, and acceptance criteria.
- Confirmed repository state, distinguished from planned or assumed work.
- Files, symbols, commands, test results, and exact important errors.
- Key decisions and their rationale.
- Failed approaches and why they failed.
- Current blockers, unresolved questions, and the exact next action.

Rules:
- Later user corrections supersede earlier instructions.
- Do not claim work is complete without supporting tool or test evidence.
- Preserve uncertainty instead of guessing.
- Remove verbose reasoning and obsolete conversational detail.
`;
