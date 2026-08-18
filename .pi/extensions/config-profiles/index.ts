import { watch as watchDirectory, type FSWatcher, type WatchListener } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickGuiOption } from "../_shared/gui-option-list.ts";
import {
	parseProjectModelPreferences,
	resolveContextWindow,
	type ModelSelectionMode,
	type ModelSelectionSettings,
} from "../ui-model-selector/model-config.ts";
import { createProfileStore, type ProfileStore } from "./profile-store.ts";

export interface ConfigProfilesDependencies {
	store?: ProfileStore;
	watch?: (path: string, listener: WatchListener<string>) => FSWatcher;
	output?: (message: string) => void;
	debounceMs?: number;
	retryMs?: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function profileListMessage(store: ProfileStore): string {
	const profiles = store.listProfiles();
	if (profiles.length === 0) return "No settings profiles found. Create one in .pi/profiles/<name>.json.";
	let active: string | undefined;
	try {
		active = store.getActiveProfile();
	} catch {
		// Listing is still useful when settings.json is temporarily invalid.
	}
	return [
		"Settings profiles:",
		...profiles.map((name) => `  ${name === active ? "*" : "-"} ${name}`),
		"Usage: /profile <name>",
	].join("\n");
}

function currentSelectionMode(ctx: ExtensionContext): ModelSelectionMode {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry?.type !== "custom" || entry.customType !== "plan-mode-state") continue;
		const data = entry.data as { active?: unknown } | undefined;
		return data?.active === true ? "plan" : "normal";
	}
	return "normal";
}

async function resolveProfileModel(
	ctx: ExtensionContext,
	settings: Record<string, unknown>,
): Promise<{ model: NonNullable<ExtensionContext["model"]>; profile: ModelSelectionSettings } | undefined> {
	const profiles = parseProjectModelPreferences(settings).profiles;
	const mode = currentSelectionMode(ctx);
	const profile = profiles[mode] ?? (mode === "plan" ? profiles.normal : undefined);
	if (!profile) return undefined;

	let model = ctx.model?.provider === profile.provider && ctx.model.id === profile.modelId
		? ctx.model
		: undefined;
	if (!model) {
		const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [profile.provider] });
		if (refresh.aborted) throw new Error(`Refreshing ${profile.provider} was aborted.`);
		const refreshError = refresh.errors.get(profile.provider);
		if (refreshError) throw refreshError;
		model = ctx.modelRegistry.find(profile.provider, profile.modelId);
	}
	if (!model) throw new Error(`Profile model ${profile.provider}/${profile.modelId} is unavailable.`);
	if (
		ctx.scopedModels.length > 0 &&
		!ctx.scopedModels.some((entry) =>
			entry.model.provider === profile.provider && entry.model.id === profile.modelId
		)
	) {
		throw new Error(`Profile model ${profile.provider}/${profile.modelId} is outside this session's model scope.`);
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`No configured authentication for ${profile.provider}/${profile.modelId}.`);
	}

	return {
		model: { ...model, contextWindow: resolveContextWindow(profile.contextWindow) },
		profile,
	};
}

