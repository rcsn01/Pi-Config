import { describe, expect, it } from "vitest";
import { buildGlobalUsageSnapshot, type GlobalSessionRecord } from "../_shared/global-usage.ts";
import { toTelemetryUsagePayload } from "./payload.ts";

function record(overrides: Partial<GlobalSessionRecord> = {}): GlobalSessionRecord {
	return {
		file: "/sessions/a.jsonl",
		id: "session-a",
		cwd: "/project/a",
		created: "2026-01-01T00:00:00.000Z",
		name: "Named session",
		firstMessage: "Build the thing",
		messageCount: 4,
		parentSession: "/sessions/parent.jsonl",
		entries: [{
			id: "usage-a",
			mode: "main",
			model: "anthropic/claude",
			timestamp: new Date(2026, 0, 30, 12, 5).getTime(),
			input: 10,
			output: 3,
			cacheRead: 4,
			cacheWrite: 2,
			cost: 0.125,
			turns: 1,
		}],
		...overrides,
	};
}

describe("toTelemetryUsagePayload", () => {
	it("preserves global and per-session usage in a detached wire payload", () => {
		const snapshot = buildGlobalUsageSnapshot([record()]);
		snapshot.scannedAt = 123;
		const payload = toTelemetryUsagePayload(snapshot, new Date(2026, 0, 30, 12, 30).getTime());

		expect(payload).toMatchObject({
			scannedAt: 123,
			sessionCount: 1,
			modelCount: 1,
			total: { input: 10, output: 3, cacheRead: 4, cacheWrite: 2, tokens: 19, cost: 0.125, turns: 1 },
			sessions: [{
				file: "/sessions/a.jsonl",
				id: "session-a",
				cwd: "/project/a",
				name: "Named session",
				parentSession: "/sessions/parent.jsonl",
				firstMessage: "Build the thing",
				messageCount: 4,
			}],
		});
		expect(payload.models.main[0]).toEqual({
			model: "anthropic/claude",
			usage: expect.objectContaining({ tokens: 19 }),
		});

		payload.total.input = 999;
		payload.totals.main.output = 999;
		payload.models.main[0]!.usage.cacheRead = 999;
		payload.sessions[0]!.total.tokens = 999;
		payload.series.daily.at(-1)!.usage.tokens = 999;
		expect(snapshot.total.input).toBe(10);
		expect(snapshot.totals.main.output).toBe(3);
		expect(snapshot.models.main[0]!.usage.cacheRead).toBe(4);
		expect(snapshot.sessions[0]!.total.tokens).toBe(19);
		expect(snapshot.timeline[0]!.input).toBe(10);
	});

	it("builds 30 local-day buckets and 168 rolling-hour buckets", () => {
		const now = new Date(2026, 0, 30, 12, 30).getTime();
		const morning = record({
			entries: [
				{ ...record().entries[0]!, id: "morning", timestamp: new Date(2026, 0, 30, 11, 15).getTime() },
				{ ...record().entries[0]!, id: "noon", timestamp: new Date(2026, 0, 30, 12, 5).getTime() },
			],
		});
		const payload = toTelemetryUsagePayload(buildGlobalUsageSnapshot([morning]), now);
		expect(payload.series.daily).toHaveLength(30);
		expect(payload.series.hourly).toHaveLength(168);
		expect(new Date(payload.series.daily[0]!.start).getDate()).toBe(1);
		expect(payload.series.daily.at(-1)!.usage).toMatchObject({ tokens: 38, turns: 2, cost: 0.25 });
		expect(payload.series.hourly.at(-2)!.usage.tokens).toBe(19);
		expect(payload.series.hourly.at(-1)!.usage.tokens).toBe(19);
	});

	it("builds the 12-month activity series and safe overview metrics", () => {
		const now = new Date(2026, 0, 8, 12, 30).getTime();
		const usage = (id: string, day: number, mode: "main" | "plan" = "main") => ({
			id,
			mode,
			model: "anthropic/claude",
			timestamp: new Date(2026, 0, day, 12).getTime(),
			input: day,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 1,
		});
		const snapshot = buildGlobalUsageSnapshot([record({
			entries: [usage("e2", 2), usage("e3", 3), usage("e6", 6), usage("e7", 7), usage("e8", 8, "plan")],
			activity: [
				{ id: "a1", kind: "assistant" },
				{ id: "a2", kind: "assistant" },
				{ id: "a3", kind: "assistant" },
				{ id: "t1", kind: "tool", toolName: "read" },
			],
		})]);
		const payload = toTelemetryUsagePayload(snapshot, now);

		expect(payload.activity.daily).toHaveLength(365);
		expect(payload.activity.weekly.length).toBeGreaterThanOrEqual(52);
		expect(payload.activity.cumulative).toHaveLength(payload.activity.weekly.length);
		expect(payload.activity.cumulative.at(-1)?.usage.tokens).toBe(payload.total.tokens);
		expect(payload.overview).toMatchObject({
			lifetimeTokens: 26,
			peakDailyTokens: 8,
			currentStreakDays: 3,
			longestStreakDays: 3,
			longestChatTurns: 3,
			totalToolRuns: 1,
			planModeShare: (8 / 26) * 100,
		});
		expect(payload.overview.mostUsedModel).toMatchObject({ model: "anthropic/claude", tokens: 26, share: 100 });
		expect(payload.tools).toEqual([{ tool: "read", runs: 1 }]);
	});

	it("uses local calendar days across leap days", () => {
		const now = new Date(2024, 2, 1, 12).getTime();
		const leapDay = { ...record().entries[0]!, id: "leap-day", timestamp: new Date(2024, 1, 29, 12).getTime() };
		const payload = toTelemetryUsagePayload(buildGlobalUsageSnapshot([record({ entries: [leapDay] })]), now);
		const leapPoint = payload.activity.daily.find((point) => {
			const date = new Date(point.start);
			return date.getFullYear() === 2024 && date.getMonth() === 1 && date.getDate() === 29;
		});
		expect(leapPoint?.usage.tokens).toBe(19);
		expect(payload.activity.daily).toHaveLength(365);
		for (let index = 1; index < payload.activity.daily.length; index++) {
			const previous = new Date(payload.activity.daily[index - 1]!.start);
			const current = new Date(payload.activity.daily[index]!.start);
			previous.setDate(previous.getDate() + 1);
			expect(current.toDateString()).toBe(previous.toDateString());
		}
	});

	it("handles an inactive today while preserving the previous-day streak", () => {
		const now = new Date(2026, 0, 8, 12).getTime();
		const entries = [
			{ ...record().entries[0]!, id: "e6", timestamp: new Date(2026, 0, 6, 12).getTime() },
			{ ...record().entries[0]!, id: "e7", timestamp: new Date(2026, 0, 7, 12).getTime() },
		];
		const payload = toTelemetryUsagePayload(buildGlobalUsageSnapshot([record({ entries })]), now);
		expect(payload.overview.currentStreakDays).toBe(2);
		expect(payload.overview.longestStreakDays).toBe(2);
	});

	it("preserves server ordering and optional metadata", () => {
		const costly = record({ file: "/sessions/costly.jsonl", id: "costly", name: undefined, parentSession: undefined });
		const cheap = record({
			file: "/sessions/cheap.jsonl",
			id: "cheap",
			created: "2026-01-02T00:00:00.000Z",
			entries: [{
				id: "usage-b", mode: "plan", model: "openai/gpt", input: 1, output: 0,
				cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1,
			}],
		});
		const payload = toTelemetryUsagePayload(buildGlobalUsageSnapshot([cheap, costly]));
		expect(payload.sessions.map((session) => session.id)).toEqual(["costly", "cheap"]);
		expect(payload.sessions[0]).not.toHaveProperty("name");
		expect(payload.sessions[0]).not.toHaveProperty("parentSession");
	});

	it("supports an empty snapshot", () => {
		const payload = toTelemetryUsagePayload(buildGlobalUsageSnapshot([]));
		expect(payload).toMatchObject({ sessionCount: 0, modelCount: 0, sessions: [], total: { tokens: 0 } });
	});
});
