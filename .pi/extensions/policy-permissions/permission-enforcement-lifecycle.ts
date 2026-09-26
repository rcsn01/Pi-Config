import type { ExecPolicyConfig } from "../_shared/command-policy.ts";
import type { GuardianReviewResult } from "./guardian-runner.ts";
import { approvalDisposition, type ApprovalMode } from "./mode-registry.ts";
import { DEFAULT_MODE_STATE, type ModePersistenceOptions, type ModeState } from "./mode-store.ts";
import { classifyToolCall } from "./permission-policy.ts";
import type { ApprovalResult, ToolCallInput } from "./policy-types.ts";
import {
	buildGuardianEvaluationMessage,
	type GuardianContextSnapshot,
} from "./guardian-evidence.ts";

export { boundGuardianEvidence, buildGuardianEvaluationMessage } from "./guardian-evidence.ts";
export type { GuardianContextSnapshot } from "./guardian-evidence.ts";

export interface PermissionEnforcementEnvironment<HostContext> {
	cwd: string;
	hasUI: boolean;
	execPolicy: ExecPolicyConfig;
	guardianContext: GuardianContextSnapshot;
	hostContext: HostContext;
}

export type PermissionEnforcementOutcome =
	| { kind: "allowed"; source: "policy" | "user" | "guardian" | "one-shot" }
	| { kind: "blocked"; reason: string; approvable: boolean };

export interface DeniedAction {
	key: string;
	title: string;
	message: string;
	at: number;
}

export type ApprovalIssueOutcome =
	| { kind: "approved"; action: DeniedAction }
	| { kind: "none" };

export interface ModeChangeOutcome {
	mode: ModeState;
}

export interface PermissionEnforcementLifecycleAdapter<HostContext> {
	loadMode(cwd: string, options: ModePersistenceOptions): ModeState | undefined;
	saveMode(cwd: string, mode: ModeState, options: ModePersistenceOptions): void;
	requestUserConfirmation(host: HostContext, title: string, message: string): Promise<boolean>;
	runGuardianReview(
		host: HostContext,
		title: string,
		evaluationMessage: string,
		triggers: readonly string[],
	): Promise<GuardianReviewResult>;
	persistGuardianVerdict(
		host: HostContext,
		verdict: GuardianReviewResult & { title: string; triggers: string[] },
	): void;
}

