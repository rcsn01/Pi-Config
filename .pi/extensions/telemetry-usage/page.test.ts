import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { TELEMETRY_USAGE_PAGE } from "./page.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, turns: 0 };
const used = { input: 1000, output: 50, cacheRead: 200, cacheWrite: 25, tokens: 1275, cost: 1.2345, turns: 3 };
const emptyModes = () => ({ main: { ...zero }, plan: { ...zero }, subagent: { ...zero }, advisor: { ...zero }, guardian: { ...zero } });
const emptyModels = () => ({ main: [], plan: [], subagent: [], advisor: [], guardian: [] });

function payload() {
	const totals = emptyModes();
	totals.main = { ...used };
	const models: any = emptyModels();
	models.main = [{ model: "anthropic/claude", usage: { ...used } }];
	const daily = Array.from({ length: 30 }, (_, index) => ({
		start: new Date(2026, 0, index + 1).getTime(),
		usage: index === 29 ? { ...used } : { ...zero },
	}));
	const hourly = Array.from({ length: 168 }, (_, index) => ({
		start: new Date(2026, 0, 24, index).getTime(),
		usage: index === 167 ? { ...used } : { ...zero },
	}));
	const session = {
		file: "/secret/session.jsonl",
		id: "session-1",
		cwd: "/projects/alpha",
		created: "2026-01-01T00:00:00.000Z",
		name: "Alpha session",
		firstMessage: "Build <img src=x onerror=alert(1)>",
		messageCount: 4,
		totals,
		total: { ...used },
		models,
	};
	return {
		scannedAt: 1,
		sessionCount: 1,
		modelCount: 1,
		totals,
		total: { ...used },
		models,
		series: { daily, hourly },
		sessions: [session],
	};
}

function modernPayload() {
	const next: any = payload();
	const daily = Array.from({ length: 365 }, (_, index) => ({
		start: new Date(2025, 0, 10 + index).getTime(),
		usage: index === 364 ? { ...used } : { ...zero },
	}));
	next.activity = {
		daily,
		weekly: [
			{ start: daily[0].start, usage: { ...used } },
			{ start: daily[7].start, usage: { input: 500, output: 25, cacheRead: 100, cacheWrite: 15, tokens: 640, cost: 0.6, turns: 1 } },
		],
		cumulative: [
			{ start: daily[0].start, usage: { ...used } },
			{ start: daily[7].start, usage: { input: 1500, output: 75, cacheRead: 300, cacheWrite: 40, tokens: 1915, cost: 1.8345, turns: 4 } },
		],
	};
	next.overview = {
		lifetimeTokens: 1275,
		peakDailyTokens: 1275,
		peakDailyStart: daily[364].start,
		longestChatTurns: 4,
		currentStreakDays: 2,
		longestStreakDays: 5,
		planModeShare: 2,
		mostUsedModel: { model: "anthropic/claude", tokens: 1275, share: 100 },
		totalToolRuns: 8,
	};
	next.tools = [{ tool: "read", runs: 5 }, { tool: "bash", runs: 3 }];
	return next;
}

function script() {
	return TELEMETRY_USAGE_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
}

async function flush() {
	for (let index = 0; index < 24; index++) await Promise.resolve();
}

