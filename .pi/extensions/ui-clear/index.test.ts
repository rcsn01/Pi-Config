import { describe, expect, it, vi } from "vitest";
import { CONFIG_PROFILES_ENTRY_TYPE } from "../_shared/active-profile.ts";
import { createConfigProfilesExtension } from "../config-profiles/index.ts";
import type { ProfileStore } from "../config-profiles/profile-store.ts";
import clearExtension from "./index.ts";

function profileStore(): ProfileStore {
	return {
		settingsPath: "/project/settings.json",
		profilesDirectory: "/project/profiles",
		listProfiles: vi.fn(() => ["default", "focused"]),
		readProfile: vi.fn(() => ({})),
		createProfile: vi.fn(async (name, source) => ({ name, source })),
		deleteProfile: vi.fn(async (name) => ({ name, replacement: "default" as const, markerReplaced: false })),
		switchProfile: vi.fn(async (name) => ({ changed: true, active: name })),
		profilePath: vi.fn((name) => `/project/profiles/${name}.json`),
	};
}

function profileEntry(active: string) {
	return { type: "custom", customType: CONFIG_PROFILES_ENTRY_TYPE, data: { active } };
}

describe("clear extension", () => {
	it("preserves the current session profile before the new session reads settings.json", async () => {
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const commands = new Map<string, any>();
		const appendEntry = vi.fn();
		const setupAppendEntry = vi.fn();
		const setStatus = vi.fn();
		const notify = vi.fn();
		const pi: any = {
			on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			}),
			registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
			appendEntry,
			setModel: vi.fn(),
			setThinkingLevel: vi.fn(),
		};
		createConfigProfilesExtension({ store: profileStore() })(pi);
		clearExtension(pi);

		const currentSessionManager = {
			getBranch: vi.fn(() => [profileEntry("focused")]),
			getSessionFile: vi.fn(() => "/sessions/current.json"),
		};
		const newSessionManager = {
			getBranch: vi.fn(() => []),
			getSessionFile: vi.fn(() => "/sessions/new.json"),
		};
		const currentContext: any = {
			hasUI: true,
			ui: { notify, setStatus, input: vi.fn(), select: vi.fn(), confirm: vi.fn() },
			sessionManager: currentSessionManager,
		};
		const newContext = { ...currentContext, sessionManager: newSessionManager };
		currentContext.newSession = vi.fn(async (options: any) => {
			// Pi emits the new session's session_start before running setup.
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ type: "session_start", reason: "new", previousSessionFile: "/sessions/current.json" }, newContext);
			}
			await options.setup?.({ appendCustomEntry: setupAppendEntry });
			await options.withSession?.(newContext);
			return { cancelled: false };
		});

		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "startup" }, currentContext);
		}
		await commands.get("clear").handler("", currentContext);

		expect(setStatus).toHaveBeenLastCalledWith("profile", "focused");
		expect(setupAppendEntry).toHaveBeenCalledWith(CONFIG_PROFILES_ENTRY_TYPE, { active: "focused" });
	});
});
