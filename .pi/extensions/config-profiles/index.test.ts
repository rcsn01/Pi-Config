import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigProfilesExtension } from "./index.ts";
import type { ProfileStore } from "./profile-store.ts";

interface HarnessOptions {
	profiles?: string[];
	active?: string;
	switchError?: Error;
	readProfileDocument?: Record<string, unknown>;
	activeProfile?: { name: string; document: Record<string, unknown> } | undefined;
	model?: { provider: string; id: string };
	branchEntries?: unknown[];
	setModelResult?: boolean;
}

const DEFAULT_MODEL = { provider: "ollama", id: "deepseek-v4-flash:0731-cloud" };

function createHarness(options: HarnessOptions = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const commands = new Map<string, any>();
	const settingsDirectory = mkdtempSync(join(tmpdir(), "pi-config-profiles-"));
	tempDirectories.push(settingsDirectory);
	const settingsPath = join(settingsDirectory, "settings.json");
	const profilesDirectory = join(settingsDirectory, "profiles");
	mkdirSync(profilesDirectory);
	writeFileSync(
		settingsPath,
		`${JSON.stringify({ configProfiles: { active: options.active ?? "default" } }, null, 2)}\n`,
	);
	const switchProfile = vi.fn(async (name: string) => {
		if (options.switchError) throw options.switchError;
		return { changed: name !== (options.active ?? "default"), active: name };
	});
	const readProfile = vi.fn(() => options.readProfileDocument ?? {});
	const loadActiveProfile = vi.fn(() =>
		options.activeProfile === undefined
			? { name: options.active ?? "default", document: {} }
			: options.activeProfile);
	const store: ProfileStore = {
		settingsPath,
		profilesDirectory,
		listProfiles: vi.fn(() => options.profiles ?? ["default", "focused"]),
		readProfile,
		getActiveProfile: vi.fn(() => options.active ?? "default"),
		loadActiveProfile,
		switchProfile,
		profilePath: vi.fn((name: string) => join(profilesDirectory, `${name}.json`)),
	};
	const notify = vi.fn();
	const output = vi.fn();
	const reload = vi.fn(async () => {});
	const request = vi.fn();
	const setModel = vi.fn(async () => options.setModelResult ?? true);
	const setThinkingLevel = vi.fn();
	const appendEntry = vi.fn();
	const modelRegistry = {
		refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
		find: vi.fn((provider: string, id: string) => ({
			provider,
			id,
			name: id,
			contextWindow: 256000,
			reasoning: true,
		})),
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { notify, request, select: vi.fn() },
		reload,
		model: options.model ?? DEFAULT_MODEL,
		scopedModels: [],
		modelRegistry,
		sessionManager: { getBranch: vi.fn(() => options.branchEntries ?? []) },
	};
	const pi = {
		on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler)),
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		setModel,
		setThinkingLevel,
		appendEntry,
	};
	createConfigProfilesExtension({ store, output })(pi as any);
	const emit = async (event: string, reason = "startup") =>
		handlers.get(event)?.({ type: event, reason }, ctx);
	return {
		commands,
		ctx,
		emit,
		store,
		notify,
		output,
		reload,
		request,
		switchProfile,
		readProfile,
		loadActiveProfile,
		setModel,
		setThinkingLevel,
		appendEntry,
		modelRegistry,
		settingsPath,
	};
}

const tempDirectories: string[] = [];

afterEach(() => {
	while (tempDirectories.length > 0) {
		rmSync(tempDirectories.pop()!, { recursive: true, force: true });
	}
});

