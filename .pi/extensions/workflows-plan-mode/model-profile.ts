import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	SettingsManager,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

export interface ModeModelProfile {
	provider: string;
	modelId: string;
	thinkingLevel: ModelThinkingLevel;
}

interface PlanModeProfileDocument {
	version: 1;
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
	return {
		provider: value.provider,
		modelId: value.modelId,
		thinkingLevel: value.thinkingLevel as ModelThinkingLevel,
	};
}

export function parsePlanModeProfileDocument(value: unknown): ModeModelProfile {
	if (!isRecord(value)) throw new Error("Plan Mode profile file must contain a JSON object.");
	if (value.version !== 1) throw new Error("Plan Mode profile file has an unsupported version.");
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
			await withFileMutationQueue(path, async () => {
				const document: PlanModeProfileDocument = { version: 1, profile: validated };
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
