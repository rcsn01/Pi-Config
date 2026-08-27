import type {
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionProfileBinding } from "./active-profile.ts";
import {
	registerSessionProfileInitialization,
	SESSION_PROFILE_ADAPTER_ORDER,
	type SessionProfileAdapterName,
	type SessionProfileInitializationAdapter,
	type SessionProfileInitializationRegistration,
} from "./session-profile-initialization.ts";

const roots: string[] = [];
const registrations: SessionProfileInitializationRegistration[] = [];

function fixture(marker: string | undefined = "focused") {
	const root = mkdtempSync(join(tmpdir(), "pi-session-profile-init-"));
	roots.push(root);
	const settingsPath = join(root, "settings.json");
	const profilesDirectory = join(root, "profiles");
	mkdirSync(profilesDirectory);
	writeFileSync(settingsPath, JSON.stringify(marker ? { configProfiles: { active: marker } } : {}));
	return { root, settingsPath, profilesDirectory };
}

function lifecycle(entries: readonly unknown[] = []) {
	const event = { type: "session_start", reason: "startup" } as SessionStartEvent;
	const ctx = {
		sessionManager: { getBranch: vi.fn(() => entries) },
	} as unknown as ExtensionContext;
	return { event, ctx };
}

function shutdown(): SessionShutdownEvent {
	return { type: "session_shutdown", reason: "quit" };
}

function register(
	paths: { settingsPath: string; profilesDirectory: string },
	adapter: SessionProfileInitializationAdapter,
): SessionProfileInitializationRegistration {
	const registration = registerSessionProfileInitialization(paths, adapter);
	registrations.push(registration);
	return registration;
}

function adapter(
	name: SessionProfileAdapterName,
	actions: string[],
	overrides: Partial<SessionProfileInitializationAdapter> = {},
): SessionProfileInitializationAdapter {
	return {
		name,
		applyPath: () => actions.push(`path:${name}`),
		initialize: async () => {
			actions.push(`init:${name}`);
			await Promise.resolve();
		},
		dispose: async () => {
			actions.push(`dispose:${name}`);
			await Promise.resolve();
		},
		...overrides,
	};
}

