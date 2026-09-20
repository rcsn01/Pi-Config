/**
 * Guardian execution: loading and resolving the guardian definition file,
 * constructing the isolated in-process AgentSession, serializing reviews, the
 * unabortable-timeout unavailability latch, timeout/abort, usage and model
 * attribution, and observability. The verdict protocol (task composition,
 * response interpretation, authorization decision) is owned by
 * guardian-verdict.ts.
 *
 * Why in-process (instead of a `pi --mode json` subprocess): the subprocess
 * paid process-spawn + full pi startup (config, extensions, model init) on
 * every reviewed command, which dominated the timeout misses. An in-process
 * AgentSession shares the running process, the model runtime, and the provider
 * connection — only the LLM call itself is paid per review.
 *
 * The guardian session is deliberately isolated from the main chat, matching
 * the old subprocess flags:
 *   - SessionManager.inMemory() → no session file, no shared history
 *   - tools: [guardian_classification] → only the structured classification tool is available
 *   - noTools: "all"                  → no repository or built-in tools are available
 *   - noExtensions / noSkills         → no extension recursion, no skill overhead
 *   - systemPromptOverride     → guardian.md is the complete system prompt
 *   - agentsFilesOverride      → project context cannot influence decisions
 *
 * A fresh in-memory session is created for every review so authorization and
 * verdict context cannot bleed between actions. The expensive ModelRuntime is
 * created lazily and reused, so model catalog/auth initialization still happens
 * only once.
 */
import type { Usage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	type AgentSession,
	type CreateAgentSessionOptions,
	DefaultResourceLoader,
	type ModelRegistry,
	type ToolDefinition,
	getAgentDir,
	ModelRuntime,
	parseFrontmatter,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getObservabilityService, type ObservabilitySource } from "../_shared/observability.ts";
import { ModelReferenceError, resolveModelReference, type RefreshableModelLookup } from "../_shared/model-reference.ts";
import { readDefaultProvider } from "../_shared/pi-defaults.ts";
import {
	composeGuardianTask,
	GUARDIAN_CLASSIFICATION_TOOL_NAME,
	guardianClassificationToolContract,
	settleGuardianResponse,
} from "./guardian-verdict.ts";
import { guardianObserverExtension, runWithGuardianObservation } from "./guardian-observer.ts";
import type { GuardianSettings } from "./guardian-settings.ts";
import type { ApprovalResult } from "./policy-types.ts";

type AnyModel = NonNullable<CreateAgentSessionOptions["model"]>;

/** Time budget for a single guardian review, matching the old subprocess timeout. */
const GUARDIAN_TIMEOUT_MS = 30_000;

export interface GuardianDefinition {
	systemPrompt: string;
	model: string;
	tools: string;
}

export interface GuardianReviewResult extends ApprovalResult {
	model?: string;
	usage?: Usage;
}

export interface RunAutoReviewerOptions {
	/** Profile-scoped override. When absent, guardian.md and Pi defaults apply. */
	settings?: GuardianSettings;
	/** Dynamic provider registrations copied from the owning Pi runtime. */
	providerRegistration?: {
		native?: ReturnType<ModelRegistry["getRegisteredNativeProvider"]>;
		config?: ReturnType<ModelRegistry["getRegisteredProviderConfig"]>;
	};
	/**
	 * Test seam: build the prompt session directly instead of constructing the
	 * isolated in-process AgentSession. Production callers leave it unset.
	 */
	sessionFactory?: (definition: GuardianDefinition, options: RunAutoReviewerOptions) => Promise<GuardianPromptSession>;
	/** Time budget override for a single review; defaults to GUARDIAN_TIMEOUT_MS. */
	timeoutMs?: number;
}

/**
 * Minimal prompt-session surface a review needs. The production AgentSession
 * satisfies it structurally; tests supply lightweight fakes.
 */
export interface GuardianPromptSession {
	prompt(task: string): Promise<unknown>;
	abort(): Promise<void>;
	dispose?(): void;
	readonly messages: readonly GuardianMessage[];
	readonly model?: { provider: string; id: string };
}

type GuardianMessage = AgentSession["messages"][number];

