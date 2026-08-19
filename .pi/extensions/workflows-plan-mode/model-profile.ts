import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	isRecord,
	mutateSettingsDocument,
	PROJECT_SETTINGS_PATH,
	readSettingsDocument,
} from "../_shared/settings-document.ts";
import {
	DEFAULT_SENTINEL,
	readPiNativeDefaults,
	type PiNativeDefaults,
} from "../_shared/pi-defaults.ts";
import { mergeProjectModelSelection, parseProjectModelPreferences } from "../ui-model-selector/model-config.ts";

export interface ModeModelProfile {
	provider: string;
	modelId: string;
	thinkingLevel: ModelThinkingLevel;
	/** Optional only while reading legacy v1/session state; all newly captured profiles include it. */
	contextWindow?: number;
}

export interface StoredModeModelProfile {
	provider: string;
	modelId: string;
	thinkingLevel: ModelThinkingLevel | typeof DEFAULT_SENTINEL;
	/** `default` resolves to the selected model's catalogue context window. */
	contextWindow?: number | typeof DEFAULT_SENTINEL;
}

export interface PlanModeProfileStore {
	load(): Promise<StoredModeModelProfile | undefined>;
	save(profile: ModeModelProfile): Promise<void>;
	/** Repoint the store at the session's profile file (default: settings.json). */
	setPath(path: string): void;
}

export interface NormalDefaultsStore {
	capture(cwd: string, fallback: ModeModelProfile): Promise<ModeModelProfile>;
	restore(cwd: string, profile: ModeModelProfile): Promise<void>;
}

export function profileLabel(
	profile: Pick<ModeModelProfile, "provider" | "modelId" | "thinkingLevel" | "contextWindow">,
): string {
	const context = profile.contextWindow === undefined
		? "legacy context"
		: `${profile.contextWindow.toLocaleString()} ctx`;
	return `${profile.provider}/${profile.modelId} · ${profile.thinkingLevel} · ${context}`;
}

export function profileFromCurrentSession(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): ModeModelProfile | undefined {
	if (!ctx.model) return undefined;
	return {
		provider: ctx.model.provider,
		modelId: ctx.model.id,
		thinkingLevel: pi.getThinkingLevel() as ModelThinkingLevel,
		contextWindow: ctx.model.contextWindow,
	};
}

export async function resolveProfileModel(
	ctx: ExtensionContext,
	profile: ModeModelProfile,
): Promise<Model<any>> {
	const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [profile.provider] });
	if (refresh.aborted) throw new Error(`Refreshing ${profile.provider} was aborted.`);
	const refreshError = refresh.errors.get(profile.provider);
	if (refreshError) throw refreshError;
	const model = ctx.modelRegistry.find(profile.provider, profile.modelId);
	if (!model) throw new Error(`Plan Mode model ${profile.provider}/${profile.modelId} is unavailable.`);
	if (
		ctx.scopedModels.length > 0 &&
		!ctx.scopedModels.some((entry) =>
			entry.model.provider === profile.provider && entry.model.id === profile.modelId
		)
	) {
		throw new Error(`Plan Mode model ${profile.provider}/${profile.modelId} is outside this session's model scope.`);
	}
	return model;
}

