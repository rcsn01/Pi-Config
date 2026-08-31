import { describe, expect, it, vi } from "vitest";
import { CONFIG_PROFILES_ENTRY_TYPE } from "../_shared/profile-document.ts";
import { createConfigProfilesExtension } from "../config-profiles/index.ts";
import type { ProfileStore } from "../config-profiles/profile-store.ts";
import { createClearExtension } from "./index.ts";

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
		const store = profileStore();
		createConfigProfilesExtension({ store })(pi);
		createClearExtension({ settingsPath: store.settingsPath })(pi);

		let currentBranch = [profileEntry("focused")];
		const currentSessionManager = {
			getBranch: vi.fn(() => currentBranch),
			getSessionFile: vi.fn(() => "/sessions/current.json"),
			getSessionId: vi.fn(() => "current-session"),
		};
		const newSessionManager = {
			getBranch: vi.fn(() => []),
			getSessionFile: vi.fn(() => "/sessions/new.json"),
			getSessionId: vi.fn(() => "new-session"),
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
		currentBranch = [profileEntry("default")];
		await commands.get("clear").handler("", currentContext);

		expect(setStatus).toHaveBeenLastCalledWith("profile", "focused");
		expect(setupAppendEntry).toHaveBeenCalledWith(CONFIG_PROFILES_ENTRY_TYPE, { active: "focused" });
	});

	it("does not clear or start a Session before its Profile binding is available", async () => {
		const commands = new Map<string, any>();
		const transfer = { openFreshSession: vi.fn() };
		const pi: any = {
			on: vi.fn(),
			registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		};
		createClearExtension({
			settingsPath: "/missing/settings.json",
			sessionProfileTransfer: transfer as any,
		})(pi);
		const notify = vi.fn();
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const ctx: any = {
			ui: { notify },
			sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined },
		};

		await commands.get("clear").handler("", ctx);

		expect(notify).toHaveBeenCalledWith(
			"Cannot clear because the Session profile binding is unavailable.",
			"error",
		);
		expect(transfer.openFreshSession).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		write.mockRestore();
	});

	it("retains a newer binding when an older Session shuts down late", async () => {
		const handlers = new Map<string, any[]>();
		const commands = new Map<string, any>();
		const transfer = { openFreshSession: vi.fn(async () => ({ status: "cancelled" as const })) };
		const pi: any = {
			on: vi.fn((event: string, handler: any) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			}),
			registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		};
		createClearExtension({
			settingsPath: "/missing/settings.json",
			sessionProfileTransfer: transfer,
		})(pi);
		const context = (sessionId: string) => ({
			ui: { notify: vi.fn() },
			sessionManager: {
				getBranch: () => [],
				getSessionId: () => sessionId,
				getSessionFile: () => `/sessions/${sessionId}.json`,
			},
		});
		const oldCtx: any = context("old");
		const newCtx: any = context("new");
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "reload" }, oldCtx);
			await handler({ type: "session_start", reason: "reload" }, newCtx);
		}
		for (const handler of handlers.get("session_shutdown") ?? []) {
			await handler({ type: "session_shutdown", reason: "switch" }, oldCtx);
		}
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await commands.get("clear").handler("", newCtx);

		expect(transfer.openFreshSession).toHaveBeenCalledOnce();
		write.mockRestore();
	});

	it.each([
		{ result: { status: "cancelled" }, error: undefined, message: "Clear cancelled.", type: "info" },
		{ result: undefined, error: new Error("boom"), message: "Cleared terminal but couldn't start new session: boom", type: "error" },
	] as const)("reports transfer outcomes without leaking transfer policy", async ({ result, error, message, type }) => {
		const handlers = new Map<string, any>();
		const commands = new Map<string, any>();
		const transfer = {
			openFreshSession: error
				? vi.fn(async () => { throw error; })
				: vi.fn(async () => result),
		};
		const pi: any = {
			on: vi.fn((event: string, handler: any) => handlers.set(event, handler)),
			registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		};
		createClearExtension({
			settingsPath: "/missing/settings.json",
			sessionProfileTransfer: transfer as any,
		})(pi);
		const notify = vi.fn();
		const ctx: any = {
			ui: { notify },
			sessionManager: {
				getBranch: () => [],
				getSessionId: () => "session",
				getSessionFile: () => undefined,
			},
		};
		await handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx);
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await commands.get("clear").handler("", ctx);

		expect(notify).toHaveBeenCalledWith(message, type);
		expect(transfer.openFreshSession).toHaveBeenCalledOnce();
		write.mockRestore();
	});
});
