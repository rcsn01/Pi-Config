import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatRunReports } from "./run-tools.ts";
import type { SubagentRunSnapshot } from "./subagent-runs.ts";

export function createSubagentBackgroundNotifications(pi: Pick<ExtensionAPI, "sendMessage">, ownership: {
	sessionId: string;
	isCurrent: () => boolean;
}) {
	let enabled = true;
	const sent = new Set<string>();
	return {
		disable() { enabled = false; },
		complete(run: SubagentRunSnapshot) {
			if (!enabled || !ownership.isCurrent() || run.sessionId !== ownership.sessionId || sent.has(run.runId)) return;
			sent.add(run.runId);
			try {
				pi.sendMessage({ customType: "subagent-completion", content: formatRunReports([run]), display: true, details: run },
					{ deliverAs: "followUp", triggerTurn: true });
			} catch { /* A delivery error must not change or discard the terminal result. */ }
		},
	};
}
