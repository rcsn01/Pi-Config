import { describe, expect, it, vi } from "vitest";
import { deriveSubagentSessionId } from "./cache-affinity.ts";
import { prepareSubagentLaunches } from "./launch-preparation.ts";
import { agent, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

describe("subagent launch preparation", () => {
	it("loads one snapshot, resolves launches as one ordered batch, and normalizes request fields", () => {
		const worker = agent();
		const direct = agent({ name: "direct", model: "anthropic/direct" });
		const empty = agent({ name: "empty" });
		const registry = memoryRegistry([worker]);
		const config = memoryConfigStore({ defaultThinkingLevel: "minimal" });
		const load = vi.spyOn(registry, "load");
		const resolveLaunchBatch = vi.spyOn(config, "resolveLaunchBatch");
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
			{ agent: empty, task: "", prompt: "fallback", cwd: "/three", cacheAffinitySeed: "" },
		], { registry, config });

		expect(load).toHaveBeenCalledTimes(1);
		expect(resolveLaunchBatch).toHaveBeenCalledTimes(1);
		expect(resolveLaunchBatch.mock.calls[0]?.[0]).toEqual([
			{ agent: worker, explicitModel: "openai/resolved", explicitThinkingLevel: "high" },
			{ agent: direct, explicitModel: undefined, explicitThinkingLevel: undefined },
			{ agent: empty, explicitModel: undefined, explicitThinkingLevel: undefined },
		]);
		expect(prepared).toEqual([
			expect.objectContaining({
				agent: worker,
				task: "preferred",
				cwd: "/one",
				launch: { model: "openai/resolved", thinkingLevel: "high", contextWindow: undefined },
				cacheSessionId: deriveSubagentSessionId("session", "openai/resolved"),
				signal: controller.signal,
				timeoutMs: 10,
				maxOutputBytes: 20,
				onUpdate,
				onProgress,
			}),
			expect.objectContaining({ agent: direct, task: "legacy", cwd: "/two" }),
			expect.objectContaining({ agent: empty, task: "", cwd: "/three" }),
		]);
		expect(prepared[1].cacheSessionId).toBeUndefined();
		expect(prepared[2].cacheSessionId).toBeUndefined();
		for (const request of prepared) {
			expect(request).not.toHaveProperty("model");
			expect(request).not.toHaveProperty("thinkingLevel");
			expect(request).not.toHaveProperty("prompt");
			expect(request).not.toHaveProperty("cacheAffinitySeed");
		}
	});

	it("uses one supplied config snapshot for every prepared launch", () => {
		const worker = agent({ name: "worker" });
		const specialist = agent({ name: "specialist" });
		const registry = memoryRegistry([worker, specialist]);
		const config = memoryConfigStore({
			defaultModel: "openai/old-default",
			defaultThinkingLevel: "low",
			defaultContextWindow: 100000,
			agentModels: { specialist: "anthropic/old-specialist" },
		});
		const configSnapshot = config.load();
		const resolveLaunchBatch = vi.spyOn(config, "resolveLaunchBatch");
		config.document = {
			defaultModel: "openai/new-default",
			defaultThinkingLevel: "high",
			defaultContextWindow: 200000,
			agentModels: { specialist: "anthropic/new-specialist" },
		};

		const prepared = prepareSubagentLaunches([
			{ agent: "worker", task: "one", cwd: "/root" },
			{ agent: "specialist", task: "two", cwd: "/root" },
		], { registry, config, configSnapshot });

		expect(prepared.map(({ launch }) => launch)).toEqual([
			{ model: "openai/old-default", thinkingLevel: "low", contextWindow: 100000 },
			{ model: "anthropic/old-specialist", thinkingLevel: "low", contextWindow: 100000 },
		]);
		expect(resolveLaunchBatch).toHaveBeenCalledTimes(1);
		expect(resolveLaunchBatch.mock.calls[0]?.[0]).toEqual([
			{ agent: worker, explicitModel: undefined, explicitThinkingLevel: undefined },
			{ agent: specialist, explicitModel: undefined, explicitThinkingLevel: undefined },
		]);
		expect(resolveLaunchBatch.mock.calls[0]?.[1]).toBe(configSnapshot);
	});

	it("validates every named agent before resolving the batch", () => {
		const registry = memoryRegistry([agent(), agent({ name: "other" })]);
		const config = memoryConfigStore();
		const resolveLaunchBatch = vi.spyOn(config, "resolveLaunchBatch");

		expect(() => prepareSubagentLaunches([
			{ agent: "worker", task: "valid", cwd: "/root" },
			{ agent: "missing", task: "invalid", cwd: "/root" },
		], { registry, config })).toThrow("Unknown subagent: missing. Available: worker, other");
		expect(resolveLaunchBatch).not.toHaveBeenCalled();
	});

	it("does not return a partial list when batch resolution fails", () => {
		const registry = memoryRegistry([agent(), agent({ name: "other" })]);
		const config = memoryConfigStore();
		const resolveLaunchBatch = vi.spyOn(config, "resolveLaunchBatch")
			.mockImplementation(() => { throw new Error("bad launch"); });

		expect(() => prepareSubagentLaunches([
			{ agent: "worker", cwd: "/root" },
			{ agent: "other", cwd: "/root" },
		], { registry, config })).toThrow("bad launch");
		expect(resolveLaunchBatch).toHaveBeenCalledTimes(1);
	});

	it("returns an empty list without loading dependencies", () => {
		const registry = { load: vi.fn() };
		const config = { resolveLaunchBatch: vi.fn() };

		expect(prepareSubagentLaunches([], { registry, config })).toEqual([]);
		expect(registry.load).not.toHaveBeenCalled();
		expect(config.resolveLaunchBatch).not.toHaveBeenCalled();
	});
});
