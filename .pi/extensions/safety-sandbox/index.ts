/**
 * Compatibility shim.
 *
 * /sandbox state, status, and command runner are now merged into
 * approval-modes/index.ts so command safety has one owner.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
	// Intentionally empty.
}
