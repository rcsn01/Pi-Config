import type {
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_PROFILES_ENTRY_TYPE } from "./profile-document.ts";
import {
	clearSessionProfileHandoff,
	registerSessionProfileBinding,
	SESSION_PROFILE_ADAPTER_ORDER,
	stageSessionProfileHandoff,
	type SessionProfileAdapter,
	type SessionProfileAdapterName,
	type SessionProfileBinding,
	type SessionProfileBindingRegistration,
} from "./session-profile-binding.ts";

const roots: string[] = [];
const registrations: SessionProfileBindingRegistration[] = [];

function fixture(marker: string | null = "focused") {
	const root = mkdtempSync(join(tmpdir(), "session-profile-binding-"));
	roots.push(root);
	const settingsPath = join(root, "settings.json");
	const profilesDirectory = join(root, "profiles");
	mkdirSync(profilesDirectory);
	writeFileSync(settingsPath, JSON.stringify(marker ? { configProfiles: { active: marker } } : {}));
	return { root, settingsPath, profilesDirectory };
}

const entry = (active: unknown) => ({
	type: "custom",
	customType: CONFIG_PROFILES_ENTRY_TYPE,
	data: { active },
});

function lifecycle(
	entries: readonly unknown[] = [],
	reason: SessionStartEvent["reason"] = "startup",
	previousSessionFile?: string,
) {
	const event = { type: "session_start", reason, previousSessionFile } as SessionStartEvent;
	const ctx = {
		sessionManager: { getBranch: vi.fn(() => entries) },
	} as unknown as ExtensionContext;
	return { event, ctx };
}

function shutdown(): SessionShutdownEvent {
	return { type: "session_shutdown", reason: "quit" };
}

type AdapterOverrides = {
	applyPath?: (binding: SessionProfileBinding) => void;
	initialize?: SessionProfileAdapter["initialize"];
	dispose?: (binding: SessionProfileBinding, ctx: ExtensionContext) => void | Promise<void>;
	validateMarkerProfile?: (profileName: string) => void;
	appendProfileEntry?: (profileName: string) => void;
	onMarkerFailure?: (error: unknown, ctx: ExtensionContext) => void;
};

function testAdapter(
	name: SessionProfileAdapterName,
	actions: string[],
	overrides: AdapterOverrides = {},
): SessionProfileAdapter {
	const common = {
		applyPath: overrides.applyPath ?? (() => actions.push(`path:${name}`)),
		initialize: overrides.initialize ?? (async () => {
			actions.push(`init:${name}`);
			await Promise.resolve();
		}),
		dispose: overrides.dispose ?? (async () => {
			actions.push(`dispose:${name}`);
			await Promise.resolve();
		}),
	};
	if (name === "config-profiles") {
		return {
			name,
			...common,
			validateMarkerProfile: overrides.validateMarkerProfile ?? (() => {}),
			appendProfileEntry: overrides.appendProfileEntry ?? (() => {}),
			onMarkerFailure: overrides.onMarkerFailure ?? (() => {}),
		};
	}
	return { name, ...common };
}

function register(
	paths: { settingsPath: string; profilesDirectory: string },
	adapter: SessionProfileAdapter,
): SessionProfileBindingRegistration {
	const registration = registerSessionProfileBinding(paths, adapter);
	registrations.push(registration);
	return registration;
}

