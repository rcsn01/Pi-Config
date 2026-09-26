import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hash, loadWorkflowFromEntry, writeWorkflowSnapshot } from "../lib/registry.ts";
import workflow from "../../../workflows/improve-architecture-plan-implement.mjs";

async function workspace() {
	const root = await mkdtemp(path.join(os.tmpdir(), "architecture-workflow-test-"));
	await mkdir(path.join(root, ".pi", "extensions", "config-prompts", "prompts"), { recursive: true });
	await writeFile(
		path.join(root, ".pi", "extensions", "config-prompts", "prompts", "explore.md"),
		"---\ndescription: Explore option 1\n---\nExplore option 1. If plan.md already exists in the repository root, delete it first. Finalize everything and write the full, detailed implementation plan to plan.md in the repository root.",
	);
	await writeFile(
		path.join(root, ".pi", "extensions", "config-prompts", "prompts", "evaluate-plan.md"),
		"---\ndescription: Evaluate plan.md\n---\nEvaluate plan.md for correctness. Read and edit plan.md only when needed.",
	);
	await writeFile(path.join(root, "plan.md"), "pre-existing user plan\n");
	return root;
}

function context(cwd, { choose = 1, implementationResult } = {}) {
	const calls = [];
	const choices = [];
	return {
		calls,
		choices,
		ctx: {
			runId: "run-architecture-pipeline",
			args: "workflow engine architecture",
			cwd,
			async phase(name, fn) { calls.push({ type: "phase", name }); return fn(); },
			async step(key, fn, options) { calls.push({ type: "step", key, options }); return fn(); },
			async select(key, title, options, stepOptions) {
				calls.push({ type: "select", key, title, stepOptions });
				choices.push([...options]);
				return options[choose];
			},
			async agent(options) {
				calls.push({ type: "agent", ...options });
				switch (options.key) {
					case "architecture-scan": return "Evidence: candidate A is shallow; candidate B has test friction.";
					case "architecture-report": return {
						reportPath: "/tmp/architecture-review-test.html",
						candidates: [
							{ id: "candidate-a", title: "Deepen reader", summary: "Move parsing behind a smaller interface", recommendation: "Worth exploring" },
							{ id: "candidate-b", title: "Fix test seam", summary: "Concentrate setup in one module", recommendation: "Strong" },
						],
					};
					case "draft-implementation-plan": {
						const planPath = options.prompt.match(/Plan path for this run: ([^\n]+)/)?.[1];
						assert.ok(planPath, "plan prompt includes run-specific path");
						assert.match(options.prompt, /candidate-b/);
						assert.match(options.prompt, /Do not delete or overwrite any existing plan/);
						assert.doesNotMatch(options.prompt, /delete it first/i);
						await mkdir(path.dirname(planPath), { recursive: true });
						await writeFile(planPath, "Implementation plan for candidate B\n");
						return `Plan saved at ${planPath}`;
					}
					case "evaluate-implementation-plan": {
						assert.match(options.prompt, /run-architecture-pipeline\/plan\.md/);
						return "Verified plan against source; no corrections needed.";
					}
					case "implement-evaluated-plan": return implementationResult || {
						status: "completed",
						summary: "Implemented and tested candidate B.",
						preexistingDirtyPaths: ["plan.md"],
						preexistingStagedPaths: [],
						changedFiles: ["src/test-seam.ts"],
						testsRun: [{ command: "pnpm test", status: "passed", result: "passed" }],
					};
					case "commit-implementation": return {
						status: "committed",
						summary: "Created commit 123abc.",
						commit: "123abcd",
						branch: "main",
						changedFiles: ["src/test-seam.ts"],
					};
					default: throw new Error(`Unexpected agent key ${options.key}`);
				}
			},
			async log() {},
			async artifact() { throw new Error("not used"); },
			fail(message) { throw new Error(message); },
		},
	};
}

