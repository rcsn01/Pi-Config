/**
 * Guardian auto-reviewer: loading the guardian agent definition, resolving the
 * colocated guardian file, parsing its JSON verdict, and running the guardian
 * as an isolated in-process AgentSession.
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
 *   - noTools: "all"            → the guardian can never call tools
 *   - noExtensions / noSkills   → no extension recursion, no skill overhead
 *   - appendSystemPrompt        → guardian.md rides the system prompt (parity
 *                                 with the old `--append-system-prompt`)
 *
 * The session is created once per process and reused; each review adds only a
 * few hundred tokens of context, negligible next to a typical context window.
 * A shared ModelRuntime is created lazily and reused across sessions so model
 * catalog/auth initialization happens once.
 */
import type { Usage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	type AgentSession,
	type CreateAgentSessionOptions,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	parseFrontmatter,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalResult } from "./policy-types.ts";

type AnyModel = NonNullable<CreateAgentSessionOptions["model"]>;

/** Time budget for a single guardian review, matching the old subprocess timeout. */
export const GUARDIAN_TIMEOUT_MS = 30_000;

export interface GuardianDefinition {
	systemPrompt: string;
	model: string;
	tools: string;
}

export interface GuardianReviewResult extends ApprovalResult {
	usage?: Usage;
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

/**
 * Parse a guardian's response into a verdict.
 * Returns `"unclear"` when the response cannot be interpreted; callers fail closed.
 */
export function parseGuardianVerdict(content: string): ApprovalResult | "unclear" {
	// Try to parse the guardian's JSON verdict — strip markdown fences first
	let jsonCandidate = content.trim()
		.replace(/```json\s*/gi, "")
		.replace(/```\s*/g, "")
		.trim();
	try {
		const verdict = JSON.parse(jsonCandidate);
		if (verdict.outcome === "allow") {
			const parts: string[] = [];
			if (verdict.risk_level) parts.push(`risk: ${verdict.risk_level}`);
			if (verdict.user_authorization) parts.push(`auth: ${verdict.user_authorization}`);
			const reason = verdict.rationale || parts.join(", ") || "allowed";
			return { allowed: true, reason };
		}
		if (verdict.outcome === "deny") {
			const parts: string[] = [];
			if (verdict.risk_level) parts.push(`risk: ${verdict.risk_level}`);
			if (verdict.user_authorization) parts.push(`auth: ${verdict.user_authorization}`);
			if (verdict.rationale) parts.push(verdict.rationale);
			return { allowed: false, reason: parts.join(" | ") || "Guardian: denied." };
		}
	} catch {}

	// Super-lenient fallback: look for ALLOW or DENY anywhere in content
	// Strip markdown code fences, extra whitespace, and common prefixes
	let cleaned = content
		.replace(/```[\s\S]*?```/g, "")  // strip code blocks
		.replace(/^[\s\S]*?(ALLOW|DENY)/im, "$1")  // strip everything before ALLOW/DENY
		.trim()
		.toUpperCase();

	if (cleaned.startsWith("ALLOW")) {
		return { allowed: true, reason: "Guardian: allowed." };
	}
	if (cleaned.startsWith("DENY")) {
		return { allowed: false, reason: "Guardian: denied." };
	}

	// Last resort: check original JSON-style patterns
	const normalized = content.trim().toUpperCase();
	if (normalized.includes('"ALLOW"') || normalized.includes('"OUTCOME":"ALLOW"')) {
		return { allowed: true, reason: "Guardian: allowed." };
	}
	if (normalized.includes('"DENY"') || normalized.includes('"OUTCOME":"DENY"')) {
		return { allowed: false, reason: "Guardian: denied." };
	}

	// Unclear response - fail closed
	return "unclear";
}

// ── In-process guardian session ───────────────────────────────────────

let sessionPromise: Promise<AgentSession> | undefined;
let runtimePromise: Promise<ModelRuntime> | undefined;

function getRuntime(): Promise<ModelRuntime> {
	runtimePromise ??= ModelRuntime.create();
	return runtimePromise;
}

/**
 * Resolve a guardian.md `model:` frontmatter spec ("provider/id" or a bare id
 * that falls back to the configured default provider). An empty spec means
 * "use the settings default model" — handled by createAgentSession itself.
 */
async function resolveGuardianModel(spec: string): Promise<AnyModel> {
	const runtime = await getRuntime();
	const slash = spec.indexOf("/");
	let provider = slash >= 0 ? spec.slice(0, slash) : undefined;
	const id = slash >= 0 ? spec.slice(slash + 1) : spec;
	if (!provider) {
		provider = SettingsManager.create(process.cwd(), getAgentDir()).getDefaultProvider();
	}
	if (!provider) {
		throw new Error(`guardian model "${spec}" has no provider and no default provider is configured`);
	}
	const model = runtime.getModel(provider, id);
	if (!model) {
		throw new Error(`guardian model not found: ${provider}/${id}`);
	}
	return model;
}

async function getGuardianSession(definition: GuardianDefinition): Promise<AgentSession> {
	sessionPromise ??= createGuardianSession(definition).catch((err) => {
		sessionPromise = undefined;
		throw err;
	});
	return sessionPromise;
}

async function createGuardianSession(definition: GuardianDefinition): Promise<AgentSession> {
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		appendSystemPrompt: [definition.systemPrompt],
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: process.cwd(),
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
		noTools: "all",
		modelRuntime: await getRuntime(),
		...(definition.model ? { model: await resolveGuardianModel(definition.model) } : {}),
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

/** Text of the newest assistant message added since `startCount` messages. */
function lastAssistantTextSince(session: AgentSession, startCount: number): string {
	const messages = session.messages.slice(startCount);
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const content = msg.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		}
	}
	return "";
}