export interface PermissionEnforcementLifecycle<HostContext> {
	readonly mode: ModeState;
	synchronizeSession(input: {
		cwd: string;
		resetTransientApprovals: boolean;
		/** Enables the trusted per-project `.pi/pi-config.json` document. */
		projectTrusted?: boolean;
	}): ModeState;
	changeMode(mode: ModeState, options?: ModePersistenceOptions): ModeChangeOutcome;
	evaluate(
		call: ToolCallInput,
		environment: PermissionEnforcementEnvironment<HostContext>,
	): Promise<PermissionEnforcementOutcome>;
	approveLastDenied(): ApprovalIssueOutcome;
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "boolean") return `boolean:${value}`;
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "number:NaN";
		if (value === Infinity) return "number:Infinity";
		if (value === -Infinity) return "number:-Infinity";
		if (Object.is(value, -0)) return "number:-0";
		return `number:${value}`;
	}
	if (typeof value === "string") return `string:${JSON.stringify(value)}`;
	if (typeof value === "bigint") return `bigint:${value}`;
	if (typeof value === "symbol" || typeof value === "function") {
		throw new TypeError(`Tool input cannot contain ${typeof value} values.`);
	}
	if (seen.has(value)) throw new TypeError("Tool input cannot contain circular references.");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const items = Array.from({ length: value.length }, (_, index) =>
				index in value ? canonicalJson(value[index], seen) : "hole"
			);
			return `array:[${items.join(",")}]`;
		}
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
			throw new TypeError("Tool input must contain only plain objects and arrays.");
		}
		const record = value as Record<string, unknown>;
		return `object:{${Object.keys(record).sort().map((key) =>
			`${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`
		).join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

/** Stable identity for an exact tool call, independent of object property order. */
export function permissionActionKey(toolName: string, input: unknown): string {
	return `${toolName}:${canonicalJson(input)}`;
}

export function createPermissionEnforcementLifecycle<HostContext>(
	adapter: PermissionEnforcementLifecycleAdapter<HostContext>,
	options: { now?: () => number } = {},
): PermissionEnforcementLifecycle<HostContext> {
	const now = options.now ?? Date.now;
	let currentMode: ModeState = { ...DEFAULT_MODE_STATE };
	let currentCwd = process.cwd();
	let lastDeniedAction: DeniedAction | undefined;
	const oneShotApprovals = new Set<string>();
	let authorizationGeneration = 0;

	function requestApproval(
		environment: PermissionEnforcementEnvironment<HostContext>,
		mode: ApprovalMode,
		title: string,
		message: string,
		onAllowed: (source: "user") => void,
	): Promise<ApprovalResult> {
		const disposition = approvalDisposition(mode, environment.hasUI);
		if (disposition.kind === "decided") return Promise.resolve(disposition.result);
		// Prompt path: only reachable for default mode with a UI.
		return adapter.requestUserConfirmation(
			environment.hostContext,
			title,
			`${message}\n\nProceed?`,
		).then((allowed) => {
			if (allowed) onAllowed("user");
			return { allowed, reason: allowed ? undefined : "User declined." };
		});
	}

	async function requestGuardianFallback(
		environment: PermissionEnforcementEnvironment<HostContext>,
		title: string,
		message: string,
		onAllowed: (source: "user" | "guardian") => void,
	): Promise<ApprovalResult> {
		const allowed = await adapter.requestUserConfirmation(
			environment.hostContext,
			title,
			message,
		);
		if (allowed) onAllowed("user");
		return allowed
			? { allowed: true, reason: "User approved (guardian fallback)." }
			: { allowed: false, reason: "Auto-review: user declined (guardian fallback)." };
	}

	async function guardianReview(
		environment: PermissionEnforcementEnvironment<HostContext>,
		title: string,
		actionDescription: string,
		triggers: string[],
		onAllowed: (source: "user" | "guardian") => void,
	): Promise<ApprovalResult> {
		if (!environment.hasUI) {
			return { allowed: false, reason: "Auto-review: no UI available for guardian fallback." };
		}
		const evaluationMessage = buildGuardianEvaluationMessage(
			environment.guardianContext,
			title,
			actionDescription,
			triggers,
		);

		let result: GuardianReviewResult;
		try {
			result = await adapter.runGuardianReview(
				environment.hostContext,
				title,
				evaluationMessage,
				triggers,
			);
		} catch {
			return requestGuardianFallback(
				environment,
				`Auto-review: ${title} (guardian unavailable)`,
				`${actionDescription}\n\nGuardian could not return a usable verdict. Proceed?`,
				onAllowed,
			);
		}

		try {
			adapter.persistGuardianVerdict(environment.hostContext, { ...result, title, triggers });
		} catch {
			return requestGuardianFallback(
				environment,
				`Auto-review: ${title} (verdict write failed)`,
				`${actionDescription}\n\nGuardian returned a verdict, but the attempt to record it in the current Session failed. Proceed?`,
				onAllowed,
			);
		}

		if (result.allowed) onAllowed("guardian");
		return {
			allowed: result.allowed,
			reason: result.reason || (result.allowed ? undefined : "Guardian denied."),
		};
	}

	return {
		get mode() {
			return { ...currentMode };
		},
		synchronizeSession(input) {
			currentCwd = input.cwd;
			const persistence: ModePersistenceOptions = { projectTrusted: input.projectTrusted ?? false };
			try {
				currentMode = adapter.loadMode(input.cwd, persistence) ?? { ...DEFAULT_MODE_STATE };
			} catch {
				currentMode = { ...DEFAULT_MODE_STATE };
			}
			if (input.resetTransientApprovals) {
				authorizationGeneration++;
				lastDeniedAction = undefined;
				oneShotApprovals.clear();
			}
			return { ...currentMode };
		},
		changeMode(mode, options = {}) {
			currentMode = { ...mode };
			authorizationGeneration++;
			lastDeniedAction = undefined;
			oneShotApprovals.clear();
			try {
				adapter.saveMode(currentCwd, currentMode, options);
			} catch {
				// Permission mode remains live when best-effort persistence fails.
			}
			return { mode: { ...currentMode } };
		},
		async evaluate(call, environment) {
			const key = permissionActionKey(call.toolName, call.input);
			if (oneShotApprovals.delete(key)) return { kind: "allowed", source: "one-shot" };

			const evaluationMode = currentMode.mode;
			const evaluationGeneration = authorizationGeneration;
			let promptedDenial = false;
			let allowedSource: "policy" | "user" | "guardian" = "policy";
			const recordAllowedSource = (source: "user" | "guardian") => {
				allowedSource = source;
			};
			const recordDenied = (denial: { title: string; message: string }) => {
				if (!environment.hasUI || evaluationGeneration !== authorizationGeneration) return;
				promptedDenial = true;
				lastDeniedAction = {
					key,
					title: denial.title,
					message: denial.message,
					at: now(),
				};
			};

			const steps = classifyToolCall(call, {
				mode: evaluationMode,
				cwd: environment.cwd,
				hasUI: environment.hasUI,
				execPolicy: environment.execPolicy,
			});
			if (steps.length === 0) return { kind: "allowed", source: "policy" };

			for (const step of steps) {
				if (step.kind === "block") {
					if (!promptedDenial) lastDeniedAction = undefined;
					return { kind: "blocked", reason: step.reason, approvable: promptedDenial };
				}
				const result = step.channel === "guardian"
					? await guardianReview(environment, step.title, step.message, [...(step.triggers ?? [])], recordAllowedSource)
					: await requestApproval(environment, evaluationMode, step.title, step.message, recordAllowedSource);
				if (result.allowed) continue;
				const reason = step.declinedReason.kind === "fixed"
					? step.declinedReason.reason
					: result.reason ?? step.declinedReason.reason;
				recordDenied(step.denial);
				return { kind: "blocked", reason, approvable: promptedDenial };
			}
			return { kind: "allowed", source: allowedSource };
		},
		approveLastDenied() {
			if (!lastDeniedAction) return { kind: "none" };
			const action = lastDeniedAction;
			lastDeniedAction = undefined;
			oneShotApprovals.add(action.key);
			return { kind: "approved", action };
		},
	};
}