afterEach(async () => {
	const event = shutdown();
	for (const registration of registrations) await registration.stop(event, {} as ExtensionContext).catch(() => {});
	for (const registration of registrations) registration.unregister();
	registrations.length = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session profile initialization", () => {
	it("shares one binding and runs every adapter in path-then-stable-init order", async () => {
		const paths = fixture();
		const actions: string[] = [];
		const byName = new Map<SessionProfileAdapterName, SessionProfileInitializationRegistration>();
		for (const name of [...SESSION_PROFILE_ADAPTER_ORDER].reverse()) {
			byName.set(name, register(paths, adapter(name, actions)));
		}
		const first = byName.get("workflows-plan")!;
		const { event, ctx } = lifecycle();

		const binding = await first.start(event, ctx);
		const sameBinding = await byName.get("config-profiles")!.start(event, ctx);

		expect(sameBinding).toBe(binding);
		expect(actions).toEqual([
			...SESSION_PROFILE_ADAPTER_ORDER.map((name) => `path:${name}`),
			...SESSION_PROFILE_ADAPTER_ORDER.map((name) => `init:${name}`),
		]);
		expect(ctx.sessionManager.getBranch).toHaveBeenCalledOnce();
		expect(binding.settingsPath).toBe(join(paths.profilesDirectory, "focused.json"));
		expect(Object.isFrozen(binding)).toBe(true);
	});

	it("isolates path pairs and gives a fresh event a fresh binding", async () => {
		const firstPaths = fixture();
		const secondPaths = fixture();
		const first = register(firstPaths, adapter("config-profiles", []));
		const equivalent = register({
			settingsPath: join(firstPaths.root, "nested", "..", "settings.json"),
			profilesDirectory: join(firstPaths.root, "nested", "..", "profiles"),
		}, adapter("policy-permissions", []));
		const other = register(secondPaths, adapter("tools-advisor", []));
		const { event, ctx } = lifecycle();

		const firstBinding = await first.start(event, ctx);
		const equivalentBinding = await equivalent.start(event, ctx);
		const otherBinding = await other.start(event, ctx);
		const freshEvent = lifecycle();
		const freshBinding = await first.start(freshEvent.event, freshEvent.ctx);

		expect(equivalentBinding).toBe(firstBinding);
		expect(otherBinding).not.toBe(firstBinding);
		expect(otherBinding.settingsPath).toBe(join(secondPaths.profilesDirectory, "focused.json"));
		expect(freshBinding).not.toBe(firstBinding);
	});

	it("continues after isolated path and initialization failures", async () => {
		const paths = fixture();
		const actions: string[] = [];
		const pathFailure = new Error("path failed");
		const initFailure = new Error("init failed");
		const failedPath = register(paths, adapter("config-profiles", actions, {
			applyPath: () => {
				actions.push("path:config-profiles");
				throw pathFailure;
			},
		}));
		const failedInit = register(paths, adapter("policy-permissions", actions, {
			initialize: async () => {
				actions.push("init:policy-permissions");
				throw initFailure;
			},
		}));
		const healthy = register(paths, adapter("tools-advisor", actions));
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

		const stopEvent = shutdown();
		await healthy.stop(stopEvent, {} as ExtensionContext);
		expect(actions.slice(-2)).toEqual([
			"dispose:tools-advisor",
			"dispose:policy-permissions",
		]);
		expect(actions).not.toContain("dispose:config-profiles");
	});

	it("does not let a stale unregister token remove a replacement", async () => {
		const paths = fixture();
		const firstActions: string[] = [];
		const secondActions: string[] = [];
		const first = register(paths, adapter("tools-advisor", firstActions));
		const replacement = register(paths, adapter("tools-advisor", secondActions));
		first.unregister();
		const { event, ctx } = lifecycle();

		await replacement.start(event, ctx);
		expect(firstActions).toEqual([]);
		expect(secondActions).toEqual(["path:tools-advisor", "init:tools-advisor"]);

		const fresh = lifecycle();
		await replacement.start(fresh.event, fresh.ctx);
		expect(secondActions).toEqual([
			"path:tools-advisor",
			"init:tools-advisor",
			"path:tools-advisor",
			"init:tools-advisor",
		]);
	});

	it("cleans up once in reverse attempt order and isolates cleanup failures", async () => {
		const paths = fixture();
		const actions: string[] = [];
		const cleanupFailure = new Error("cleanup failed");
		const first = register(paths, adapter("config-profiles", actions));
		const failing = register(paths, adapter("policy-permissions", actions, {
			dispose: async () => {
				actions.push("dispose:policy-permissions");
				throw cleanupFailure;
			},
		}));
		const last = register(paths, adapter("tools-advisor", actions));
		const { event, ctx } = lifecycle();
		await first.start(event, ctx);
		const stopEvent = shutdown();

		await last.stop(stopEvent, {} as ExtensionContext);
		expect(() => failing.stop(stopEvent, {} as ExtensionContext)).rejects.toBe(cleanupFailure);
		await first.stop(stopEvent, {} as ExtensionContext);
		await expect(last.stop(shutdown(), {} as ExtensionContext)).resolves.toBeUndefined();
		expect(actions.slice(-3)).toEqual([
			"dispose:tools-advisor",
			"dispose:policy-permissions",
			"dispose:config-profiles",
		]);
	});

	it("resolves a binding even when all adapters are removed before start", async () => {
		const paths = fixture();
		const registration = register(paths, adapter("config-profiles", []));
		registration.unregister();
		const { event, ctx } = lifecycle();

		const binding: SessionProfileBinding = await registration.start(event, ctx);
		expect(binding.profileName).toBe("focused");
		expect(binding.settingsPath).toBe(paths.profilesDirectory + "/focused.json");
	});
});

