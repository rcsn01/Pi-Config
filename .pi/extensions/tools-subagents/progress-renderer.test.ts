import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderSubagentCall, renderSubagentResult } from "./progress-renderer.ts";
import { agentResult, theme } from "./test-harness.ts";

function output(component: any, width = 100): string {
	return component.render(width).join("\n");
}

describe("subagent progress rendering", () => {
	it("renders single, parallel, and empty calls", () => {
		expect(output(renderSubagentCall({ tasks: [{ agent: "worker", task: "Inspect\nfiles" }] }, theme())))
			.toContain("subagent worker Inspect files");
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

	it("renders timing diagnostics", () => {
		const result = agentResult({
			timing: {
				totalMs: 402_100,
				startupMs: 800,
				modelPhaseMs: 318_300,
				toolWallMs: 72_000,
				repoQueryWallMs: 58_100,
				unclassifiedMs: 11_000,
				repositoryQueries: 2,
				repositoryOperations: 11,
				partial: false,
				anomalyCount: 0,
			},
		});
		const rendered = output(renderSubagentResult({
			content: [{ type: "text", text: "review findings only" }],
			details: { mode: "single", results: [result] },
		}, { expanded: true }, theme(), () => 160), 160);
		expect(rendered).toContain("timing model/provider 5m18s · tools 1m12s");
		expect(rendered).toContain("repo_query 58.1s (2 calls/11 ops)");
		expect(rendered).toContain("startup 800ms · unclassified 11.0s");
	});

	it("marks partial timing and unavailable startup data", () => {
		const result = agentResult({
			timing: {
				totalMs: 100,
				modelPhaseMs: 10,
				toolWallMs: 80,
				repoQueryWallMs: 0,
				unclassifiedMs: 10,
				repositoryQueries: 0,
				repositoryOperations: 0,
				partial: true,
				anomalyCount: 1,
			},
		});
		const rendered = output(renderSubagentResult({
			content: [{ type: "text", text: "done" }],
			details: { mode: "single", results: [result] },
		}, { expanded: true }, theme(), () => 160), 160);
		expect(rendered).toContain("timing ~ model/provider 10ms");
		expect(rendered).toContain("startup unavailable");
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

	it("keeps pending parallel work in the pending state", () => {
		const pending = agentResult({
			exitCode: -1,
			progress: { ...agentResult().progress, status: "pending" },
		});
		const rendered = output(renderSubagentResult({
			content: [{ type: "text", text: "pending" }],
			details: { mode: "parallel", results: [pending] },
		}, { expanded: false }, theme(), () => 100));
		expect(rendered).toContain("○ parallel 0/1 completed");
		expect(rendered).not.toContain("✗ parallel");
	});

	it("falls back to the first text content without details", () => {
		const fallback = renderSubagentResult({
			content: [{ type: "text", text: "x".repeat(250) }],
		}, { expanded: false }, theme()) as any;
		expect(visibleWidth(fallback.text)).toBeLessThanOrEqual(200);
		expect(fallback.text).toContain("…");
		expect((renderSubagentResult({ content: [] }, { expanded: false }, theme()) as any).text).toBe("(no output)");
		const expanded = renderSubagentResult({ content: [{ type: "text", text: "full output" }] }, { expanded: true }, theme(), () => 100);
		expect(output(expanded, 100)).toContain("full output");
		const error = renderSubagentResult({ content: [{ type: "text", text: "failed" }] }, { expanded: false }, theme(), () => 100, { isError: true });
		expect(output(error, 100)).toContain("✗ failed");
	});
});
