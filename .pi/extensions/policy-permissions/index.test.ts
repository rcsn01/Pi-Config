import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import safetyPermissions, { createSafetyPermissionsExtension } from "./index.ts";
import { saveModeToFile } from "./mode-store.ts";
import { clearSessionProfileHandoff, stageSessionProfileHandoff } from "../_shared/session-profile-binding.ts";

const mocked = vi.hoisted(() => ({
	runAutoReviewer: vi.fn(),
	disposeAutoReviewer: vi.fn(async () => {}),
	parseGuardianDefinition: vi.fn(),
	resolveGuardianPath: vi.fn(),
	pickModelConfiguration: vi.fn(),
}));
vi.mock("./guardian-runner.ts", () => mocked);
vi.mock("../_shared/model-picker.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../_shared/model-picker.ts")>()),
	pickModelConfiguration: mocked.pickModelConfiguration,
}));

const tempDirectories: string[] = [];

afterEach(() => {
	vi.clearAllMocks();
	while (tempDirectories.length > 0) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

function createHarness(options: { settingsPath?: string; branch?: any[] } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-safety-status-"));
	tempDirectories.push(cwd);
	// Redirect the project state root (mode file, etc.) into a temp dir so the
	// tests never write to ~/.pi/state/pi-config.
	const stateDir = mkdtempSync(join(tmpdir(), "pi-safety-state-"));
	tempDirectories.push(stateDir);
	process.env.PI_CONFIG_STATE_DIR = stateDir;
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const commands = new Map<string, any>();
	const renderers = new Map<string, (entry: any, options: any, theme: any) => any>();
	const setStatus = vi.fn();
	const appendEntry = vi.fn();
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerEntryRenderer: (type: string, renderer: any) => renderers.set(type, renderer),
		appendEntry,
	};
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		scopedModels: [],
		ui: { setStatus, notify: vi.fn(), confirm: vi.fn(async () => false) },
		modelRegistry: { find: vi.fn() },
		sessionManager: {
			getBranch: () => options.branch ?? [{ type: "custom", customType: "configProfiles", data: { active: "focused" } }],
		},
	};

	if (options.settingsPath) createSafetyPermissionsExtension({ settingsPath: options.settingsPath })(pi as any);
	else safetyPermissions(pi as any);
	return { ctx, handlers, commands, setStatus, renderers, appendEntry };
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

describe("permission enforcement adapter", () => {
	it("issues and consumes one canonical one-shot approval through /approve", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		const toolCall = harness.handlers.get("tool_call")!;

		expect(await toolCall(
			{ toolName: "ddg_search", input: { query: "x", max_results: 5 } },
			harness.ctx,
		)).toEqual(expect.objectContaining({ block: true }));
		await harness.commands.get("approve").handler("", harness.ctx);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Approved once: Network Tool"),
			"info",
		);
		expect(await toolCall(
			{ toolName: "ddg_search", input: { max_results: 5, query: "x" } },
			harness.ctx,
		)).toBeUndefined();
		expect(await toolCall(
			{ toolName: "ddg_search", input: { query: "x", max_results: 5 } },
			harness.ctx,
		)).toEqual(expect.objectContaining({ block: true }));
	});
});