describe("config profiles extension", () => {
	it("records the active profile as a session entry on startup", async () => {
		const harness = createHarness({ active: "default" });
		await harness.emit("session_start", "startup");
		expect(harness.loadActiveProfile).toHaveBeenCalledOnce();
		expect(harness.appendEntry).toHaveBeenCalledWith("configProfiles", { active: "default" });
	});

	it("records the active profile on resume and fork boundaries", async () => {
		for (const reason of ["resume", "fork", "new"] as const) {
			const harness = createHarness({ active: "default" });
			await harness.emit("session_start", reason);
			expect(harness.appendEntry).toHaveBeenCalledWith("configProfiles", { active: "default" });
		}
	});

	it("does nothing on reload: the session entry persists and siblings re-read the profile", async () => {
		const harness = createHarness({ active: "default" });
		await harness.emit("session_start", "reload");
		expect(harness.loadActiveProfile).not.toHaveBeenCalled();
		expect(harness.appendEntry).not.toHaveBeenCalled();
	});

	it("notifies when the active profile file is missing", async () => {
		const harness = createHarness({ activeProfile: undefined });
		harness.loadActiveProfile.mockImplementation(() => {
			throw new Error("Cannot read /missing/default.json");
		});
		await harness.emit("session_start", "startup");
		expect(harness.appendEntry).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("Cannot read /missing/default.json"),
			"error",
		);
	});

	it("switches a direct argument, records the entry, notifies, and reloads exactly once", async () => {
		const harness = createHarness({ active: "default" });
		await harness.commands.get("profile").handler("focused", harness.ctx);
		expect(harness.switchProfile).toHaveBeenCalledWith("focused");
		expect(harness.appendEntry).toHaveBeenCalledWith("configProfiles", { active: "focused" });
		expect(harness.notify).toHaveBeenCalledWith('Switched to profile "focused". Reloading…', "info");
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("applies the target profile's normal model before reloading", async () => {
		const harness = createHarness({
			active: "default",
			readProfileDocument: {
				uiModelSelector: {
					profiles: {
						normal: { provider: "ollama", modelId: "gpt-5.6-sol", thinkingLevel: "high", contextWindow: 256000 },
						plan: { provider: "ollama", modelId: "plan-model", thinkingLevel: "low", contextWindow: 131072 },
					},
				},
			},
		});
		await harness.commands.get("profile").handler("focused", harness.ctx);

		expect(harness.readProfile).toHaveBeenCalledWith("focused");
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: "ollama",
			id: "gpt-5.6-sol",
			contextWindow: 256000,
		}));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(harness.notify).toHaveBeenCalledWith("Profile model: ollama/gpt-5.6-sol", "info");
		expect(harness.notify).toHaveBeenCalledWith('Switched to profile "focused". Reloading…', "info");
		expect(harness.reload).toHaveBeenCalledOnce();
		// The model must be applied before the reload tears the runtime down.
		expect(harness.setModel.mock.invocationCallOrder[0]).toBeLessThan(harness.reload.mock.invocationCallOrder[0]);
	});

	it("applies the plan selection when plan mode is active", async () => {
		const harness = createHarness({
			active: "default",
			branchEntries: [{ type: "custom", customType: "plan-mode-state", data: { active: true } }],
			readProfileDocument: {
				uiModelSelector: {
					profiles: {
						normal: { provider: "ollama", modelId: "normal-model", thinkingLevel: "medium", contextWindow: 200000 },
						plan: { provider: "ollama", modelId: "plan-model", thinkingLevel: "low", contextWindow: 131072 },
					},
				},
			},
		});
		await harness.commands.get("profile").handler("focused", harness.ctx);

		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "plan-model", contextWindow: 131072 }));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("low");
	});

	it("always applies the selection even when the model is unchanged", async () => {
		const harness = createHarness({
			active: "default",
			model: { provider: "ollama", id: "gpt-5.6-sol" },
			readProfileDocument: {
				uiModelSelector: {
					profiles: {
						normal: { provider: "ollama", modelId: "gpt-5.6-sol", thinkingLevel: "max", contextWindow: 256000 },
					},
				},
			},
		});
		await harness.commands.get("profile").handler("focused", harness.ctx);

		expect(harness.setModel).toHaveBeenCalledOnce();
		// No "Profile model:" notification when the session model already matches.
		expect(harness.notify).not.toHaveBeenCalledWith("Profile model: ollama/gpt-5.6-sol", "info");
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("keeps the current model when the profile has no model selection", async () => {
		const harness = createHarness({
			active: "default",
			readProfileDocument: { compaction: { threshold: 0.1 } },
		});
		await harness.commands.get("profile").handler("focused", harness.ctx);

		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.notify).not.toHaveBeenCalledWith(expect.stringContaining("Profile model:"), "info");
		expect(harness.notify).toHaveBeenCalledWith('Switched to profile "focused". Reloading…', "info");
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("reports a malformed model selection but still reloads", async () => {
		const harness = createHarness({
			active: "default",
			readProfileDocument: { uiModelSelector: { profiles: { normal: "not-an-object" } } },
		});
		await harness.commands.get("profile").handler("focused", harness.ctx);

		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("Could not apply the profile model:"),
			"error",
		);
		expect(harness.notify).toHaveBeenCalledWith('Switched to profile "focused". Reloading…', "info");
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("reports an authentication failure but still reloads", async () => {
		const harness = createHarness({
			active: "default",
			setModelResult: false,
			readProfileDocument: {
				uiModelSelector: {
					profiles: {
						normal: { provider: "ollama", modelId: "gpt-5.6-sol", thinkingLevel: "high", contextWindow: 256000 },
					},
				},
			},
		});
		await harness.commands.get("profile").handler("focused", harness.ctx);

		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.notify).toHaveBeenCalledWith(
			"Could not apply the profile model: No configured authentication for ollama/gpt-5.6-sol.",
			"error",
		);
		expect(harness.notify).toHaveBeenCalledWith('Switched to profile "focused". Reloading…', "info");
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("uses the shared picker and marks the active profile", async () => {
		const harness = createHarness({ active: "default" });
		harness.request.mockResolvedValue({ value: "focused" });
		await harness.commands.get("profile").handler("", harness.ctx);

		expect(harness.request).toHaveBeenCalledWith(expect.objectContaining({
			method: "optionList",
			options: [
				expect.objectContaining({ value: "default", checked: true }),
				expect.objectContaining({ value: "focused", checked: false }),
			],
		}));
		expect(harness.switchProfile).toHaveBeenCalledWith("focused");
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("provides current filename completions", () => {
		const harness = createHarness({ profiles: ["default", "focused", "fast"] });
		const completions = harness.commands.get("profile").getArgumentCompletions("f");
		expect(completions).toEqual([
			{ value: "focused", label: "focused" },
			{ value: "fast", label: "fast" },
		]);
		expect(harness.commands.get("profile").getArgumentCompletions("missing")).toBeNull();
	});

	it("lists profiles and usage without prompting in non-interactive mode", async () => {
		const harness = createHarness({ active: "default" });
		const context = { ...harness.ctx, hasUI: false, mode: "print" };
		await harness.commands.get("profile").handler("", context);
		expect(harness.output).toHaveBeenCalledWith(expect.stringContaining("Usage: /profile <name>"));
		expect(harness.notify).not.toHaveBeenCalled();
		expect(harness.switchProfile).not.toHaveBeenCalled();
	});

	it("does not install a settings.json watcher", async () => {
		const harness = createHarness({ active: "default" });
		await harness.emit("session_start", "startup");
		await harness.emit("session_start", "reload");
		// No watcher, timers, or synchronization: the profile file is the source of
		// truth and is only read at session boundaries.
		expect(harness.switchProfile).not.toHaveBeenCalled();
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("reports an already-active profile without applying or reloading", async () => {
		const harness = createHarness({ active: "default" });
		await harness.commands.get("profile").handler("default", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith('Profile "default" is already active.', "info");
		expect(harness.appendEntry).not.toHaveBeenCalled();
		expect(harness.readProfile).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("reports failed switches without applying or reloading", async () => {
		const harness = createHarness({ switchError: new Error("broken destination") });
		await harness.commands.get("profile").handler("focused", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith(
			"Could not switch settings profile: broken destination",
			"error",
		);
		expect(harness.appendEntry).not.toHaveBeenCalled();
		expect(harness.readProfile).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.reload).not.toHaveBeenCalled();
	});
});
