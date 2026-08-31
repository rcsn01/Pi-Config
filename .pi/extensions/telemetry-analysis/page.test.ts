import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { ANALYSIS_PAGE } from "./page.ts";

describe("analysis page", () => {
	it("is dependency-free and inserts captured values with textContent", () => {
		expect(ANALYSIS_PAGE).not.toMatch(/<script[^>]+src=/i);
		expect(ANALYSIS_PAGE).not.toMatch(/<link[^>]+href=/i);
		expect(ANALYSIS_PAGE).not.toMatch(/https?:\/\//i);
		expect(ANALYSIS_PAGE).toContain("textContent");
		expect(ANALYSIS_PAGE).not.toContain("innerHTML");
		expect(ANALYSIS_PAGE).not.toContain("OpenAI request analysis");
		expect(ANALYSIS_PAGE).not.toContain("Pi provider request analysis");
		expect(ANALYSIS_PAGE).not.toContain("Captured prompts and tool data may contain secrets.");
		expect(ANALYSIS_PAGE).toContain("Section-level cache placement is estimated");
		expect(ANALYSIS_PAGE).toContain("request parts");
		expect(ANALYSIS_PAGE).toContain("Tool rows include each transmitted tool description and parameter schema");
		expect(ANALYSIS_PAGE).toContain("Expand all");
		expect(ANALYSIS_PAGE).toContain("Collapse all");
		expect(ANALYSIS_PAGE).toContain("details.analysis-section[open]");
		const script = ANALYSIS_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1];
		expect(() => new Function(script!)).not.toThrow();
	});

	it("filters source tabs, reports counts and empty states, and restores per-tab selection", async () => {
		const { window, document } = parseHTML(ANALYSIS_PAGE);
		const records = [
			{ sequence: 1, source: { channel: "main", invocationId: "main", displayLabel: "Main agent" }, provider: "openai", model: "main", api: "openai-responses", apiLabel: "OpenAI Responses", run: 1, turn: 0, requestedAt: 1, state: "complete", correlation: "exact", bytes: 10, fidelity: "exact-provider" },
			{ sequence: 2, source: { channel: "main", invocationId: "main", displayLabel: "Main agent" }, provider: "openai", model: "main", api: "openai-responses", apiLabel: "OpenAI Responses", run: 1, turn: 1, requestedAt: 2, state: "complete", correlation: "exact", bytes: 10, fidelity: "exact-provider", usage: { input: 10, cacheRead: 20, cacheWrite: 5, output: 15, reasoning: 5, totalTokens: 50, cost: { total: 0 } } },
			{ sequence: 3, source: { channel: "subagent", invocationId: "worker-1", displayLabel: "worker" }, provider: "openai", model: "worker", api: "openai-responses", apiLabel: "OpenAI Responses", run: 1, turn: 0, requestedAt: 3, state: "complete", correlation: "exact", bytes: 10, fidelity: "exact-provider" },
			{ sequence: 4, source: { channel: "subagent", invocationId: "explorer-1", displayLabel: "explorer" }, provider: "openai", model: "explorer", api: "openai-responses", apiLabel: "OpenAI Responses", run: 1, turn: 0, requestedAt: 4, state: "complete", correlation: "exact", bytes: 10, fidelity: "exact-provider" },
			{ sequence: 5, source: { channel: "compaction", invocationId: "compact-1", displayLabel: "Compaction" }, provider: "pi", model: "openai/main", api: "pi-compaction", apiLabel: "Pi Compaction Preparation", run: 1, turn: 0, requestedAt: 5, state: "complete", correlation: "exact", bytes: 10, fidelity: "pi-preparation" },
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
		expect(tabs.map((tab) => tab.textContent)).toEqual(["Main (2)", "Subagents (2)", "Guardian (0)", "Compaction (1)"]);
		expect(tabs.map((tab) => [tab.id, tab.getAttribute("aria-controls"), tab.getAttribute("tabindex")])).toEqual([
			["tab-main", "sourcePanel", "0"], ["tab-subagent", "sourcePanel", "-1"],
			["tab-guardian", "sourcePanel", "-1"], ["tab-compaction", "sourcePanel", "-1"],
		]);
		expect(document.getElementById("sourcePanel")?.getAttribute("aria-labelledby")).toBe("tab-main");
		const requestBars = Array.from(document.querySelectorAll<HTMLElement>(".request-usage-bar"));
		expect(requestBars).toHaveLength(2);
		expect(Array.from(requestBars[0]!.children, (segment) => [segment.className, segment.getAttribute("style")])).toEqual([
			["uncached", "width:20%"], ["cache", "width:40%"], ["write", "width:10%"],
			["output", "width:20%"], ["reasoning", "width:10%"],
		]);
		expect(requestBars[0]!.getAttribute("aria-label")).toContain("Cache hit: 20 tokens (40.0%)");
		expect(requestBars[1]!.classList.contains("usage-unavailable")).toBe(true);
		expect(document.querySelector(".detail-pane h2")?.textContent).toContain("Request #2");

		tabs[1]!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(Array.from(document.querySelectorAll(".request-row strong"), (row) => row.textContent)).toEqual([
			"#4 explorer · openai/explorer", "#3 worker · openai/worker",
		]);
		document.querySelectorAll<HTMLButtonElement>(".request-row")[1]!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		tabs[0]!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		tabs[1]!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.querySelector(".request-row.selected strong")?.textContent).toContain("#3 worker");

		tabs[2]!.click();
		expect(document.querySelector(".request-list .empty-state")?.textContent).toContain("No requests");
		expect(document.querySelector(".detail-pane .empty-state")?.textContent).toContain("Guardian");
		tabs[3]!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.querySelector(".detail-pane h2")?.textContent).toContain("Compaction #5");
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
				tools: [{ name: "read", description: "Read exact files", parameters: { type: "object" } }],
				metadata: { "a/b~c": "decoded pointer value" },
				model: "gpt-test",
			}),
			cachePlacement: "estimated",
			sections: [
				{ kind: "instruction", label: "instructions", pointer: "/instructions", allocatedTokens: 4, cachedTokens: 4 },
				{ kind: "tool", label: "tool: read", pointer: "/tools/0", allocatedTokens: 8, cachedTokens: 2 },
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
		expect(rows).toHaveLength(4);
		const toolGroup = document.querySelector<HTMLDetailsElement>("details.tool-section-group")!;
		expect(toolGroup.open).toBe(false);
		expect(toolGroup.querySelector(":scope > summary")?.textContent).toBe("Tool schemas (1)");
		expect(toolGroup.querySelectorAll("details.analysis-section")).toHaveLength(1);
		const toolContent = document.querySelector('[data-pointer="/tools/0"] pre')?.textContent;
		expect(toolContent).toContain("Read exact files");
		expect(toolContent).toContain('"parameters"');
		expect(toolContent).toContain('"type": "object"');
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
