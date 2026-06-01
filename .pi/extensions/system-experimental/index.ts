/**
 * Compatibility shim.
 *
 * /experimental is now merged into feature-flags.ts so feature state, status,
 * prompt hints, and the __pi_features helper have one implementation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
	// Intentionally empty.
}
