import { describe, expect, it, vi } from "vitest";
import type { ObservabilityEvent } from "../_shared/observability.ts";
import { registerAnalysisObservationAdapter } from "./observation-adapter.ts";

function harness(options: { active?: boolean } = {}) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi: any = {
		on: vi.fn((name: string, handler: (...args: any[]) => any) => handlers.set(name, handler)),
	};
	const events: ObservabilityEvent[] = [];
	const observability = {
		isActive: vi.fn(() => options.active ?? true),
		publish: vi.fn((event: ObservabilityEvent) => events.push(event)),
	};
	const ids = ["main-id", "compaction-1", "compaction-2"];
	registerAnalysisObservationAdapter(pi, {
		observability,
		createInvocationId: () => ids.shift() ?? "extra-id",
	});
	const ctx: any = {
		model: { provider: "openrouter", api: "openai-completions", id: "test-model" },
	};
	return { pi, handlers, events, observability, ctx };
}

function compactionPreparation() {
	return {
		preparation: {
			firstKeptEntryId: "kept",
			messagesToSummarize: [{ role: "user", content: "old" }],
			turnPrefixMessages: [{ role: "assistant", content: "prefix" }],
			isSplitTurn: true,
			tokensBefore: 123,
			previousSummary: "previous",
			fileOps: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
			settings: { keepRecentTokens: 20 },
		},
		customInstructions: "focus",
		reason: "manual",
		willRetry: false,
	};
}

function compactionCompletion(summary = "saved summary") {
	return {
		compactionEntry: {
			summary,
			usage: { input: 2, output: 1, totalTokens: 3 },
			tokensBefore: 123,
			firstKeptEntryId: "kept",
		},
		reason: "manual",
		willRetry: false,
		fromExtension: false,
	};
}

function compactionAssistants(events: ObservabilityEvent[]) {
	return events.filter((event) => event.type === "assistant" && event.source.channel === "compaction");
}

