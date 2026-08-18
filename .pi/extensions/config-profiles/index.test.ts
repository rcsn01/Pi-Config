import { mkdtempSync, rmSync, type FSWatcher, type WatchListener } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigProfilesExtension } from "./index.ts";
import type { ProfileStore } from "./profile-store.ts";
import { createProjectSettingsStore } from "../ui-model-selector/apply-profile.ts";

interface HarnessOptions {
	profiles?: string[];
	active?: string;
	switchError?: Error;
	readProfileDocument?: Record<string, unknown>;
	model?: { provider: string; id: string };
	branchEntries?: unknown[];
	setModelResult?: boolean;
}

const DEFAULT_MODEL = { provider: "ollama", id: "deepseek-v4-flash:0731-cloud" };

function createHarness(options: HarnessOptions = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const commands = new Map<string, any>();
	const synchronizeActiveProfile = vi.fn(async () => options.active);
	const switchProfile = vi.fn(async (name: string) => {
		if (options.switchError) throw options.switchError;
		return { changed: name !== options.active, active: name };
	});
	const readProfile = vi.fn(() => options.readProfileDocument ?? {});
	const store: ProfileStore = {
		settingsPath: "/shared/.pi/settings.json",
		profilesDirectory: "/shared/.pi/profiles",
		listProfiles: vi.fn(() => options.profiles ?? ["default", "focused"]),
		readProfile,
		readSettings: vi.fn(),
		getActiveProfile: vi.fn(() => options.active ?? "default"),
		synchronizeActiveProfile,
		switchProfile,
	};
	let watchListener: WatchListener<string> | undefined;
	const close = vi.fn();
	const onWatcherEvent = vi.fn();
	const watch = vi.fn((_path: string, listener: WatchListener<string>) => {
		watchListener = listener;
		return { close, on: onWatcherEvent } as unknown as FSWatcher;
	});
	const notify = vi.fn();
	const output = vi.fn();
	const reload = vi.fn(async () => {});
	const request = vi.fn();
	const setModel = vi.fn(async () => options.setModelResult ?? true);
	const setThinkingLevel = vi.fn();
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
	};
	const settingsDirectory = mkdtempSync(join(tmpdir(), "pi-config-profiles-"));
	tempDirectories.push(settingsDirectory);
	const settingsStore = createProjectSettingsStore(join(settingsDirectory, "settings.json"));
	createConfigProfilesExtension({ store, watch, output, debounceMs: 10, retryMs: 20, settingsStore })(pi as any);
	const emit = async (event: string) => handlers.get(event)?.({ type: event, reason: "startup" }, ctx);
	return {
		commands,
		ctx,
		emit,
		store,
		watch,
		close,
		notify,
		output,
		reload,
		request,
		switchProfile,
		synchronizeActiveProfile,
		readProfile,
		setModel,
		setThinkingLevel,
		modelRegistry,
		settingsDirectory,
		fireWatch: (filename: string | null = "settings.json") => watchListener?.("rename", filename),
	};
}

const tempDirectories: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	while (tempDirectories.length > 0) {
		rmSync(tempDirectories.pop()!, { recursive: true, force: true });
	}
});

describe("config profiles extension", () => {
	it("switches a direct argument, notifies, and reloads exactly once", async () => {
		const harness = createHarness({ active: "default" });
		await harness.commands.get("profile").handler("focused", harness.ctx);
		expect(harness.switchProfile).toHaveBeenCalledWith("focused");
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

	it("starts watching on session_start and debounces settings changes", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		expect(harness.watch).not.toHaveBeenCalled();
		await harness.emit("session_start");
		expect(harness.watch).toHaveBeenCalledWith("/shared/.pi", expect.any(Function));
		expect(harness.synchronizeActiveProfile).toHaveBeenCalledOnce();

		harness.fireWatch();
		harness.fireWatch();
		await vi.advanceTimersByTimeAsync(10);
		expect(harness.synchronizeActiveProfile).toHaveBeenCalledTimes(2);
	});

	it("flushes pending synchronization and closes the watcher on shutdown", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		await harness.emit("session_start");
		harness.fireWatch();
		await harness.emit("session_shutdown");
		expect(harness.close).toHaveBeenCalledOnce();
		expect(harness.synchronizeActiveProfile).toHaveBeenCalledTimes(2);
		await vi.runAllTimersAsync();
		expect(harness.synchronizeActiveProfile).toHaveBeenCalledTimes(2);
	});

	it("synchronizes an already-active profile without applying or reloading", async () => {
		const harness = createHarness({ active: "default" });
		await harness.commands.get("profile").handler("default", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith(
			'Profile "default" is already active; settings synchronized.',
			"info",
		);
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
		expect(harness.readProfile).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("retries transient watcher errors and only reports persistent failures", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		await harness.emit("session_start");
		harness.synchronizeActiveProfile
			.mockRejectedValueOnce(new Error("half-written"))
			.mockRejectedValueOnce(new Error("still malformed"));
		harness.fireWatch();
		await vi.advanceTimersByTimeAsync(10);
		expect(harness.notify).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(20);
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("still malformed"), "error");
	});
});
