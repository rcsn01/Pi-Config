import { describe, expect, it } from "vitest";
import { formatRunReports, registerSubagentRunTools } from "./run-tools.ts";
import { runHarness } from "./background-test-harness.ts";
import { agentResult } from "./test-harness.ts";

describe("background control tools", () => {
	it("lists summaries without output bodies and retrieves full structured terminal results", async () => {
		const h = runHarness(); const tools = new Map<string, any>();
		registerSubagentRunTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, { list: h.manager.list, get: h.manager.get, wait: h.manager.wait, cancel: h.manager.cancel });
		const [run] = h.spawn(); h.gates[0].resolve(agentResult({ output: "private-output-body" }));
		await h.manager.wait([run.runId]);
		const list = await tools.get("subagent_status").execute("", {});
		expect(list.content[0].text).not.toContain("private-output-body");
		expect(list.details.runs[0]).not.toHaveProperty("result");
		expect(await tools.get("subagent_status").execute("", { runId: "" })).toEqual(list);
		const get = await tools.get("subagent_status").execute("", { runId: run.runId });
		expect(get.content[0].text).toContain("private-output-body"); expect(get.isError).toBe(false);
		expect(get.structuredContent).toEqual(get.details);
		expect(tools.get("subagent_status").outputSchema).toBeDefined();
	});
	it("returns wait results in caller order with child failure flags, but cancellation acknowledgement is successful", async () => {
		const h = runHarness(); const tools = new Map<string, any>();
		registerSubagentRunTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, { list: h.manager.list, get: h.manager.get, wait: h.manager.wait, cancel: h.manager.cancel });
		const [a, b] = h.spawn(2);
		const wait = tools.get("subagent_wait").execute("", { runIds: [b.runId, a.runId] });
		h.gates[0].reject(new Error("failed")); h.gates[1].resolve(agentResult());
		const result = await wait;
		expect(result.details.runs.map((r: any) => r.runId)).toEqual([b.runId, a.runId]); expect(result.isError).toBe(true);
		const cancelled = await tools.get("subagent_cancel").execute("", { runIds: [a.runId] });
		expect(cancelled.isError).toBe(false);
	});
	it("preserves all headings inside aggregated byte and line limits", () => {
		const runs = Array.from({ length: 32 }, (_, i) => ({ runId: `run-${i}`, sessionId: "s", agent: "worker", task: "t", cwd: "/", model: "model", status: "completed" as const, createdAt: 1, result: agentResult({ output: "x".repeat(100) + "\n".repeat(3000) + "y".repeat(100000) }) }));
		const text = formatRunReports(runs);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
		expect(text.split("\n").length).toBeLessThanOrEqual(2000);
		for (const run of runs) expect(text).toContain(`### ${run.runId} ·`);
		expect(text).toContain("subagent_status");
	});
});

describe("structured retrieval limits", () => {
	it("bounds oversized structured output while preserving full renderer snapshots and manager results", async () => {
		const { runToolResult } = await import("./run-tools.ts");
		const h = runHarness(); const handles = h.spawn(4);
		h.gates.forEach((gate) => gate.resolve(agentResult({ output: "large output\n".repeat(10000) })));
		const runs = await h.manager.wait(handles.map((r) => r.runId)); const result = runToolResult(runs);
		expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(50 * 1024);
		expect(result.structuredContent).toMatchObject({ truncated: true });
		expect(result.structuredContent.runs.map((r) => r.runId)).toEqual(handles.map((r) => r.runId));
		expect(result.details.runs[0].result?.output).toBe(h.manager.get(handles[0].runId).result?.output);
	});
});
