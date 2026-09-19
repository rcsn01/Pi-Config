import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPermissionCommands, type CommandService } from "./commands.ts";
import type { ModeState } from "./mode-store.ts";
import { piConfigPath } from "../_shared/pi-config.ts";

let prevRulesFile: string | undefined;
const tempDirectories: string[] = [];

afterEach(() => {
	if (prevRulesFile === undefined) delete process.env.PI_EXECPOLICY_FILE;
	else process.env.PI_EXECPOLICY_FILE = prevRulesFile;
	prevRulesFile = undefined;
	while (tempDirectories.length > 0) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

const mocked = vi.hoisted(() => ({ pickGuiOption: vi.fn() }));
vi.mock("../_shared/gui-option-list.ts", () => mocked);

function createHarness(options: { current?: ModeState; hasUI?: boolean; cwd?: string; projectTrusted?: boolean } = {}) {
	const current = options.current ?? { mode: "default", setAt: 1 };
	const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
	const pi = { registerCommand: (name: string, command: any) => commands.set(name, command) };
	const ui = { notify: vi.fn(), confirm: vi.fn(async () => true) };
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: "tui",
		ui,
		cwd: options.cwd,
		isProjectTrusted: () => options.projectTrusted ?? false,
	};
	const changed: ModeState[] = [];
	const service: CommandService = {
		getMode: () => current,
		changeMode: (mode) => changed.push(mode),
		updateStatus: () => {},
		approveLastDenied: () => ({ kind: "none" }),
	};
	registerPermissionCommands(pi as any, service);
	return { permissions: commands.get("permissions")!, execpolicy: commands.get("execpolicy")!, ui, ctx, changed };
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

describe("/execpolicy command", () => {
	function withRulesFile(): string {
		const file = join(mkdtempSync(join(tmpdir(), "pi-execpolicy-cmd-")), "execpolicy.json");
		tempDirectories.push(path.dirname(file));
		prevRulesFile = process.env.PI_EXECPOLICY_FILE;
		process.env.PI_EXECPOLICY_FILE = file;
		return file;
	}

	function withProject(): string {
		const cwd = mkdtempSync(join(tmpdir(), "pi-execpolicy-project-"));
		tempDirectories.push(cwd);
		return cwd;
	}

	it("adds to the project layer in trusted projects", async () => {
		const file = withRulesFile();
		const cwd = withProject();
		const harness = createHarness({ cwd, projectTrusted: true });

		await harness.execpolicy.handler("add ^pnpm test | allow | project test runner", harness.ctx);

		expect(JSON.parse(readFileSync(piConfigPath(cwd), "utf-8")).execPolicy.rules).toEqual([
			{ id: "1", pattern: "^pnpm test", action: "allow", reason: "project test runner" },
		]);
		expect(harness.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Project rule added (.pi/pi-config.json)"),
			"info",
		);
		expect(existsSync(file)).toBe(false);
	});

	it("adds to the global file outside trusted projects", async () => {
		const file = withRulesFile();
		const harness = createHarness({ cwd: withProject() });

		await harness.execpolicy.handler("add curl | prompt | network", harness.ctx);

		expect(JSON.parse(readFileSync(file, "utf-8")).rules).toEqual([
			{ id: "1", pattern: "curl", action: "prompt", reason: "network" },
		]);
		expect(harness.ui.notify).toHaveBeenCalledWith("Rule added: [1] PROMPT: curl", "info");
	});

	it("lists both layers with tagged ids in trusted projects", async () => {
		const file = withRulesFile();
		writeFileSync(file, JSON.stringify({ rules: [{ id: "1", pattern: "curl", action: "block", reason: "no network" }], defaultAction: "prompt" }));
		const cwd = withProject();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(piConfigPath(cwd), JSON.stringify({ execPolicy: { rules: [{ id: "1", pattern: "^pnpm test", action: "allow", reason: "tests" }] } }));
		const harness = createHarness({ cwd, projectTrusted: true });

		await harness.execpolicy.handler("rules", harness.ctx);

		expect(harness.ui.notify).toHaveBeenCalledWith([
			"Project rules (.pi/pi-config.json):",
			"[p1] ALLOW: ^pnpm test — tests",
			"",
			"Global rules (~/.pi/execpolicy.json):",
			"[g1] BLOCK: curl — no network",
			"",
			"Default action: PROMPT (global)",
		].join("\n"), "info");
	});

	it("checks against the merged layers", async () => {
		const file = withRulesFile();
		writeFileSync(file, JSON.stringify({ rules: [{ id: "1", pattern: "curl", action: "block", reason: "no network" }], defaultAction: "allow" }));
		const cwd = withProject();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(piConfigPath(cwd), JSON.stringify({ execPolicy: { rules: [{ id: "1", pattern: "^pnpm test", action: "allow", reason: "tests" }] } }));
		const harness = createHarness({ cwd, projectTrusted: true });

		await harness.execpolicy.handler("check pnpm test", harness.ctx);
		expect(harness.ui.notify).toHaveBeenCalledWith("MATCHED: ALLOW — tests", "info");

		await harness.execpolicy.handler("check curl example.com", harness.ctx);
		expect(harness.ui.notify).toHaveBeenCalledWith("MATCHED: BLOCK — no network", "error");
	});

	it("removes by tagged id and keeps bare ids global", async () => {
		const file = withRulesFile();
		writeFileSync(file, JSON.stringify({ rules: [{ id: "1", pattern: "curl", action: "prompt", reason: "network" }], defaultAction: "allow" }));
		const cwd = withProject();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(piConfigPath(cwd), JSON.stringify({ execPolicy: { rules: [{ id: "1", pattern: "^pnpm test", action: "allow", reason: "tests" }] } }));
		const harness = createHarness({ cwd, projectTrusted: true });

		await harness.execpolicy.handler("remove p1", harness.ctx);
		expect(JSON.parse(readFileSync(piConfigPath(cwd), "utf-8")).execPolicy.rules).toEqual([]);

		await harness.execpolicy.handler("remove g1", harness.ctx);
		expect(JSON.parse(readFileSync(file, "utf-8")).rules).toEqual([]);
		expect(harness.ui.notify).toHaveBeenLastCalledWith("Removed rule [1]: curl", "info");
	});

	it("refuses project-rule removal outside trusted projects", async () => {
		withRulesFile();
		const harness = createHarness({ cwd: withProject() });

		await harness.execpolicy.handler("remove p1", harness.ctx);
		expect(harness.ui.notify).toHaveBeenCalledWith("Project rules require a trusted project.", "warning");
	});

	it("keeps default action global in trusted projects", async () => {
		const file = withRulesFile();
		const cwd = withProject();
		const harness = createHarness({ cwd, projectTrusted: true });

		await harness.execpolicy.handler("default prompt", harness.ctx);

		expect(JSON.parse(readFileSync(file, "utf-8")).defaultAction).toBe("prompt");
	});
});