describe("guardian model command", () => {
	it("writes the shared picker selection to the session-bound profile", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-guardian-profile-"));
		tempDirectories.push(root);
		const settingsPath = join(root, "settings.json");
		const profilesDirectory = join(root, "profiles");
		mkdirSync(profilesDirectory);
		writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "other" }, rootOnly: true }));
		writeFileSync(join(profilesDirectory, "focused.json"), JSON.stringify({
			configProfiles: { active: "focused" },
			keep: true,
			guardian: { provider: "old", modelId: "guardian", thinkingLevel: "low", contextWindow: 128_000 },
		}));
		mocked.pickModelConfiguration.mockResolvedValue({
			model: { provider: "anthropic", id: "strong", name: "Strong", contextWindow: 256_000 },
			thinkingLevel: "high",
			contextWindow: 256_000,
		});
		const harness = createHarness({ settingsPath });
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

		await harness.commands.get("guardian").handler("", harness.ctx);

		expect(JSON.parse(readFileSync(join(profilesDirectory, "focused.json"), "utf8"))).toMatchObject({
			keep: true,
			guardian: { provider: "anthropic", modelId: "strong", thinkingLevel: "high", contextWindow: 256_000 },
		});
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ configProfiles: { active: "other" }, rootOnly: true });
		expect(mocked.pickModelConfiguration).toHaveBeenCalledWith(harness.ctx, expect.objectContaining({
			modelTitle: "Select Guardian model",
			previous: expect.objectContaining({ provider: "old", modelId: "guardian" }),
		}));
	});

	it("does not write if the session binding changes while the picker is open", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-guardian-race-"));
		tempDirectories.push(root);
		const settingsPath = join(root, "settings.json");
		const profilesDirectory = join(root, "profiles");
		mkdirSync(profilesDirectory);
		writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "focused" } }));
		writeFileSync(join(profilesDirectory, "focused.json"), JSON.stringify({ keep: true }));
		let finishPicker!: (selection: any) => void;
		mocked.pickModelConfiguration.mockImplementation(() => new Promise((resolve) => { finishPicker = resolve; }));
		const harness = createHarness({ settingsPath, branch: [] });
		await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
		const command = harness.commands.get("guardian").handler("", harness.ctx);
		await harness.handlers.get("session_shutdown")?.({ reason: "reload" }, harness.ctx);
		finishPicker({
			model: { provider: "openai", id: "guardian", contextWindow: 128_000 },
			thinkingLevel: "medium",
			contextWindow: 128_000,
		});
		await command;

		expect(JSON.parse(readFileSync(join(profilesDirectory, "focused.json"), "utf8"))).toEqual({ keep: true });
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("profile changed"), "warning");
	});

	it("keeps the remembered profile binding on reload", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-guardian-reload-"));
		tempDirectories.push(root);
		const settingsPath = join(root, "settings.json");
		const profilesDirectory = join(root, "profiles");
		mkdirSync(profilesDirectory);
		writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "focused" } }));
		writeFileSync(join(profilesDirectory, "default.json"), JSON.stringify({ keep: "default" }));
		writeFileSync(join(profilesDirectory, "focused.json"), JSON.stringify({ keep: "focused" }));
		mocked.pickModelConfiguration.mockResolvedValue({
			model: { provider: "openai", id: "guardian", name: "Guardian", contextWindow: 128_000 },
			thinkingLevel: "medium",
			contextWindow: 128_000,
		});
		const harness = createHarness({
			settingsPath,
			branch: [{ type: "custom", customType: "configProfiles", data: { active: "default" } }],
		});
		await harness.handlers.get("session_start")?.({ reason: "reload" }, harness.ctx);

		await harness.commands.get("guardian").handler("", harness.ctx);

		expect(JSON.parse(readFileSync(join(profilesDirectory, "default.json"), "utf8"))).toHaveProperty("guardian.modelId", "guardian");
		expect(JSON.parse(readFileSync(join(profilesDirectory, "focused.json"), "utf8"))).toEqual({ keep: "focused" });
	});

	it("uses the matching clear handoff for Guardian settings", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-guardian-clear-handoff-"));
		tempDirectories.push(root);
		const settingsPath = join(root, "settings.json");
		const profilesDirectory = join(root, "profiles");
		const previousSessionFile = join(root, "previous-session.json");
		mkdirSync(profilesDirectory);
		writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "other" } }));
		writeFileSync(join(profilesDirectory, "focused.json"), JSON.stringify({
			configProfiles: { active: "focused" },
			keep: true,
			guardian: { provider: "old", modelId: "guardian", thinkingLevel: "low", contextWindow: 128_000 },
		}));
		writeFileSync(join(profilesDirectory, "other.json"), JSON.stringify({ keep: "other" }));
		mocked.pickModelConfiguration.mockResolvedValue({
			model: { provider: "anthropic", id: "strong", name: "Strong", contextWindow: 256_000 },
			thinkingLevel: "high",
			contextWindow: 256_000,
		});

		stageSessionProfileHandoff(previousSessionFile, "focused");
		try {
			const harness = createHarness({ settingsPath, branch: [] });
			await harness.handlers.get("session_start")?.({
				reason: "new",
				previousSessionFile,
			}, harness.ctx);

			await harness.commands.get("guardian").handler("", harness.ctx);

			expect(JSON.parse(readFileSync(join(profilesDirectory, "focused.json"), "utf8"))).toMatchObject({
				keep: true,
				guardian: { provider: "anthropic", modelId: "strong", thinkingLevel: "high", contextWindow: 256_000 },
			});
			expect(JSON.parse(readFileSync(join(profilesDirectory, "other.json"), "utf8"))).toEqual({ keep: "other" });
		} finally {
			clearSessionProfileHandoff(previousSessionFile);
		}
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
			{ expanded: true },
			{
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				italic: (text: string) => text,
				strikethrough: (text: string) => text,
				underline: (text: string) => text,
			},
		);
		const output = box.render(80).join("\n");
		expect(output).toContain("Triggers: dangerous, network");
		expect(output.match(/Triggers:/g)).toHaveLength(1);
	});
});
