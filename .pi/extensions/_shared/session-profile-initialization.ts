import type {
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import {
	createSessionProfileContext,
	type SessionProfileBinding,
	type SessionProfileContext,
} from "./active-profile.ts";

export const SESSION_PROFILE_ADAPTER_ORDER = [
	"config-profiles",
	"policy-permissions",
	"tools-advisor",
	"tools-subagents",
	"ui-model-selector",
	"workflows-plan",
] as const;

export type SessionProfileAdapterName = typeof SESSION_PROFILE_ADAPTER_ORDER[number];

export interface SessionProfileInitializationAdapter {
	readonly name: SessionProfileAdapterName;
	readonly applyPath?: (binding: SessionProfileBinding) => void;
	readonly initialize: (
		binding: SessionProfileBinding,
		event: SessionStartEvent,
		ctx: ExtensionContext,
	) => void | Promise<void>;
	readonly dispose?: (binding: SessionProfileBinding, ctx: ExtensionContext) => void | Promise<void>;
}

export interface SessionProfileInitializationOptions {
	readonly settingsPath: string;
	readonly profilesDirectory: string;
}

export interface SessionProfileInitializationRegistration {
	start(event: SessionStartEvent, ctx: ExtensionContext): Promise<SessionProfileBinding>;
	stop(event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void>;
	unregister(): void;
}

interface SessionProfileInitializationRecord {
	readonly name: SessionProfileAdapterName;
	readonly adapter: SessionProfileInitializationAdapter;
	readonly context: SessionProfileContext;
}

interface SessionProfileInitializationRun {
	readonly binding: SessionProfileBinding;
	readonly records: readonly SessionProfileInitializationRecord[];
	readonly attempted: SessionProfileInitializationRecord[];
	readonly failures: Map<SessionProfileInitializationRecord, unknown>;
}

interface SessionProfileCleanupRun {
	readonly failures: Map<SessionProfileInitializationRecord, unknown>;
}

interface SessionProfileInitializationPathState {
	readonly pathKey: string;
	readonly registrations: Map<SessionProfileAdapterName, SessionProfileInitializationRecord>;
	readonly startsByEvent: WeakMap<SessionStartEvent, Promise<SessionProfileInitializationRun>>;
	readonly stopsByEvent: WeakMap<SessionShutdownEvent, Promise<SessionProfileCleanupRun>>;
	activeRun?: Promise<SessionProfileInitializationRun>;
	cleanupInFlight?: Promise<SessionProfileCleanupRun>;
}

interface SessionProfileInitializationRegistry {
	readonly paths: Map<string, SessionProfileInitializationPathState>;
}

const SESSION_PROFILE_INITIALIZATION_KEY = Symbol.for("pi.extensions.active-profile.session-initialization.v1");
const ADAPTER_RANK = new Map<string, number>(SESSION_PROFILE_ADAPTER_ORDER.map((name, index) => [name, index]));

function sessionProfileInitializationRegistry(): SessionProfileInitializationRegistry {
	const globals = globalThis as typeof globalThis & {
		[SESSION_PROFILE_INITIALIZATION_KEY]?: SessionProfileInitializationRegistry;
	};
	return globals[SESSION_PROFILE_INITIALIZATION_KEY] ??= { paths: new Map() };
}

function canonicalPathOptions(options: SessionProfileInitializationOptions): {
	settingsPath: string;
	profilesDirectory: string;
	pathKey: string;
} {
	const settingsPath = resolve(options.settingsPath);
	const profilesDirectory = resolve(options.profilesDirectory);
	return {
		settingsPath,
		profilesDirectory,
		pathKey: JSON.stringify([settingsPath, profilesDirectory]),
	};
}

function getPathState(
	registry: SessionProfileInitializationRegistry,
	{ pathKey }: ReturnType<typeof canonicalPathOptions>,
): SessionProfileInitializationPathState {
	const existing = registry.paths.get(pathKey);
	if (existing) return existing;

	const state: SessionProfileInitializationPathState = {
		pathKey,
		registrations: new Map(),
		startsByEvent: new WeakMap(),
		stopsByEvent: new WeakMap(),
	};
	registry.paths.set(pathKey, state);
	return state;
}

function orderedRecords(
	registrations: Iterable<SessionProfileInitializationRecord>,
): SessionProfileInitializationRecord[] {
	return [...registrations].sort((left, right) => {
		const rankDifference = (ADAPTER_RANK.get(left.name) ?? Number.MAX_SAFE_INTEGER) -
			(ADAPTER_RANK.get(right.name) ?? Number.MAX_SAFE_INTEGER);
		return rankDifference !== 0 ? rankDifference : left.name.localeCompare(right.name);
	});
}

async function runInitialization(
	state: SessionProfileInitializationPathState,
	initiatingRecord: SessionProfileInitializationRecord,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): Promise<SessionProfileInitializationRun> {
	const binding = initiatingRecord.context.enter(event, ctx);
	const records = orderedRecords(state.registrations.values());
	const run: SessionProfileInitializationRun = {
		binding,
		records,
		attempted: [],
		failures: new Map(),
	};

	for (const record of records) {
		try {
			record.adapter.applyPath?.(binding);
		} catch (error) {
			run.failures.set(record, error);
		}
	}

	for (const record of records) {
		if (run.failures.has(record)) continue;
		run.attempted.push(record);
		try {
			await record.adapter.initialize(binding, event, ctx);
		} catch (error) {
			run.failures.set(record, error);
		}
	}

	return run;
}

function beginInitialization(
	state: SessionProfileInitializationPathState,
	record: SessionProfileInitializationRecord,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): Promise<SessionProfileInitializationRun> {
	const existing = state.startsByEvent.get(event);
	if (existing) return existing;

	const run = Promise.resolve().then(() => runInitialization(state, record, event, ctx));
	state.startsByEvent.set(event, run);
	state.activeRun = run;
	void run.catch(() => {});
	return run;
}

async function runCleanup(
	run: SessionProfileInitializationRun | undefined,
	ctx: ExtensionContext,
): Promise<SessionProfileCleanupRun> {
	const failures = new Map<SessionProfileInitializationRecord, unknown>();
	if (!run) return { failures };

	for (const record of [...run.attempted].reverse()) {
		if (!record.adapter.dispose) continue;
		try {
			await record.adapter.dispose(run.binding, ctx);
		} catch (error) {
			failures.set(record, error);
		}
	}
	return { failures };
}

function beginCleanup(
	registry: SessionProfileInitializationRegistry,
	state: SessionProfileInitializationPathState,
	event: SessionShutdownEvent,
	ctx: ExtensionContext,
): Promise<SessionProfileCleanupRun> {
	const existing = state.stopsByEvent.get(event);
	if (existing) return existing;
	if (state.cleanupInFlight) return state.cleanupInFlight;

	const activeRun = state.activeRun;
	const recordsAtShutdown = new Set(state.registrations.values());
	const cleanup = Promise.resolve().then(async () => {
		let run: SessionProfileInitializationRun | undefined;
		if (activeRun) {
			try {
				run = await activeRun;
			} catch {
				// Binding resolution failed, so there is no adapter state to dispose.
			}
		}

		const result = await runCleanup(run, ctx);
		const recordsToRemove = run ? new Set(run.records) : recordsAtShutdown;
		for (const [name, record] of state.registrations) {
			if (recordsToRemove.has(record)) state.registrations.delete(name);
		}
		if (state.activeRun === activeRun) state.activeRun = undefined;
		if (state.cleanupInFlight === cleanup) state.cleanupInFlight = undefined;
		if (state.registrations.size === 0 && state.activeRun === undefined) {
			if (registry.paths.get(state.pathKey) === state) registry.paths.delete(state.pathKey);
		}
		return result;
	});
	state.stopsByEvent.set(event, cleanup);
	state.cleanupInFlight = cleanup;
	return cleanup;
}

/**
 * Register one optional Profile-aware adapter for a canonical Settings/Profile
 * path pair. The first start for an event coordinates every currently
 * registered adapter; later starts observe the same run and binding.
 */
export function registerSessionProfileInitialization(
	options: SessionProfileInitializationOptions,
	adapter: SessionProfileInitializationAdapter,
): SessionProfileInitializationRegistration {
	const canonical = canonicalPathOptions(options);
	const registry = sessionProfileInitializationRegistry();
	const state = getPathState(registry, canonical);
	const record: SessionProfileInitializationRecord = {
		name: adapter.name,
		adapter,
		context: createSessionProfileContext(canonical),
	};
	state.registrations.set(adapter.name, record);
	let unregistered = false;

	return {
		async start(event, ctx) {
			const currentState = registry.paths.get(canonical.pathKey) ?? state;
			const run = await beginInitialization(currentState, record, event, ctx);
			if (run.failures.has(record)) throw run.failures.get(record);
			return run.binding;
		},

		async stop(event, ctx) {
			if (!state.stopsByEvent.has(event) && state.activeRun === undefined && state.registrations.get(adapter.name) !== record) return;
			const cleanup = await beginCleanup(registry, state, event, ctx);
			if (cleanup.failures.has(record)) throw cleanup.failures.get(record);
		},

		unregister() {
			if (unregistered) return;
			unregistered = true;
			if (state.registrations.get(adapter.name) !== record) return;
			state.registrations.delete(adapter.name);
			if (state.registrations.size === 0 && state.activeRun === undefined && state.cleanupInFlight === undefined &&
				registry.paths.get(state.pathKey) === state) {
				registry.paths.delete(state.pathKey);
			}
		},
	};
}
