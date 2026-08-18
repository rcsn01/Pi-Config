import { watch as watchDirectory, type FSWatcher, type WatchListener } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickGuiOption } from "../_shared/gui-option-list.ts";
import {
	parseProjectModelPreferences,
	resolveModelContext,
	type ModelSelectionMode,
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

function currentModelSelectionMode(ctx: ExtensionContext): ModelSelectionMode {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== "plan-mode-state") continue;
		const data = candidate.data as { active?: unknown; mode?: unknown } | undefined;
		return data?.active === true || data?.mode === "plan" ? "plan" : "normal";
	}
	return "normal";
}

async function activateProfileModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: Record<string, unknown>,
): Promise<void> {
	const preferences = parseProjectModelPreferences(settings);
	if (!preferences.profiles.normal && !preferences.profiles.plan) return;
	const profile = preferences.profiles[currentModelSelectionMode(ctx)];
	if (!profile) return;

	const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [profile.provider] });
	if (refresh.aborted) throw new Error(`Refreshing ${profile.provider} was aborted.`);
	const refreshError = refresh.errors.get(profile.provider);
	if (refreshError) throw refreshError;
	const catalogueModel = ctx.modelRegistry.find(profile.provider, profile.modelId);
	if (!catalogueModel) throw new Error(`Profile model ${profile.provider}/${profile.modelId} is unavailable.`);
	if (
		ctx.scopedModels.length > 0 &&
		!ctx.scopedModels.some((entry) => entry.model.provider === profile.provider && entry.model.id === profile.modelId)
	) {
		throw new Error(`Profile model ${profile.provider}/${profile.modelId} is outside this session's model scope.`);
	}

	const model = {
		...resolveModelContext(catalogueModel),
		contextWindow: profile.contextWindow,
	};
	if (!(await pi.setModel(model))) {
		throw new Error(`No configured authentication for ${profile.provider}/${profile.modelId}.`);
	}
	pi.setThinkingLevel(profile.thinkingLevel);
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

					const result = await store.switchProfile(name);
					if (!result.changed) {
						ctx.ui.notify(`Profile "${name}" is already active; settings synchronized.`, "info");
						return;
					}
					ctx.ui.notify(`Switched to profile "${name}". Reloading…`, "info");
					await ctx.reload();
					// Reload refreshes project settings but preserves the session model.
					try {
						await activateProfileModel(pi, ctx, store.readSettings());
					} catch (error) {
						ctx.ui.notify(`Could not activate the profile model: ${errorMessage(error)}`, "error");
					}
					return;
				} catch (error) {
					ctx.ui.notify(`Could not switch settings profile: ${errorMessage(error)}`, "error");
				}
			},
		});
	};
}

export default createConfigProfilesExtension();
