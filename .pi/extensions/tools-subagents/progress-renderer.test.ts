import { describe, expect, it } from "vitest";
import { renderSubagentCall, renderSubagentResult } from "./progress-renderer.ts";
import { agentResult, theme } from "./test-harness.ts";

function output(component: any, width = 100): string {
	return component.render(width).join("\n");
}

describe("subagent progress rendering", () => {
	it("renders single, parallel, and empty calls", () => {
		expect(output(renderSubagentCall({ agent: "worker", task: "Inspect\nfiles" }, theme()))).toContain("subagent worker Inspect files");
		expect(output(renderSubagentCall({ tasks: [{ agent: "worker" }, { agent: "explorer" }] }, theme())))
			.toContain("subagent parallel (2 tasks: worker, explorer)");
		expect(output(renderSubagentCall({}, theme()))).toContain("subagent");
	});

	it("renders running details and expanded final output", () => {
		const running = agentResult({
			exitCode: -1,
			progress: {
				...agentResult().progress,
				status: "running",
				currentTool: "read",
				currentToolArgs: "src/a.ts",
				recentTools: [{ tool: "grep", args: "needle" }],
			},
		});
		const collapsed = output(renderSubagentResult({
			content: [{ type: "text", text: "running" }],
			details: { mode: "single", results: [running] },
		}, { expanded: false }, theme(), () => 100));
		expect(collapsed).toContain("⟳ worker (openai/test-model · thinking minimal)");
		expect(collapsed).toContain("▸ read: src/a.ts");
		expect(collapsed).toContain("grep: needle");

		const expanded = output(renderSubagentResult({
			content: [{ type: "text", text: "Done" }],
			details: { mode: "single", results: [agentResult({ output: "Final output" })] },
		}, { expanded: true }, theme(), () => 100));
		expect(expanded).toContain("Final output");
		expect(expanded).toContain("1 turn · in:10 · out:5 · $0.0100");
	});

	it("renders mixed parallel summaries and errors", () => {
		const failed = agentResult({
			agent: "explorer",
			exitCode: 2,
			progress: { ...agentResult().progress, agent: "explorer", status: "failed", error: "boom" },
		});
		const rendered = output(renderSubagentResult({
			content: [{ type: "text", text: "mixed" }],
			details: { mode: "parallel", results: [agentResult(), failed] },
		}, { expanded: false }, theme(), () => 100));
		expect(rendered).toContain("✗ parallel 1/2 completed");
		expect(rendered).toContain("Error: boom");
	});

	it("falls back to the first text content without details", () => {
		const fallback = renderSubagentResult({
			content: [{ type: "text", text: "x".repeat(250) }],
		}, { expanded: false }, theme()) as any;
		expect(fallback.text).toHaveLength(200);
		expect((renderSubagentResult({ content: [] }, { expanded: false }, theme()) as any).text).toBe("(no output)");
	});
});
