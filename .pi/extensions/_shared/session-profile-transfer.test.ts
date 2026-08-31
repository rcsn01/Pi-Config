import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CONFIG_PROFILES_ENTRY_TYPE } from "./profile-document.ts";
import type { SessionProfileBinding } from "./session-profile-binding.ts";
import {
	createSessionProfileTransfer,
	readSessionProfileHandoff,
} from "./session-profile-transfer.ts";

const namedBinding: SessionProfileBinding = Object.freeze({
	profileName: "focused",
	settingsPath: "/project/profiles/focused.json",
});
const unboundBinding: SessionProfileBinding = Object.freeze({
	profileName: undefined,
	settingsPath: "/project/settings.json",
});

function commandContext(
	newSession: (options: any) => Promise<{ cancelled: boolean }>,
	parentSession: string | undefined = "/sessions/current.json",
): ExtensionCommandContext {
	return {
		newSession,
		sessionManager: { getSessionFile: () => parentSession },
	} as unknown as ExtensionCommandContext;
}

describe("Session profile transfer", () => {
	it("stages a named Profile before setup, persists it, then runs fresh-Session work", async () => {
		const actions: string[] = [];
		const appendCustomEntry = vi.fn((type: string, data: unknown) => {
			actions.push(`entry:${type}:${JSON.stringify(data)}`);
		});
		const withFreshSession = vi.fn(async () => { actions.push("fresh"); });
		const ctx = commandContext(async (options) => {
			actions.push(`handoff:${readSessionProfileHandoff(options.parentSession)?.profileName}`);
			await options.setup({ appendCustomEntry });
			await options.withSession({});
			return { cancelled: false };
		});

		const result = await createSessionProfileTransfer().openFreshSession(ctx, namedBinding, { withFreshSession });

		expect(result).toEqual({ status: "started" });
		expect(actions).toEqual([
			"handoff:focused",
			`entry:${CONFIG_PROFILES_ENTRY_TYPE}:${JSON.stringify({ active: "focused" })}`,
			"fresh",
		]);
		expect(appendCustomEntry).toHaveBeenCalledOnce();
		expect(readSessionProfileHandoff("/sessions/current.json")).toBeUndefined();
	});

	it("stages an explicit unbound Profile without writing a Profile entry", async () => {
		const appendCustomEntry = vi.fn();
		let observedHandoff = false;
		const ctx = commandContext(async (options) => {
			const handoff = readSessionProfileHandoff(options.parentSession);
			observedHandoff = handoff !== undefined && handoff.profileName === undefined;
			await options.setup({ appendCustomEntry });
			return { cancelled: false };
		});

		await createSessionProfileTransfer().openFreshSession(ctx, unboundBinding);

		expect(observedHandoff).toBe(true);
		expect(appendCustomEntry).not.toHaveBeenCalled();
	});

	it("normalizes an empty parent Session once for staging and newSession", async () => {
		const observed: unknown[] = [];
		const ctx = commandContext(async (options) => {
			observed.push(options.parentSession, readSessionProfileHandoff(undefined)?.previousSessionFile);
			await options.setup({ appendCustomEntry: vi.fn() });
			return { cancelled: false };
		}, "");

		await createSessionProfileTransfer().openFreshSession(ctx, namedBinding);

		expect(observed).toEqual([undefined, undefined]);
	});

	it("returns cancellation and releases the handoff", async () => {
		const setup = vi.fn();
		const ctx = commandContext(async () => ({ cancelled: true }));

		await expect(createSessionProfileTransfer().openFreshSession(ctx, namedBinding, {
			withFreshSession: setup,
		})).resolves.toEqual({ status: "cancelled" });
		expect(setup).not.toHaveBeenCalled();
		expect(readSessionProfileHandoff("/sessions/current.json")).toBeUndefined();
	});

	it.each(["newSession", "setup", "fresh callback"] as const)(
		"preserves the original %s failure and permits a later transfer",
		async (phase) => {
			const failure = new Error(`${phase} failed`);
			const transfer = createSessionProfileTransfer();
			const failingCtx = commandContext(async (options) => {
				if (phase === "newSession") throw failure;
				if (phase === "setup") {
					await options.setup({ appendCustomEntry: () => { throw failure; } });
				} else {
					await options.setup({ appendCustomEntry: vi.fn() });
					await options.withSession({});
				}
				return { cancelled: false };
			});

			await expect(transfer.openFreshSession(failingCtx, namedBinding, {
				withFreshSession: phase === "fresh callback" ? async () => { throw failure; } : undefined,
			})).rejects.toBe(failure);
			expect(readSessionProfileHandoff("/sessions/current.json")).toBeUndefined();

			const succeedingCtx = commandContext(async (options) => {
				await options.setup({ appendCustomEntry: vi.fn() });
				return { cancelled: false };
			});
			await expect(transfer.openFreshSession(succeedingCtx, namedBinding)).resolves.toEqual({ status: "started" });
		},
	);

	it("rejects an overlapping transfer without replacing the first handoff", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const transfer = createSessionProfileTransfer();
		const firstCtx = commandContext(async (options) => {
			markStarted();
			await blocked;
			await options.setup({ appendCustomEntry: vi.fn() });
			return { cancelled: false };
		}, "/sessions/first.json");
		const first = transfer.openFreshSession(firstCtx, namedBinding);
		await started;

		const secondCtx = commandContext(async () => ({ cancelled: false }), "/sessions/second.json");
		await expect(transfer.openFreshSession(secondCtx, unboundBinding))
			.rejects.toThrow("A Session profile transfer is already in progress.");
		expect(readSessionProfileHandoff("/sessions/first.json")?.profileName).toBe("focused");
		expect(readSessionProfileHandoff("/sessions/second.json")).toBeUndefined();

		release();
		await first;
	});
});
