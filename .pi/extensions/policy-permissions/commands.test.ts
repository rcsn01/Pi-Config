import { describe, expect, it, vi } from "vitest";
import { registerPermissionCommands, type CommandService } from "./commands.ts";
import type { ModeState } from "./mode-store.ts";

const mocked = vi.hoisted(() => ({ pickGuiOption: vi.fn() }));
vi.mock("../_shared/gui-option-list.ts", () => mocked);

function createHarness(options: { current?: ModeState; hasUI?: boolean } = {}) {
	const current = options.current ?? { mode: "default", setAt: 1 };
	const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
	const pi = { registerCommand: (name: string, command: any) => commands.set(name, command) };
	const ui = { notify: vi.fn(), confirm: vi.fn(async () => true) };
	const ctx = { hasUI: options.hasUI ?? true, mode: "tui", ui };
	const changed: ModeState[] = [];
	const service: CommandService = {
		getMode: () => current,
		changeMode: (mode) => changed.push(mode),
		updateStatus: () => {},
		approveLastDenied: () => ({ kind: "none" }),
	};
	registerPermissionCommands(pi as any, service);
	return { permissions: commands.get("permissions")!, ui, ctx, changed };
}

describe("/permissions command", () => {
	it("pins the registered description", () => {
		expect(createHarness().permissions.description).toBe(
			"Switch approval mode: read-only | default | auto-review | full-access",
		);
	});

	it("notifies the no-UI hint without opening the picker", async () => {
		const harness = createHarness({ hasUI: false });
		await harness.permissions.handler("", harness.ctx);
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Current mode: default. Use /permissions read-only|default|auto-review|full-access",
			"info",
		);
	});

	it("notifies the or-list message for an invalid mode", async () => {
		const harness = createHarness();
		await harness.permissions.handler("bogus", harness.ctx);
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Invalid mode. Use: read-only, default, auto-review, or full-access",
			"warning",
		);
		expect(harness.changed).toEqual([]);
	});

	it("resolves aliases, pinning auto→default", async () => {
		const ro = createHarness();
		await ro.permissions.handler("ro", ro.ctx);
		expect(ro.changed[0]).toEqual(expect.objectContaining({ mode: "read-only" }));

		const auto = createHarness({ current: { mode: "read-only", setAt: 1 } });
		await auto.permissions.handler("auto", auto.ctx);
		expect(auto.changed[0]).toEqual(expect.objectContaining({ mode: "default" }));

		const review = createHarness();
		await review.permissions.handler(" review ", review.ctx);
		expect(review.changed[0]).toEqual(expect.objectContaining({ mode: "auto-review" }));
	});

	it("resolves case-insensitive input", async () => {
		const harness = createHarness({ current: { mode: "default", setAt: 1 } });
		await harness.permissions.handler("FULL", harness.ctx);
		expect(harness.changed[0]).toEqual(expect.objectContaining({ mode: "full-access" }));
	});

	it("notifies when already in the requested mode", async () => {
		const harness = createHarness({ current: { mode: "read-only", setAt: 1 } });
		await harness.permissions.handler("ro", harness.ctx);
		expect(harness.ui.notify).toHaveBeenCalledWith("Already in read-only mode.", "info");
		expect(harness.changed).toEqual([]);
	});

	it("confirms the full-access switch and keeps the mode on decline", async () => {
		const harness = createHarness();
		harness.ui.confirm.mockResolvedValueOnce(false);
		await harness.permissions.handler("FULL", harness.ctx);
		expect(harness.ui.confirm).toHaveBeenCalledWith(
			"⚠️ Full Access Mode",
			"This removes ALL restrictions. The agent can run any command, write anywhere, and access the network without confirmation.\n\nExercise caution when using.\n\nAre you sure?",
		);
		expect(harness.changed).toEqual([]);

		harness.ui.confirm.mockResolvedValueOnce(true);
		await harness.permissions.handler("FULL", harness.ctx);
		expect(harness.changed[0]).toEqual(expect.objectContaining({ mode: "full-access" }));
		expect(harness.ui.notify).toHaveBeenCalledWith("Mode changed: full-access", "info");
	});

	it("assembles picker options in canonical order with the current mode checked", async () => {
		mocked.pickGuiOption.mockResolvedValue(undefined);
		const harness = createHarness({ current: { mode: "read-only", setAt: 1 } });
		await harness.permissions.handler("", harness.ctx);
		expect(mocked.pickGuiOption).toHaveBeenCalledWith(harness.ctx, {
			title: "Permission Mode:",
			message: "Current mode: read-only",
			options: [
				{
					label: "read-only",
					value: "read-only",
					description: "Read-only browsing – read in current directory only",
					checked: true,
				},
				{
					label: "default",
					value: "default",
					description: "Default – read, edit, and run commands in workspace; approval for internet and external writes",
					checked: false,
				},
				{
					label: "auto-review",
					value: "auto-review",
					description: "Auto-review – full auto; only prompts you for edits outside the workspace",
					checked: false,
				},
				{
					label: "full-access",
					value: "full-access",
					description: "Full Access – no restrictions, no approval prompts (use with caution)",
					checked: false,
				},
			],
		});
		expect(harness.changed).toEqual([]);
	});

	it("switches to the picked mode through the same switch flow", async () => {
		mocked.pickGuiOption.mockResolvedValue("auto-review");
		const harness = createHarness();
		await harness.permissions.handler("", harness.ctx);
		expect(harness.changed[0]).toEqual(expect.objectContaining({ mode: "auto-review" }));
	});
});