import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { ObservabilityService, ObservabilitySource } from "../_shared/observability.ts";

export interface AnalysisObservationAdapterDependencies {
	observability: Pick<ObservabilityService, "isActive" | "publish">;
	createInvocationId?: () => string;
}

export function registerAnalysisObservationAdapter(
	pi: ExtensionAPI,
	dependencies: AnalysisObservationAdapterDependencies,
): void {
	const createInvocationId = dependencies.createInvocationId ?? randomUUID;
	const mainSource: ObservabilitySource = {
		channel: "main",
		invocationId: createInvocationId(),
		displayLabel: "Main agent",
	};
	let pendingCompaction: ObservabilitySource | undefined;

	pi.on("agent_start", () => dependencies.observability.publish({ type: "agent_start", source: mainSource }));
	pi.on("turn_start", (event) => dependencies.observability.publish({
		type: "turn_start",
		source: mainSource,
		turnIndex: event.turnIndex,
		at: event.timestamp,
	}));
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		dependencies.observability.publish({
			type: "request",
			source: mainSource,
			provider: model.provider,
			api: model.api,
			model: model.id,
			payload: event.payload,
		});
	});
	pi.on("after_provider_response", (event) => {
		dependencies.observability.publish({ type: "response", source: mainSource, status: event.status });
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		dependencies.observability.publish({ type: "assistant", source: mainSource, message: event.message });
	});
	pi.on("session_before_compact", (event, ctx) => {
		pendingCompaction = undefined;
		if (!dependencies.observability.isActive()) return;
		const source: ObservabilitySource = {
			channel: "compaction",
			invocationId: createInvocationId(),
			displayLabel: "Compaction",
		};
		pendingCompaction = source;
		dependencies.observability.publish({ type: "agent_start", source });
		dependencies.observability.publish({ type: "turn_start", source, turnIndex: 0 });
		dependencies.observability.publish({
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
		dependencies.observability.publish({
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
	pi.on("session_compact_failed", () => {
		pendingCompaction = undefined;
	});
	pi.on("session_shutdown", () => {
		pendingCompaction = undefined;
	});
}
