import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	SettingsManager,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface ModeModelProfile {
	provider: string;
	modelId: string;
	thinkingLevel: ModelThinkingLevel;
	/** Optional only while reading legacy v1/session state; all newly captured profiles include it. */
	contextWindow?: number;
}

interface PlanModeProfileDocument {
	version: 2;
	profile: ModeModelProfile;
}

export interface PlanModeProfileStore {
	load(): Promise<ModeModelProfile | undefined>;
	save(profile: ModeModelProfile): Promise<void>;
}

export interface NormalDefaultsStore {
	capture(cwd: string, fallback: ModeModelProfile): Promise<ModeModelProfile>;
	restore(cwd: string, profile: ModeModelProfile): Promise<void>;
}

export const PLAN_MODE_PROFILE_PATH = join(getAgentDir(), "plan-mode-profile.json");

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

export async function applySessionProfile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	profile: ModeModelProfile,
): Promise<ModeModelProfile> {
	const currentModel = ctx.model;
	const sameModel = currentModel?.provider === profile.provider && currentModel.id === profile.modelId;
	let model: Model<any>;
	let shouldSetModel = false;

	if (sameModel) {
		model = profile.contextWindow === undefined || profile.contextWindow === currentModel.contextWindow
			? currentModel
			: { ...currentModel, contextWindow: profile.contextWindow };
		shouldSetModel = model.contextWindow !== currentModel.contextWindow;
	} else {
		const catalogueModel = await resolveProfileModel(ctx, profile);
		model = profile.contextWindow === undefined
			? catalogueModel
			: { ...catalogueModel, contextWindow: profile.contextWindow };
		shouldSetModel = true;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateModeModelProfile(value: unknown, label = "Plan Mode profile"): ModeModelProfile {
	if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
	if (typeof value.provider !== "string" || !value.provider.trim()) {
		throw new Error(`${label} provider must be a non-empty string.`);
	}
	if (typeof value.modelId !== "string" || !value.modelId.trim()) {
		throw new Error(`${label} modelId must be a non-empty string.`);
	}
	if (typeof value.thinkingLevel !== "string" || !THINKING_LEVELS.has(value.thinkingLevel as ModelThinkingLevel)) {
		throw new Error(`${label} thinkingLevel is not supported.`);
	}
	if (value.contextWindow !== undefined && (!Number.isInteger(value.contextWindow) || (value.contextWindow as number) <= 0)) {
		throw new Error(`${label} contextWindow must be a positive integer.`);
	}
	return {
		provider: value.provider,
		modelId: value.modelId,
		thinkingLevel: value.thinkingLevel as ModelThinkingLevel,
		contextWindow: value.contextWindow as number | undefined,
	};
}

export function parsePlanModeProfileDocument(value: unknown): ModeModelProfile {
	if (!isRecord(value)) throw new Error("Plan Mode profile file must contain a JSON object.");
	if (value.version !== 1 && value.version !== 2) {
		throw new Error("Plan Mode profile file has an unsupported version.");
	}
	return validateModeModelProfile(value.profile);
}

export function createPlanModeProfileStore(path = PLAN_MODE_PROFILE_PATH): PlanModeProfileStore {
	return {
		async load() {
			if (!existsSync(path)) return undefined;
			try {
				return parsePlanModeProfileDocument(JSON.parse(readFileSync(path, "utf-8")));
			} catch (error) {
				throw new Error(`Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		},

		async save(profile) {
			const validated = validateModeModelProfile(profile);
			if (validated.contextWindow === undefined) {
				throw new Error("Plan Mode profile contextWindow must be a positive integer.");
			}
			await withFileMutationQueue(path, async () => {
				const document: PlanModeProfileDocument = { version: 2, profile: validated };
				mkdirSync(dirname(path), { recursive: true });
				const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
				try {
					writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
					renameSync(temporaryPath, path);
				} finally {
					if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
				}
			});
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
