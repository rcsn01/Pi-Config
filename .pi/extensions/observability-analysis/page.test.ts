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
		expect(ANALYSIS_PAGE).toContain("Section-level cache placement is estimated");
		expect(ANALYSIS_PAGE).toContain("request parts");
		expect(ANALYSIS_PAGE).toContain("Tool rows include each transmitted tool description and parameter schema");
		expect(ANALYSIS_PAGE).toContain("Expand all");
		expect(ANALYSIS_PAGE).toContain("Collapse all");
		expect(ANALYSIS_PAGE).toContain("details.analysis-section[open]");
		const script = ANALYSIS_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1];
		expect(() => new Function(script!)).not.toThrow();
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
		const toolContent = document.querySelector('[data-pointer="/tools/0"] pre')?.textContent;
		expect(toolContent).toContain("Read exact files");
		expect(toolContent).toContain('"parameters"');
		expect(toolContent).toContain('"type": "object"');
		expect(document.querySelector('[data-pointer="/metadata/a~1b~0c"] pre')?.textContent).toBe("decoded pointer value");

		const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".section-controls button"));
		buttons[0]!.click();
		expect(rows.every((row) => row.open)).toBe(true);
		buttons[1]!.click();
		expect(rows.every((row) => !row.open)).toBe(true);

		const toolRow = document.querySelector<HTMLDetailsElement>('[data-pointer="/tools/0"]')!;
		toolRow.setAttribute("open", "");
		bytes++;
		refreshInterval();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const updatedToolRow = document.querySelector<HTMLDetailsElement>('[data-pointer="/tools/0"]');
		expect(updatedToolRow).not.toBe(toolRow);
		expect(updatedToolRow?.open).toBe(true);
	});
});
