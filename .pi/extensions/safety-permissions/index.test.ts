import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import safetyPermissions from "./index.ts";
import { saveModeToFile } from "./mode-store.ts";

const mocked = vi.hoisted(() => ({
	runAutoReviewer: vi.fn(),
	parseGuardianDefinition: vi.fn(),
	resolveGuardianPath: vi.fn(),
}));
vi.mock("./guardian-runner.ts", () => mocked);

const tempDirectories: string[] = [];

afterEach(() => {
	while (tempDirectories.length > 0) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

function createHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-safety-status-"));
	tempDirectories.push(cwd);
	// Redirect the project state root (mode file, etc.) into a temp dir so the
	// tests never write to ~/.pi/state/pi-config.
	const stateDir = mkdtempSync(join(tmpdir(), "pi-safety-state-"));
	tempDirectories.push(stateDir);
	process.env.PI_CONFIG_STATE_DIR = stateDir;
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const renderers = new Map<string, (entry: any, options: any, theme: any) => any>();
	const setStatus = vi.fn();
	const appendEntry = vi.fn();
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
		registerCommand: vi.fn(),
		registerEntryRenderer: (type: string, renderer: any) => renderers.set(type, renderer),
		appendEntry,
	};
	const ctx = {
		cwd,
		hasUI: true,
		ui: { setStatus, notify: vi.fn() },
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "configProfiles", data: { active: "focused" } }],
		},
	};

	safetyPermissions(pi as any);
	return { ctx, handlers, setStatus, renderers, appendEntry };
}

describe("safety permission status", () => {
	it("publishes only the permission mode, not a profile-qualified label", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

		expect(harness.setStatus).toHaveBeenCalledWith("approval-mode", "default");
		expect(harness.setStatus).not.toHaveBeenCalledWith("approval-mode", expect.stringContaining(" · "));
		expect(harness.setStatus).not.toHaveBeenCalledWith("profile", expect.anything());
	});
});

describe("auto-review verdict wiring", () => {
	it("forwards triggers through the tool_call wiring into the verdict entry", async () => {
		mocked.runAutoReviewer.mockResolvedValue({ allowed: true, reason: "safe" });
		const harness = createHarness();
		saveModeToFile(harness.ctx.cwd, { mode: "auto-review", setAt: 0 });
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

		await harness.handlers.get("tool_call")?.(
			{ toolName: "bash", input: { command: "sudo rm -rf /workspace/x" } },
			harness.ctx,
		);

		expect(harness.appendEntry).toHaveBeenCalledWith("auto-review-verdict", expect.objectContaining({
			title: "Command Review",
			triggers: ["dangerous", "external-path"],
		}));
	});

	it("renders triggers on the verdict entry", () => {
		const harness = createHarness();
		const renderer = harness.renderers.get("auto-review-verdict");
		expect(renderer).toBeDefined();
		const box = renderer!(
			{ data: { allowed: false, title: "Command Review", triggers: ["dangerous", "network"], reason: "unsafe" } },
			{},
			{ fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text },
		);
		expect(box.render(80).join("\n")).toContain("[dangerous, network]");
	});
});