describe("analysis observation adapter", () => {
	it("registers observation hooks and uses one stable Main source", () => {
		const h = harness();
		expect([...h.handlers.keys()]).toEqual([
			"agent_start",
			"turn_start",
			"before_provider_request",
			"after_provider_response",
			"message_end",
			"session_before_compact",
			"session_compact",
			"session_compact_failed",
			"session_shutdown",
		]);

		const payload = { secret: true };
		const assistant = { role: "assistant", content: [{ type: "text", text: "done" }] };
		h.handlers.get("agent_start")!({}, h.ctx);
		h.handlers.get("turn_start")!({ turnIndex: 3, timestamp: 99 }, h.ctx);
		h.handlers.get("before_provider_request")!({ payload }, h.ctx);
		h.handlers.get("after_provider_response")!({ status: 201 }, h.ctx);
		h.handlers.get("message_end")!({ message: assistant }, h.ctx);

		expect(h.events).toEqual([
			{ type: "agent_start", source: { channel: "main", invocationId: "main-id", displayLabel: "Main agent" } },
			{ type: "turn_start", source: { channel: "main", invocationId: "main-id", displayLabel: "Main agent" }, turnIndex: 3, at: 99 },
			{ type: "request", source: { channel: "main", invocationId: "main-id", displayLabel: "Main agent" }, provider: "openrouter", api: "openai-completions", model: "test-model", payload },
			{ type: "response", source: { channel: "main", invocationId: "main-id", displayLabel: "Main agent" }, status: 201 },
			{ type: "assistant", source: { channel: "main", invocationId: "main-id", displayLabel: "Main agent" }, message: assistant },
		]);
	});

	it("observes without replacing values and ignores missing models and non-assistant messages", () => {
		const h = harness();
		expect(h.handlers.get("before_provider_request")!({ payload: { one: 1 } }, h.ctx)).toBeUndefined();
		expect(h.handlers.get("message_end")!({ message: { role: "assistant", content: [] } }, h.ctx)).toBeUndefined();
		const published = h.events.length;
		expect(h.handlers.get("before_provider_request")!({ payload: { two: 2 } }, { ...h.ctx, model: undefined })).toBeUndefined();
		expect(h.handlers.get("message_end")!({ message: { role: "user", content: [] } }, h.ctx)).toBeUndefined();
		expect(h.events).toHaveLength(published);
	});

	it("publishes Compaction preparation in order with preserved payload and model fallback", () => {
		const h = harness();
		const event = compactionPreparation();
		h.handlers.get("session_before_compact")!(event, { ...h.ctx, model: undefined });

		expect(h.events).toEqual([
			{ type: "agent_start", source: { channel: "compaction", invocationId: "compaction-1", displayLabel: "Compaction" } },
			{ type: "turn_start", source: { channel: "compaction", invocationId: "compaction-1", displayLabel: "Compaction" }, turnIndex: 0 },
			{
				type: "request",
				source: { channel: "compaction", invocationId: "compaction-1", displayLabel: "Compaction" },
				provider: "pi",
				api: "pi-compaction",
				model: "unknown",
				fidelity: "pi-preparation",
				payload: {
					instructions: "focus",
					previousSummary: "previous",
					messagesToSummarize: event.preparation.messagesToSummarize,
					turnPrefixMessages: event.preparation.turnPrefixMessages,
					options: {
						reason: "manual",
						willRetry: false,
						isSplitTurn: true,
						tokensBefore: 123,
						firstKeptEntryId: "kept",
						settings: event.preparation.settings,
						fileOps: event.preparation.fileOps,
					},
				},
			},
		]);
	});

	it("does not create Compaction observations while capture is inactive", () => {
		const h = harness({ active: false });
		expect(h.handlers.get("session_before_compact")!(compactionPreparation(), h.ctx)).toBeUndefined();
		expect(h.events).toEqual([]);
	});

	it("correlates successful Compaction once and preserves completion fields", () => {
		const h = harness();
		h.handlers.get("session_before_compact")!(compactionPreparation(), h.ctx);
		const completion = compactionCompletion();
		h.handlers.get("session_compact")!(completion, h.ctx);
		h.handlers.get("session_compact")!(compactionCompletion("late"), h.ctx);

		expect(compactionAssistants(h.events)).toEqual([{
			type: "assistant",
			source: { channel: "compaction", invocationId: "compaction-1", displayLabel: "Compaction" },
			message: {
				role: "assistant",
				content: [{ type: "text", text: "saved summary" }],
				summary: "saved summary",
				usage: completion.compactionEntry.usage,
				tokensBefore: 123,
				firstKeptEntryId: "kept",
				reason: "manual",
				willRetry: false,
				fromExtension: false,
			},
		}]);
	});

	it.each([
		["failure", { aborted: false, errorMessage: "failed" }],
		["abort", { aborted: true }],
	])("clears pending Compaction after %s", (_name, outcome) => {
		const h = harness();
		h.handlers.get("session_before_compact")!(compactionPreparation(), h.ctx);
		h.handlers.get("session_compact_failed")!({ ...outcome, reason: "manual", willRetry: false, fromExtension: false }, h.ctx);
		h.handlers.get("session_compact")!(compactionCompletion("late"), h.ctx);
		expect(compactionAssistants(h.events)).toEqual([]);
	});

	it("clears pending Compaction on shutdown and replaces it on a second preparation", () => {
		const shutdown = harness();
		shutdown.handlers.get("session_before_compact")!(compactionPreparation(), shutdown.ctx);
		shutdown.handlers.get("session_shutdown")!({ reason: "reload" }, shutdown.ctx);
		shutdown.handlers.get("session_compact")!(compactionCompletion("late"), shutdown.ctx);
		expect(compactionAssistants(shutdown.events)).toEqual([]);

		const replaced = harness();
		replaced.handlers.get("session_before_compact")!(compactionPreparation(), replaced.ctx);
		replaced.handlers.get("session_before_compact")!(compactionPreparation(), replaced.ctx);
		replaced.handlers.get("session_compact")!(compactionCompletion(), replaced.ctx);
		expect(compactionAssistants(replaced.events)[0]?.source.invocationId).toBe("compaction-2");

		const inactiveReplacement = harness();
		inactiveReplacement.handlers.get("session_before_compact")!(compactionPreparation(), inactiveReplacement.ctx);
		inactiveReplacement.observability.isActive.mockReturnValue(false);
		inactiveReplacement.handlers.get("session_before_compact")!(compactionPreparation(), inactiveReplacement.ctx);
		inactiveReplacement.handlers.get("session_compact")!(compactionCompletion("late"), inactiveReplacement.ctx);
		expect(compactionAssistants(inactiveReplacement.events)).toEqual([]);
	});
});
