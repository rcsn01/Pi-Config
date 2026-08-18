import { watch as watchDirectory, type FSWatcher, type WatchListener } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyProfileModelSelection,
	createProjectSettingsStore,
	type ProjectSettingsStore,
} from "../ui-model-selector/apply-profile.ts";
import { pickGuiOption } from "../_shared/gui-option-list.ts";
import { createProfileStore, type ProfileStore } from "./profile-store.ts";

export interface ConfigProfilesDependencies {
	store?: ProfileStore;
	watch?: (path: string, listener: WatchListener<string>) => FSWatcher;
	output?: (message: string) => void;
	debounceMs?: number;
	retryMs?: number;
	settingsStore?: ProjectSettingsStore;
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

export function createConfigProfilesExtension(dependencies: ConfigProfilesDependencies = {}) {
	return function configProfilesExtension(pi: ExtensionAPI): void {
		const store = dependencies.store ?? createProfileStore();
		const settingsStore = dependencies.settingsStore ?? createProjectSettingsStore();
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
					// Apply the switched profile's saved model selection for the current
					// mode (normal or plan) before reloading, so the session model follows
					// the profile instead of staying behind until a manual /model. The
					// switch itself never rolls back; on failure the current model is
					// kept and the settings reload still proceeds.
					const previousModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
					try {
						const document = store.readProfile(name);
						const selection = document
							? await applyProfileModelSelection(pi, ctx, document, settingsStore)
							: undefined;
						if (selection && `${selection.provider}/${selection.modelId}` !== previousModel) {
							ctx.ui.notify(`Profile model: ${selection.provider}/${selection.modelId}`, "info");
						}
					} catch (error) {
						ctx.ui.notify(`Could not apply the profile model: ${errorMessage(error)}`, "error");
					}
					ctx.ui.notify(`Switched to profile "${name}". Reloading…`, "info");
					await ctx.reload();
					return;
				} catch (error) {
					ctx.ui.notify(`Could not switch settings profile: ${errorMessage(error)}`, "error");
				}
			},
		});
	};
}

export default createConfigProfilesExtension();