/**
 * Run the guardian LLM in-process to evaluate an action.
 * On timeout, subprocess failure, or an unparseable/absent response the result
 * is denied (fail closed), while any usage emitted by that request is retained.
 */
export async function runAutoReviewer(
	title: string,
	message: string,
	guardianPath = resolveGuardianPath(import.meta.url),
): Promise<GuardianReviewResult> {
	const task = `Evaluate this action for safety.

You are operating in auto-review mode. You are the FINAL authority — your decision is never escalated to the user. Decide yourself: allow or deny.

Title: ${title}

${message}`;

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

	let session: AgentSession | undefined;
	let startCount = 0;
	const requestUsage = (): Usage | undefined => session ? collectGuardianUsage(session.messages, startCount) : undefined;
	const withRequestUsage = (result: ApprovalResult): GuardianReviewResult => {
		const usage = requestUsage();
		return usage ? { ...result, usage } : result;
	};

	try {
		session = await getGuardianSession(definition);
		startCount = session.messages.length;
		await withTimeout(session.prompt(task), GUARDIAN_TIMEOUT_MS);
		const content = lastAssistantTextSince(session, startCount);

		if (!content.trim()) {
			return withRequestUsage({ allowed: false, reason: "Guardian returned no response; blocked for safety." });
		}

		const verdict = parseGuardianVerdict(content);
		if (verdict === "unclear") {
			return withRequestUsage({ allowed: false, reason: "Guardian returned ambiguous response; blocked for safety." });
		}
		return withRequestUsage(verdict);
	} catch (err: any) {
		if (err?.message && /timed out after/.test(err.message)) {
			// Best-effort abort so a stranded LLM stream stops burning tokens.
			try {
				await session?.abort();
			} catch {}
			return withRequestUsage({
				allowed: false,
				reason: `Guardian timed out after ${GUARDIAN_TIMEOUT_MS / 1000}s; blocked for safety.`,
			});
		}
		return withRequestUsage({ allowed: false, reason: `Guardian error: ${err.message || String(err)}` });
	}
}
