/**
 * Compatibility shim.
 *
 * Draft capture/replay is now merged into prompt-history.ts so user input is
 * captured, redacted, and replayed by one history implementation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
	// Intentionally empty.
}
