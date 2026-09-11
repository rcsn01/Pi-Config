import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSkillUpdateExtension } from "./index.ts";
import type {
	SkillBackgroundCheckOutcome,
	SkillUpdateLifecycle,
} from "./skill-update-lifecycle.ts";

function harness(
	outcome: SkillBackgroundCheckOutcome | Error = { kind: "skipped", reason: "cooldown" },
) {
	const handlers = new Map<string, (...args: any[]) => any>();
	let command: any;
	const notify = vi.fn();
	const pi = {
		on: vi.fn((name: string, handler: (...args: any[]) => any) => {
			handlers.set(name, handler);
		}),
		registerCommand: vi.fn((_name: string, registration: any) => {
			command = registration;
		}),
	} as unknown as ExtensionAPI;
	const checkInBackground = vi.fn(async () => {
		if (outcome instanceof Error) throw outcome;
		return outcome;
	});
	const runInteractive = vi.fn(async () => {});
	const lifecycleFactory = vi.fn((): SkillUpdateLifecycle => ({
		checkInBackground,
		runInteractive,
	}));
	const gitFactory = vi.fn(() => ({} as any));
	createSkillUpdateExtension({
		extensionDir: "/extension",
		gitFactory,
		lifecycleFactory,
	})(pi);
	const ctx = {
		cwd: "/project",
		mode: "json",
		ui: {
			notify,
			select: vi.fn(),
			confirm: vi.fn(),
			setWidget: vi.fn(),
		},
	} as any;
	return {
		pi,
		handlers,
		get command() { return command; },
		ctx,
		notify,
		lifecycleFactory,
		checkInBackground,
		runInteractive,
	};
}

describe("Skill update extension wiring", () => {
	it("registers session_start and /update-skill", () => {
		const extension = harness();
		expect(extension.pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(extension.pi.registerCommand).toHaveBeenCalledWith(
			"update-skill",
			expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
		);
	});

	it.each([
		{ kind: "skipped", reason: "cooldown" } as const,
		{ kind: "checked", ok: true, updates: [] } as const,
	])("keeps $kind outcomes without updates quiet", async (outcome) => {
		const extension = harness(outcome);
		await extension.handlers.get("session_start")!({}, extension.ctx);
		expect(extension.notify).not.toHaveBeenCalled();
	});

	it.each([
		[["code-review"], "update-skill: 1 skill has updates (code-review). Run /update-skill"],
		[["code-review", "tdd"], "update-skill: 2 skills have updates (code-review, tdd). Run /update-skill"],
	] as const)("renders checked update notices", async (updates, message) => {
		const extension = harness({ kind: "checked", ok: false, updates });
		await extension.handlers.get("session_start")!({}, extension.ctx);
		expect(extension.notify).toHaveBeenCalledWith(message, "info");
	});

	it("admits background work only once per extension load, even after settlement", async () => {
		const extension = harness();
		const start = extension.handlers.get("session_start")!;
		await start({}, extension.ctx);
		await start({}, extension.ctx);
		expect(extension.checkInBackground).toHaveBeenCalledTimes(1);
		expect(extension.lifecycleFactory).toHaveBeenCalledTimes(1);
	});

	it("logs an unexpected background failure without rejecting startup", async () => {
		const error = new Error("offline");
		const extension = harness(error);
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(extension.handlers.get("session_start")!({}, extension.ctx)).toBeUndefined();
		await vi.waitFor(() => {
			expect(spy).toHaveBeenCalledWith("[update-skill] background check failed:", error);
		});
		spy.mockRestore();
	});

	it("creates a fresh lifecycle and Pi interaction adapter for the command cwd", async () => {
		const extension = harness();
		await extension.command.handler("", extension.ctx);
		expect(extension.lifecycleFactory).toHaveBeenCalledWith({
			projectRoot: "/project",
			extensionDir: "/extension",
			git: expect.anything(),
		});
		expect(extension.runInteractive).toHaveBeenCalledWith(expect.objectContaining({
			chooseSkill: expect.any(Function),
			chooseAction: expect.any(Function),
			confirm: expect.any(Function),
			report: expect.any(Function),
		}));
	});
});
