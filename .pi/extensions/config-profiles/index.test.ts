import type { FSWatcher, WatchListener } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigProfilesExtension } from "./index.ts";
import type { ProfileStore } from "./profile-store.ts";

function createHarness(options: {
	profiles?: string[];
	active?: string;
	switchError?: Error;
	planMode?: boolean;
	setModelResult?: boolean;
} = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const commands = new Map<string, any>();
	const configuredProfiles = {
		normal: {
			provider: "github-copilot",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "medium",
			contextWindow: 256_000,
		},
		plan: {
			provider: "ollama",
			modelId: "deepseek-v4-flash:0731-cloud",
			thinkingLevel: "xhigh",
			contextWindow: 200_000,
		},
	};
	const models = Object.values(configuredProfiles).map((profile) => ({
		provider: profile.provider,
		id: profile.modelId,
		name: profile.modelId,
		contextWindow: 128_000,
		reasoning: true,
	}));
	const synchronizeActiveProfile = vi.fn(async () => options.active);
	const switchProfile = vi.fn(async (name: string) => {
		if (options.switchError) throw options.switchError;
		return { changed: name !== options.active, active: name };
	});
	const store: ProfileStore = {
		settingsPath: "/shared/.pi/settings.json",
		profilesDirectory: "/shared/.pi/profiles",
		listProfiles: vi.fn(() => options.profiles ?? ["default", "focused"]),
		readProfile: vi.fn(() => ({ uiModelSelector: { profiles: configuredProfiles } })),
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
	const setModel = vi.fn(async () => options.setModelResult ?? true);
	const setThinkingLevel = vi.fn();
	const request = vi.fn();
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { notify, request, select: vi.fn() },
		model: undefined,
		modelRegistry: {
			refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
			find: vi.fn((provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id)),
			hasConfiguredAuth: vi.fn(() => true),
		},
		scopedModels: [],
		sessionManager: {
			getBranch: vi.fn(() => options.planMode
				? [{ type: "custom", customType: "plan-mode-state", data: { active: true } }]
				: []),
		},
		reload,
	};
	const pi = {
		on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler)),
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		setModel,
		setThinkingLevel,
	};
	createConfigProfilesExtension({ store, watch, output, debounceMs: 10, retryMs: 20 })(pi as any);
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
		setModel,
		setThinkingLevel,
		request,
		switchProfile,
		synchronizeActiveProfile,
		fireWatch: (filename: string | null = "settings.json") => watchListener?.("rename", filename),
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("config profiles extension", () => {
	it("switches a direct argument, notifies, and reloads exactly once", async () => {
		const harness = createHarness({ active: "default" });
		await harness.commands.get("profile").handler("focused", harness.ctx);
		expect(harness.switchProfile).toHaveBeenCalledWith("focused");
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: "github-copilot",
			id: "gpt-5.6-sol",
			contextWindow: 256_000,
		}));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("medium");
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

	it("synchronizes an already-active profile without reloading", async () => {
		const harness = createHarness({ active: "default" });
		await harness.commands.get("profile").handler("default", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith(
			'Profile "default" is already active; settings and model synchronized.',
			"info",
		);
		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("applies the Plan model when Plan Mode is active", async () => {
		const harness = createHarness({ active: "default", planMode: true });
		await harness.commands.get("profile").handler("focused", harness.ctx);
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: "ollama",
			id: "deepseek-v4-flash:0731-cloud",
			contextWindow: 200_000,
		}));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("xhigh");
	});

	it("reloads switched settings and reports when the model cannot be applied", async () => {
		const harness = createHarness({ active: "default", setModelResult: false });
		await harness.commands.get("profile").handler("focused", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("Profile settings changed, but the configured model could not be applied"),
			"error",
		);
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("reports failed switches and does not reload", async () => {
		const harness = createHarness({ switchError: new Error("broken destination") });
		await harness.commands.get("profile").handler("focused", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith(
			"Could not switch settings profile: broken destination",
			"error",
		);
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
