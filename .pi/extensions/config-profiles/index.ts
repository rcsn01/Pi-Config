import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { PiNativeDefaults } from "../_shared/pi-defaults.ts";
import { applySelectionFromDocument } from "../_shared/model-selection.ts";
import {
	CONFIG_PROFILES_ENTRY_TYPE,
	sessionProfileName,
} from "../_shared/profile-document.ts";
import { pickGuiOption } from "../_shared/gui-option-list.ts";
import { registerSessionProfileBinding, wireSessionProfileBinding } from "../_shared/session-profile-binding.ts";
import { PROJECT_SETTINGS_PATH } from "../_shared/settings-document.ts";
import { createProfileStore, type ProfileStore } from "./profile-store.ts";
import {
	createAndActivateProfile,
	createProfileTransitionLifecycle,
	deleteActiveProfile,
	switchProfile,
	type ProfileTransitionLifecycleAdapter,
	type ProfileTransitionNotice,
	type ProfileTransitionRequest,
} from "./profile-transition-lifecycle.ts";

export interface ConfigProfilesDependencies {
	settingsPath?: string;
	store?: ProfileStore;
	output?: (message: string) => void;
	nativeDefaults?: PiNativeDefaults;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function renderProfileTransitionNotice(
	ctx: ExtensionCommandContext,
	notice: ProfileTransitionNotice,
): void {
	switch (notice.kind) {
		case "profile-model-applied":
			ctx.ui.notify(`Profile model: ${notice.selection.provider}/${notice.selection.modelId}`, "info");
			return;
		case "profile-model-apply-failed":
			ctx.ui.notify(`Could not apply the profile model: ${errorMessage(notice.cause)}`, "error");
			return;
		case "profile-switched":
			ctx.ui.notify(`Switched to profile "${notice.name}". Reloading…`, "info");
			return;
		case "profile-added":
			ctx.ui.notify(`Added profile "${notice.name}". Reloading…`, "info");
			return;
		case "active-profile-deleted":
			ctx.ui.notify(
				`Deleted profile "${notice.name}". Switched to "${notice.replacement}". Reloading…`,
				"info",
			);
	}
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
		const requestedSettingsPath = dependencies.settingsPath;
		const store = dependencies.store ?? createProfileStore({
			settingsPath: requestedSettingsPath ?? PROJECT_SETTINGS_PATH,
		});
		if (requestedSettingsPath !== undefined && resolve(requestedSettingsPath) !== resolve(store.settingsPath)) {
			throw new Error(
				`Config profiles settingsPath ${requestedSettingsPath} does not match the injected ProfileStore path ${store.settingsPath}.`,
			);
		}
		const output = dependencies.output ?? console.log;

		let sessionProfile: string | undefined;
		let profileInitializationStarted = false;
		let profileInitializationDisposed = false;

		const updateStatus = (ctx: ExtensionContext, profile: string | undefined): void => {
			if (ctx.hasUI) ctx.ui.setStatus("profile", profile);
		};

		const profileInitialization = registerSessionProfileBinding(
			{
				settingsPath: store.settingsPath,
				profilesDirectory: store.profilesDirectory,
			},
			{
				name: "config-profiles",
				validateMarkerProfile: (profileName) => {
					store.readProfile(profileName);
				},
				appendProfileEntry: (profileName) => {
					pi.appendEntry(CONFIG_PROFILES_ENTRY_TYPE, { active: profileName });
				},
				onMarkerFailure: (error, ctx) => {
					sessionProfile = undefined;
					updateStatus(ctx, undefined);
					ctx.ui.notify(`Could not load the active settings profile: ${errorMessage(error)}`, "error");
				},
				initialize(binding, _event, ctx) {
					profileInitializationStarted = true;
					profileInitializationDisposed = false;
					sessionProfile = binding.profileName;
					updateStatus(ctx, binding.profileName);
				},
				dispose: (_binding, ctx) => {
					sessionProfile = undefined;
					profileInitializationStarted = false;
					profileInitializationDisposed = true;
					updateStatus(ctx, undefined);
				},
			},
		);

		const runProfileTransition = (
			request: ProfileTransitionRequest,
			ctx: ExtensionCommandContext,
		) => {
			const adapter: ProfileTransitionLifecycleAdapter = {
				switchProfile: async (name) => {
					await store.switchProfile(name);
				},
				createProfile: async (name, source) => {
					await store.createProfile(name, source);
				},
				deleteProfile: async (name, options) => {
					await store.deleteProfile(name, options);
				},
				readProfile: (name) => store.readProfile(name),
				publishSessionProfile: (name) => {
					// Remember the session's Profile before reload so sibling extensions
					// re-read the same Profile at the next session boundary.
					pi.appendEntry(CONFIG_PROFILES_ENTRY_TYPE, { active: name });
					sessionProfile = name;
				},
				getCurrentModelKey: () => ctx.model
					? `${ctx.model.provider}/${ctx.model.id}`
					: undefined,
				applyProfileSelection: (document) => applySelectionFromDocument(
					pi,
					ctx,
					document,
					dependencies.nativeDefaults,
				),
				reportNotice: (notice) => renderProfileTransitionNotice(ctx, notice),
				reload: () => ctx.reload(),
			};
			return createProfileTransitionLifecycle(adapter).transition(request);
		};

		const addProfile = async (source: string | undefined, ctx: ExtensionCommandContext): Promise<void> => {
			const enteredName = await ctx.ui.input("New settings profile name", "profile-name");
			const name = enteredName?.trim() ?? "";
			if (!name) return;

			try {
				await runProfileTransition(createAndActivateProfile(name, source), ctx);
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
					await runProfileTransition(deleteActiveProfile(name), ctx);
				} else {
					await store.deleteProfile(name, { replaceMarker: false });
					ctx.ui.notify(`Deleted profile "${name}".`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Could not delete settings profile: ${errorMessage(error)}`, "error");
			}
		};

		wireSessionProfileBinding(pi, profileInitialization, {
			afterStop: (ctx) => {
				if (!profileInitializationStarted && !profileInitializationDisposed) {
					sessionProfile = undefined;
					updateStatus(ctx, undefined);
				}
			},
		});

		pi.on("session_tree", async (_event, ctx) => {
			sessionProfile = sessionProfileName(ctx.sessionManager.getBranch());
			updateStatus(ctx, sessionProfile);
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
				// session may have changed.
				const sessionCurrent = sessionProfile;
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
					await runProfileTransition(switchProfile(name), ctx);
					return;
				} catch (error) {
					ctx.ui.notify(`Could not switch settings profile: ${errorMessage(error)}`, "error");
				}
			},
		});
	};
}

export default createConfigProfilesExtension();
