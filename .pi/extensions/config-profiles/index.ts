import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiNativeDefaults } from "../_shared/pi-defaults.ts";
import { applySelectionFromDocument } from "../_shared/model-selection.ts";
import { CONFIG_PROFILES_ENTRY_TYPE, createSessionProfileResolver, NON_RELOAD_REASON, sessionProfileName } from "../_shared/active-profile.ts";
import { pickGuiOption } from "../_shared/gui-option-list.ts";
import { createProfileStore, type ProfileStore } from "./profile-store.ts";

export interface ConfigProfilesDependencies {
	store?: ProfileStore;
	output?: (message: string) => void;
	nativeDefaults?: PiNativeDefaults;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const ADD_PROFILE_ACTION = "\u0000add-profile";
const DELETE_PROFILE_ACTION = "\u0000delete-profile";
const DEFAULT_PROFILE_NAME = "default";

function profileListMessage(store: ProfileStore, active: string | undefined): string {
	const profiles = store.listProfiles();
	if (profiles.length === 0) return "No settings profiles found. Create one in .pi/profiles/<name>.json.";
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

		const resolver = createSessionProfileResolver({
			settingsPath: store.settingsPath,
			profilesDirectory: store.profilesDirectory,
		});
		let sessionBindingResolved = false;
		let sessionProfile: string | undefined;

		const updateStatus = (ctx: ExtensionContext, profile: string | undefined): void => {
			if (ctx.hasUI) ctx.ui.setStatus("profile", profile);
		};

		const applyProfileModel = async (name: string, ctx: ExtensionContext): Promise<void> => {
			const previousModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			try {
				const document = store.readProfile(name);
				const selection = document
					? await applySelectionFromDocument(
						pi,
						ctx,
						document,
						dependencies.nativeDefaults,
					)
					: undefined;
				if (selection && `${selection.provider}/${selection.modelId}` !== previousModel) {
					ctx.ui.notify(`Profile model: ${selection.provider}/${selection.modelId}`, "info");
				}
			} catch (error) {
				// The profile switch is already committed. Keep the current model when
				// applying the saved selection fails, then let reload rebind the rest.
				ctx.ui.notify(`Could not apply the profile model: ${errorMessage(error)}`, "error");
			}
		};

		const applyAndReload = async (name: string, ctx: ExtensionCommandContext, message: string): Promise<void> => {
			await applyProfileModel(name, ctx);
			ctx.ui.notify(message, "info");
			await ctx.reload();
		};

		const activateAndReload = async (name: string, ctx: ExtensionCommandContext, message: string): Promise<void> => {
			// Remember the session's profile before reloading so sibling extensions
			// re-read the profile file with this name at the new session boundary.
			pi.appendEntry(CONFIG_PROFILES_ENTRY_TYPE, { active: name });
			sessionProfile = name;
			sessionBindingResolved = true;
			await applyAndReload(name, ctx, message);
		};

		const addProfile = async (source: string | undefined, ctx: ExtensionCommandContext): Promise<void> => {
			const enteredName = await ctx.ui.input("New settings profile name", "profile-name");
			const name = enteredName?.trim() ?? "";
			if (!name) return;

			try {
				await store.createProfile(name, source);
				await activateAndReload(name, ctx, `Added profile "${name}". Reloading…`);
			} catch (error) {
				ctx.ui.notify(`Could not add settings profile: ${errorMessage(error)}`, "error");
			}
		};

		const deleteProfile = async (sessionCurrent: string | undefined, ctx: ExtensionCommandContext): Promise<void> => {
			try {
				const deletableProfiles = store.listProfiles().filter((name) => name !== DEFAULT_PROFILE_NAME);
				if (deletableProfiles.length === 0) {
					ctx.ui.notify("No profiles can be deleted. The default profile is kept as a fallback.", "warning");
					return;
				}

				const name = await pickGuiOption(ctx, {
					title: "Delete settings profile",
					message: "The default profile is kept as the fallback.",
					options: deletableProfiles.map((profile) => ({
						label: profile,
						value: profile,
						checked: profile === sessionCurrent,
					})),
				});
				if (!name) return;

				const confirmed = await ctx.ui.confirm(
					`Delete settings profile "${name}"?`,
					"This cannot be undone.",
				);
				if (!confirmed) return;

				const sessionOwnsProfile = sessionCurrent === name;
				if (sessionOwnsProfile) {
					// Validate the target and fallback before changing the session entry.
					// If appending the replacement entry fails, the deleted profile is
					// still present and this session remains safely bound to it.
					store.readProfile(name);
					store.readProfile(DEFAULT_PROFILE_NAME);
					pi.appendEntry(CONFIG_PROFILES_ENTRY_TYPE, { active: DEFAULT_PROFILE_NAME });
					sessionProfile = DEFAULT_PROFILE_NAME;
					sessionBindingResolved = true;
				}

				await store.deleteProfile(name, { replaceMarker: sessionOwnsProfile });
				if (sessionOwnsProfile) {
					await applyAndReload(
						DEFAULT_PROFILE_NAME,
						ctx,
						`Deleted profile "${name}". Switched to "${DEFAULT_PROFILE_NAME}". Reloading…`,
					);
				} else {
					ctx.ui.notify(`Deleted profile "${name}".`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Could not delete settings profile: ${errorMessage(error)}`, "error");
			}
		};

		pi.on("session_start", async (event, ctx) => {
			const rememberedProfile = sessionProfileName(ctx.sessionManager.getBranch());
			// The session's own remembered profile wins on every boundary: on
			// reload it persists, and on startup/resume/fork it survives another
			// session's marker switch. An existing entry is never re-appended.
			if (event.reason === "reload" || rememberedProfile !== undefined) {
				sessionProfile = rememberedProfile;
				sessionBindingResolved = true;
				updateStatus(ctx, rememberedProfile);
				return;
			}
			// No remembered choice: the settings.json marker is the default for
			// fresh sessions, committed as this session's entry so reloads keep it.
			try {
				const active = store.loadActiveProfile();
				sessionProfile = active?.name;
				sessionBindingResolved = true;
				updateStatus(ctx, active?.name);
				if (active) pi.appendEntry(CONFIG_PROFILES_ENTRY_TYPE, { active: active.name });
			} catch (error) {
				sessionProfile = undefined;
				sessionBindingResolved = true;
				updateStatus(ctx, undefined);
				ctx.ui.notify(`Could not load the active settings profile: ${errorMessage(error)}`, "error");
			}
		});

		pi.on("session_tree", async (_event, ctx) => {
			sessionProfile = sessionProfileName(ctx.sessionManager.getBranch());
			sessionBindingResolved = true;
			updateStatus(ctx, sessionProfile);
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			sessionProfile = undefined;
			sessionBindingResolved = false;
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
				// Use the binding captured at session_start rather than a marker another
				// session may have changed. The resolver is only a fallback before the
				// session lifecycle has established a binding.
				const sessionCurrent = sessionBindingResolved
					? sessionProfile
					: resolver.resolveName(ctx.sessionManager.getBranch(), NON_RELOAD_REASON);
				try {
					if (!name) {
						if (!ctx.hasUI) {
							output(profileListMessage(store, sessionCurrent));
							return;
						}

						const profiles = store.listProfiles();
						const selected = await pickGuiOption(ctx, {
							title: "Select settings profile",
							message: "Profiles replace the complete .pi/settings.json document.",
							options: [
								...profiles.map((profile) => ({
									label: profile,
									value: profile,
									checked: profile === sessionCurrent,
								})),
								{ label: "Add profile", value: ADD_PROFILE_ACTION, spacerBefore: profiles.length > 0 },
								{ label: "Delete profile", value: DELETE_PROFILE_ACTION },
							],
						});
						if (!selected) return;
						if (selected === ADD_PROFILE_ACTION) {
							await addProfile(sessionCurrent, ctx);
							return;
						}
						if (selected === DELETE_PROFILE_ACTION) {
							await deleteProfile(sessionCurrent, ctx);
							return;
						}
						name = selected;
					}

					if (name === sessionCurrent) {
						ctx.ui.notify(`Profile "${name}" is already active.`, "info");
						return;
					}

					// The marker write may be a no-op while this session still needs
					// rebinding (its entry differs), so the switch proceeds regardless.
					await store.switchProfile(name);
					await activateAndReload(name, ctx, `Switched to profile "${name}". Reloading…`);
					return;
				} catch (error) {
					ctx.ui.notify(`Could not switch settings profile: ${errorMessage(error)}`, "error");
				}
			},
		});
	};
}

export default createConfigProfilesExtension();
