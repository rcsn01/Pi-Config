import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRunPersistence, type InternalRunPaths, type RunPersistence } from "./run-store.ts";
import {
	isWorkflowRunNotFound,
	recoverWorkflowRunState,
	WorkflowEventLogEmptyError,
	WorkflowRunNotFoundError,
} from "./workflow-run-recovery.ts";
import {
	isWorkflowRunNotFound as compatibilityIsNotFound,
	WorkflowEventLogEmptyError as CompatibilityEmptyError,
	WorkflowRunNotFoundError as CompatibilityNotFoundError,
} from "./workflow-run.ts";
import { rebuildState, type WorkflowRunEventView } from "./workflow-run-state.ts";
import { InMemoryRunPersistence } from "./test-support.ts";

const temporary: string[] = [];
const originalStateDir = process.env.PI_CONFIG_STATE_DIR;

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	if (originalStateDir === undefined) delete process.env.PI_CONFIG_STATE_DIR;
	else process.env.PI_CONFIG_STATE_DIR = originalStateDir;
});

function runCreated(runId: string, overrides: Record<string, unknown> = {}): WorkflowRunEventView {
	return {
		type: "run_created",
		ts: 1,
		runId,
		workflowName: "recovery-test",
		trust: "bundled",
		args: "",
		sourceHash: "hash",
		...overrides,
	};
}

function stateFrom(runId: string, ...events: WorkflowRunEventView[]) {
	return rebuildState([runCreated(runId), ...events]);
}

async function filePersistence(runId: string): Promise<FileRunPersistence> {
	const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "workflow-recovery-state-"));
	const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "workflow-recovery-project-"));
	temporary.push(stateDirectory, projectDirectory);
	process.env.PI_CONFIG_STATE_DIR = stateDirectory;
	return new FileRunPersistence(projectDirectory, runId);
}

type RecoveryPersistence = Pick<RunPersistence, "readEventLog" | "readProjection" | "writeProjection" | "paths">;

interface TraceOptions {
	log?: { exists: boolean; events: readonly WorkflowRunEventView[] };
	projection?: unknown;
	readEventError?: unknown;
	readProjectionError?: unknown;
	pathsError?: unknown;
}

function tracingPersistence(options: TraceOptions = {}): { persistence: RecoveryPersistence; calls: string[] } {
	const calls: string[] = [];
	const paths: InternalRunPaths = {
		root: "/runs/trace",
		events: "/runs/trace/events.jsonl",
		state: "/runs/trace/state.json",
		input: "/runs/trace/input.json",
		artifacts: "/runs/trace/artifacts",
	};
	return {
		calls,
		persistence: {
			async readEventLog() {
				calls.push("readEventLog");
				if (options.readEventError !== undefined) throw options.readEventError;
				return options.log ?? { exists: false, events: [] };
			},
			async readProjection() {
				calls.push("readProjection");
				if (options.readProjectionError !== undefined) throw options.readProjectionError;
				return options.projection;
			},
			async writeProjection() {
				calls.push("writeProjection");
			},
			paths() {
				calls.push("paths");
				if (options.pathsError !== undefined) throw options.pathsError;
				return { ...paths };
			},
		},
	};
}

