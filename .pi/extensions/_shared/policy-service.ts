export type PolicyEffect =
	| "workspace-read"
	| "external-read"
	| "workspace-write"
	| "external-write"
	| "shell-execution"
	| "dangerous-shell"
	| "network"
	| "child-process"
	| "worktree"
	| "clipboard"
	| "session-mutation"
	| "config-mutation";

export interface PolicyActionDetails {
	"workspace-read": { path: string };
	"external-read": { path: string };
	"workspace-write": { path: string };
	"external-write": { path: string };
	"shell-execution": { command: string; cwd: string };
	"dangerous-shell": { command: string; cwd: string; reason: string };
	network: { operation: string; target?: string };
	"child-process": { executable: string; args: string[]; cwd: string };
	worktree: { operation: "create" | "remove" | "apply" | "cleanup"; path?: string };
	clipboard: { operation: "read" | "write" };
	"session-mutation": { operation: string };
	"config-mutation": { operation: string; path?: string };
}

export type PolicyAction<TEffect extends PolicyEffect = PolicyEffect> = {
	[TEffectName in TEffect]: {
		effect: TEffectName;
		description: string;
		details: PolicyActionDetails[TEffectName];
	};
}[TEffect];

export type PolicyOutcome = "allow" | "prompt" | "deny" | "unmanaged";
export type ManagedPolicyOutcome = Exclude<PolicyOutcome, "unmanaged">;

export interface PolicyDecision {
	outcome: PolicyOutcome;
	reason: string;
	providerId?: string;
	overrideId?: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PolicyProvider {
	id: string;
	evaluate(action: PolicyAction): PolicyDecision | Promise<PolicyDecision>;
	snapshot(): JsonValue;
}

export interface PolicyOverride {
	id: string;
	reason: string;
	effects: Partial<Record<PolicyEffect, ManagedPolicyOutcome>>;
}

export interface ChildPolicySnapshot {
	version: 1;
	providerId: string;
	providerState: JsonValue;
	overrides: PolicyOverride[];
}

export interface PolicyService {
	registerProvider(provider: PolicyProvider): () => void;
	pushOverride(override: PolicyOverride): () => void;
	evaluate(action: PolicyAction): Promise<PolicyDecision>;
	createChildSnapshot(): ChildPolicySnapshot | undefined;
	clear(): void;
}

const OUTCOME_PRIORITY: Record<ManagedPolicyOutcome, number> = {
	allow: 0,
	prompt: 1,
	deny: 2,
};

export function createPolicyService(): PolicyService {
	let provider: PolicyProvider | undefined;
	const overrides: PolicyOverride[] = [];

	return {
		registerProvider(nextProvider) {
			validateIdentifier(nextProvider.id, "provider");
			if (provider) {
				throw new Error(`Policy provider "${provider.id}" is already registered.`);
			}
			provider = nextProvider;
			return () => {
				if (provider === nextProvider) provider = undefined;
			};
		},

		pushOverride(override) {
			validateOverride(override);
			if (overrides.some((entry) => entry.id === override.id)) {
				throw new Error(`Policy override "${override.id}" is already active.`);
			}
			const stored = cloneJson(override);
			overrides.push(stored);
			return () => {
				const index = overrides.indexOf(stored);
				if (index >= 0) overrides.splice(index, 1);
			};
		},

		async evaluate(action) {
			if (!provider) {
				return { outcome: "unmanaged", reason: "No policy provider is registered." };
			}

			const base = await provider.evaluate(action);
			validateDecision(base, provider.id);
			if (base.outcome === "unmanaged") return base;

			let decision: PolicyDecision & { outcome: ManagedPolicyOutcome } = {
				...base,
				outcome: base.outcome,
				providerId: provider.id,
			};
			for (const override of overrides) {
				const outcome = override.effects[action.effect];
				if (outcome && OUTCOME_PRIORITY[outcome] > OUTCOME_PRIORITY[decision.outcome]) {
					decision = {
						outcome,
						reason: override.reason,
						providerId: provider.id,
						overrideId: override.id,
					};
				}
			}
			return decision;
		},

		createChildSnapshot() {
			if (!provider) return undefined;
			return cloneJson({
				version: 1,
				providerId: provider.id,
				providerState: provider.snapshot(),
				overrides,
			});
		},

		clear() {
			provider = undefined;
			overrides.splice(0);
		},
	};
}

export function parseChildPolicySnapshot(value: unknown): ChildPolicySnapshot {
	if (!isRecord(value) || value.version !== 1 || typeof value.providerId !== "string") {
		throw new Error("Invalid child policy snapshot header.");
	}
	validateIdentifier(value.providerId, "provider");
	if (!("providerState" in value) || !isJsonValue(value.providerState)) {
		throw new Error("Invalid child policy provider state.");
	}
	if (!Array.isArray(value.overrides)) {
		throw new Error("Invalid child policy overrides.");
	}
	for (const override of value.overrides) validateOverride(override);
	return cloneJson(value as unknown as ChildPolicySnapshot);
}

export const policyService = createPolicyService();

function validateDecision(decision: PolicyDecision, providerId: string): void {
	if (
		!isRecord(decision) ||
		!["allow", "prompt", "deny", "unmanaged"].includes(String(decision.outcome)) ||
		typeof decision.reason !== "string"
	) {
		throw new Error(`Policy provider "${providerId}" returned an invalid decision.`);
	}
}

function validateOverride(value: unknown): asserts value is PolicyOverride {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.reason !== "string" ||
		!isRecord(value.effects)
	) {
		throw new Error("Invalid policy override.");
	}
	validateIdentifier(value.id, "override");
	for (const [effect, outcome] of Object.entries(value.effects)) {
		if (!POLICY_EFFECTS.has(effect as PolicyEffect) || !["allow", "prompt", "deny"].includes(String(outcome))) {
			throw new Error(`Invalid policy override rule: ${effect}`);
		}
	}
}

function validateIdentifier(value: string, kind: string): void {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
		throw new Error(`Invalid policy ${kind} id: ${value}`);
	}
}

function cloneJson<T>(value: T): T {
	if (!isJsonValue(value)) throw new Error("Policy snapshot data must be JSON-serializable.");
	return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

const POLICY_EFFECTS = new Set<PolicyEffect>([
	"workspace-read",
	"external-read",
	"workspace-write",
	"external-write",
	"shell-execution",
	"dangerous-shell",
	"network",
	"child-process",
	"worktree",
	"clipboard",
	"session-mutation",
	"config-mutation",
]);