function resolveStoredModeProfile(
	pi: ExtensionAPI,
	profile: StoredModeModelProfile,
	nativeDefaults?: PiNativeDefaults,
): { profile: ModeModelProfile; useCatalogueContext: boolean } {
	const needsNativeDefaults = profile.provider === DEFAULT_SENTINEL ||
		profile.modelId === DEFAULT_SENTINEL ||
		profile.thinkingLevel === DEFAULT_SENTINEL;
	const defaults = needsNativeDefaults ? (nativeDefaults ?? readPiNativeDefaults()) : undefined;
	const thinkingLevel = profile.thinkingLevel === DEFAULT_SENTINEL
		? defaults?.thinkingLevel ?? pi.getThinkingLevel()
		: profile.thinkingLevel;
	if (typeof thinkingLevel !== "string" || !THINKING_LEVELS.has(thinkingLevel as ModelThinkingLevel)) {
		throw new Error(`Pi's native defaultThinkingLevel is not supported: ${String(thinkingLevel)}.`);
	}
	return {
		profile: {
			provider: profile.provider === DEFAULT_SENTINEL ? defaults!.provider : profile.provider,
			modelId: profile.modelId === DEFAULT_SENTINEL ? defaults!.modelId : profile.modelId,
			thinkingLevel: thinkingLevel as ModelThinkingLevel,
			contextWindow: profile.contextWindow === DEFAULT_SENTINEL ? undefined : profile.contextWindow,
		},
		useCatalogueContext: profile.contextWindow === DEFAULT_SENTINEL,
	};
}

export function usesDefaultModeProfile(profile: StoredModeModelProfile): boolean {
	return profile.provider === DEFAULT_SENTINEL ||
		profile.modelId === DEFAULT_SENTINEL ||
		profile.thinkingLevel === DEFAULT_SENTINEL ||
		profile.contextWindow === DEFAULT_SENTINEL;
}

export async function applySessionProfile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	storedProfile: StoredModeModelProfile,
	nativeDefaults?: PiNativeDefaults,
): Promise<ModeModelProfile> {
	const { profile, useCatalogueContext } = resolveStoredModeProfile(pi, storedProfile, nativeDefaults);
	const currentModel = ctx.model;
	const sameModel = currentModel?.provider === profile.provider && currentModel.id === profile.modelId;
	let model: Model<any>;
	let shouldSetModel = false;

	if (sameModel && !useCatalogueContext) {
		model = profile.contextWindow === undefined || profile.contextWindow === currentModel.contextWindow
			? currentModel
			: { ...currentModel, contextWindow: profile.contextWindow };
		shouldSetModel = model.contextWindow !== currentModel.contextWindow;
	} else {
		const catalogueModel = await resolveProfileModel(ctx, profile);
		model = profile.contextWindow === undefined
			? catalogueModel
			: { ...catalogueModel, contextWindow: profile.contextWindow };
		shouldSetModel = !sameModel || model.contextWindow !== currentModel?.contextWindow;
	}

	if (shouldSetModel) {
		const changed = await pi.setModel(model);
		if (!changed) throw new Error(`No configured authentication for ${profile.provider}/${profile.modelId}.`);
	}
	if (pi.getThinkingLevel() !== profile.thinkingLevel) pi.setThinkingLevel(profile.thinkingLevel);
	return {
		...profile,
		thinkingLevel: pi.getThinkingLevel() as ModelThinkingLevel,
		contextWindow: model.contextWindow,
	};
}

export async function preserveNormalGlobalDefaults(
	ctx: ExtensionContext,
	defaults: ModeModelProfile | undefined,
	waitForNativePersistence: () => Promise<void>,
	normalDefaultsStore: NormalDefaultsStore,
): Promise<void> {
	if (!defaults) return;
	await waitForNativePersistence();
	await normalDefaultsStore.restore(ctx.cwd, defaults);
}

const THINKING_LEVELS = new Set<ModelThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export function validateStoredModeModelProfile(value: unknown, label = "Plan Mode profile"): StoredModeModelProfile {
	if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
	if (typeof value.provider !== "string" || !value.provider.trim()) {
		throw new Error(`${label} provider must be a non-empty string.`);
	}
	if (typeof value.modelId !== "string" || !value.modelId.trim()) {
		throw new Error(`${label} modelId must be a non-empty string.`);
	}
	if (
		typeof value.thinkingLevel !== "string" ||
		(value.thinkingLevel !== DEFAULT_SENTINEL && !THINKING_LEVELS.has(value.thinkingLevel as ModelThinkingLevel))
	) {
		throw new Error(`${label} thinkingLevel is not supported.`);
	}
	if (
		value.contextWindow !== undefined &&
		value.contextWindow !== DEFAULT_SENTINEL &&
		(!Number.isInteger(value.contextWindow) || (value.contextWindow as number) <= 0)
	) {
		throw new Error(`${label} contextWindow must be a positive integer.`);
	}
	return {
		provider: value.provider,
		modelId: value.modelId,
		thinkingLevel: value.thinkingLevel as ModelThinkingLevel | typeof DEFAULT_SENTINEL,
		contextWindow: value.contextWindow as number | typeof DEFAULT_SENTINEL | undefined,
	};
}

