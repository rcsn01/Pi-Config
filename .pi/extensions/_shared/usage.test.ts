import { describe, expect, it } from "vitest";
import { collectSessionUsage, collectSubagentUsage, normalizeContextUsage } from "./usage.ts";
import { buildContextEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";

describe("shared usage", () => {
	it("totals assistant, nested tool, compaction, and branch-summary usage", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{
				type: "message",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						output: 20,
						cacheRead: 30,
						cacheWrite: 5,
						cost: { total: 0.25 },
					},
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					usage: { input: 11, output: 2, cacheRead: 7, cacheWrite: 3, cost: { total: 0.1 } },
				},
			},
			{
				type: "compaction",
				usage: { input: 40, output: 8, cacheRead: 9, cacheWrite: 4, cost: { total: 0.2 } },
			},
			{
				type: "branch_summary",
				usage: { input: 50, output: 10, cacheRead: 12, cacheWrite: 6, cost: { total: 0.3 } },
			},
		] as SessionEntry[];

		expect(collectSessionUsage(entries)).toEqual({
			input: 201,
			output: 40,
			cacheRead: 58,
			cacheWrite: 18,
			tokens: 317,
			cost: 0.8500000000000001,
			turns: 1,
		});
	});

	it("ignores unrelated entries and normalizes malformed usage without changing turn accounting", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: Number.NaN, output: -2, cacheRead: Infinity, cacheWrite: -1, cost: {} },
				},
			},
			{ type: "custom", usage: { input: 999, output: 999, cacheRead: 999 } },
			{ type: "message", message: { role: "user", usage: { input: 999 } } },
		] as unknown as SessionEntry[];
		expect(collectSessionUsage(entries)).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			tokens: 0,
			cost: 0,
			turns: 1,
		});
	});

	it("accumulates every single and parallel subagent result across the supplied history", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					details: { results: [
						{ usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4, cost: 0.1, turns: 1 } },
					] },
				},
			},
			{ type: "message", message: { role: "assistant", usage: { input: 100, output: 20 } } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					details: { mode: "parallel", results: [
						{ usage: { input: 5, output: 1, cacheRead: 7, cacheWrite: 3, cost: 0.2, turns: 2 } },
						{ usage: { input: 8, output: 4, cacheRead: 9, cacheWrite: 6, cost: 0.3, turns: 3 } },
					] },
				},
			},
		] as unknown as SessionEntry[];

		expect(collectSubagentUsage(entries)).toEqual({
			input: 23,
			output: 7,
			cacheRead: 46,
			cacheWrite: 13,
			tokens: 89,
			cost: 0.6000000000000001,
			turns: 6,
		});
	});

	it("counts only subagents retained on the active compaction-aware branch", () => {
		const subagent = (id: string, parentId: string | null, input: number) => ({
			type: "message",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult",
				toolName: "subagent",
				usage: { input, output: 1, cacheRead: input * 2, cacheWrite: 0, cost: { total: 0 } },
			},
		});
		const entries = [
			{ type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "start" } },
			subagent("summarized", "user", 1_000),
			subagent("retained", "summarized", 10),
			{ type: "message", id: "assistant", parentId: "retained", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { input: 20, output: 2 } } },
			{ type: "compaction", id: "compact", parentId: "assistant", timestamp: "2026-01-01T00:00:00.000Z", summary: "Earlier work", firstKeptEntryId: "retained", tokensBefore: 1_000 },
			subagent("abandoned-post-compact", "compact", 500),
			subagent("active-post-compact", "compact", 5),
		] as unknown as SessionEntry[];

		const contextEntries = buildContextEntries(entries, "active-post-compact");
		expect(contextEntries.map((entry) => entry.id)).toEqual([
			"compact", "retained", "assistant", "active-post-compact",
		]);
		expect(collectSubagentUsage(contextEntries)).toEqual({
			input: 15,
			output: 2,
			cacheRead: 30,
			cacheWrite: 0,
			tokens: 47,
			cost: 0,
			turns: 0,
		});
		expect(collectSessionUsage(contextEntries)).toMatchObject({
			input: 35,
			output: 4,
			cacheRead: 30,
			turns: 1,
		});
	});

	it("ignores unrelated and malformed results and normalizes invalid usage values", () => {
		const entries = [
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: { results: [{ usage: { input: 999 } }] } } },
			{ type: "message", message: { role: "toolResult", toolName: "subagent", details: null } },
			{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: "invalid" } } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					details: { results: [null, {}, { usage: {
						input: -1,
						output: Number.NaN,
						cacheRead: Infinity,
						cacheWrite: "4",
						cost: -2,
						turns: -3,
					} }] },
				},
			},
		] as unknown as SessionEntry[];

		expect(collectSubagentUsage(entries)).toEqual({
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, turns: 0,
		});
	});

	it("prefers persisted top-level subagent usage without double counting nested details", () => {
		const entries = [{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "subagent",
				usage: {
					input: 20,
					output: 4,
					cacheRead: 50,
					cacheWrite: 6,
					cost: { total: 0.75 },
				},
				details: { results: [{ usage: {
					input: 999, output: 999, cacheRead: 999, cacheWrite: 999, cost: 999, turns: 999,
				} }] },
			},
		}] as unknown as SessionEntry[];

		const expected = {
			input: 20,
			output: 4,
			cacheRead: 50,
			cacheWrite: 6,
			tokens: 80,
			cost: 0.75,
			turns: 0,
		};
		expect(collectSubagentUsage(entries)).toEqual(expected);
		expect(collectSessionUsage(entries)).toEqual(expected);
	});

	it("includes historical nested subagent usage in session totals but only counts assistant turns", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: { input: 100, output: 10 } } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					details: { results: [
						{ usage: { input: 5, output: 2, cacheRead: 8, cacheWrite: 1, cost: 0.2, turns: 7 } },
					] },
				},
			},
		] as unknown as SessionEntry[];

		expect(collectSessionUsage(entries)).toEqual({
			input: 105,
			output: 12,
			cacheRead: 8,
			cacheWrite: 1,
			tokens: 126,
			cost: 0.2,
			turns: 1,
		});
	});

	it("normalizes reported, derived, and post-compaction context pressure", () => {
		expect(normalizeContextUsage({ tokens: 5_000, contextWindow: 10_000, percent: null })).toEqual({
			tokens: 5_000,
			contextWindow: 10_000,
			percent: 50,
		});
		expect(normalizeContextUsage({ tokens: null, contextWindow: 0, percent: null }, 200_000)).toEqual({
			tokens: null,
			contextWindow: 200_000,
			percent: null,
		});
		expect(normalizeContextUsage({ tokens: 20_000, contextWindow: 10_000, percent: 200 })).toMatchObject({
			percent: 100,
		});
	});
});