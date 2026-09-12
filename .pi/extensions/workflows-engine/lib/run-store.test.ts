import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDir } from "./registry.ts";
import { FileRunPersistence, runPaths, safeArtifactPath, validateRunId } from "./run-store.ts";

const temporary: string[] = [];
const originalStateDir = process.env.PI_CONFIG_STATE_DIR;

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	if (originalStateDir === undefined) delete process.env.PI_CONFIG_STATE_DIR;
	else process.env.PI_CONFIG_STATE_DIR = originalStateDir;
});

async function project(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-adapter-test-"));
	temporary.push(directory);
	process.env.PI_CONFIG_STATE_DIR = directory;
	return mkdtemp(path.join(os.tmpdir(), "workflow-adapter-cwd-"));
}

describe("FileRunPersistence", () => {
	it("initializes the documented layout and preserves JSONL timestamps", async () => {
		const cwd = await project();
		temporary.push(cwd);
		const persistence = new FileRunPersistence(cwd, "run-1");
		await persistence.initializeInput({ args: "args", workflowName: "demo", sourceHash: "hash", createdAt: 1 });
		expect((await stat(persistence.paths().artifacts)).isDirectory()).toBe(true);
		await persistence.appendEvent({ type: "run_created", runId: "run-1", ts: 123 });
		const log = await persistence.readEventLog();
		expect(log.exists).toBe(true);
		expect(log.events).toEqual([{ type: "run_created", runId: "run-1", ts: 123 }]);
		expect(JSON.parse(await readFile(persistence.paths().input, "utf8")).args).toBe("args");
	});

	it("distinguishes a missing event log from an existing empty one", async () => {
		const cwd = await project();
		temporary.push(cwd);
		const persistence = new FileRunPersistence(cwd, "run-2");
		expect((await persistence.readEventLog()).exists).toBe(false);
		await ensureDir(path.dirname(persistence.paths().events));
		await writeFile(persistence.paths().events, "", "utf8");
		expect(await persistence.readEventLog()).toEqual({ exists: true, events: [] });
	});

	it("writes artifacts only below the run artifact directory", async () => {
		const cwd = await project();
		temporary.push(cwd);
		const persistence = new FileRunPersistence(cwd, "run-3");
		expect(await persistence.writeArtifact("diffs/change.patch", "patch")).toBe("artifacts/diffs/change.patch");
		expect(await readFile(path.join(persistence.paths().root, "artifacts/diffs/change.patch"), "utf8")).toBe("patch");
		await expect(persistence.writeArtifact("../escape", "bad")).rejects.toThrow(/escapes/);
		expect(() => safeArtifactPath(persistence.paths().artifacts, "../escape")).toThrow(/escapes/);
	});

	it("rejects unsafe run ids before composing paths", () => {
		expect(() => validateRunId("")).toThrow(/Invalid workflow run id/);
		expect(() => validateRunId("../run")).toThrow(/Invalid workflow run id/);
		expect(() => runPaths(process.cwd(), "a/b")).toThrow(/Invalid workflow run id/);
	});
});
