import type {
	ExtensionAPI,
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
	registerSessionProfileBinding,
	SESSION_PROFILE_ADAPTER_ORDER,
	type SessionProfileAdapter,
	type SessionProfileAdapterName,
	type SessionProfileBinding,
	type SessionProfileBindingRegistration,
	wireSessionProfileBinding,
} from "./session-profile-binding.ts";
import { createSessionProfileTransfer } from "./session-profile-transfer.ts";

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
	paths: { settingsPath: string; profilesDirectory?: string },
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
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Session profile binding", () => {
	it("derives the Profile directory when it is omitted", async () => {
		const paths = fixture("focused");
		let observed: SessionProfileBinding | undefined;
		const registration = register({ settingsPath: paths.settingsPath }, testAdapter("tools-advisor", [], {
			initialize: (binding) => { observed = binding; },
		}));
		const { event, ctx } = lifecycle();

		await registration.start(event, ctx);

		expect(observed?.settingsPath).toBe(join(paths.profilesDirectory, "focused.json"));
	});

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
		const handoff = register(handoffPaths, testAdapter("tools-advisor", [], { initialize: (binding) => { observed.push(binding); } }));
		const marker = register(markerPaths, testAdapter("tools-advisor", [], { initialize: (binding) => { observed.push(binding); } }));
		const unbound = register(unboundPaths, testAdapter("tools-advisor", [], { initialize: (binding) => { observed.push(binding); } }));
		const parentCtx = {
			sessionManager: { getSessionFile: () => "parent.jsonl" },
			newSession: async () => {
				await handoff.start(...Object.values(lifecycle([], "new", "parent.jsonl")) as [SessionStartEvent, ExtensionContext]);
				return { cancelled: false };
			},
		} as any;

		await createSessionProfileTransfer().openFreshSession(parentCtx, {
			profileName: "handoff",
			settingsPath: join(handoffPaths.profilesDirectory, "handoff.json"),
		});
		await marker.start(...Object.values(lifecycle([], "new", "other.jsonl")) as [SessionStartEvent, ExtensionContext]);
		await unbound.start(...Object.values(lifecycle([], "startup")) as [SessionStartEvent, ExtensionContext]);

		expect(observed.map((binding) => binding.profileName)).toEqual(["handoff", "focused", undefined]);
		expect(observed[2]?.settingsPath).toBe(unboundPaths.settingsPath);
	});

	it("preserves an explicit unbound handoff instead of falling back to the marker", async () => {
		const paths = fixture("marker");
		let observed: SessionProfileBinding | undefined;
		const registration = register(paths, testAdapter("tools-advisor", [], {
			initialize: (binding) => { observed = binding; },
		}));
		const parentCtx = {
			sessionManager: { getSessionFile: () => "parent.jsonl" },
			newSession: async () => {
				const { event, ctx } = lifecycle([], "new", "parent.jsonl");
				await registration.start(event, ctx);
				return { cancelled: false };
			},
		} as any;

		await createSessionProfileTransfer().openFreshSession(parentCtx, {
			profileName: undefined,
			settingsPath: paths.settingsPath,
		});

		expect(observed).toEqual({ profileName: undefined, settingsPath: paths.settingsPath });
	});

	it("consults entries only on reload", async () => {
		const paths = fixture("marker");
		let observed: SessionProfileBinding | undefined;
		const registration = register(paths, testAdapter("tools-advisor", [], {
			initialize: (binding) => { observed = binding; },
		}));
		const parentCtx = {
			sessionManager: { getSessionFile: () => "parent.jsonl" },
			newSession: async () => {
				const { event, ctx } = lifecycle([], "reload", "parent.jsonl");
				await registration.start(event, ctx);
				return { cancelled: false };
			},
		} as any;

		await createSessionProfileTransfer().openFreshSession(parentCtx, {
			profileName: "handoff",
			settingsPath: join(paths.profilesDirectory, "handoff.json"),
		});

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

describe("Session profile binding wiring", () => {
	function wiring() {
		const handlers = new Map<string, (event: object, ctx: ExtensionContext) => Promise<void>>();
		const pi = {
			on: (type: string, handler: (event: object, ctx: ExtensionContext) => Promise<void>) => {
				handlers.set(type, handler);
			},
		} as unknown as ExtensionAPI;
		const emit = (type: "session_start" | "session_shutdown", event: object, ctx: ExtensionContext) => {
			const handler = handlers.get(type);
			if (!handler) throw new Error(`no ${type} handler registered`);
			return handler(event, ctx);
		};
		return { pi, emit };
	}

	it("delegates both session boundaries to the registration", async () => {
		const harness = wiring();
		const start = vi.fn(async () => {});
		const stop = vi.fn(async () => {});
		const unregister = vi.fn();
		wireSessionProfileBinding(harness.pi, { start, stop, unregister });

		const startBoundary = lifecycle();
		const stopEvent = shutdown();
		await harness.emit("session_start", startBoundary.event, startBoundary.ctx);
		await harness.emit("session_shutdown", stopEvent, startBoundary.ctx);

		expect(start).toHaveBeenCalledWith(startBoundary.event, startBoundary.ctx);
		expect(stop).toHaveBeenCalledWith(stopEvent, startBoundary.ctx);
		expect(unregister).toHaveBeenCalledOnce();
	});

	it("awaits the registration start before session_start settles", async () => {
		const harness = wiring();
		let releaseStart!: () => void;
		const startPending = new Promise<void>((resolve) => { releaseStart = resolve; });
		wireSessionProfileBinding(harness.pi, {
			start: () => startPending,
			stop: async () => {},
			unregister: () => {},
		});
		const boundary = lifecycle();

		const emitted = harness.emit("session_start", boundary.event, boundary.ctx);
		const firstToSettle = await Promise.race([
			emitted.then(() => "settled", () => "settled"),
			Promise.resolve("pending"),
		]);
		expect(firstToSettle).toBe("pending");

		releaseStart();
		await emitted;
	});

	it("awaits the registration stop before afterStop and unregister run", async () => {
		const harness = wiring();
		const events: string[] = [];
		let releaseStop!: () => void;
		const stopPending = new Promise<void>((resolve) => { releaseStop = resolve; });
		wireSessionProfileBinding(harness.pi, {
			start: async () => {},
			stop: () => stopPending,
			unregister: () => { events.push("unregister"); },
		}, {
			afterStop: () => { events.push("afterStop"); },
		});

		const emitted = harness.emit("session_shutdown", shutdown(), {} as ExtensionContext);
		const firstToSettle = await Promise.race([
			emitted.then(() => "settled", () => "settled"),
			Promise.resolve("pending"),
		]);
		expect(firstToSettle).toBe("pending");
		expect(events).toEqual([]);

		releaseStop();
		await emitted;
		expect(events).toEqual(["afterStop", "unregister"]);
	});

	it("awaits afterStop before unregister", async () => {
		const harness = wiring();
		const events: string[] = [];
		wireSessionProfileBinding(harness.pi, {
			start: async () => {},
			stop: async () => { events.push("stop"); },
			unregister: () => { events.push("unregister"); },
		}, {
			afterStop: async () => {
				events.push("afterStop:start");
				await Promise.resolve();
				events.push("afterStop:end");
			},
		});

		await harness.emit("session_shutdown", shutdown(), {} as ExtensionContext);

		expect(events).toEqual(["stop", "afterStop:start", "afterStop:end", "unregister"]);
	});

	it("runs afterStop and unregister even when stop fails", async () => {
		const harness = wiring();
		const events: string[] = [];
		const stopFailure = new Error("stop failed");
		wireSessionProfileBinding(harness.pi, {
			start: async () => {},
			stop: async () => { events.push("stop"); throw stopFailure; },
			unregister: () => { events.push("unregister"); },
		}, {
			afterStop: () => { events.push("afterStop"); },
		});

		await expect(harness.emit("session_shutdown", shutdown(), {} as ExtensionContext)).rejects.toBe(stopFailure);
		expect(events).toEqual(["stop", "afterStop", "unregister"]);
	});

	it("unregisters when stop fails without an afterStop callback", async () => {
		const harness = wiring();
		const events: string[] = [];
		const stopFailure = new Error("stop failed");
		wireSessionProfileBinding(harness.pi, {
			start: async () => {},
			stop: async () => { events.push("stop"); throw stopFailure; },
			unregister: () => { events.push("unregister"); },
		});

		await expect(harness.emit("session_shutdown", shutdown(), {} as ExtensionContext)).rejects.toBe(stopFailure);
		expect(events).toEqual(["stop", "unregister"]);
	});

	it("unregisters even when afterStop fails, and propagates its failure", async () => {
		const harness = wiring();
		const events: string[] = [];
		const afterStopFailure = new Error("afterStop failed");
		wireSessionProfileBinding(harness.pi, {
			start: async () => {},
			stop: async () => { events.push("stop"); },
			unregister: () => { events.push("unregister"); },
		}, {
			afterStop: () => { events.push("afterStop"); throw afterStopFailure; },
		});

		await expect(harness.emit("session_shutdown", shutdown(), {} as ExtensionContext)).rejects.toBe(afterStopFailure);
		expect(events).toEqual(["stop", "afterStop", "unregister"]);
	});

	it("propagates the afterStop failure when stop also fails", async () => {
		const harness = wiring();
		const events: string[] = [];
		const stopFailure = new Error("stop failed");
		const afterStopFailure = new Error("afterStop failed");
		wireSessionProfileBinding(harness.pi, {
			start: async () => {},
			stop: async () => { events.push("stop"); throw stopFailure; },
			unregister: () => { events.push("unregister"); },
		}, {
			afterStop: () => { events.push("afterStop"); throw afterStopFailure; },
		});

		await expect(harness.emit("session_shutdown", shutdown(), {} as ExtensionContext)).rejects.toBe(afterStopFailure);
		expect(events).toEqual(["stop", "afterStop", "unregister"]);
	});
});