describe("telemetry usage page", () => {
	it("is standalone, syntax-valid, responsive, and uses safe DOM insertion", () => {
		expect(TELEMETRY_USAGE_PAGE).not.toMatch(/<script[^>]+src=/i);
		expect(TELEMETRY_USAGE_PAGE).not.toMatch(/<link[^>]+href=/i);
		expect(TELEMETRY_USAGE_PAGE).not.toContain("innerHTML");
		expect(TELEMETRY_USAGE_PAGE).toContain("textContent");
		expect(TELEMETRY_USAGE_PAGE).toContain("@media (max-width: 760px)");
		expect(TELEMETRY_USAGE_PAGE).toContain('role="tablist"');
		expect(TELEMETRY_USAGE_PAGE).not.toContain("<h1>Global usage</h1>");
		expect(TELEMETRY_USAGE_PAGE).not.toContain("Token usage and cost across persisted Pi sessions.");
		expect(() => new Function(script())).not.toThrow();
	});

	it("renders totals, mode tabs, safe session detail, search, and selection", async () => {
		const { window, document } = parseHTML(TELEMETRY_USAGE_PAGE);
		const fetch = vi.fn(async (_path: string, options: any) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ phase: "ready", data: payload() }),
			options,
		}));
		Object.assign(window, {
			location: { hash: "#token=test-token", pathname: "/", search: "" },
			history: { replaceState: () => {} },
			fetch,
			setTimeout: () => 1,
			clearTimeout: () => {},
		});
		vm.runInContext(script(), vm.createContext(window));
		await flush();

		expect(fetch.mock.calls[0]?.[0]).toBe("/api/usage");
		expect(document.getElementById("status")?.hidden).toBe(true);
		expect(document.getElementById("status")?.textContent).toBe("");
		expect(document.getElementById("cards")?.textContent).toContain("1,275");
		expect(document.getElementById("panel")?.textContent).toContain("Daily usage");
		expect(document.getElementById("panel")?.textContent).toContain("Last 30 days");
		expect(document.getElementById("panel")?.textContent).toContain("Hourly usage");
		expect(document.getElementById("panel")?.textContent).toContain("Last 7 days");
		expect(document.querySelectorAll(".chart-card")).toHaveLength(2);
		expect(document.querySelectorAll(".chart-bar")).toHaveLength(198);
		expect(document.querySelector(".chart-bar[title*='1,275 tokens']")).not.toBeNull();
		expect(document.getElementById("panel")?.textContent).toContain("Cache write");
		expect(document.getElementById("panel")?.textContent).toContain("$1.234");

		const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Overview", "Main", "Plan mode", "Subagent", "Advisor", "Guardian", "Sessions (1)",
		]);
		tabs[1]!.click();
		expect(document.getElementById("panel")?.textContent).toContain("anthropic/claude");
		tabs[2]!.click();
		expect(document.getElementById("panel")?.textContent).toContain("No usage recorded");
		tabs[6]!.click();
		expect(document.querySelector(".session-detail")?.textContent).toContain("/secret/session.jsonl");
		expect(document.querySelector(".first-message")?.textContent).toContain("<img src=x onerror=alert(1)>");
		expect(document.querySelector(".first-message img")).toBeNull();

		const search = document.getElementById("session-search") as HTMLInputElement;
		search.value = "missing";
		search.dispatchEvent(new window.Event("input"));
		expect(document.querySelector(".sessions-layout")?.textContent).toContain("No sessions match this search");
		search.value = "alpha";
		search.dispatchEvent(new window.Event("input"));
		expect(document.querySelector(".session-title")?.textContent).toBe("Alpha session");
	});

	it("renders reference-style overview cards, heatmap views, insights, and tools", async () => {
		const { window, document } = parseHTML(TELEMETRY_USAGE_PAGE);
		Object.assign(window, {
			location: { hash: "#token=test-token", pathname: "/", search: "" },
			history: { replaceState: () => {} },
			fetch: async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ phase: "ready", data: modernPayload() }) }),
			setTimeout: () => 1,
			clearTimeout: () => {},
		});
		vm.runInContext(script(), vm.createContext(window));
		await flush();

		expect(document.querySelectorAll(".overview-card")).toHaveLength(5);
		expect(document.getElementById("cards")?.textContent).toContain("Lifetime tokens");
		expect(document.getElementById("cards")?.textContent).toContain("Peak day");
		expect(document.getElementById("cards")?.textContent).toContain("assistant turns");
		expect(document.getElementById("cards")?.textContent).toContain("Activity streak");
		expect(document.getElementById("cards")?.textContent).toContain("Sessions");
		expect(document.getElementById("cards")?.textContent).toContain("1.3k");
		expect(document.querySelectorAll(".heatmap-cell")).toHaveLength(365);
		expect(document.querySelector(".activity-card figcaption")).toBeNull();
		expect(document.querySelector(".activity-card")?.textContent).not.toContain("Daily token activity");
		expect(document.querySelector(".activity-card")?.textContent).not.toContain("Last 12 months");
		expect(document.querySelector(".heatmap-weekdays")).toBeNull();
		const usedDay = document.querySelector(".heatmap-grid .heatmap-cell.level-4")!;
		expect(usedDay.getAttribute("aria-label")).toContain("1.3k tokens on 9 Jan");
		usedDay.dispatchEvent(new window.Event("mouseenter"));
		const tip = document.querySelector(".heatmap-tip")!;
		expect(tip.classList.contains("visible")).toBe(true);
		expect(tip.textContent).toContain("1.3k tokens on 9 Jan");
		usedDay.dispatchEvent(new window.Event("mouseleave"));
		expect(tip.classList.contains("visible")).toBe(false);
		expect(document.querySelector(".heatmap-grid .heatmap-cell.level-0")!.hasAttribute("aria-label")).toBe(false);
		expect(document.getElementById("panel")?.textContent).toContain("Activity insights");
		expect(document.getElementById("panel")?.textContent).toContain("Most used model");
		expect(document.getElementById("panel")?.textContent).toContain("read");
		expect(document.getElementById("panel")?.textContent).toContain("5 runs");

		const weekly = document.querySelector<HTMLButtonElement>('[data-activity="weekly"]')!;
		weekly.click();
		expect(document.querySelectorAll(".activity-tab[aria-selected=\"true\"]")).toHaveLength(1);
		expect(document.querySelector(".activity-card")?.getAttribute("aria-label")).toBe("Weekly token activity");
		expect(document.querySelectorAll(".heatmap-grid .heatmap-cell")).toHaveLength(371);
		expect(document.querySelectorAll(".heatmap-grid .heatmap-cell.fill-on")).toHaveLength(11);
		const weeklyCells = document.querySelectorAll(".heatmap-grid .heatmap-cell");
		expect(weeklyCells[0]!.classList.contains("fill-on")).toBe(true);
		expect(weeklyCells[0]!.getAttribute("aria-label")).toContain("1.3k tokens on the week of 6 Jan");
		expect(weeklyCells[7]!.classList.contains("fill-on")).toBe(false);
		expect(weeklyCells[7]!.hasAttribute("aria-label")).toBe(false);
		expect(weeklyCells[10]!.classList.contains("fill-on")).toBe(true);
		expect(weeklyCells[10]!.getAttribute("aria-label")).toContain("640 tokens on the week of 13 Jan");
		expect(weeklyCells[14]!.classList.contains("fill-on")).toBe(false);
		expect(weeklyCells[14]!.hasAttribute("aria-label")).toBe(false);
		const cumulative = document.querySelector<HTMLButtonElement>('[data-activity="cumulative"]')!;
		const keydown = new window.Event("keydown");
		Object.defineProperty(keydown, "key", { value: "ArrowLeft" });
		cumulative.dispatchEvent(keydown);
		expect(document.querySelector(".activity-tab[aria-selected=\"true\"]")?.getAttribute("data-activity")).toBe("weekly");
		cumulative.click();
		expect(document.querySelector(".activity-card")?.getAttribute("aria-label")).toBe("Cumulative token activity");
		expect(document.querySelector(".activity-card")?.textContent).not.toContain("running total");
		expect(document.querySelectorAll(".heatmap-grid .heatmap-cell.fill-on")).toHaveLength(12);
		const cumulativeCells = document.querySelectorAll(".heatmap-grid .heatmap-cell");
		expect(cumulativeCells[0]!.classList.contains("fill-on")).toBe(false);
		expect(cumulativeCells[0]!.hasAttribute("aria-label")).toBe(false);
		expect(cumulativeCells[2]!.getAttribute("aria-label")).toContain("1.3k tokens to date on the week of 6 Jan");
		expect(cumulativeCells[7]!.getAttribute("aria-label")).toContain("1.9k tokens to date on the week of 13 Jan");
		expect(cumulativeCells[14]!.classList.contains("fill-on")).toBe(false);
		expect(cumulativeCells[14]!.hasAttribute("aria-label")).toBe(false);
	});

	it("polls only while scanning and starts a new scan from Refresh", async () => {
		const { window, document } = parseHTML(TELEMETRY_USAGE_PAGE);
		let timer: (() => void) | undefined;
		const responses = [
			{ phase: "scanning", progress: { loaded: 2, total: 5 } },
			{ phase: "ready", data: payload() },
			{ phase: "scanning" },
		];
		const calls: Array<{ path: string; method?: string }> = [];
		Object.assign(window, {
			location: { hash: "#token=test", pathname: "/", search: "" },
			history: { replaceState: () => {} },
			setTimeout: (callback: () => void) => { timer = callback; return 1; },
			clearTimeout: () => {},
			fetch: async (path: string, options: any = {}) => {
				calls.push({ path, method: options.method });
				if (path === "/api/refresh") return { ok: true, status: 202, statusText: "Accepted", json: async () => ({ accepted: true }) };
				const body = responses.shift() ?? { phase: "ready", data: payload() };
				return { ok: true, status: 200, statusText: "OK", json: async () => body };
			},
		});
		vm.runInContext(script(), vm.createContext(window));
		await flush();
		expect(document.getElementById("status")?.textContent).toContain("2/5");
		expect(timer).toBeTypeOf("function");

		const scheduled = timer!;
		timer = undefined;
		scheduled();
		await flush();
		expect(document.getElementById("status")?.hidden).toBe(true);
		expect(document.getElementById("status")?.textContent).toBe("");
		expect(timer).toBeUndefined();

		(document.getElementById("refresh") as HTMLButtonElement).click();
		await flush();
		expect(calls).toContainEqual({ path: "/api/refresh", method: "POST" });
		expect(document.getElementById("status")?.textContent).toContain("Scanning sessions");
		expect(timer).toBeTypeOf("function");
	});

	it("does not call the server when the capability token is missing", () => {
		const { window, document } = parseHTML(TELEMETRY_USAGE_PAGE);
		const fetch = vi.fn();
		Object.assign(window, {
			location: { hash: "", pathname: "/", search: "" },
			history: { replaceState: vi.fn() },
			fetch,
			setTimeout: () => 1,
			clearTimeout: () => {},
		});
		vm.runInContext(script(), vm.createContext(window));
		expect(fetch).not.toHaveBeenCalled();
		expect(document.getElementById("fatal")?.textContent).toContain("missing its capability token");
	});
});