/** Aggregate usage from assistant messages emitted by one guardian request. */
export function collectGuardianUsage(messages: readonly GuardianMessage[], startIndex = 0): Usage | undefined {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let found = false;
	let hasCacheWrite1h = false;
	let cacheWrite1h = 0;
	let hasReasoning = false;
	let reasoning = 0;
	for (const message of messages.slice(Math.max(0, Math.floor(startIndex)))) {
		if (message.role !== "assistant" || !message.usage) continue;
		found = true;
		const usage = message.usage;
		total.input += finiteUsageNumber(usage.input);
		total.output += finiteUsageNumber(usage.output);
		total.cacheRead += finiteUsageNumber(usage.cacheRead);
		total.cacheWrite += finiteUsageNumber(usage.cacheWrite);
		total.totalTokens += finiteUsageNumber(usage.totalTokens);
		total.cost.input += finiteUsageNumber(usage.cost.input);
		total.cost.output += finiteUsageNumber(usage.cost.output);
		total.cost.cacheRead += finiteUsageNumber(usage.cost.cacheRead);
		total.cost.cacheWrite += finiteUsageNumber(usage.cost.cacheWrite);
		total.cost.total += finiteUsageNumber(usage.cost.total);
		if (typeof usage.cacheWrite1h === "number" && Number.isFinite(usage.cacheWrite1h)) {
			hasCacheWrite1h = true;
			cacheWrite1h += usage.cacheWrite1h;
		}
		if (typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning)) {
			hasReasoning = true;
			reasoning += usage.reasoning;
		}
	}
	if (!found) return undefined;
	if (hasCacheWrite1h) total.cacheWrite1h = cacheWrite1h;
	if (hasReasoning) total.reasoning = reasoning;
	return total;
}

function finiteUsageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function resolveGuardianPath(moduleUrl: string): string {
	return path.join(path.dirname(fileURLToPath(moduleUrl)), "guardian.md");
}

export function parseGuardianDefinition(content: string): GuardianDefinition {
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	return {
		systemPrompt: body.trim(),
		model: frontmatter.model?.trim() ?? "",
		tools: frontmatter.tools?.trim() ?? "",
	};
}

const guardianClassificationTool: ToolDefinition = {
	...guardianClassificationToolContract,
	async execute() {
		return {
			content: [{ type: "text", text: "Classification recorded." }],
			details: undefined,
			terminate: true,
		};
	},
};

// ── In-process guardian session ───────────────────────────────────────

let runtimePromise: Promise<ModelRuntime> | undefined;
let guardianReviewTail: Promise<void> = Promise.resolve();
let guardianUnavailableReason: string | undefined;

async function withGuardianReviewLock<T>(operation: () => Promise<T>): Promise<T> {
	const previous = guardianReviewTail;
	let release = () => {};
	guardianReviewTail = new Promise<void>((resolve) => { release = resolve; });
	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
}

/** Wait for any in-flight isolated review to finish at the owning Pi session boundary. */
export function disposeAutoReviewer(): Promise<void> {
	return withGuardianReviewLock(async () => {});
}

function getRuntime(): Promise<ModelRuntime> {
	runtimePromise ??= ModelRuntime.create();
	return runtimePromise;
}

/**
 * Resolve a guardian.md `model:` frontmatter spec ("provider/id" or a bare id
 * that falls back to the configured default provider) through the shared
 * model-reference module. An empty spec means "use the settings default
 * model" — handled by createAgentSession itself.
 *
 * The ModelRuntime is adapted to the shared lookup face inline: it has no
 * refresh and no scoped-models concept, so both stay absent and the
 * scoped-models invariant is not applicable to the guardian session.
 * @internal test seam: exported so the empty-provider tightening is pinnable.
 */
export async function resolveGuardianModel(spec: string, runtime: ModelRuntime): Promise<AnyModel> {
	const lookup: RefreshableModelLookup = {
		modelRegistry: { find: (provider, modelId) => runtime.getModel(provider, modelId) },
	};
	try {
		return await resolveModelReference(lookup, spec, {
			allowBareId: true,
			bareIdFallback: () => readDefaultProvider(getAgentDir()),
		}) as AnyModel;
	} catch (error) {
		if (!(error instanceof ModelReferenceError)) throw error;
		if (error.reason === "no-provider") {
			throw new Error(`guardian model "${spec}" has no provider and no default provider is configured`);
		}
		if (error.reason === "invalid") {
			throw new Error(`guardian model "${spec}" is not a valid model reference.`);
		}
		throw new Error(`guardian model not found: ${error.provider}/${error.modelId}`);
	}
}

async function getGuardianSession(
	definition: GuardianDefinition,
	options: RunAutoReviewerOptions,
): Promise<GuardianPromptSession> {
	if (options.sessionFactory) return options.sessionFactory(definition, options);
	return createGuardianSession(definition, options);
}

