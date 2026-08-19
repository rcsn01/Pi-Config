import { describe, expect, it } from "vitest";
import { collectUsageSnapshot, normalizeContextUsage } from "./usage.ts";
import { buildContextEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";

describe("shared usage snapshot", () => {
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

		expect(collectUsageSnapshot(entries).session).toEqual({
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
		expect(collectUsageSnapshot(entries).session).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			tokens: 0,
			cost: 0,
			turns: 1,
		});
	});

	it("collects named advisor tools and guardian verdict entries without mixing malformed usage", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "advisor",
					usage: { input: 40, output: 5, cacheRead: 7, cacheWrite: 2, cost: { total: 0.4 } },
				},
			},
			{
				type: "custom_message",
				customType: "auto-review-verdict",
				details: { usage: { input: 11, output: 3, cacheRead: 13, cacheWrite: 1, cost: { total: 0.2 } } },
			},
			{
				type: "custom",
				customType: "auto-review-verdict",
				data: { usage: { input: 5, output: 1, cacheRead: 7, cacheWrite: 0 } },
			},
			{
				type: "custom_message",
				customType: "auto-review-verdict",
				details: { usage: { input: -1, output: Number.NaN, cacheRead: "bad", cacheWrite: 0, cost: -2 } },
			},
			{ type: "message", message: { role: "toolResult", toolName: "bash", usage: { input: 999 } } },
		] as unknown as SessionEntry[];

		const usage = collectUsageSnapshot(entries);
		expect(usage.advisor).toMatchObject({
			input: 40, output: 5, cacheRead: 7, cacheWrite: 2, tokens: 54, cost: 0.4, turns: 0,
		});
		expect(usage.guardian).toMatchObject({
			input: 16, output: 4, cacheRead: 20, cacheWrite: 1, tokens: 41, cost: 0.2, turns: 0,
		});
		expect(usage.session).toMatchObject({ input: 1055, output: 9, cacheRead: 27, cacheWrite: 3, tokens: 1094, cost: 0.6000000000000001 });
	});

	it("attributes usage to persisted models across assistants and delegated work", () => {
		const entries = [
			{
				type: "message",
				message: { role: "toolResult", toolName: "bash", usage: { input: 1 } },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt",
					usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, cost: { total: 0.5 } },
				},
			},
			{ type: "model_change", provider: "anthropic", modelId: "claude" },
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude",
					usage: { input: 20, output: 4, cacheRead: 5, cost: { total: 1 } },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "advisor",
					details: { model: "openai/advisor" },
					usage: { input: 5, output: 1, cacheRead: 2, cost: { total: 0.2 } },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					details: { results: [
						{ model: "subagent/one", usage: { input: 7, output: 2, cacheRead: 1, cost: 0.3, turns: 2 } },
						{ model: "subagent/two", usage: { input: 3, output: 1, cacheWrite: 1, cost: 0.1, turns: 1 } },
					] },
				},
			},
			{
				type: "custom_message",
				customType: "auto-review-verdict",
				details: { model: "guardian/model", usage: { input: 9, output: 2, cacheRead: 4, cost: { total: 0.4 } } },
			},
			{
				type: "compaction",
				usage: { input: 2, output: 1, cacheRead: 1, cost: { total: 0.25 } },
			},
		] as unknown as SessionEntry[];

		const snapshot = collectUsageSnapshot(entries);
		expect(snapshot.models.map((row) => row.model)).toEqual([
			"anthropic/claude",
			"openai/gpt",
			"guardian/model",
			"subagent/one",
			"openai/advisor",
			"subagent/two",
			"unknown",
		]);
		expect(snapshot.models[0]).toMatchObject({
			model: "anthropic/claude",
			session: { input: 22, output: 5, cacheRead: 6, cacheWrite: 0, tokens: 33, cost: 1.25, turns: 1 },
		});
		expect(snapshot.models[1]).toMatchObject({
			model: "openai/gpt",
			session: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, tokens: 16, cost: 0.5, turns: 1 },
		});
		expect(snapshot.models[2]).toMatchObject({
			model: "guardian/model",
			guardian: { input: 9, output: 2, cacheRead: 4, cacheWrite: 0, tokens: 15, cost: 0.4, turns: 0 },
		});
		expect(snapshot.models[3]).toMatchObject({
			model: "subagent/one",
			subagent: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, tokens: 10, cost: 0.3, turns: 2 },
		});
		expect(snapshot.models[4]).toMatchObject({
			model: "openai/advisor",
			advisor: { input: 5, output: 1, cacheRead: 2, cacheWrite: 0, tokens: 8, cost: 0.2, turns: 0 },
		});
		expect(snapshot.models[5]).toMatchObject({
			model: "subagent/two",
			subagent: { input: 3, output: 1, cacheRead: 0, cacheWrite: 1, tokens: 5, cost: 0.1, turns: 1 },
		});
		expect(snapshot.models[6]).toMatchObject({
			model: "unknown",
			session: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 1, cost: 0, turns: 0 },
		});
	});

	it("keeps named usage restricted to the active compaction-aware branch", () => {
		const custom = (id: string, parentId: string | null, input: number) => ({
			type: "custom_message",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "auto-review-verdict",
			content: "verdict",
			display: true,
			details: { usage: { input, output: 1, cacheRead: input * 2, cacheWrite: 0, cost: { total: 0 } } },
		});
		const entries = [
			{ type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "start" } },
			custom("abandoned", "user", 1_000),
			custom("retained", "abandoned", 10),
			{ type: "message", id: "assistant", parentId: "retained", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { input: 20, output: 2 } } },
			{ type: "compaction", id: "compact", parentId: "assistant", timestamp: "2026-01-01T00:00:00.000Z", summary: "Earlier work", firstKeptEntryId: "retained", tokensBefore: 1_000 },
			custom("abandoned-post-compact", "compact", 500),
			custom("active-post-compact", "compact", 5),
		] as unknown as SessionEntry[];
		const contextEntries = buildContextEntries(entries, "active-post-compact");
		expect(collectUsageSnapshot(contextEntries).guardian).toMatchObject({
			input: 15, output: 2, cacheRead: 30, tokens: 47,
		});
	});

	it("keeps model rows restricted to the active compaction-aware branch", () => {
		const verdict = (id: string, parentId: string, model: string, input: number) => ({
			type: "custom_message",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "auto-review-verdict",
			content: "verdict",
			display: true,
			details: { model, usage: { input, output: 1, cost: { total: 0 } } },
		});
		const entries = [
			{ type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "start" } },
			{ type: "model_change", id: "change", parentId: "user", timestamp: "2026-01-01T00:00:00.000Z", provider: "main", modelId: "model" },
			{ type: "message", id: "assistant", parentId: "change", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", provider: "main", model: "model", usage: { input: 20, output: 2 } } },
			{ type: "compaction", id: "compact", parentId: "assistant", timestamp: "2026-01-01T00:00:00.000Z", summary: "Earlier work", firstKeptEntryId: "assistant", tokensBefore: 100 },
			verdict("abandoned", "compact", "old/model", 1_000),
			verdict("active", "compact", "new/model", 5),
		] as unknown as SessionEntry[];
		const contextEntries = buildContextEntries(entries, "active");

		const snapshot = collectUsageSnapshot(contextEntries);
		expect(snapshot.models.map((row) => row.model)).toEqual([
			"main/model",
			"new/model",
		]);
		expect(snapshot.models[0]).toMatchObject({
			model: "main/model",
			session: { input: 20, output: 2 },
		});
		expect(snapshot.models[1]).toMatchObject({
			model: "new/model",
			guardian: { input: 5, output: 1 },
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

		expect(collectUsageSnapshot(entries).subagent).toEqual({
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
		const snapshot = collectUsageSnapshot(contextEntries);
		expect(snapshot.subagent).toEqual({
			input: 15,
			output: 2,
			cacheRead: 30,
			cacheWrite: 0,
			tokens: 47,
			cost: 0,
			turns: 0,
		});
		expect(snapshot.session).toMatchObject({
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

		expect(collectUsageSnapshot(entries).subagent).toEqual({
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

		const snapshot = collectUsageSnapshot(entries);
		const expected = {
			input: 20,
			output: 4,
			cacheRead: 50,
			cacheWrite: 6,
			tokens: 80,
			cost: 0.75,
			turns: 0,
		};
		expect(snapshot.subagent).toEqual(expected);
		expect(snapshot.session).toEqual(expected);
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

		expect(collectUsageSnapshot(entries).session).toEqual({
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