export function createConfigProfilesExtension(dependencies: ConfigProfilesDependencies = {}) {
	return function configProfilesExtension(pi: ExtensionAPI): void {
		const store = dependencies.store ?? createProfileStore();
		const watch = dependencies.watch ?? ((path, listener) => watchDirectory(path, listener));
		const output = dependencies.output ?? console.log;
		const debounceMs = dependencies.debounceMs ?? 75;
		const retryMs = dependencies.retryMs ?? 150;
		let watcher: FSWatcher | undefined;
		let debounceTimer: NodeJS.Timeout | undefined;
		let retryTimer: NodeJS.Timeout | undefined;

		const clearTimers = () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			if (retryTimer) clearTimeout(retryTimer);
			debounceTimer = undefined;
			retryTimer = undefined;
		};

		const report = (ctx: ExtensionContext, error: unknown) => {
			ctx.ui.notify(`Could not synchronize the active settings profile: ${errorMessage(error)}`, "error");
		};

		const synchronizeWithRetry = async (ctx: ExtensionContext): Promise<void> => {
			try {
				await store.synchronizeActiveProfile();
				if (retryTimer) clearTimeout(retryTimer);
				retryTimer = undefined;
			} catch {
				if (retryTimer) clearTimeout(retryTimer);
				retryTimer = setTimeout(() => {
					retryTimer = undefined;
					void store.synchronizeActiveProfile().catch((error) => report(ctx, error));
				}, retryMs);
			}
		};

		const scheduleSynchronization = (ctx: ExtensionContext) => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				debounceTimer = undefined;
				void synchronizeWithRetry(ctx);
			}, debounceMs);
		};

		pi.on("session_start", async (_event, ctx) => {
			clearTimers();
			watcher?.close();
			try {
				watcher = watch(dirname(store.settingsPath), (_eventType, filename) => {
					if (filename === null || filename.toString() === basename(store.settingsPath)) {
						scheduleSynchronization(ctx);
					}
				});
				watcher.on("error", (error) => report(ctx, error));
			} catch (error) {
				watcher = undefined;
				ctx.ui.notify(`Could not watch .pi/settings.json: ${errorMessage(error)}`, "error");
			}
			await synchronizeWithRetry(ctx);
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			clearTimers();
			watcher?.close();
			watcher = undefined;
			try {
				await store.synchronizeActiveProfile();
			} catch (error) {
				report(ctx, error);
			}
		});

		pi.registerCommand("profile", {
			description: "Switch the complete project settings profile",
			getArgumentCompletions: (prefix: string) => {
				try {
					const items = store.listProfiles()
						.filter((name) => name.startsWith(prefix))
						.map((name) => ({ value: name, label: name }));
					return items.length > 0 ? items : null;
				} catch {
					return null;
				}
			},
			handler: async (args, ctx) => {
				let name = args.trim();
				let profileChanged = false;
				try {
					if (!name) {
						if (!ctx.hasUI) {
							output(profileListMessage(store));
							return;
						}
						const profiles = store.listProfiles();
						if (profiles.length === 0) {
							ctx.ui.notify("No settings profiles found in .pi/profiles.", "warning");
							return;
						}
						let active: string | undefined;
						try {
							active = store.getActiveProfile();
						} catch {
							// The switch operation will provide the detailed validation error.
						}
						name = await pickGuiOption(ctx, {
							title: "Select settings profile",
							message: "Profiles replace the complete .pi/settings.json document.",
							options: profiles.map((profile) => ({
								label: profile,
								value: profile,
								checked: profile === active,
							})),
						}) ?? "";
						if (!name) return;
					}

					// Resolve the target before replacing settings.json so an invalid or
					// unavailable configured model cannot leave a half-applied switch.
					const target = await resolveProfileModel(ctx, store.readProfile(name));
					const result = await store.switchProfile(name);
					profileChanged = result.changed;
					if (target) {
						if (!(await pi.setModel(target.model))) {
							throw new Error(`No configured authentication for ${target.profile.provider}/${target.profile.modelId}.`);
						}
						pi.setThinkingLevel(target.profile.thinkingLevel);
					}
					if (!result.changed) {
						ctx.ui.notify(`Profile "${name}" is already active; settings and model synchronized.`, "info");
						return;
					}
					ctx.ui.notify(`Switched to profile "${name}". Reloading…`, "info");
					await ctx.reload();
					return;
				} catch (error) {
					ctx.ui.notify(
						profileChanged
							? `Profile settings changed, but the configured model could not be applied: ${errorMessage(error)}`
							: `Could not switch settings profile: ${errorMessage(error)}`,
						"error",
					);
					if (profileChanged) await ctx.reload();
				}
			},
		});
	};
}

export default createConfigProfilesExtension();
