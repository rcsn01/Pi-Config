import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { openInBrowser } from "../_shared/browser.ts";
import { getObservabilityService, type ObservabilitySource } from "../_shared/observability.ts";
import {
	getPersistentAnalysisRuntime,
	persistentAnalysisRuntime,
	type AnalysisRuntime,
	type AnalysisRuntimeStore,
} from "./runtime.ts";

export interface AnalysisExtensionDependencies {
	createRuntime?: (notify: (message: string) => void) => AnalysisRuntime;
	/** Best-effort opener for the dashboard URL; must not throw. Defaults to spawning the platform browser opener. */
	openUrl?: (url: string) => void;
}

export function createAnalysisExtension(dependencies: AnalysisExtensionDependencies = {}) {
	return (pi: ExtensionAPI) => {
		let notify = (_message: string) => {};
		const usesPersistentRuntime = !dependencies.createRuntime;
		const runtime = dependencies.createRuntime?.((message) => notify(message))
			?? getPersistentAnalysisRuntime((message) => notify(message));
		const lifecycle = runtime as Partial<Pick<AnalysisRuntimeStore, "isActive" | "setNotify">>;
		const observability = getObservabilityService();
		const mainSource: ObservabilitySource = { channel: "main", invocationId: randomUUID(), displayLabel: "Main agent" };
		let unsubscribe: (() => void) | undefined;
		let pendingCompaction: ObservabilitySource | undefined;
		let locallyActive = false;
		const attach = () => {
			lifecycle.setNotify?.((message) => notify(message));
			if (!(lifecycle.isActive?.() ?? locallyActive) || unsubscribe) return;
			unsubscribe = observability.activate((event) => runtime.observe(event));
		};
		const detach = () => {
			unsubscribe?.();
			unsubscribe = undefined;
			lifecycle.setNotify?.(undefined);
		};
		const publish = (event: Parameters<typeof observability.publish>[0]) => observability.publish(event);

		pi.registerCommand("analysis", {
			description: "Start the local provider request analysis dashboard",
			handler: async (args, ctx) => {
				notify = (message) => ctx.ui.notify(message, "warning");
				if (args.trim()) {
					ctx.ui.notify("Usage: /analysis", "warning");
					return;
				}
				try {
					const { url } = await runtime.start();
					(dependencies.openUrl ?? openInBrowser)(url);
					locallyActive = true;
					attach();
					ctx.ui.notify(`Provider request analysis is active. Treat this URL as a secret:\n${url}`, "info");
				} catch (error) {
					ctx.ui.notify(`Could not start request analysis: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		});

		pi.on("session_start", (_event, ctx) => {
			notify = (message) => ctx.ui.notify(message, "warning");
			attach();
		});
		pi.on("agent_start", () => publish({ type: "agent_start", source: mainSource }));
		pi.on("turn_start", (event) => publish({ type: "turn_start", source: mainSource, turnIndex: event.turnIndex, at: event.timestamp }));
		pi.on("before_provider_request", (event, ctx) => {
			const model = ctx.model;
			if (!model) return;
			publish({
				type: "request", source: mainSource,
				provider: model.provider,
				api: model.api,
				model: model.id,
				payload: event.payload,
			});
			// Observation only. Returning undefined preserves the provider payload.
		});
		pi.on("after_provider_response", (event) => {
			publish({ type: "response", source: mainSource, status: event.status });
		});
		pi.on("message_end", (event) => {
			if (event.message.role === "assistant") publish({ type: "assistant", source: mainSource, message: event.message });
			// Observation only. Returning undefined preserves the finalized message.
		});
		pi.on("session_before_compact", (event, ctx) => {
			if (!observability.isActive()) return;
			const source: ObservabilitySource = { channel: "compaction", invocationId: randomUUID(), displayLabel: "Compaction" };
			pendingCompaction = source;
			publish({ type: "agent_start", source });
			publish({ type: "turn_start", source, turnIndex: 0 });
			publish({
				type: "request",
				source,
				provider: "pi",
				api: "pi-compaction",
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
				fidelity: "pi-preparation",
				payload: {
					instructions: event.customInstructions,
					previousSummary: event.preparation.previousSummary,
					messagesToSummarize: event.preparation.messagesToSummarize,
					turnPrefixMessages: event.preparation.turnPrefixMessages,
					options: {
						reason: event.reason,
						willRetry: event.willRetry,
						isSplitTurn: event.preparation.isSplitTurn,
						tokensBefore: event.preparation.tokensBefore,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						settings: event.preparation.settings,
						fileOps: event.preparation.fileOps,
					},
				},
			});
		});
		pi.on("session_compact", (event) => {
			const source = pendingCompaction;
			pendingCompaction = undefined;
			if (!source) return;
			publish({
				type: "assistant",
				source,
				message: {
					role: "assistant",
					content: [{ type: "text", text: event.compactionEntry.summary }],
					summary: event.compactionEntry.summary,
					usage: event.compactionEntry.usage,
					tokensBefore: event.compactionEntry.tokensBefore,
					firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
					reason: event.reason,
					willRetry: event.willRetry,
					fromExtension: event.fromExtension,
				},
			});
		});
		pi.on("session_shutdown", async (event) => {
			detach();
			locallyActive = false;
			pendingCompaction = undefined;
			if (usesPersistentRuntime) {
				await persistentAnalysisRuntime.dispose(runtime as AnalysisRuntimeStore, {
					permanent: event.reason === "quit",
				});
				return;
			}
			if (event.reason === "quit") await runtime.close();
		});
	};
}

export default createAnalysisExtension();
