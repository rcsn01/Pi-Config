import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadAgents } from "./index.ts";

const BUNDLED_AGENTS = ["default", "explorer", "judge", "researcher", "worker"];

describe("subagent extension paths", () => {
	it("discovers bundled agents from the extension directory", () => {
		const agents = loadAgents();
		expect(agents.map((agent) => agent.name)).toEqual(expect.arrayContaining(BUNDLED_AGENTS));

		for (const name of BUNDLED_AGENTS) {
			const agent = agents.find((candidate) => candidate.name === name);
			expect(agent?.filePath, `missing file path for ${name}`).toBeTruthy();
			expect(existsSync(agent!.filePath!), `missing agent file for ${name}`).toBe(true);
		}
	});
});
