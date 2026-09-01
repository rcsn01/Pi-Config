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

interface Harness {
	root: string;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	notify: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	selectLabels: string[][];
	run: (args: string, options?: { hasUI?: boolean }) => Promise<void>;
}

function createHarness(root: string): Harness {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	createFeatureFlagsExtension({
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
	} as any);

	const notify = vi.fn();
	const selectLabels: string[][] = [];
	let selectCalls = 0;
	// Fallback picker: first call toggles the only offered option off, then save.
	const select = vi.fn(async (_title: string, labels: string[]) => {
		selectLabels.push(labels);
		selectCalls += 1;
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