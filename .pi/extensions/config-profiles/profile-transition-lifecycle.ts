import type { ModelSelectionSettings } from "../_shared/model-selection.ts";
const DEFAULT_PROFILE_NAME = "default";

export type ProfileTransitionRequest =
	| { kind: "switch"; name: string }
	| { kind: "create-and-activate"; name: string; source?: string }
	| { kind: "delete-active"; name: string };

export type ProfileModelApplication =
	| { kind: "applied"; selection: ModelSelectionSettings }
	| { kind: "unchanged" }
	| { kind: "failed"; cause: unknown };

export interface ProfileTransitionOutcome {
	kind: "completed";
	request: ProfileTransitionRequest;
	activeProfile: string;
	modelApplication: ProfileModelApplication;
}

export type ProfileTransitionNotice =
	| { kind: "profile-model-applied"; selection: ModelSelectionSettings }
	| { kind: "profile-model-apply-failed"; cause: unknown }
	| { kind: "profile-switched"; name: string }
	| { kind: "profile-added"; name: string }
	| { kind: "active-profile-deleted"; name: string; replacement: string };

export interface ProfileTransitionLifecycleAdapter {
	switchProfile(name: string): Promise<void>;
	createProfile(name: string, source?: string): Promise<void>;
	deleteProfile(name: string, options: { replaceMarker: true }): Promise<void>;
	readProfile(name: string): Record<string, unknown>;
	publishSessionProfile(name: string): void;
	getCurrentModelKey(): string | undefined;
	applyProfileSelection(document: Record<string, unknown>): Promise<ModelSelectionSettings | undefined>;
	reportNotice(notice: ProfileTransitionNotice): void;
	reload(): Promise<void>;
}

export interface ProfileTransitionLifecycle {
	transition(request: ProfileTransitionRequest): Promise<ProfileTransitionOutcome>;
}

export function switchProfile(name: string): ProfileTransitionRequest {
	return { kind: "switch", name };
}

export function createAndActivateProfile(name: string, source?: string): ProfileTransitionRequest {
	return { kind: "create-and-activate", name, source };
}

export function deleteActiveProfile(name: string): ProfileTransitionRequest {
	return { kind: "delete-active", name };
}

export function createProfileTransitionLifecycle(
	adapter: ProfileTransitionLifecycleAdapter,
): ProfileTransitionLifecycle {
	async function commitTransition(request: ProfileTransitionRequest): Promise<string> {
		if (request.kind === "switch") {
			await adapter.switchProfile(request.name);
			adapter.publishSessionProfile(request.name);
			return request.name;
		}
		if (request.kind === "create-and-activate") {
			await adapter.createProfile(request.name, request.source);
			adapter.publishSessionProfile(request.name);
			return request.name;
		}

		adapter.readProfile(request.name);
		adapter.readProfile(DEFAULT_PROFILE_NAME);
		adapter.publishSessionProfile(DEFAULT_PROFILE_NAME);
		await adapter.deleteProfile(request.name, { replaceMarker: true });
		return DEFAULT_PROFILE_NAME;
	}

	async function applyProfileModel(profile: string): Promise<ProfileModelApplication> {
		const previousModel = adapter.getCurrentModelKey();
		try {
			const selection = await adapter.applyProfileSelection(adapter.readProfile(profile));
			if (!selection) return { kind: "unchanged" };
			if (`${selection.provider}/${selection.modelId}` !== previousModel) {
				adapter.reportNotice({ kind: "profile-model-applied", selection });
			}
			return { kind: "applied", selection };
		} catch (cause) {
			adapter.reportNotice({ kind: "profile-model-apply-failed", cause });
			return { kind: "failed", cause };
		}
	}

	function reportCompletion(request: ProfileTransitionRequest, activeProfile: string): void {
		if (request.kind === "switch") {
			adapter.reportNotice({ kind: "profile-switched", name: request.name });
		} else if (request.kind === "create-and-activate") {
			adapter.reportNotice({ kind: "profile-added", name: request.name });
		} else {
			adapter.reportNotice({
				kind: "active-profile-deleted",
				name: request.name,
				replacement: activeProfile,
			});
		}
	}

	return {
		async transition(request) {
			const activeProfile = await commitTransition(request);
			const modelApplication = await applyProfileModel(activeProfile);
			reportCompletion(request, activeProfile);
			await adapter.reload();
			return { kind: "completed", request, activeProfile, modelApplication };
		},
	};
}
