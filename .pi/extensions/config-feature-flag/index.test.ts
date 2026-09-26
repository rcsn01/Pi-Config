import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import createFeatureFlagsExtension from "./index.ts";

/**
 * The /features surface. `config-feature-flag` used to be missing from the
 * protected set (a stale name protected a nonexistent extension), so the
 * extension could disable itself. These tests pin the deliberate behavior
 * change: `_shared` and `config-feature-flag` can no longer be disabled.
 */

const tempDirectories: string[] = [];

function createRepository(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-config-features-"));
	tempDirectories.push(root);
	mkdirSync(join(root, ".pi", "extensions", "_shared"), { recursive: true });
	mkdirSync(join(root, ".pi", "extensions", "config-feature-flag"), { recursive: true });
	mkdirSync(join(root, ".pi", "extensions", "worker"), { recursive: true });
	mkdirSync(join(root, ".pi", "extensions-disabled"));
	writeFileSync(join(root, ".pi", "extensions", "_shared", "index.ts"), "export {};\n");
	writeFileSync(join(root, ".pi", "extensions", "config-feature-flag", "index.ts"), "export {};\n");
	writeFileSync(join(root, ".pi", "extensions", "worker", "index.ts"), "export {};\n");
	writeFileSync(
		join(root, ".pi", "extensions", "catalog.json"),
		`${JSON.stringify(
			{
				version: 1,
				extensions: {
					worker: {
						displayName: "Worker",
						pack: "autonomy",
						defaultEnabled: false,
						requires: [],
						conflicts: [],
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	return root;
}

function createDependencyRepository(): string {
	const root = createRepository();
	mkdirSync(join(root, ".pi", "extensions", "core"));
	writeFileSync(join(root, ".pi", "extensions", "core", "index.ts"), "export {};\n");
	writeFileSync(
		join(root, ".pi", "extensions", "catalog.json"),
		`${JSON.stringify(
			{
				version: 1,
				extensions: {
					core: {
						displayName: "Core",
						pack: "core",
						defaultEnabled: true,
						requires: [],
						conflicts: [],
					},
					worker: {
						displayName: "Worker",
						pack: "autonomy",
						defaultEnabled: false,
						requires: ["core"],
						conflicts: [],
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	return root;
}

interface Harness {
	root: string;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	notify: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	selectLabels: string[][];
	run: (args: string, options?: { hasUI?: boolean }) => Promise<void>;
}

function createHarness(root: string, pickerSteps?: string[]): Harness {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	createFeatureFlagsExtension({
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
	} as any);

	const notify = vi.fn();
	const selectLabels: string[][] = [];
	let selectCalls = 0;
	// Fallback picker: first call toggles the only offered option off, then save.
	const steps = pickerSteps ? [...pickerSteps] : undefined;
	const select = vi.fn(async (_title: string, labels: string[]) => {
		selectLabels.push(labels);
		selectCalls += 1;
		if (steps) {
			const step = steps.shift();
			if (step === "save") return "✓ Save selected";
			if (step === "cancel") return "✗ Cancel";
			return labels.find((label) => label.toLowerCase().includes(step?.toLowerCase() ?? "\u0000"));
		}
		if (selectCalls === 1) {
			return labels.find((label) => label !== "✓ Save selected" && label !== "✗ Cancel");
		}
		return "✓ Save selected";
	});
	const contexts = new Map<boolean, unknown>([
		[true, { cwd: root, hasUI: true, mode: "tui", ui: { notify, select } }],
		[false, { cwd: root, hasUI: false, mode: "tui", ui: { notify, select } }],
	]);
	const run = async (args: string, options?: { hasUI?: boolean }) => {
		const command = commands.get("features");
		if (!command) throw new Error("/features was not registered");
		await command.handler(args, contexts.get(options?.hasUI ?? true) as any);
	};

	return { root, commands, notify, select, selectLabels, run };
}

afterEach(() => {
	while (tempDirectories.length > 0) {
		rmSync(tempDirectories.pop()!, { recursive: true, force: true });
	}
});

describe("/features protection", () => {
	it("marks _shared and config-feature-flag as protected in the plain list", async () => {
		const harness = createHarness(createRepository());
		await harness.run("", { hasUI: false });

		const list = harness.notify.mock.calls.map((call) => call[0]).join("\n");
		expect(list).toContain("protected  _shared");
		expect(list).toContain("protected  config-feature-flag");
		expect(list).toContain("● enabled   worker");
		expect(list).not.toContain("system-feature-flags");
	});

	it("reports protected status for both names", async () => {
		const harness = createHarness(createRepository());
		await harness.run("status _shared");
		await harness.run("status config-feature-flag");

		const reported = harness.notify.mock.calls.map((call) => call[0]).join("\n");
		expect(reported).toContain("_shared: enabled (protected)");
		expect(reported).toContain("config-feature-flag: enabled (protected)");
	});

	it("refuses to disable config-feature-flag and leaves it installed", async () => {
		const root = createRepository();
		const harness = createHarness(root);
		await harness.run("disable config-feature-flag");

		expect(harness.notify).toHaveBeenCalledWith(
			'"config-feature-flag" is protected and cannot be disabled.',
			"warning",
		);
		expect(existsSync(join(root, ".pi", "extensions", "config-feature-flag", "index.ts"))).toBe(true);
		expect(existsSync(join(root, ".pi", "extensions-disabled", "config-feature-flag"))).toBe(false);
	});

	it("refuses to disable a requirement until its enabled dependent is disabled first", async () => {
		const root = createDependencyRepository();
		const harness = createHarness(root);

		await harness.run("disable core");
		expect(harness.notify).toHaveBeenLastCalledWith(
			'Extension change blocked:\nCannot disable "core": enabled extension "worker" depends on it. Disable "worker" first.',
			"warning",
		);
		expect(existsSync(join(root, ".pi", "extensions", "core", "index.ts"))).toBe(true);

		await harness.run("disable worker");
		await harness.run("disable core");
		expect(existsSync(join(root, ".pi", "extensions-disabled", "worker", "index.ts"))).toBe(true);
		expect(existsSync(join(root, ".pi", "extensions-disabled", "core", "index.ts"))).toBe(true);
	});

	it("discards a cancelled picker without changing directories", async () => {
		const root = createRepository();
		const harness = createHarness(root, ["cancel"]);

		await harness.run("");

		expect(harness.notify).toHaveBeenCalledWith("Changes discarded.", "info");
		expect(existsSync(join(root, ".pi", "extensions", "worker", "index.ts"))).toBe(true);
		expect(existsSync(join(root, ".pi", "extensions-disabled", "worker"))).toBe(false);
	});

	it("reports a saved unchanged picker selection as a no-op", async () => {
		const root = createRepository();
		const harness = createHarness(root, ["save"]);

		await harness.run("");

		expect(harness.notify).toHaveBeenCalledWith("No changes needed.", "info");
		expect(existsSync(join(root, ".pi", "extensions", "worker", "index.ts"))).toBe(true);
		expect(existsSync(join(root, ".pi", "extensions-disabled", "worker"))).toBe(false);
	});

	it("disables a dependent and its requirement in one picker batch", async () => {
		const root = createDependencyRepository();
		const harness = createHarness(root, ["Core", "Worker", "save"]);

		await harness.run("");

		expect(existsSync(join(root, ".pi", "extensions-disabled", "worker", "index.ts"))).toBe(true);
		expect(existsSync(join(root, ".pi", "extensions-disabled", "core", "index.ts"))).toBe(true);
		expect(harness.notify).toHaveBeenCalledWith("2 extension(s) moved. Run /reload to apply.", "info");
	});

	it("reports partial picker success with moved and failed Extensions", async () => {
		const root = createDependencyRepository();
		mkdirSync(join(root, ".pi", "extensions", "independent"));
		writeFileSync(join(root, ".pi", "extensions", "independent", "index.ts"), "export {};\n");
		mkdirSync(join(root, ".pi", "extensions-disabled", "worker"));
		writeFileSync(join(root, ".pi", "extensions-disabled", "worker", "index.ts"), "export {};\n");
		const harness = createHarness(root, ["Core", "Worker", "independent", "save"]);

		await harness.run("");

		const message = harness.notify.mock.calls.map((call) => call[0]).join("\n");
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("Moved: independent (disable)"), "warning");
		expect(message).toContain("worker (disable)");
		expect(message).toContain("Run /reload to apply successful moves.");
		expect(message).not.toContain("No changes needed.");
		expect(existsSync(join(root, ".pi", "extensions-disabled", "independent", "index.ts"))).toBe(true);
	});

	it("reports an all-failed picker batch as an error rather than a no-op", async () => {
		const root = createRepository();
		mkdirSync(join(root, ".pi", "extensions-disabled", "worker"));
		writeFileSync(join(root, ".pi", "extensions-disabled", "worker", "index.ts"), "export {};\n");
		const harness = createHarness(root, ["Worker", "save"]);

		await harness.run("");

		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("worker (disable)"),
			"error",
		);
		const notifications = harness.notify.mock.calls.map((call) => call[0]).join("\n");
		expect(notifications).not.toContain("No changes needed.");
		expect(existsSync(join(root, ".pi", "extensions", "worker", "index.ts"))).toBe(true);
	});

	it("preserves enable, disable, and reset success and already-at-target messages", async () => {
		const root = createRepository();
		const harness = createHarness(root);

		await harness.run("disable worker");
		expect(harness.notify).toHaveBeenLastCalledWith('"worker" disabled. Run /reload to apply.', "info");
		await harness.run("disable worker");
		expect(harness.notify).toHaveBeenLastCalledWith('"worker" is already disabled.', "info");

		await harness.run("enable worker");
		expect(harness.notify).toHaveBeenLastCalledWith('"worker" enabled. Run /reload to apply.', "info");
		await harness.run("enable worker");
		expect(harness.notify).toHaveBeenLastCalledWith('"worker" is already enabled.', "info");

		await harness.run("reset worker");
		expect(harness.notify).toHaveBeenLastCalledWith(
			'"worker" reset to default (disabled). Run /reload to apply.',
			"info",
		);
		await harness.run("reset worker");
		expect(harness.notify).toHaveBeenLastCalledWith(
			'"worker" already matches its default (disabled).',
			"info",
		);
	});

	it("reports command move failures with the target Extension and direction", async () => {
		const root = createRepository();
		const disabledPath = join(root, ".pi", "extensions-disabled", "worker");
		mkdirSync(disabledPath);
		const harness = createHarness(root);

		await harness.run("disable worker");

		expect(harness.notify).toHaveBeenLastCalledWith('Failed to disable "worker".', "error");
		expect(existsSync(join(root, ".pi", "extensions", "worker", "index.ts"))).toBe(true);
		expect(existsSync(disabledPath)).toBe(true);
	});

	it("keeps protected extensions enabled when the interactive picker saves without them", async () => {
		const root = createRepository();
		const harness = createHarness(root);
		await harness.run("");

		// Protected extensions are never offered to the picker.
		expect(harness.selectLabels[0].some((label) => label.includes("config-feature-flag"))).toBe(
			false,
		);
		expect(harness.selectLabels[0].some((label) => label.includes("_shared"))).toBe(false);

		// The user disabled the only offered option (worker); protected extensions stay put.
		expect(existsSync(join(root, ".pi", "extensions", "worker", "index.ts"))).toBe(false);
		expect(existsSync(join(root, ".pi", "extensions-disabled", "worker", "index.ts"))).toBe(true);
		expect(existsSync(join(root, ".pi", "extensions", "_shared", "index.ts"))).toBe(true);
		expect(existsSync(join(root, ".pi", "extensions", "config-feature-flag", "index.ts"))).toBe(
			true,
		);
		expect(harness.notify).toHaveBeenCalledWith("1 extension(s) moved. Run /reload to apply.", "info");
	});
});