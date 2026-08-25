/**
 * Path policy helpers: which tools accept paths, which fields carry them,
 * and how to extract the relevant paths from a tool call input.
 *
 * The path predicates themselves live in `_shared/command-policy.ts` and are
 * reused here unchanged.
 */
import {
	isExternalWritePath,
	isPathWithinCwd,
	isSensitivePath,
	resolveToolPath,
} from "../_shared/command-policy.ts";

// Tools that read paths
export const PATH_READ_TOOLS = new Set(["read", "grep", "find"]);
// Tools that write/edit paths — blocked entirely in read-only
export const WRITE_TOOLS = new Set(["bash", "write", "edit", "github_repo_remove"]);
// All tools that accept paths
export const ALL_PATH_TOOLS = new Set([...PATH_READ_TOOLS, "write", "edit", "ls"]);
// Field names that might contain paths
export const PATH_FIELDS = ["path", "file", "output", "target", "dest", "destination", "dir", "directory"];

/**
 * Extract the paths referenced by a tool call from its input object.
 * Returns the primary `path` field plus any other path-bearing fields.
 */
export function extractPathsFromInput(toolName: string, input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const obj = input as Record<string, unknown>;
	const paths: string[] = [];

	// Primary path field
	if (typeof obj.path === "string") paths.push(obj.path);
	// edits array (edit tool) — edit doesn't have per-edit paths but the primary
	// path is the target, already captured above.

	// For other path-containing fields
	for (const field of PATH_FIELDS) {
		if (typeof obj[field] === "string" && field !== "path") paths.push(obj[field] as string);
	}

	return paths.filter(Boolean);
}

export {
	isExternalWritePath,
	isPathWithinCwd,
	isSensitivePath,
	resolveToolPath,
};