export function validateModeModelProfile(value: unknown, label = "Plan Mode profile"): ModeModelProfile {
	const stored = validateStoredModeModelProfile(value, label);
	if (
		stored.provider === DEFAULT_SENTINEL ||
		stored.modelId === DEFAULT_SENTINEL ||
		stored.thinkingLevel === DEFAULT_SENTINEL ||
		stored.contextWindow === DEFAULT_SENTINEL
	) {
		throw new Error(`${label} must contain concrete model settings.`);
	}
	return {
		provider: stored.provider,
		modelId: stored.modelId,
		thinkingLevel: stored.thinkingLevel,
		contextWindow: stored.contextWindow,
	};
}

export function createPlanModeProfileStore(path = PROJECT_SETTINGS_PATH): PlanModeProfileStore {
	let currentPath = path;
	return {
		async load() {
			try {
				const profile = parseProjectModelPreferences(readSettingsDocument(currentPath)).profiles.plan;
				return profile ? validateStoredModeModelProfile(profile) : undefined;
			} catch (error) {
				throw new Error(`Cannot load the Plan Mode profile from ${currentPath}: ${error instanceof Error ? error.message : String(error)}`);
			}
		},

		async save(profile) {
			const validated = validateModeModelProfile(profile);
			if (validated.contextWindow === undefined) {
				throw new Error("Plan Mode profile contextWindow must be a positive integer.");
			}
			await mutateSettingsDocument(currentPath, (settings) =>
				mergeProjectModelSelection(settings, "plan", {
					...validated,
					contextWindow: validated.contextWindow!,
				}),
			);
		},

		setPath(nextPath) {
			currentPath = nextPath;
		},
	};
}

function settingsErrorMessage(errors: ReturnType<SettingsManager["drainErrors"]>): string | undefined {
	if (errors.length === 0) return undefined;
	return errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; ");
}

export function createNormalDefaultsStore(agentDir = getAgentDir()): NormalDefaultsStore {
	return {
		async capture(cwd, fallback) {
			const validatedFallback = validateModeModelProfile(fallback, "Normal profile fallback");
			const settings = SettingsManager.create(cwd, agentDir).getGlobalSettings();
			const hasConfiguredModel = typeof settings.defaultProvider === "string" && settings.defaultProvider.length > 0 &&
				typeof settings.defaultModel === "string" && settings.defaultModel.length > 0;
			return {
				provider: hasConfiguredModel ? settings.defaultProvider! : validatedFallback.provider,
				modelId: hasConfiguredModel ? settings.defaultModel! : validatedFallback.modelId,
				thinkingLevel: settings.defaultThinkingLevel ?? validatedFallback.thinkingLevel,
				contextWindow: validatedFallback.contextWindow,
			};
		},

		async restore(cwd, profile) {
			const validated = validateModeModelProfile(profile, "Normal global defaults");
			const settings = SettingsManager.create(cwd, agentDir);
			settings.setDefaultModelAndProvider(validated.provider, validated.modelId);
			settings.setDefaultThinkingLevel(validated.thinkingLevel);
			await settings.flush();
			const error = settingsErrorMessage(settings.drainErrors());
			if (error) throw new Error(`Could not restore Pi's normal defaults: ${error}`);
		},
	};
}