test("project workflow source loads from the engine's approved snapshot", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "architecture-workflow-snapshot-"));
	try {
		const source = await readFile(new URL("../../../workflows/improve-architecture-plan-implement.mjs", import.meta.url), "utf8");
		const entry = {
			name: "improve-architecture-plan-implement",
			trust: "project",
			description: "Architecture pipeline",
			cost: "unknown",
			canEditFiles: undefined,
			extension: ".mjs",
			source,
			sourceHash: hash(source),
		};
		const snapshot = await writeWorkflowSnapshot(root, entry);
		const loaded = await loadWorkflowFromEntry(entry, snapshot);
		assert.equal(loaded.name, "improve-architecture-plan-implement");
		assert.equal(loaded.canEditFiles, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("architecture workflow waits for a selection, adapts saved prompts, and automates through commit", async () => {
	const cwd = await workspace();
	try {
		const h = context(cwd);
		const result = await workflow.run(h.ctx);

		assert.equal(result.status, "completed");
		assert.equal(result.selectedCandidate.id, "candidate-b");
		assert.equal(result.planPath, path.join(cwd, ".pi", "workflow-runs", "run-architecture-pipeline", "plan.md"));
		assert.equal(result.commit.commit, "123abcd");
		assert.deepEqual(h.choices, [[
			"1. Deepen reader | Worth exploring",
			"2. Fix test seam | Strong",
		]]);
		assert.equal(await readFile(path.join(cwd, "plan.md"), "utf8"), "pre-existing user plan\n");
		assert.match(await readFile(result.planPath, "utf8"), /candidate B/);

		const selectCall = h.calls.find((call) => call.type === "select");
		assert.equal(selectCall.stepOptions.dependsOn[0], "architecture-report");
		const evaluate = h.calls.find((call) => call.type === "agent" && call.key === "evaluate-implementation-plan");
		assert.match(evaluate.prompt, /Evaluate .*workflow-runs\/run-architecture-pipeline\/plan\.md/);
		const commit = h.calls.find((call) => call.type === "agent" && call.key === "commit-implementation");
		assert.match(commit.prompt, /git diff --cached is empty/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("architecture workflow refuses to commit if verification failed", async () => {
	const cwd = await workspace();
	try {
		const h = context(cwd, {
			implementationResult: {
				status: "completed",
				summary: "Implementation finished but verification failed.",
				preexistingDirtyPaths: [],
				preexistingStagedPaths: [],
				changedFiles: ["src/test-seam.ts"],
				testsRun: [{ command: "pnpm test", status: "failed", result: "one test failed" }],
			},
		});
		const result = await workflow.run(h.ctx);

		assert.equal(result.status, "blocked-before-commit");
		assert.deepEqual(result.blockers, ["Checks must all pass before commit: pnpm test (failed)"]);
		assert.equal(h.calls.some((call) => call.key === "commit-implementation"), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("architecture workflow rejects a directory-wide commit path from the implementation agent", async () => {
	const cwd = await workspace();
	try {
		const h = context(cwd, {
			implementationResult: {
				status: "completed",
				summary: "Implementation finished.",
				preexistingDirtyPaths: [],
				preexistingStagedPaths: [],
				changedFiles: ["."],
				testsRun: [{ command: "pnpm test", status: "passed", result: "passed" }],
			},
		});
		await assert.rejects(workflow.run(h.ctx), /invalid changed files list/);
		assert.equal(h.calls.some((call) => call.key === "commit-implementation"), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("architecture workflow does not commit without any verification checks", async () => {
	const cwd = await workspace();
	try {
		const h = context(cwd, {
			implementationResult: {
				status: "completed",
				summary: "Implementation finished without reporting checks.",
				preexistingDirtyPaths: [],
				preexistingStagedPaths: [],
				changedFiles: ["src/test-seam.ts"],
				testsRun: [],
			},
		});
		const result = await workflow.run(h.ctx);

		assert.equal(result.status, "blocked-before-commit");
		assert.deepEqual(result.blockers, ["Implementation reported no tests/checks; refusing to commit without verification."]);
		assert.equal(h.calls.some((call) => call.key === "commit-implementation"), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("architecture workflow stops before commit when staged user changes were present", async () => {
	const cwd = await workspace();
	try {
		const h = context(cwd, {
			implementationResult: {
				status: "completed",
				summary: "Implemented candidate B.",
				preexistingDirtyPaths: ["plan.md"],
				preexistingStagedPaths: ["README.md"],
				changedFiles: ["src/test-seam.ts"],
				testsRun: [{ command: "pnpm test", status: "passed", result: "passed" }],
			},
		});
		const result = await workflow.run(h.ctx);

		assert.equal(result.status, "blocked-before-commit");
		assert.deepEqual(result.blockers, ["Pre-existing staged changes prevent a safe commit: README.md"]);
		assert.equal(h.calls.some((call) => call.key === "commit-implementation"), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
