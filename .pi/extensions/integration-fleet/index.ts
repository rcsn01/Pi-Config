/**
 * Fleet Integration Extension
 *
 * Registers fleet/minion integrations. Codex is the primary fleet minion
 * backend and is mounted from ./integration-codex.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCodexIntegration from "./integration-codex/index.ts";

export default function (pi: ExtensionAPI) {
	registerCodexIntegration(pi);
}