afterEach(async () => {
	const event = shutdown();
	for (const registration of registrations) await registration.stop(event, {} as ExtensionContext).catch(() => {});
	for (const registration of registrations) registration.unregister();
	registrations.length = 0;
	clearSessionProfileHandoff(undefined);
	clearSessionProfileHandoff("parent.jsonl");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Session profile binding", () => {
	it.each(["startup", "resume", "fork"] as const)("prefers the session entry on %s", async (reason) => {
		const paths = fixture("marker");
		let observed: SessionProfileBinding | undefined;
		const registration = register(paths, testAdapter("tools-advisor", [], {
			initialize: (binding) => { observed = binding; },
		}));
		const { event, ctx } = lifecycle([entry("remembered")], reason);

		await registration.start(event, ctx);

		expect(observed).toEqual({
			profileName: "remembered",
			settingsPath: join(paths.profilesDirectory, "remembered.json"),
		});
		expect(Object.isFrozen(observed)).toBe(true);
	});

	it("uses matching handoff, then marker, then the Settings document", async () => {
		const handoffPaths = fixture("marker");
		const markerPaths = fixture("focused");
		const unboundPaths = fixture(null);
		const observed: SessionProfileBinding[] = [];
		stageSessionProfileHandoff("parent.jsonl", "handoff");
		const handoff = register(handoffPaths, testAdapter("tools-advisor", [], { initialize: (binding) => { observed.push(binding); } }));
		const marker = register(markerPaths, testAdapter("tools-advisor", [], { initialize: (binding) => { observed.push(binding); } }));
		const unbound = register(unboundPaths, testAdapter("tools-advisor", [], { initialize: (binding) => { observed.push(binding); } }));

		await handoff.start(...Object.values(lifecycle([], "new", "parent.jsonl")) as [SessionStartEvent, ExtensionContext]);
		await marker.start(...Object.values(lifecycle([], "new", "other.jsonl")) as [SessionStartEvent, ExtensionContext]);
		await unbound.start(...Object.values(lifecycle([], "startup")) as [SessionStartEvent, ExtensionContext]);

		expect(observed.map((binding) => binding.profileName)).toEqual(["handoff", "focused", undefined]);
		expect(observed[2]?.settingsPath).toBe(unboundPaths.settingsPath);
	});

	it("consults entries only on reload", async () => {
		const paths = fixture("marker");
		stageSessionProfileHandoff("parent.jsonl", "handoff");
		let observed: SessionProfileBinding | undefined;
		const registration = register(paths, testAdapter("tools-advisor", [], {
			initialize: (binding) => { observed = binding; },
		}));
		const { event, ctx } = lifecycle([], "reload", "parent.jsonl");

		await registration.start(event, ctx);

		expect(observed).toEqual({ profileName: undefined, settingsPath: paths.settingsPath });
	});

	it("applies every path before stable initialization through one frozen binding", async () => {
		const paths = fixture();
		const actions: string[] = [];
		const bindings: SessionProfileBinding[] = [];
		const byName = new Map<SessionProfileAdapterName, SessionProfileBindingRegistration>();
		for (const name of [...SESSION_PROFILE_ADAPTER_ORDER].reverse()) {
			byName.set(name, register(paths, testAdapter(name, actions, {
				initialize: async (binding) => {
					bindings.push(binding);
					actions.push(`init:${name}`);
				},
			})));
		}
		const { event, ctx } = lifecycle();

		await byName.get("workflows-plan")!.start(event, ctx);
		await byName.get("config-profiles")!.start(event, ctx);

		expect(actions).toEqual([
			...SESSION_PROFILE_ADAPTER_ORDER.map((name) => `path:${name}`),
			...SESSION_PROFILE_ADAPTER_ORDER.map((name) => `init:${name}`),
		]);
		expect(ctx.sessionManager.getBranch).toHaveBeenCalledOnce();
		expect(bindings.every((binding) => binding === bindings[0])).toBe(true);
		expect(Object.isFrozen(bindings[0])).toBe(true);
	});

	it("validates and persists marker bindings automatically", async () => {
		const paths = fixture("focused");
		const validate = vi.fn();
		const append = vi.fn();
		const onFailure = vi.fn();
		const actions: string[] = [];
		const registration = register(paths, testAdapter("config-profiles", actions, {
			validateMarkerProfile: validate,
			appendProfileEntry: append,
			onMarkerFailure: onFailure,
		}));
		const { event, ctx } = lifecycle();

		await registration.start(event, ctx);
		await registration.start(event, ctx);

		expect(validate).toHaveBeenCalledOnce();
		expect(append).toHaveBeenCalledOnce();
		expect(append).toHaveBeenCalledWith("focused");
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("reports marker failure, continues siblings, and retries on a fresh event", async () => {
		const paths = fixture("focused");
		const appendFailure = new Error("append failed");
		const append = vi.fn()
			.mockImplementationOnce(() => { throw appendFailure; })
			.mockImplementation(() => undefined);
		const onFailure = vi.fn();
		const actions: string[] = [];
		const profile = register(paths, testAdapter("config-profiles", actions, { appendProfileEntry: append, onMarkerFailure: onFailure }));
		const sibling = register(paths, testAdapter("tools-advisor", actions));

		const first = lifecycle();
		await sibling.start(first.event, first.ctx);
		expect(onFailure).toHaveBeenCalledWith(appendFailure, first.ctx);
		expect(actions).toContain("init:tools-advisor");

		const second = lifecycle();
		await profile.start(second.event, second.ctx);
		expect(append).toHaveBeenCalledTimes(2);
	});

	it("isolates path and initialization failures", async () => {
		const paths = fixture(null);
		const actions: string[] = [];
		const pathFailure = new Error("path failed");
		const initFailure = new Error("init failed");
		const failedPath = register(paths, testAdapter("config-profiles", actions, {
			applyPath: () => { actions.push("path:config-profiles"); throw pathFailure; },
		}));
		const failedInit = register(paths, testAdapter("policy-permissions", actions, {
			initialize: async () => { actions.push("init:policy-permissions"); throw initFailure; },
		}));
		const healthy = register(paths, testAdapter("tools-advisor", actions));
		const { event, ctx } = lifecycle();

		await healthy.start(event, ctx);
		await expect(failedPath.start(event, ctx)).rejects.toBe(pathFailure);
		await expect(failedInit.start(event, ctx)).rejects.toBe(initFailure);
		expect(actions).toEqual([
			"path:config-profiles",
			"path:policy-permissions",
			"path:tools-advisor",
			"init:policy-permissions",
			"init:tools-advisor",
		]);
	});

	it("keeps replacement registrations safe from stale lifecycle tokens", async () => {
		const paths = fixture(null);
		const staleActions: string[] = [];
		const replacementActions: string[] = [];
		const stale = register(paths, testAdapter("tools-advisor", staleActions));
		stale.unregister();
		const replacement = register(paths, testAdapter("tools-advisor", replacementActions));
		stale.unregister();
		const { event, ctx } = lifecycle();

		await stale.start(event, ctx);
		await replacement.start(event, ctx);

		expect(staleActions).toEqual([]);
		expect(replacementActions).toEqual(["path:tools-advisor", "init:tools-advisor"]);
	});

	it("queues cleanup for a restarted lifecycle while prior cleanup is in flight", async () => {
		const paths = fixture(null);
		let releaseFirstDispose!: () => void;
		let markFirstDisposeStarted!: () => void;
		const firstDisposeStarted = new Promise<void>((resolve) => { markFirstDisposeStarted = resolve; });
		const firstDisposeReleased = new Promise<void>((resolve) => { releaseFirstDispose = resolve; });
		let disposeCount = 0;
		const registration = register(paths, testAdapter("tools-advisor", [], {
			dispose: async () => {
				disposeCount++;
				if (disposeCount === 1) {
					markFirstDisposeStarted();
					await firstDisposeReleased;
				}
			},
		}));
		const first = lifecycle();
		await registration.start(first.event, first.ctx);
		const firstStop = registration.stop(shutdown(), first.ctx);
		await firstDisposeStarted;

		const second = lifecycle();
		await registration.start(second.event, second.ctx);
		const secondStop = registration.stop(shutdown(), second.ctx);
		releaseFirstDispose();
		await Promise.all([firstStop, secondStop]);

		expect(disposeCount).toBe(2);
	});

	it("cleans up attempted adapters once in reverse order and isolates failures", async () => {
		const paths = fixture(null);
		const actions: string[] = [];
		const cleanupFailure = new Error("cleanup failed");
		const first = register(paths, testAdapter("config-profiles", actions));
		const failing = register(paths, testAdapter("policy-permissions", actions, {
			dispose: async () => { actions.push("dispose:policy-permissions"); throw cleanupFailure; },
		}));
		const last = register(paths, testAdapter("tools-advisor", actions));
		const { event, ctx } = lifecycle();
		await first.start(event, ctx);
		const stopEvent = shutdown();

		await last.stop(stopEvent, {} as ExtensionContext);
		await expect(failing.stop(stopEvent, {} as ExtensionContext)).rejects.toBe(cleanupFailure);
		await first.stop(stopEvent, {} as ExtensionContext);

		expect(actions.slice(-3)).toEqual([
			"dispose:tools-advisor",
			"dispose:policy-permissions",
			"dispose:config-profiles",
		]);
	});
});
