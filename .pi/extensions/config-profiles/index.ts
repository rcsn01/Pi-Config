import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyProfileModelSelection,
	createProjectSettingsStore,
} from "../ui-model-selector/apply-profile.ts";
import { CONFIG_PROFILES_ENTRY_TYPE, sessionProfileName } from "../_shared/active-profile.ts";
import { pickGuiOption } from "../_shared/gui-option-list.ts";
import { createProfileStore, type ProfileStore } from "./profile-store.ts";

export interface ConfigProfilesDependencies {
	store?: ProfileStore;
	output?: (message: string) => void;
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
		const output = dependencies.output ?? console.log;

		const updateStatus = (ctx: ExtensionContext, profile: string | undefined): void => {
			if (ctx.hasUI) ctx.ui.setStatus("profile", profile);
		};

		pi.on("session_start", async (event, ctx) => {
			// On reload the session keeps its profile: the remembered session entry
			// persists and the sibling extensions re-read the profile file with it.
			if (event.reason === "reload") {
				updateStatus(ctx, sessionProfileName(ctx.sessionManager.getBranch()));
				return;
			}
			try {
				const active = store.loadActiveProfile();
				updateStatus(ctx, active?.name);
				if (active) pi.appendEntry(CONFIG_PROFILES_ENTRY_TYPE, { active: active.name });
			} catch (error) {
				updateStatus(ctx, undefined);
				ctx.ui.notify(`Could not load the active settings profile: ${errorMessage(error)}`, "error");
			}
		});

		pi.on("session_tree", async (_event, ctx) => {
			updateStatus(ctx, sessionProfileName(ctx.sessionManager.getBranch()));
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			updateStatus(ctx, undefined);
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
						ctx.ui.notify(`Profile "${name}" is already active.`, "info");
						return;
					}
					// Remember the session's profile before reloading so the sibling
					// extensions re-read the profile file with this name on reload.
					pi.appendEntry(CONFIG_PROFILES_ENTRY_TYPE, { active: name });
					// Apply the switched profile's saved model selection for the current
					// mode (normal or plan) before reloading, so the session model follows
					// the profile instead of staying behind until a manual /model. The
					// switch itself never rolls back; on failure the current model is
					// kept and the settings reload still proceeds. The settings store is
					// pointed at the profile for uiModelSelector and at settings.json for
					// the model-derived compaction values.
					const previousModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
					try {
						const document = store.readProfile(name);
						const selection = document
							? await applyProfileModelSelection(
								pi,
								ctx,
								document,
								createProjectSettingsStore(store.profilePath(name), store.settingsPath),
							)
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
