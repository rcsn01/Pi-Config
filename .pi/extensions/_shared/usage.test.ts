import { describe, expect, it } from "vitest";
import { collectSessionUsage, normalizeContextUsage } from "./usage.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

describe("shared usage", () => {
	it("totals assistant usage and ignores non-assistant entries", () => {
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
		] as SessionEntry[];

		expect(collectSessionUsage(entries)).toEqual({
			input: 100,
			output: 20,
			cacheRead: 30,
			cacheWrite: 5,
			tokens: 155,
			cost: 0.25,
			turns: 1,
		});
	});

	it("treats absent and non-finite usage values as zero", () => {
		const entries = [{
			type: "message",
			message: {
				role: "assistant",
				usage: { input: Number.NaN, output: -2, cacheRead: Infinity, cost: {} },
			},
		}] as unknown as SessionEntry[];
		expect(collectSessionUsage(entries)).toMatchObject({ tokens: 0, cost: 0, turns: 1 });
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