describe("recoverWorkflowRunState", () => {
	it("uses canonical events and repairs a conflicting projection", async () => {
		const persistence = new InMemoryRunPersistence(process.cwd(), "run-events");
		const events = [runCreated("run-events"), { type: "run_started", ts: 2 }];
		persistence.seedEvents(events);
		persistence.seedProjection(stateFrom("run-events"));

		const state = await recoverWorkflowRunState(persistence, "run-events");

		expect(state.status).toBe("running");
		expect(persistence.projection).toEqual(state);
	});

	it("uses a valid projection only when the event log is missing", async () => {
		const persistence = new InMemoryRunPersistence(process.cwd(), "run-projection");
		const projection = stateFrom("run-projection", { type: "run_started", ts: 2 });
		persistence.seedProjection(projection);

		expect(await recoverWorkflowRunState(persistence, "run-projection")).toEqual(projection);
		expect(persistence.projection).toEqual(projection);
	});

	it("reports a missing run with stable error details", async () => {
		const persistence = new InMemoryRunPersistence(process.cwd(), "run-missing");

		const failure = await recoverWorkflowRunState(persistence, "run-missing").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(WorkflowRunNotFoundError);
		expect(failure).toMatchObject({
			name: "WorkflowRunNotFoundError",
			code: "WORKFLOW_RUN_NOT_FOUND",
			message: "Workflow run not found: run-missing",
		});
	});

	it("treats an existing empty log as authoritative", async () => {
		const persistence = new InMemoryRunPersistence(process.cwd(), "run-empty");
		const projection = stateFrom("run-empty");
		persistence.setEmptyEventLog();
		persistence.seedProjection(projection);

		const failure = await recoverWorkflowRunState(persistence, "run-empty").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(WorkflowEventLogEmptyError);
		expect(failure).toMatchObject({
			name: "WorkflowEventLogEmptyError",
			code: "WORKFLOW_EVENT_LOG_EMPTY",
			message: `Workflow event log is empty: ${persistence.paths().events}`,
		});
		expect(persistence.projection).toEqual(projection);
	});

	it("returns canonical state when projection repair fails", async () => {
		const persistence = new InMemoryRunPersistence(process.cwd(), "run-repair-failure", { failProjection: true });
		persistence.seedEvents([runCreated("run-repair-failure"), { type: "run_started", ts: 2 }]);

		expect((await recoverWorkflowRunState(persistence, "run-repair-failure")).status).toBe("running");
	});

	it("propagates fallback projection validation failures", async () => {
		const persistence = new InMemoryRunPersistence(process.cwd(), "run-invalid-projection");
		persistence.seedProjection({ runId: "run-invalid-projection" });

		await expect(recoverWorkflowRunState(persistence, "run-invalid-projection"))
			.rejects.toThrow("Invalid workflow projection");
	});

	it("rejects a fallback projection for another run", async () => {
		const persistence = new InMemoryRunPersistence(process.cwd(), "run-expected");
		persistence.seedProjection(stateFrom("run-other"));

		await expect(recoverWorkflowRunState(persistence, "run-expected"))
			.rejects.toThrow("Workflow projection run id mismatch: expected run-expected, got run-other");
	});

	it("does not use a fallback projection after reducer failure", async () => {
		const persistence = new InMemoryRunPersistence(process.cwd(), "run-reducer");
		persistence.seedEvents([{ type: "run_started", ts: 1 }]);
		persistence.seedProjection(stateFrom("run-reducer"));

		await expect(recoverWorkflowRunState(persistence, "run-reducer"))
			.rejects.toThrow("Cannot apply run_started before run_created");
		expect(persistence.projection).toEqual(stateFrom("run-reducer"));
	});

	it("does not use a fallback projection after canonical run-id mismatch", async () => {
		const persistence = new InMemoryRunPersistence(process.cwd(), "run-expected-events");
		persistence.seedEvents([runCreated("run-other-events")]);
		persistence.seedProjection(stateFrom("run-expected-events"));

		await expect(recoverWorkflowRunState(persistence, "run-expected-events"))
			.rejects.toThrow("Workflow projection run id mismatch: expected run-expected-events, got run-other-events");
		expect(persistence.projection).toEqual(stateFrom("run-expected-events"));
	});

	it("keeps event and fallback persistence ordering explicit", async () => {
		const canonical = tracingPersistence({ log: { exists: true, events: [runCreated("run-order-events")] } });
		await recoverWorkflowRunState(canonical.persistence, "run-order-events");
		expect(canonical.calls).toEqual(["readEventLog", "writeProjection"]);

		const fallback = tracingPersistence({ projection: stateFrom("run-order-projection") });
		await recoverWorkflowRunState(fallback.persistence, "run-order-projection");
		expect(fallback.calls).toEqual(["readEventLog", "readProjection"]);
	});

	it("does not access projection methods after canonical failures", async () => {
		const cases = [
			{ name: "empty", events: [] },
			{ name: "unreducible", events: [{ type: "run_started", ts: 1 }] },
			{ name: "invalid", events: [runCreated("run-invalid-order", { trust: "invalid" })] },
		] as const;
		for (const current of cases) {
			const traced = tracingPersistence({ log: { exists: true, events: current.events } });
			await expect(recoverWorkflowRunState(traced.persistence, "run-invalid-order")).rejects.toBeInstanceOf(Error);
			expect(traced.calls.filter((call) => call === "readProjection" || call === "writeProjection"), current.name).toEqual([]);
		}
	});

	it("propagates path and read failures without later persistence calls", async () => {
		const pathError = new Error("path failed");
		const pathFailure = tracingPersistence({ log: { exists: true, events: [] }, pathsError: pathError });
		await expect(recoverWorkflowRunState(pathFailure.persistence, "run-path-error")).rejects.toBe(pathError);
		expect(pathFailure.calls).toEqual(["readEventLog", "paths"]);

		const eventError = new Error("event read failed");
		const eventFailure = tracingPersistence({ readEventError: eventError });
		await expect(recoverWorkflowRunState(eventFailure.persistence, "run-event-error")).rejects.toBe(eventError);
		expect(eventFailure.calls).toEqual(["readEventLog"]);

		const projectionError = new Error("projection read failed");
		const projectionFailure = tracingPersistence({ readProjectionError: projectionError });
		await expect(recoverWorkflowRunState(projectionFailure.persistence, "run-projection-error")).rejects.toBe(projectionError);
		expect(projectionFailure.calls).toEqual(["readEventLog", "readProjection"]);
	});

	it("repairs state.json through the file adapter", async () => {
		const persistence = await filePersistence("run-file-repair");
		await persistence.appendEvent(runCreated("run-file-repair"));
		await persistence.appendEvent({ type: "run_started", ts: 2 });
		await persistence.writeProjection(stateFrom("run-file-repair"));

		const state = await recoverWorkflowRunState(persistence, "run-file-repair");

		expect(state.status).toBe("running");
		expect(JSON.parse(await readFile(persistence.paths().state, "utf8"))).toEqual(state);
	});

	it("does not fall back after malformed file-backed JSONL", async () => {
		const persistence = await filePersistence("run-malformed-events");
		const projection = stateFrom("run-malformed-events");
		await persistence.writeProjection(projection);
		await writeFile(persistence.paths().events, "{malformed\n", "utf8");

		await expect(recoverWorkflowRunState(persistence, "run-malformed-events"))
			.rejects.toThrow(`Invalid workflow event JSONL at ${persistence.paths().events}:1`);
		expect(await persistence.readProjection()).toEqual(projection);
	});

	it("treats whitespace-only file-backed JSONL as an existing empty log", async () => {
		const persistence = await filePersistence("run-whitespace-events");
		const projection = stateFrom("run-whitespace-events");
		await persistence.writeProjection(projection);
		await writeFile(persistence.paths().events, "  \n\t\n", "utf8");

		await expect(recoverWorkflowRunState(persistence, "run-whitespace-events"))
			.rejects.toThrow(`Workflow event log is empty: ${persistence.paths().events}`);
		expect(await persistence.readProjection()).toEqual(projection);
	});

	it("propagates malformed file-backed projection JSON", async () => {
		const persistence = await filePersistence("run-malformed-projection");
		await persistence.writeProjection(stateFrom("run-malformed-projection"));
		await writeFile(persistence.paths().state, "{malformed", "utf8");

		await expect(recoverWorkflowRunState(persistence, "run-malformed-projection"))
			.rejects.toBeInstanceOf(SyntaxError);
	});

	it("does not fall back after canonical event-derived validation failure", async () => {
		const persistence = new InMemoryRunPersistence(process.cwd(), "run-invalid-events");
		persistence.seedEvents([runCreated("run-invalid-events", { trust: "invalid" })]);
		persistence.seedProjection(stateFrom("run-invalid-events"));

		await expect(recoverWorkflowRunState(persistence, "run-invalid-events"))
			.rejects.toThrow("Invalid workflow projection: trust must be bundled or project");
		expect(persistence.projection).toEqual(stateFrom("run-invalid-events"));
	});

	it("preserves error predicates and compatibility exports", () => {
		const notFound = new WorkflowRunNotFoundError("run-errors");
		const empty = new WorkflowEventLogEmptyError("/runs/run-errors/events.jsonl");
		expect(notFound).toMatchObject({ name: "WorkflowRunNotFoundError", code: "WORKFLOW_RUN_NOT_FOUND", message: "Workflow run not found: run-errors" });
		expect(empty).toMatchObject({ name: "WorkflowEventLogEmptyError", code: "WORKFLOW_EVENT_LOG_EMPTY", message: "Workflow event log is empty: /runs/run-errors/events.jsonl" });
		expect(isWorkflowRunNotFound(notFound)).toBe(true);
		expect(isWorkflowRunNotFound({ code: "WORKFLOW_RUN_NOT_FOUND" })).toBe(true);
		expect(isWorkflowRunNotFound({ code: "OTHER" })).toBe(false);
		expect(isWorkflowRunNotFound(null)).toBe(false);
		expect(CompatibilityNotFoundError).toBe(WorkflowRunNotFoundError);
		expect(CompatibilityEmptyError).toBe(WorkflowEventLogEmptyError);
		expect(compatibilityIsNotFound).toBe(isWorkflowRunNotFound);
	});
});