async function createGuardianSession(
	definition: GuardianDefinition,
	options: RunAutoReviewerOptions,
): Promise<AgentSession> {
	const { settings, providerRegistration } = options;
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		extensionFactories: [{ name: "guardian-analysis-observer", factory: guardianObserverExtension, hidden: true }],
		systemPromptOverride: () => definition.systemPrompt,
		appendSystemPromptOverride: () => [],
		agentsFilesOverride: () => ({ agentsFiles: [] }),
	});
	await loader.reload();

	const runtime = await getRuntime();
	if (settings && providerRegistration?.native) {
		runtime.registerNativeProvider(providerRegistration.native);
	}
	if (settings && providerRegistration?.config) {
		runtime.registerProvider(settings.provider, providerRegistration.config);
	}
	const configuredModel = settings
		? await resolveGuardianModel(`${settings.provider}/${settings.modelId}`, runtime)
		: definition.model
			? await resolveGuardianModel(definition.model, runtime)
			: undefined;
	if (configuredModel && settings && settings.contextWindow > configuredModel.contextWindow) {
		throw new Error(
			`guardian context window ${settings.contextWindow} exceeds the catalogue maximum of ${configuredModel.contextWindow}`,
		);
	}
	const model = configuredModel && settings && configuredModel.contextWindow !== settings.contextWindow
		? { ...configuredModel, contextWindow: settings.contextWindow }
		: configuredModel;
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
		noTools: "all",
		tools: [GUARDIAN_CLASSIFICATION_TOOL_NAME],
		customTools: [guardianClassificationTool],
		modelRuntime: runtime,
		...(model ? { model } : {}),
		...(settings ? { thinkingLevel: settings.thinkingLevel } : {}),
	});
	return session;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Run the guardian LLM in-process to evaluate an action.
 * On timeout, subprocess failure, or an unparseable/absent response the result
 * is denied (fail closed), while any usage emitted by that request is retained.
 */
export async function runAutoReviewer(
	title: string,
	message: string,
	options: RunAutoReviewerOptions = {},
	guardianPath = resolveGuardianPath(import.meta.url),
): Promise<GuardianReviewResult> {
	const task = composeGuardianTask(title, message);

	// Read guardian agent config
	let definition: GuardianDefinition;

	try {
		definition = parseGuardianDefinition(fs.readFileSync(guardianPath, "utf-8"));
		if (!definition.systemPrompt) {
			return { allowed: false, reason: "Guardian agent has no system prompt; blocked for safety." };
		}
	} catch {
		// Guardian not found or invalid — fail closed
		return { allowed: false, reason: "Guardian agent not found; blocked for safety." };
	}

	return withGuardianReviewLock(async () => {
	if (guardianUnavailableReason) {
		return { allowed: false, reason: guardianUnavailableReason };
	}
	const timeoutMs = options.timeoutMs ?? GUARDIAN_TIMEOUT_MS;
	let session: GuardianPromptSession | undefined;
	let startCount = 0;
	let sessionModel: string | undefined;
	const requestUsage = (): Usage | undefined => session ? collectGuardianUsage(session.messages, startCount) : undefined;
	const withRequestUsage = (result: ApprovalResult): GuardianReviewResult => {
		const usage = requestUsage();
		return {
			...result,
			...(sessionModel ? { model: sessionModel } : {}),
			...(usage ? { usage } : {}),
		};
	};

	try {
		session = await getGuardianSession(definition, options);
		const model = session.model;
		if (model) sessionModel = `${model.provider}/${model.id}`;
		startCount = session.messages.length;
		const observability = getObservabilityService();
		const observationSource: ObservabilitySource | undefined = observability.isActive()
			? { channel: "guardian", invocationId: randomUUID(), displayLabel: "Guardian" }
			: undefined;
		await runWithGuardianObservation(observationSource, () => withTimeout(session!.prompt(task), timeoutMs));

		return withRequestUsage(settleGuardianResponse(session!.messages.slice(startCount)));
	} catch (err: any) {
		if (err?.message && /timed out after/.test(err.message)) {
			// Do not start later reviews if an uncooperative provider leaves this
			// request alive: overlapping safety evaluations are not an acceptable
			// recovery mode. A process restart restores availability.
			try {
				await session?.abort();
			} catch (abortError) {
				guardianUnavailableReason = `Guardian abort failed after timeout; blocked for safety: ${abortError instanceof Error ? abortError.message : String(abortError)}`;
			}
			return withRequestUsage({
				allowed: false,
				reason: `Guardian timed out after ${timeoutMs / 1000}s; blocked for safety.`,
			});
		}
		return withRequestUsage({ allowed: false, reason: `Guardian error: ${err.message || String(err)}` });
	} finally {
		session?.dispose?.();
	}
	});
}
