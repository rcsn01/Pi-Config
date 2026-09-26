import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverWorkflows } from "./registry.ts";
import { prepareNewWorkflowRun } from "./runner.ts";

const temporary: string[] = [];
const originalStateDir = process.env.PI_CONFIG_STATE_DIR;

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	if (originalStateDir === undefined) delete process.env.PI_CONFIG_STATE_DIR;
	else process.env.PI_CONFIG_STATE_DIR = originalStateDir;
});

async function tempDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
	temporary.push(directory);
	return directory;
}

describe("workflow runner interactive selection bridge", () => {
	it("routes a durable workflow choice through the parent TUI after workflow approval", async () => {
		const project = await tempDirectory("workflow-selection-project-");
		const state = await tempDirectory("workflow-selection-state-");
		process.env.PI_CONFIG_STATE_DIR = state;
		const workflowDirectory = path.join(project, ".pi", "workflows");
		await mkdir(workflowDirectory, { recursive: true });
		await writeFile(path.join(workflowDirectory, "interactive-choice.mjs"), `export default {
  name: "interactive-choice",
  description: "Exercise the parent TUI selection bridge.",
  canEditFiles: false,
  async run(ctx) {
    return ctx.select("pick-candidate", "Choose a candidate", ["Option A", "Option B"]);
  }
};\n`);
		const entry = (await discoverWorkflows(project)).find((candidate) => candidate.name === "interactive-choice");
		expect(entry).toBeDefined();

		const selection = vi.fn(async (_title: string, options: string[], _dialogOptions?: { signal?: AbortSignal }) => options.includes("Run once") ? "Run once" : "Option B");
		const ctx = {
			cwd: project,
			signal: new AbortController().signal,
			hasUI: true,
			sessionManager: { getSessionId: () => "main-session" },
			ui: { select: selection, setStatus: vi.fn(), notify: vi.fn() },
		} as any;

		const prepared = await prepareNewWorkflowRun(ctx, entry!, "scope");
		expect(prepared).toBeDefined();
		expect(await prepared!.handle.execute()).toBe("Option B");
		expect(selection).toHaveBeenCalledTimes(2);
		expect(selection.mock.calls[0][1]).toContain("Run once");
		expect(selection.mock.calls[1][0]).toBe("Choose a candidate");
		expect(selection.mock.calls[1][1]).toEqual(["Option A", "Option B"]);
		expect(selection.mock.calls[1][2]).toMatchObject({ signal: expect.any(AbortSignal) });
	});
});
