import * as path from "node:path";
import { runPaths, safeArtifactPath, type InternalRunPaths, type RunInput, type RunPersistence } from "./run-store.ts";
import type { WorkflowRunEventView } from "./workflow-run-events.ts";

export interface InMemoryRunPersistenceOptions {
	paths?: InternalRunPaths;
	failAppend?: boolean;
	failProjection?: boolean;
	failNextAppend?: boolean;
	failNextProjection?: boolean;
}

/**
 * Test-only persistence with the same JSON/timestamp boundaries as the file
 * adapter. It deliberately has no reducer or lifecycle policy.
 */
export class InMemoryRunPersistence implements RunPersistence {
	private readonly runPaths: InternalRunPaths;
	private inputValue: unknown;
	private eventLogExists = false;
	private eventValues: WorkflowRunEventView[] = [];
	private projectionValue: unknown;
	private readonly artifactValues = new Map<string, string>();
	failAppend: boolean;
	failProjection: boolean;
	failNextAppend: boolean;
	failNextProjection: boolean;

	constructor(cwd = process.cwd(), runId = `test-${Date.now()}`, options: InMemoryRunPersistenceOptions = {}) {
		this.runPaths = options.paths ? { ...options.paths } : runPaths(cwd, runId);
		this.failAppend = options.failAppend ?? false;
		this.failProjection = options.failProjection ?? false;
		this.failNextAppend = options.failNextAppend ?? false;
		this.failNextProjection = options.failNextProjection ?? false;
	}

	paths(): InternalRunPaths {
		return { ...this.runPaths };
	}

	async initializeInput(input: RunInput): Promise<void> {
		this.inputValue = JSON.parse(JSON.stringify({
			args: input.args,
			workflowName: input.workflowName,
			sourceHash: input.sourceHash,
			createdAt: input.createdAt ?? Date.now(),
		}));
	}

	async appendEvent(event: WorkflowRunEventView): Promise<void> {
		if (this.failAppend || this.failNextAppend) {
			this.failNextAppend = false;
			throw new Error("Injected in-memory event append failure");
		}
		this.eventLogExists = true;
		this.eventValues.push(JSON.parse(JSON.stringify({ ts: Date.now(), ...event })) as WorkflowRunEventView);
	}

	async readEventLog(): Promise<{ exists: boolean; events: readonly WorkflowRunEventView[] }> {
		return { exists: this.eventLogExists, events: JSON.parse(JSON.stringify(this.eventValues)) as WorkflowRunEventView[] };
	}

	async readProjection(): Promise<unknown | undefined> {
		return this.projectionValue === undefined ? undefined : JSON.parse(JSON.stringify(this.projectionValue));
	}

	async writeProjection(projection: unknown): Promise<void> {
		if (this.failProjection || this.failNextProjection) {
			this.failNextProjection = false;
			throw new Error("Injected in-memory projection write failure");
		}
		this.projectionValue = JSON.parse(JSON.stringify(projection));
	}

	async writeArtifact(requestedPath: string, data: string): Promise<string> {
		const target = safeArtifactPath(this.runPaths.artifacts, requestedPath);
		const relative = path.relative(this.runPaths.root, target);
		this.artifactValues.set(relative, data);
		return relative;
	}

	get input(): unknown { return this.inputValue === undefined ? undefined : JSON.parse(JSON.stringify(this.inputValue)); }
	get events(): readonly WorkflowRunEventView[] { return JSON.parse(JSON.stringify(this.eventValues)) as WorkflowRunEventView[]; }
	get projection(): unknown { return this.projectionValue === undefined ? undefined : JSON.parse(JSON.stringify(this.projectionValue)); }
	get artifacts(): ReadonlyMap<string, string> { return new Map(this.artifactValues); }
	setEmptyEventLog(): void { this.eventLogExists = true; this.eventValues = []; }
	seedEvents(events: readonly WorkflowRunEventView[]): void {
		this.eventLogExists = true;
		this.eventValues = JSON.parse(JSON.stringify(events)) as WorkflowRunEventView[];
	}
	seedProjection(projection: unknown): void { this.projectionValue = JSON.parse(JSON.stringify(projection)); }
}