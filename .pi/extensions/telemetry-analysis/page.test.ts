import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { DASHBOARD_CLIENT_HELPERS } from "../_shared/dashboard-client.ts";
import { ANALYSIS_PAGE } from "./page.ts";
import { ANALYSIS_PAGE_CLIENT } from "./page-client.ts";

describe("analysis page", () => {
	it("is dependency-free and inserts captured values with textContent", () => {
		expect(ANALYSIS_PAGE).not.toMatch(/<script[^>]+src=/i);
		expect(ANALYSIS_PAGE).not.toMatch(/<link[^>]+href=/i);
		expect(ANALYSIS_PAGE).not.toMatch(/https?:\/\//i);
		expect(ANALYSIS_PAGE).toContain("textContent");
		expect(ANALYSIS_PAGE).not.toContain("innerHTML");
		expect(ANALYSIS_PAGE).toContain(DASHBOARD_CLIENT_HELPERS);
		expect(ANALYSIS_PAGE.indexOf(DASHBOARD_CLIENT_HELPERS)).toBeLessThan(ANALYSIS_PAGE.indexOf(ANALYSIS_PAGE_CLIENT));
		expect(ANALYSIS_PAGE_CLIENT).not.toContain(["Arrow", "Right"].join(""));
		expect(ANALYSIS_PAGE_CLIENT).not.toContain(["Arrow", "Left"].join(""));
		expect(ANALYSIS_PAGE_CLIENT).not.toContain("event.key === 'Home'");
		expect(ANALYSIS_PAGE).not.toContain("OpenAI request analysis");
		expect(ANALYSIS_PAGE).not.toContain("Pi provider request analysis");
		expect(ANALYSIS_PAGE).not.toContain("Captured prompts and tool data may contain secrets.");
		expect(ANALYSIS_PAGE).not.toContain("Section-level cache placement is estimated");
		expect(ANALYSIS_PAGE).not.toContain("request parts");
		expect(ANALYSIS_PAGE).not.toContain("Tool rows include each transmitted tool description and parameter schema");
		expect(ANALYSIS_PAGE).toContain("Expand all");
		expect(ANALYSIS_PAGE).toContain("Collapse all");
		expect(ANALYSIS_PAGE).toContain("details.analysis-section[open]");
		for (const tokenClass of ["token-input", "token-cache-input", "token-cache-write", "token-output", "token-reasoning"]) {
			expect(ANALYSIS_PAGE).toContain(tokenClass);
		}
		const script = ANALYSIS_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1];
		expect(() => new Function(script!)).not.toThrow();
	});

	it("filters source tabs and subagent requests, reports counts, and restores selections", async () => {
		const { window, document } = parseHTML(ANALYSIS_PAGE);
		const records = [
			{ sequence: 1, source: { channel: "main", invocationId: "main", displayLabel: "Main agent" }, provider: "openai", model: "main", api: "openai-responses", apiLabel: "OpenAI Responses", run: 1, turn: 0, requestedAt: 1, state: "complete", correlation: "exact", bytes: 10, fidelity: "exact-provider" },
			{ sequence: 2, source: { channel: "main", invocationId: "main", displayLabel: "Main agent" }, provider: "openai", model: "main", api: "openai-responses", apiLabel: "OpenAI Responses", run: 1, turn: 1, requestedAt: 2, state: "complete", correlation: "exact", bytes: 10, fidelity: "exact-provider", requestActivities: [
				{ kind: "user-input", count: 1 },
				{ kind: "tool-result", count: 1, labels: ["read"] },
			], responseActivities: [
				{ kind: "thinking", count: 1 },
				{ kind: "tool-call-request", count: 1, labels: ["bash"] },
				{ kind: "output", count: 1 },
			], usage: { input: 10, cacheRead: 20, cacheWrite: 5, output: 15, reasoning: 5, totalTokens: 50, cost: { total: 0 } } },
			{ sequence: 3, source: { channel: "subagent", invocationId: "worker-1", displayLabel: "worker" }, provider: "openai", model: "worker", api: "openai-responses", apiLabel: "OpenAI Responses", run: 1, turn: 0, requestedAt: 3, state: "complete", correlation: "exact", bytes: 10, fidelity: "exact-provider" },
			{ sequence: 4, source: { channel: "subagent", invocationId: "explorer-1", displayLabel: "explorer" }, provider: "openai", model: "explorer", api: "openai-responses", apiLabel: "OpenAI Responses", run: 1, turn: 0, requestedAt: 4, state: "complete", correlation: "exact", bytes: 10, fidelity: "exact-provider" },
			{ sequence: 5, source: { channel: "advisor", invocationId: "advisor-1", displayLabel: "Advisor" }, provider: "anthropic", model: "strong", api: "anthropic-messages", apiLabel: "Anthropic Messages", run: 1, turn: 0, requestedAt: 5, state: "complete", correlation: "exact", bytes: 10, fidelity: "pi-preparation" },
			{ sequence: 6, source: { channel: "compaction", invocationId: "compact-1", displayLabel: "Compaction" }, provider: "pi", model: "openai/main", api: "pi-compaction", apiLabel: "Pi Compaction Preparation", run: 1, turn: 0, requestedAt: 6, state: "complete", correlation: "exact", bytes: 10, fidelity: "pi-preparation" },
		];
		Object.assign(window, {
			location: { hash: "#token=test", pathname: "/" }, history: { replaceState: () => {} }, setInterval: () => 1,
			fetch: async (url: string) => ({ ok: true, status: 200, json: async () => {
				if (url === "/api/summary") return { activatedAt: 1, paused: false, records };
				const sequence = Number(url.split("/").at(-1));
				return { ...records.find((record) => record.sequence === sequence), requestJson: "{}", assistantJson: "{}", sections: [] };
			} }),
		});
		const script = ANALYSIS_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1];
		vm.runInContext(script!, vm.createContext(window));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
		expect(document.querySelector("main")?.firstElementChild?.id).toBe("sourceTabs");
		expect(document.getElementById("activation")?.classList.contains("hidden")).toBe(true);
		expect(document.getElementById("activation")?.textContent).toBe("");
		expect(tabs.map((tab) => tab.textContent)).toEqual(["Main (2)", "Subagents (2)", "Advisor (1)", "Guardian (0)", "Compaction (1)"]);
		expect(tabs.map((tab) => [tab.id, tab.getAttribute("aria-controls"), tab.getAttribute("tabindex")])).toEqual([
			["tab-main", "sourcePanel", "0"], ["tab-subagent", "sourcePanel", "-1"],
			["tab-advisor", "sourcePanel", "-1"], ["tab-guardian", "sourcePanel", "-1"],
			["tab-compaction", "sourcePanel", "-1"],
		]);
		expect(document.getElementById("sourcePanel")?.getAttribute("aria-labelledby")).toBe("tab-main");
		const requestBars = Array.from(document.querySelectorAll<HTMLElement>(".request-usage-bar"));
		expect(requestBars).toHaveLength(4);
		expect(Array.from(requestBars[0]!.children, (segment) => [segment.className, segment.getAttribute("style")])).toEqual([
			["token-output", "width:66.66666666666667%"], ["token-reasoning", "width:33.333333333333336%"],
		]);
		expect(requestBars[0]!.getAttribute("aria-label")).toContain("Output: 10 tokens (66.7%)");
		expect(Array.from(requestBars[1]!.children, (segment) => [segment.className, segment.getAttribute("style")])).toEqual([
			["token-input", "width:28.571428571428573%"], ["token-cache-input", "width:57.142857142857146%"], ["token-cache-write", "width:14.285714285714286%"],
		]);
		expect(requestBars[1]!.getAttribute("aria-label")).toContain("Cache input: 20 tokens (57.1%)");
		expect(requestBars[2]!.classList.contains("usage-unavailable")).toBe(true);
		expect(requestBars[3]!.classList.contains("usage-unavailable")).toBe(true);
		expect(document.querySelector(".detail-pane h2")?.textContent).toContain("Response #2");
		expect(document.querySelector(".request-row.selected")?.parentElement?.querySelector(".request-group-title")?.textContent).toBe("openai/main");
		expect(Array.from(document.querySelectorAll(".request-group-title"), (row) => row.textContent)).toEqual([
			"openai/main", "openai/main",
		]);
		expect(Array.from(document.querySelectorAll<HTMLButtonElement>(".request-row"), (row) => [row.dataset.sequence, row.dataset.part])).toEqual([
			["2", "response"], ["2", "request"], ["1", "response"], ["1", "request"],
		]);
		expect(Array.from(document.querySelectorAll(".request-row.selected .activity-badge"), (row) => row.textContent)).toEqual([
			"Thinking", "Tool request: bash", "Output",
		]);
		expect(document.querySelector(".request-row.selected .request-activities")).toBeNull();
		expect(document.querySelector(".request-row.selected .response-activities")?.getAttribute("aria-label")).toBe(
			"Provider response activities: Thinking, Tool request: bash, Output",
		);
		const responseOverview = document.querySelector<HTMLElement>(".request-overview")!;
		expect(responseOverview.querySelectorAll(".detail-grid > .metric")).toHaveLength(8);
		expect(responseOverview.querySelector(".summary-label")?.textContent).toBe("Exact provider-reported usage");
		expect(responseOverview.querySelectorAll(".usage-grid > .metric")).toHaveLength(7);
		const tokenMetrics = Array.from(document.querySelectorAll<HTMLElement>(".token-metric"));
		expect(tokenMetrics.map((metric) => [metric.className, metric.firstElementChild?.textContent])).toEqual([
			["metric token-metric token-input", "Input"],
			["metric token-metric token-cache-input", "Cache input"],
			["metric token-metric token-cache-write", "Cache write"],
			["metric token-metric token-output", "Output"],
			["metric token-metric token-reasoning", "Reasoning, subset of output"],
		]);
		const requestRow = document.querySelector<HTMLButtonElement>('.request-row[data-sequence="2"][data-part="request"]')!;
		requestRow.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.querySelector(".detail-pane h2")?.textContent).toContain("Request #2");
		expect(Array.from(document.querySelectorAll(".request-row.selected .activity-badge"), (row) => row.textContent)).toEqual([
			"User input", "Tool result: read",
		]);
		expect(document.querySelector(".request-row.selected .request-activities")?.getAttribute("aria-label")).toBe(
			"Provider request activities: User input, Tool result: read",
		);
		expect(document.querySelector(".request-row.selected .response-activities")).toBeNull();
		expect(document.querySelector(".request-overview .summary-label")?.textContent).toBe("Exact provider-reported usage");
		expect(document.querySelectorAll(".request-overview .usage-grid > .metric")).toHaveLength(7);

		expect(document.getElementById("subagentList")?.classList.contains("hidden")).toBe(true);
		tabs[1]!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.getElementById("sourcePanel")?.classList.contains("subagent-mode")).toBe(true);
		expect(document.getElementById("subagentList")?.classList.contains("hidden")).toBe(false);
		expect(Array.from(document.querySelectorAll(".subagent-row"), (row) => [
			row.querySelector("strong")?.textContent, row.querySelector("span")?.textContent,
		])).toEqual([
			["explorer", "explorer-1 · 1 request"], ["worker", "worker-1 · 1 request"],
		]);
		expect(document.querySelector(".subagent-row.selected strong")?.textContent).toBe("explorer");
		expect(Array.from(document.querySelectorAll(".request-group-title"), (row) => row.textContent)).toEqual([
			"openai/explorer",
		]);
		document.querySelectorAll<HTMLButtonElement>(".subagent-row")[1]!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(Array.from(document.querySelectorAll(".request-group-title"), (row) => row.textContent)).toEqual([
			"openai/worker",
		]);
		expect(document.querySelector(".detail-pane h2")?.textContent).toContain("Response #3");
		tabs[0]!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		tabs[1]!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.querySelector(".subagent-row.selected strong")?.textContent).toBe("worker");
		expect(document.querySelector(".request-row.selected")?.parentElement?.querySelector(".request-group-title")?.textContent).toBe("openai/worker");

		tabs[2]!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.querySelector(".detail-pane h2")?.textContent).toContain("Response #5");
		expect(document.querySelector(".detail-pane")?.textContent).toContain("Advisor");
		tabs[3]!.click();
		expect(document.querySelector(".request-list .dash-empty")?.textContent).toContain("No requests");
		expect(document.querySelector(".detail-pane .dash-empty")?.textContent).toContain("Guardian");
		tabs[4]!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.querySelector(".detail-pane h2")?.textContent).toContain("Compaction Response #6");
		expect(document.querySelector(".detail-pane")?.textContent).toContain("Pi-level preparation, not exact provider payload");
	});

	it("expands captured sections and keeps them open when a request updates", async () => {
		const { window, document } = parseHTML(ANALYSIS_PAGE);
		let bytes = 100;
		let refreshInterval = () => {};
		const summary = () => ({
			activatedAt: 1,
			paused: false,
			records: [{
				sequence: 1, run: 1, turn: 0, requestedAt: 1, provider: "github-copilot", api: "openai-responses",
				apiLabel: "OpenAI Responses", model: "gpt-test", state: "pending", correlation: "exact", bytes,
			}],
		});
		const detail = () => ({
			...summary().records[0],
			requestJson: JSON.stringify({
				instructions: "Follow the system rules",
				tools: [
					{ name: "read", description: "Read exact files", parameters: { type: "object" } },
					{ name: "bash", description: "Run a command", parameters: { type: "object" } },
					{ name: "edit", description: "Edit a file", parameters: { type: "object" } },
				],
				afterTools: { role: "user", content: "first line\nsecond line" },
				metadata: { "a/b~c": "decoded pointer value" },
				model: "gpt-test",
			}),
			cachePlacement: "estimated",
			sections: [
				{ kind: "instruction", label: "instructions", pointer: "/instructions", allocatedTokens: 4, cachedTokens: 4 },
				{ kind: "tool", label: "tool: read", pointer: "/tools/0", allocatedTokens: 8, cachedTokens: 2 },
				{ kind: "tool", label: "tool: bash", pointer: "/tools/1", allocatedTokens: 7, cachedTokens: 1 },
				{ kind: "conversation", label: "after tools", pointer: "/afterTools", allocatedTokens: 3, cachedTokens: 0 },
				{ kind: "tool", label: "tool: edit", pointer: "/tools/2", allocatedTokens: 6, cachedTokens: 0 },
				{ kind: "option", label: "model", pointer: "/model" },
				{ kind: "option", label: "escaped", pointer: "/metadata/a~1b~0c" },
			],
		});
		Object.assign(window, {
			location: { hash: "#token=test", pathname: "/" },
			history: { replaceState: () => {} },
			setInterval: (callback: () => void) => { refreshInterval = callback; return 1; },
			fetch: async (path: string) => ({
				ok: true,
				status: 200,
				json: async () => path === "/api/summary" ? summary() : detail(),
			}),
		});
		const script = ANALYSIS_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1];
		vm.runInContext(script!, vm.createContext(window));
		await new Promise((resolve) => setTimeout(resolve, 0));

		const rows = Array.from(document.querySelectorAll<HTMLDetailsElement>("details.analysis-section"));
		expect(rows).toHaveLength(7);
		const toolGroup = document.querySelector<HTMLDetailsElement>("details.tool-section-group")!;
		expect(toolGroup.open).toBe(false);
		expect(toolGroup.querySelector(":scope > summary")?.textContent).toBe("Tool schemas (2)");
		expect(toolGroup.querySelectorAll("details.analysis-section")).toHaveLength(2);
		expect(Array.from(document.querySelectorAll<HTMLDetailsElement>(".sections > details"), (row) => row.dataset.pointer)).toEqual([
			"/instructions", "__tool_schemas__/tools/0", "/afterTools", "/tools/2", "/model", "/metadata/a~1b~0c",
		]);
		const toolContent = document.querySelector('[data-pointer="/tools/0"] pre')?.textContent;
		expect(toolContent).toContain("Read exact files");
		expect(toolContent).toContain('"parameters"');
		expect(toolContent).toContain('"type": "object"');
		const messageContent = document.querySelector('[data-pointer="/afterTools"] pre')?.textContent;
		expect(messageContent).toBe("role: user\ncontent:\nfirst line\nsecond line");
		expect(messageContent).not.toContain("\\n");
		expect(document.querySelector('[data-pointer="/metadata/a~1b~0c"] pre')?.textContent).toBe("decoded pointer value");

		const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".section-controls button"));
		buttons[0]!.click();
		expect(rows.every((row) => row.open)).toBe(true);
		expect(toolGroup.open).toBe(true);
		buttons[1]!.click();
		expect(rows.every((row) => !row.open)).toBe(true);
		expect(toolGroup.open).toBe(false);

		const toolRow = document.querySelector<HTMLDetailsElement>('[data-pointer="/tools/0"]')!;
		toolGroup.setAttribute("open", "");
		toolRow.setAttribute("open", "");
		bytes++;
		refreshInterval();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const updatedToolRow = document.querySelector<HTMLDetailsElement>('[data-pointer="/tools/0"]');
		expect(updatedToolRow).not.toBe(toolRow);
		expect(document.querySelector<HTMLDetailsElement>("details.tool-section-group")?.open).toBe(true);
		expect(updatedToolRow?.open).toBe(true);
	});
});
