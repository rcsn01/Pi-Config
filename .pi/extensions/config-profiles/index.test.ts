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
	createError?: Error;
	deleteError?: Error;
	nativeDefaults?: { provider: string; modelId: string; thinkingLevel?: string };
	readProfileDocument?: Record<string, unknown>;
	readProfileError?: Error;
	appendError?: Error;
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
	const createProfile = vi.fn(async (name: string, source?: string) => {
		if (options.createError) throw options.createError;
		return { name, source };
	});
	const deleteProfile = vi.fn(async (name: string, deleteOptions?: { replaceMarker?: boolean }) => {
		if (options.deleteError) throw options.deleteError;
		return {
			name,
			replacement: "default" as const,
			markerReplaced: deleteOptions?.replaceMarker ?? name === (options.active ?? "default"),
		};
	});
	const readProfile = vi.fn(() => {
		if (options.readProfileError) throw options.readProfileError;
		return options.readProfileDocument ?? {};
	});
	const store: ProfileStore = {
		settingsPath,
		profilesDirectory,
		listProfiles: vi.fn(() => options.profiles ?? ["default", "focused"]),
		readProfile,
		createProfile,
		deleteProfile,
		switchProfile,
		profilePath: vi.fn((name: string) => join(profilesDirectory, `${name}.json`)),
	};
	const notify = vi.fn();
	const setStatus = vi.fn();
	const output = vi.fn();
	const reload = vi.fn(async () => {});
	const select = vi.fn();
	const input = vi.fn();
	const confirm = vi.fn();
	const setModel = vi.fn(async () => options.setModelResult ?? true);
	const setThinkingLevel = vi.fn();
	const appendEntry = vi.fn(() => {
		if (options.appendError) throw options.appendError;
	});
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
		ui: { notify, select, input, confirm, setStatus },
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
	createConfigProfilesExtension({ store, output, nativeDefaults: options.nativeDefaults })(pi as any);
	const emit = async (event: string, reason = "startup") =>
		handlers.get(event)?.({ type: event, reason }, ctx);
	const runProfileCommand = async (args: string, context = ctx) => {
		await emit("session_start", "startup");
		for (const mock of [appendEntry, notify, setStatus, reload, switchProfile, createProfile, deleteProfile, readProfile, setModel, setThinkingLevel]) {
			mock.mockClear();
		}
		return commands.get("profile").handler(args, context);
	};
	return {
		commands,
		ctx,
		emit,
		runProfileCommand,
		store,
		notify,
		setStatus,
		output,
		reload,
		select,
		input,
		confirm,
		switchProfile,
		createProfile,
		deleteProfile,
		readProfile,
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
	it("records and publishes the active profile on startup", async () => {
		const harness = createHarness({ active: "default" });
		await harness.emit("session_start", "startup");
		expect(harness.readProfile).toHaveBeenCalledWith("default");
		expect(harness.appendEntry).toHaveBeenCalledWith("configProfiles", { active: "default" });
		expect(harness.setStatus).toHaveBeenCalledWith("profile", "default");
	});

	it("records the active profile on resume, fork, and unseeded new boundaries", async () => {
		for (const reason of ["resume", "fork", "new"] as const) {
			const harness = createHarness({ active: "default" });
			await harness.emit("session_start", reason);
			expect(harness.appendEntry).toHaveBeenCalledWith("configProfiles", { active: "default" });
		}
	});

	it("keeps the remembered profile on startup, resume, and fork even when the marker changed", async () => {
		for (const reason of ["startup", "resume", "fork"] as const) {
			const harness = createHarness({
				active: "github",
				branchEntries: [{ type: "custom", customType: "configProfiles", data: { active: "focused" } }],
			});
			await harness.emit("session_start", reason);

			expect(harness.setStatus).toHaveBeenCalledWith("profile", "focused");
			expect(harness.readProfile).not.toHaveBeenCalled();
			expect(harness.appendEntry).not.toHaveBeenCalled();
		}
	});

	it("publishes a profile seeded into a new session without replacing it from the active marker", async () => {
		const harness = createHarness({
			active: "github",
			branchEntries: [{ type: "custom", customType: "configProfiles", data: { active: "focused" } }],
		});
		await harness.emit("session_start", "new");

		expect(harness.setStatus).toHaveBeenCalledWith("profile", "focused");
		expect(harness.readProfile).not.toHaveBeenCalled();
		expect(harness.appendEntry).not.toHaveBeenCalled();
	});

	it("publishes the remembered session profile on reload without rewriting it", async () => {
		const harness = createHarness({
			active: "default",
			branchEntries: [{ type: "custom", customType: "configProfiles", data: { active: "focused" } }],
		});
		await harness.emit("session_start", "reload");
		expect(harness.readProfile).not.toHaveBeenCalled();
		expect(harness.appendEntry).not.toHaveBeenCalled();
		expect(harness.setStatus).toHaveBeenCalledWith("profile", "focused");
	});

	it("clears the profile status when the active profile file is missing", async () => {
		const harness = createHarness({ readProfileError: new Error("Cannot read /missing/default.json") });
		await harness.emit("session_start", "startup");
		expect(harness.appendEntry).not.toHaveBeenCalled();
		expect(harness.setStatus).toHaveBeenCalledWith("profile", undefined);
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("Cannot read /missing/default.json"),
			"error",
		);
	});

	it("clears the profile status on reload without a remembered entry", async () => {
		const harness = createHarness({ active: "default" });
		await harness.emit("session_start", "reload");
		expect(harness.setStatus).toHaveBeenCalledWith("profile", undefined);
		expect(harness.readProfile).not.toHaveBeenCalled();
		expect(harness.appendEntry).not.toHaveBeenCalled();
	});

	it("clears the profile status when remembering the marker binding fails", async () => {
		const harness = createHarness({ active: "default", appendError: new Error("append failed") });
		await harness.emit("session_start", "startup");

		expect(harness.readProfile).toHaveBeenCalledWith("default");
		expect(harness.setStatus).toHaveBeenLastCalledWith("profile", undefined);
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("append failed"),
			"error",
		);
	});

	it("publishes the remembered profile when the session tree changes", async () => {
		const harness = createHarness({
			branchEntries: [{ type: "custom", customType: "configProfiles", data: { active: "focused" } }],
		});
		await harness.emit("session_tree");
		expect(harness.setStatus).toHaveBeenCalledWith("profile", "focused");
	});

	it("copies the session startup profile after another session changes the marker", async () => {
		const harness = createHarness({ active: "default" });
		await harness.emit("session_start", "startup");
		writeFileSync(harness.settingsPath, `${JSON.stringify({ configProfiles: { active: "focused" } }, null, 2)}\n`);
		harness.select.mockResolvedValue("  Add profile");
		harness.input.mockResolvedValue("copy");
		await harness.commands.get("profile").handler("", harness.ctx);

		expect(harness.createProfile).toHaveBeenCalledWith("copy", "default");
	});

	it("clears the profile status on shutdown", async () => {
		const harness = createHarness({ active: "default" });
		await harness.emit("session_shutdown");
		expect(harness.setStatus).toHaveBeenCalledWith("profile", undefined);
	});

	it("clears the profile status once after coordinated initialization", async () => {
		const harness = createHarness({ active: "default" });
		await harness.emit("session_start");
		harness.setStatus.mockClear();
		await harness.emit("session_shutdown");
		expect(harness.setStatus).toHaveBeenCalledOnce();
		expect(harness.setStatus).toHaveBeenCalledWith("profile", undefined);
	});

	it("switches a direct argument, records the entry, notifies, and reloads exactly once", async () => {
		const harness = createHarness({ active: "default" });
		await harness.runProfileCommand("focused");
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
		await harness.runProfileCommand("focused");

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
		await harness.runProfileCommand("focused");

		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "plan-model", contextWindow: 131072 }));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("low");
	});

	it("resolves the default profile through Pi native settings", async () => {
		const harness = createHarness({
			active: "focused",
			nativeDefaults: { provider: "openai-codex", modelId: "gpt-5.6-luna", thinkingLevel: "max" },
			readProfileDocument: {
				uiModelSelector: {
					profiles: {
						normal: { provider: "default", modelId: "default", thinkingLevel: "default", contextWindow: "default" },
						plan: { provider: "default", modelId: "default", thinkingLevel: "default", contextWindow: "default" },
					},
				},
			},
		});
		await harness.runProfileCommand("default");

		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: "openai-codex",
			id: "gpt-5.6-luna",
			contextWindow: 256000,
		}));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("max");
		expect(harness.notify).toHaveBeenCalledWith("Profile model: openai-codex/gpt-5.6-luna", "info");
		expect(harness.reload).toHaveBeenCalledOnce();
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
		await harness.runProfileCommand("focused");

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
		await harness.runProfileCommand("focused");

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
		await harness.runProfileCommand("focused");

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
		await harness.runProfileCommand("focused");

		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.notify).toHaveBeenCalledWith(
			"Could not apply the profile model: No configured authentication for ollama/gpt-5.6-sol.",
			"error",
		);
		expect(harness.notify).toHaveBeenCalledWith('Switched to profile "focused". Reloading…', "info");
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("uses the shared picker and puts profile actions at the bottom", async () => {
		const harness = createHarness({ active: "default" });
		harness.select.mockResolvedValue("  focused");
		await harness.runProfileCommand("");

		expect(harness.select).toHaveBeenCalledWith("Select settings profile", [
			"● default (current)",
			"  focused",
			"  Add profile",
			"  Delete profile",
		]);
		expect(harness.switchProfile).toHaveBeenCalledWith("focused");
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("adds a profile by copying the session profile and activating it", async () => {
		const harness = createHarness({ active: "default" });
		harness.select.mockResolvedValue("  Add profile");
		harness.input.mockResolvedValue(" focused-copy ");
		await harness.runProfileCommand("");

		expect(harness.input).toHaveBeenCalledWith("New settings profile name", "profile-name");
		expect(harness.createProfile).toHaveBeenCalledWith("focused-copy", "default");
		expect(harness.appendEntry).toHaveBeenCalledWith("configProfiles", { active: "focused-copy" });
		expect(harness.notify).toHaveBeenCalledWith('Added profile "focused-copy". Reloading…', "info");
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("can add the first profile when the profile list is empty", async () => {
		const harness = createHarness({ profiles: [], active: "" });
		harness.select.mockResolvedValue("  Add profile");
		harness.input.mockResolvedValue("first");
		await harness.runProfileCommand("");

		expect(harness.select).toHaveBeenCalledWith("Select settings profile", ["  Add profile", "  Delete profile"]);
		expect(harness.createProfile).toHaveBeenCalledWith("first", undefined);
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("reports profile creation errors without reloading", async () => {
		const harness = createHarness({ active: "default", createError: new Error('Profile "focused" already exists.') });
		harness.select.mockResolvedValue("  Add profile");
		harness.input.mockResolvedValue("focused");
		await harness.runProfileCommand("");

		expect(harness.notify).toHaveBeenCalledWith(
			'Could not add settings profile: Profile "focused" already exists.',
			"error",
		);
		expect(harness.appendEntry).not.toHaveBeenCalled();
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("does not add a profile when the name prompt is cancelled", async () => {
		const harness = createHarness({ active: "default" });
		harness.select.mockResolvedValue("  Add profile");
		harness.input.mockResolvedValue(undefined);
		await harness.runProfileCommand("");

		expect(harness.createProfile).not.toHaveBeenCalled();
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("deletes an inactive profile after confirmation without reloading", async () => {
		const harness = createHarness({ profiles: ["default", "focused", "other"], active: "default" });
		harness.select
			.mockResolvedValueOnce("  Delete profile")
			.mockResolvedValueOnce("  other");
		harness.confirm.mockResolvedValue(true);
		await harness.runProfileCommand("");

		expect(harness.select).toHaveBeenNthCalledWith(2, "Delete settings profile", ["  focused", "  other"]);
		expect(harness.confirm).toHaveBeenCalledWith(
			'Delete settings profile "other"?',
			"This cannot be undone.",
		);
		expect(harness.deleteProfile).toHaveBeenCalledWith("other", { replaceMarker: false });
		expect(harness.notify).toHaveBeenCalledWith('Deleted profile "other".', "info");
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("does not delete a profile when confirmation is cancelled", async () => {
		const harness = createHarness({ profiles: ["default", "focused"], active: "default" });
		harness.select
			.mockResolvedValueOnce("  Delete profile")
			.mockResolvedValueOnce("  focused");
		harness.confirm.mockResolvedValue(false);
		await harness.runProfileCommand("");

		expect(harness.deleteProfile).not.toHaveBeenCalled();
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("reports when there are no deletable profiles", async () => {
		const harness = createHarness({ profiles: ["default"], active: "default" });
		harness.select.mockResolvedValue("  Delete profile");
		await harness.runProfileCommand("");

		expect(harness.notify).toHaveBeenCalledWith(
			"No profiles can be deleted. The default profile is kept as a fallback.",
			"warning",
		);
		expect(harness.confirm).not.toHaveBeenCalled();
		expect(harness.deleteProfile).not.toHaveBeenCalled();
	});

	it("reports profile deletion errors without reloading", async () => {
		const harness = createHarness({ profiles: ["default", "focused"], active: "default", deleteError: new Error("missing default") });
		harness.select
			.mockResolvedValueOnce("  Delete profile")
			.mockResolvedValueOnce("  focused");
		harness.confirm.mockResolvedValue(true);
		await harness.runProfileCommand("");

		expect(harness.notify).toHaveBeenCalledWith(
			"Could not delete settings profile: missing default",
			"error",
		);
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("deletes the session profile by switching to default and reloading", async () => {
		const harness = createHarness({ profiles: ["default", "focused"], active: "focused" });
		harness.select
			.mockResolvedValueOnce("  Delete profile")
			.mockResolvedValueOnce("● focused (current)");
		harness.confirm.mockResolvedValue(true);
		await harness.runProfileCommand("");

		expect(harness.deleteProfile).toHaveBeenCalledWith("focused", { replaceMarker: true });
		expect(harness.appendEntry).toHaveBeenCalledWith("configProfiles", { active: "default" });
		expect(harness.notify).toHaveBeenCalledWith('Deleted profile "focused". Switched to "default". Reloading…', "info");
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("omits default from the delete picker", async () => {
		const harness = createHarness({ profiles: ["default", "focused"], active: "default" });
		harness.select.mockResolvedValueOnce("  Delete profile").mockResolvedValueOnce(undefined);
		await harness.runProfileCommand("");

		expect(harness.select).toHaveBeenNthCalledWith(2, "Delete settings profile", ["  focused"]);
		expect(harness.deleteProfile).not.toHaveBeenCalled();
	});

	it("marks the session's remembered profile in the picker, not the marker", async () => {
		const harness = createHarness({
			active: "github",
			branchEntries: [{ type: "custom", customType: "configProfiles", data: { active: "focused" } }],
		});
		harness.select.mockResolvedValue("● focused (current)");
		await harness.runProfileCommand("");

		expect(harness.select).toHaveBeenCalledWith("Select settings profile", [
			"  default",
			"● focused (current)",
			"  Add profile",
			"  Delete profile",
		]);
		expect(harness.switchProfile).not.toHaveBeenCalled();
		expect(harness.reload).not.toHaveBeenCalled();
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
		await harness.runProfileCommand("", context);
		expect(harness.output).toHaveBeenCalledWith(expect.stringContaining("Usage: /profile <name>"));
		expect(harness.notify).not.toHaveBeenCalled();
		expect(harness.switchProfile).not.toHaveBeenCalled();
	});

	it("stars the session's remembered profile in non-interactive listings", async () => {
		const harness = createHarness({
			active: "github",
			profiles: ["github", "focused"],
			branchEntries: [{ type: "custom", customType: "configProfiles", data: { active: "focused" } }],
		});
		const context = { ...harness.ctx, hasUI: false, mode: "print" };
		await harness.runProfileCommand("", context);

		const message = harness.output.mock.calls[0][0] as string;
		expect(message).toContain("* focused");
		expect(message).toContain("- github");
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
		await harness.runProfileCommand("default");
		expect(harness.notify).toHaveBeenCalledWith('Profile "default" is already active.', "info");
		expect(harness.appendEntry).not.toHaveBeenCalled();
		expect(harness.readProfile).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("keeps the captured session profile when the marker changes after startup", async () => {
		const harness = createHarness({ active: "focused" });
		await harness.emit("session_start", "startup");
		// Another session switches the marker after this session started. The
		// captured binding remains focused for this session.
		writeFileSync(harness.settingsPath, `${JSON.stringify({ configProfiles: { active: "github" } }, null, 2)}\n`);
		harness.notify.mockClear();
		await harness.commands.get("profile").handler("focused", harness.ctx);

		expect(harness.notify).toHaveBeenCalledWith('Profile "focused" is already active.', "info");
		expect(harness.switchProfile).not.toHaveBeenCalled();
	});

	it("treats the session's own profile as already active even when the marker names another", async () => {
		const harness = createHarness({
			active: "github",
			branchEntries: [{ type: "custom", customType: "configProfiles", data: { active: "focused" } }],
		});
		await harness.runProfileCommand("focused");

		expect(harness.notify).toHaveBeenCalledWith('Profile "focused" is already active.', "info");
		expect(harness.switchProfile).not.toHaveBeenCalled();
		expect(harness.appendEntry).not.toHaveBeenCalled();
		expect(harness.readProfile).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("rebinds the session when switching to the marker's profile with a differing entry", async () => {
		const harness = createHarness({
			active: "github",
			branchEntries: [{ type: "custom", customType: "configProfiles", data: { active: "focused" } }],
		});
		await harness.runProfileCommand("github");

		expect(harness.switchProfile).toHaveBeenCalledWith("github");
		expect(harness.appendEntry).toHaveBeenCalledWith("configProfiles", { active: "github" });
		expect(harness.notify).toHaveBeenCalledWith('Switched to profile "github". Reloading…', "info");
		expect(harness.reload).toHaveBeenCalledOnce();
	});

	it("reports failed switches without applying or reloading", async () => {
		const harness = createHarness({ switchError: new Error("broken destination") });
		await harness.runProfileCommand("focused");
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
