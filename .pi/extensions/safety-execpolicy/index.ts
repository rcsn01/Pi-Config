/**
 * Compatibility shim.
 *
 * /execpolicy and execpolicy tool-call enforcement are now merged into
 * approval-modes/index.ts, which is the single command-safety owner.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
	// Intentionally empty.
}
