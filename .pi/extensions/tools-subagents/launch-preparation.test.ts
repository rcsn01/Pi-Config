import { describe, expect, it, vi } from "vitest";
import { deriveSubagentSessionId } from "./cache-affinity.ts";
import { prepareSubagentLaunches } from "./launch-preparation.ts";
import { agent, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

describe("subagent launch preparation", () => {
	it("loads one snapshot, resolves each launch once, and normalizes request fields", () => {
		const worker = agent();
		const direct = agent({ name: "direct", model: "anthropic/direct" });
		const registry = memoryRegistry([worker]);
		const config = memoryConfigStore({ defaultThinkingLevel: "minimal" });
		const load = vi.spyOn(registry, "load");
		const resolveLaunch = vi.spyOn(config, "resolveLaunch");
		const controller = new AbortController();
		const onUpdate = vi.fn();
		const onProgress = vi.fn();

		const prepared = prepareSubagentLaunches([
			{
				agent: "worker",
				task: "preferred",
				prompt: "legacy",
				cwd: "/one",
				model: "openai/resolved",
				thinkingLevel: "high",
				cacheAffinitySeed: "session",
				signal: controller.signal,
				timeoutMs: 10,
				maxOutputBytes: 20,
				onUpdate,
				onProgress,
			},
			{ agent: direct, prompt: "legacy", cwd: "/two" },
		], { registry, config });

		expect(load).toHaveBeenCalledTimes(1);
		expect(resolveLaunch).toHaveBeenCalledTimes(2);
		expect(resolveLaunch).toHaveBeenNthCalledWith(1, worker, "openai/resolved", "high");
		expect(resolveLaunch).toHaveBeenNthCalledWith(2, direct, undefined, undefined);
		expect(prepared).toEqual([
			expect.objectContaining({
				agent: worker,
				task: "preferred",
				cwd: "/one",
				launch: { model: "openai/resolved", thinkingLevel: "high" },
				cacheSessionId: deriveSubagentSessionId("session", "openai/resolved"),
				signal: controller.signal,
				timeoutMs: 10,
				maxOutputBytes: 20,
				onUpdate,
				onProgress,
			}),
			expect.objectContaining({ agent: direct, task: "legacy", cwd: "/two" }),
		]);
		expect(prepared[1].cacheSessionId).toBeUndefined();
		for (const request of prepared) {
			expect(request).not.toHaveProperty("model");
			expect(request).not.toHaveProperty("thinkingLevel");
			expect(request).not.toHaveProperty("prompt");
			expect(request).not.toHaveProperty("cacheAffinitySeed");
		}
	});

	it("validates every named agent before resolving configuration", () => {
		const registry = memoryRegistry([agent(), agent({ name: "other" })]);
		const config = memoryConfigStore();
		const resolveLaunch = vi.spyOn(config, "resolveLaunch");

		expect(() => prepareSubagentLaunches([
			{ agent: "worker", task: "valid", cwd: "/root" },
			{ agent: "missing", task: "invalid", cwd: "/root" },
		], { registry, config })).toThrow("Unknown agent: missing. Available agents: worker, other");
		expect(resolveLaunch).not.toHaveBeenCalled();
	});

	it("does not return a partial list when a later launch resolution fails", () => {
		const registry = memoryRegistry([agent(), agent({ name: "other" })]);
		const config = memoryConfigStore();
		const resolveLaunch = vi.spyOn(config, "resolveLaunch")
			.mockReturnValueOnce({ model: "openai/first" })
			.mockImplementationOnce(() => { throw new Error("bad launch"); });

		expect(() => prepareSubagentLaunches([
			{ agent: "worker", cwd: "/root" },
			{ agent: "other", cwd: "/root" },
		], { registry, config })).toThrow("bad launch");
		expect(resolveLaunch).toHaveBeenCalledTimes(2);
	});

	it("returns an empty list without loading dependencies", () => {
		const registry = { load: vi.fn() };
		const config = { resolveLaunch: vi.fn() };

		expect(prepareSubagentLaunches([], { registry, config })).toEqual([]);
		expect(registry.load).not.toHaveBeenCalled();
		expect(config.resolveLaunch).not.toHaveBeenCalled();
	});
});
