import { createHash } from "node:crypto";

const CACHE_AFFINITY_VERSION = "subagent-model-v1";

/**
 * Derive an ephemeral child session ID for provider cache affinity.
 *
 * The main session scopes the cache namespace, while every subagent using the
 * same resolved provider/model shares an ID. The hash keeps the main session ID
 * private from child providers and guarantees the child ID is never reused as
 * the main session ID itself.
 */
export function deriveSubagentSessionId(mainSessionId: string, resolvedModel: string): string {
	if (!mainSessionId) throw new Error("Main session ID is required for subagent cache affinity.");
	if (!resolvedModel) throw new Error("Resolved subagent model is required for cache affinity.");
	const digest = createHash("sha256")
		.update(CACHE_AFFINITY_VERSION)
		.update("\0")
		.update(mainSessionId)
		.update("\0")
		.update(resolvedModel)
		.digest("hex")
		.slice(0, 32);
	return `subagent-${digest}`;
}
