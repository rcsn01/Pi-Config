import { describe, expect, it, vi } from "vitest";
import { createSubagentRunner } from "./subagent-runner.ts";
import {
	agent,
	agentResult,
	memoryConfigStore,
	memoryRegistry,
} from "./test-harness.ts";

describe("single subagent runner", () => {
	it("prepares a request before sending it to child execution", async () => {
		const worker = agent();
		const expectedResult = agentResult();
		const execute = vi.fn(async () => expectedResult);
		const run = createSubagentRunner({
			registry: memoryRegistry([worker]),
			config: memoryConfigStore({ defaultThinkingLevel: "minimal" }),
			childExecution: { execute },
		});

		const result = await run({
			agent: "worker",
			prompt: "legacy task",
			cwd: "/workspace",
			cacheAffinitySeed: "session",
		});

		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith(expect.objectContaining({
			agent: worker,
			task: "legacy task",
			cwd: "/workspace",
			launch: { model: "openai/test-model", thinkingLevel: "minimal" },
			cacheSessionId: "subagent-0ddf41435c428ceb02f68c37425d9861",
		}));
		expect(result).toBe(expectedResult);
	});
});
