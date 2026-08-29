import type {
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import {
	profilePath,
	profilesDirectoryFor,
	readActiveProfileName,
	sessionProfileName,
	validateProfileName,
} from "./profile-document.ts";

/** Why a session started; only reload changes Profile resolution. */
export type SessionBoundaryReason = "startup" | "reload" | "new" | "resume" | "fork";

type SessionProfileOrigin = "entry" | "handoff" | "marker" | "none";

/** The immutable Session profile binding visible to Profile-aware adapters. */
export interface SessionProfileBinding {
	readonly profileName: string | undefined;
	readonly settingsPath: string;
}

export const SESSION_PROFILE_ADAPTER_ORDER = [
	"config-profiles",
	"policy-permissions",
	"tools-advisor",
	"tools-subagents",
	"ui-model-selector",
	"workflows-plan",
] as const;

export type SessionProfileAdapterName = typeof SESSION_PROFILE_ADAPTER_ORDER[number];

interface BaseSessionProfileAdapter {
	readonly name: SessionProfileAdapterName;
	readonly applyPath?: (binding: SessionProfileBinding) => void;
	readonly initialize: (
		binding: SessionProfileBinding,
		event: SessionStartEvent,
		ctx: ExtensionContext,
	) => void | Promise<void>;
	readonly dispose?: (binding: SessionProfileBinding, ctx: ExtensionContext) => void | Promise<void>;
}

/** The Profile adapter supplies capabilities used only for a marker-origin binding. */
export interface ConfigProfilesSessionProfileAdapter extends BaseSessionProfileAdapter {
	readonly name: "config-profiles";
	readonly validateMarkerProfile: (profileName: string) => void;
	readonly appendProfileEntry: (profileName: string) => void;
	readonly onMarkerFailure: (error: unknown, ctx: ExtensionContext) => void;
}

export interface OrdinarySessionProfileAdapter extends BaseSessionProfileAdapter {
	readonly name: Exclude<SessionProfileAdapterName, "config-profiles">;
}

export type SessionProfileAdapter = ConfigProfilesSessionProfileAdapter | OrdinarySessionProfileAdapter;

export interface SessionProfileBindingOptions {
	readonly settingsPath: string;
	readonly profilesDirectory?: string;
}

export interface SessionProfileBindingRegistration {
	start(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
	stop(event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void>;
	unregister(): void;
}

const SESSION_PROFILE_HANDOFF_KEY = Symbol.for("pi.extensions.config-profiles.session-handoff.v1");

interface SessionProfileHandoff {
	previousSessionFile?: string;
	profile: string;
}

function sessionProfileHandoff(): SessionProfileHandoff | undefined {
	const globals = globalThis as typeof globalThis & { [SESSION_PROFILE_HANDOFF_KEY]?: SessionProfileHandoff };
	return globals[SESSION_PROFILE_HANDOFF_KEY];
}

/** Stage a Profile for a fresh session before its session_start handlers run. */
export function stageSessionProfileHandoff(previousSessionFile: string | undefined, profile: string | undefined): void {
	const globals = globalThis as typeof globalThis & { [SESSION_PROFILE_HANDOFF_KEY]?: SessionProfileHandoff };
	if (profile === undefined) {
		clearSessionProfileHandoff(previousSessionFile);
		return;
	}
	globals[SESSION_PROFILE_HANDOFF_KEY] = {
		previousSessionFile,
		profile: validateProfileName(profile),
	};
}

function readSessionProfileHandoff(previousSessionFile: string | undefined): string | undefined {
	const handoff = sessionProfileHandoff();
	if (!handoff || handoff.previousSessionFile !== previousSessionFile) return undefined;
	return handoff.profile;
}

/** Clear a completed or cancelled Profile handoff. */
export function clearSessionProfileHandoff(previousSessionFile: string | undefined): void {
	const globals = globalThis as typeof globalThis & { [SESSION_PROFILE_HANDOFF_KEY]?: SessionProfileHandoff };
	const handoff = globals[SESSION_PROFILE_HANDOFF_KEY];
	if (handoff && handoff.previousSessionFile === previousSessionFile) delete globals[SESSION_PROFILE_HANDOFF_KEY];
}

interface SessionProfileSlot {
	readonly binding: SessionProfileBinding;
	readonly origin: SessionProfileOrigin;
	remembered: boolean;
}

interface SessionProfileBindingRegistry {
	readonly slotsByEvent: WeakMap<SessionStartEvent, Map<string, SessionProfileSlot>>;
}

const SESSION_PROFILE_CONTEXT_KEY = Symbol.for("pi.extensions.session-profile-binding.context.v2");

function sessionProfileBindingRegistry(): SessionProfileBindingRegistry {
	const globals = globalThis as typeof globalThis & {
		[SESSION_PROFILE_CONTEXT_KEY]?: SessionProfileBindingRegistry;
	};
	return globals[SESSION_PROFILE_CONTEXT_KEY] ??= { slotsByEvent: new WeakMap() };
}

function resolveSessionProfileSlot(input: {
	entries: readonly unknown[];
	reason: SessionBoundaryReason;
	previousSessionFile?: string;
	settingsPath: string;
	profilesDirectory: string;
}): SessionProfileSlot {
	const fromEntry = sessionProfileName(input.entries);
	if (fromEntry !== undefined) {
		return {
			binding: Object.freeze({
				profileName: fromEntry,
				settingsPath: profilePath(input.profilesDirectory, fromEntry),
			}),
			origin: "entry",
			remembered: false,
		};
	}

	if (input.reason !== "reload") {
		const fromHandoff = input.reason === "new"
			? readSessionProfileHandoff(input.previousSessionFile)
			: undefined;
		if (fromHandoff !== undefined) {
			return {
				binding: Object.freeze({
					profileName: fromHandoff,
					settingsPath: profilePath(input.profilesDirectory, fromHandoff),
				}),
				origin: "handoff",
				remembered: false,
			};
		}

		const fromMarker = readActiveProfileName(input.settingsPath);
		if (fromMarker !== undefined) {
			return {
				binding: Object.freeze({
					profileName: fromMarker,
					settingsPath: profilePath(input.profilesDirectory, fromMarker),
				}),
				origin: "marker",
				remembered: false,
			};
		}
	}

	return {
		binding: Object.freeze({ profileName: undefined, settingsPath: input.settingsPath }),
		origin: "none",
		remembered: false,
	};
}

function enterSessionProfile(
	event: SessionStartEvent,
	ctx: ExtensionContext,
	state: SessionProfileBindingPathState,
): SessionProfileSlot {
	const registry = sessionProfileBindingRegistry();
	let slots = registry.slotsByEvent.get(event);
	if (!slots) {
		slots = new Map();
		registry.slotsByEvent.set(event, slots);
	}
	const existing = slots.get(state.pathKey);
	if (existing) return existing;

	const slot = resolveSessionProfileSlot({
		entries: ctx.sessionManager.getBranch(),
		reason: event.reason,
		previousSessionFile: event.previousSessionFile,
		settingsPath: state.settingsPath,
		profilesDirectory: state.profilesDirectory,
	});
	slots.set(state.pathKey, slot);
	return slot;
}

interface SessionProfileBindingRecord {
	readonly name: SessionProfileAdapterName;
	readonly adapter: SessionProfileAdapter;
}

interface SessionProfileBindingRun {
	readonly slot: SessionProfileSlot;
	readonly records: readonly SessionProfileBindingRecord[];
	readonly attempted: SessionProfileBindingRecord[];
	readonly failures: Map<SessionProfileBindingRecord, unknown>;
}

interface SessionProfileCleanupRun {
	readonly failures: Map<SessionProfileBindingRecord, unknown>;
}

interface SessionProfileBindingPathState {
	readonly settingsPath: string;
	readonly profilesDirectory: string;
	readonly pathKey: string;
	readonly registrations: Map<SessionProfileAdapterName, SessionProfileBindingRecord>;
	readonly startsByEvent: WeakMap<SessionStartEvent, Promise<SessionProfileBindingRun>>;
	readonly stopsByEvent: WeakMap<SessionShutdownEvent, Promise<SessionProfileCleanupRun>>;
	activeRun?: Promise<SessionProfileBindingRun>;
	cleanupInFlight?: Promise<SessionProfileCleanupRun>;
}

interface SessionProfileInitializationRegistry {
	readonly paths: Map<string, SessionProfileBindingPathState>;
}

const SESSION_PROFILE_INITIALIZATION_KEY = Symbol.for("pi.extensions.session-profile-binding.initialization.v2");
const ADAPTER_RANK = new Map<string, number>(SESSION_PROFILE_ADAPTER_ORDER.map((name, index) => [name, index]));

function sessionProfileInitializationRegistry(): SessionProfileInitializationRegistry {
	const globals = globalThis as typeof globalThis & {
		[SESSION_PROFILE_INITIALIZATION_KEY]?: SessionProfileInitializationRegistry;
	};
	return globals[SESSION_PROFILE_INITIALIZATION_KEY] ??= { paths: new Map() };
}

function canonicalPathOptions(options: SessionProfileBindingOptions): {
	settingsPath: string;
	profilesDirectory: string;
	pathKey: string;
} {
	const settingsPath = resolve(options.settingsPath);
	const profilesDirectory = resolve(options.profilesDirectory ?? profilesDirectoryFor(options.settingsPath));
	return {
		settingsPath,
		profilesDirectory,
		pathKey: JSON.stringify([settingsPath, profilesDirectory]),
	};
}

function getPathState(
	registry: SessionProfileInitializationRegistry,
	canonical: ReturnType<typeof canonicalPathOptions>,
): SessionProfileBindingPathState {
	const existing = registry.paths.get(canonical.pathKey);
	if (existing) return existing;
	const state: SessionProfileBindingPathState = {
		...canonical,
		registrations: new Map(),
		startsByEvent: new WeakMap(),
		stopsByEvent: new WeakMap(),
	};
	registry.paths.set(canonical.pathKey, state);
	return state;
}

function orderedRecords(registrations: Iterable<SessionProfileBindingRecord>): SessionProfileBindingRecord[] {
	return [...registrations].sort((left, right) => {
		const rankDifference = (ADAPTER_RANK.get(left.name) ?? Number.MAX_SAFE_INTEGER) -
			(ADAPTER_RANK.get(right.name) ?? Number.MAX_SAFE_INTEGER);
		return rankDifference !== 0 ? rankDifference : left.name.localeCompare(right.name);
	});
}

async function initializeRecord(
	record: SessionProfileBindingRecord,
	run: SessionProfileBindingRun,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): Promise<void> {
	const { slot } = run;
	if (record.adapter.name !== "config-profiles" || slot.origin !== "marker" || slot.binding.profileName === undefined) {
		await record.adapter.initialize(slot.binding, event, ctx);
		return;
	}

	const adapter = record.adapter;
	try {
		adapter.validateMarkerProfile(slot.binding.profileName);
		await adapter.initialize(slot.binding, event, ctx);
		if (!slot.remembered) {
			adapter.appendProfileEntry(slot.binding.profileName);
			slot.remembered = true;
		}
	} catch (error) {
		adapter.onMarkerFailure(error, ctx);
	}
}

async function runInitialization(
	state: SessionProfileBindingPathState,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): Promise<SessionProfileBindingRun> {
	const slot = enterSessionProfile(event, ctx, state);
	const records = orderedRecords(state.registrations.values());
	const run: SessionProfileBindingRun = { slot, records, attempted: [], failures: new Map() };

	for (const record of records) {
		try {
			record.adapter.applyPath?.(slot.binding);
		} catch (error) {
			run.failures.set(record, error);
		}
	}

	for (const record of records) {
		if (run.failures.has(record)) continue;
		run.attempted.push(record);
		try {
			await initializeRecord(record, run, event, ctx);
		} catch (error) {
			run.failures.set(record, error);
		}
	}
	return run;
}

function beginInitialization(
	state: SessionProfileBindingPathState,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): Promise<SessionProfileBindingRun> {
	const existing = state.startsByEvent.get(event);
	if (existing) return existing;
	const run = Promise.resolve().then(() => runInitialization(state, event, ctx));
	state.startsByEvent.set(event, run);
	state.activeRun = run;
	void run.catch(() => {});
	return run;
}

async function runCleanup(
	run: SessionProfileBindingRun | undefined,
	ctx: ExtensionContext,
): Promise<SessionProfileCleanupRun> {
	const failures = new Map<SessionProfileBindingRecord, unknown>();
	if (!run) return { failures };
	for (const record of [...run.attempted].reverse()) {
		if (!record.adapter.dispose) continue;
		try {
			await record.adapter.dispose(run.slot.binding, ctx);
		} catch (error) {
			failures.set(record, error);
		}
	}
	return { failures };
}

function beginCleanup(
	registry: SessionProfileInitializationRegistry,
	state: SessionProfileBindingPathState,
	event: SessionShutdownEvent,
	ctx: ExtensionContext,
): Promise<SessionProfileCleanupRun> {
	const existing = state.stopsByEvent.get(event);
	if (existing) return existing;

	const previousCleanup = state.cleanupInFlight;
	const activeRun = state.activeRun;
	const recordsAtShutdown = new Set(state.registrations.values());
	const cleanup = Promise.resolve().then(async () => {
		if (previousCleanup) await previousCleanup;
		let run: SessionProfileBindingRun | undefined;
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
 * Register one Profile-aware adapter for a canonical Settings/Profile path pair.
 * The first start coordinates every registered adapter through one immutable binding.
 */
export function registerSessionProfileBinding(
	options: SessionProfileBindingOptions,
	adapter: SessionProfileAdapter,
): SessionProfileBindingRegistration {
	const canonical = canonicalPathOptions(options);
	const registry = sessionProfileInitializationRegistry();
	const state = getPathState(registry, canonical);
	const record: SessionProfileBindingRecord = { name: adapter.name, adapter };
	state.registrations.set(adapter.name, record);
	let unregistered = false;

	return {
		async start(event, ctx) {
			const currentState = registry.paths.get(canonical.pathKey) ?? state;
			const run = await beginInitialization(currentState, event, ctx);
			if (run.failures.has(record)) throw run.failures.get(record);
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
