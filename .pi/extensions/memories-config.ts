/**
 * Compatibility shim.
 *
 * The /memories command and memory-state compatibility are now owned by
 * memory.ts so MEMORY.md prompt injection, status, and persistence have a
 * single implementation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
	// Intentionally empty.
}
