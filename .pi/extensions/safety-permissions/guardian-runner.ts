/**
 * Guardian auto-reviewer: loading the guardian agent definition, resolving the
 * colocated guardian file, parsing its JSON verdict, and running the guardian
 * as a subprocess.
 */
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalResult } from "./policy-types.ts";

export interface GuardianDefinition {
	systemPrompt: string;
	model: string;
	tools: string;
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

/**
 * Run the guardian LLM as a subprocess to evaluate an action.
 * Returns an `ApprovalResult`. On subprocess failure or an unparseable/absent
 * response the result is denied (fail closed).
 */
export async function runAutoReviewer(
	title: string,
	message: string,
	guardianPath = resolveGuardianPath(import.meta.url),
): Promise<ApprovalResult> {
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

	const { systemPrompt, model, tools } = definition;

	// Resolve pi binary
	const entry = process.argv[1];
	let command = "pi";
	let baseArgs: string[] = [];
	if (entry) {
		try {
			const realEntry = fs.realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				command = process.execPath;
				baseArgs = [realEntry];
			}
		} catch {}
	}

	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-guardian-"));
	const promptPath = path.join(tempDir, "guardian.md");
	await fs.promises.writeFile(promptPath, systemPrompt, { encoding: "utf-8", mode: 0o600 });

	const args = [
		...baseArgs,
		"--mode", "json",
		"-p",
		"--no-session",
		"--no-skills",
	];
	if (tools) {
		args.push("--tools", tools);
	} else {
		args.push("--no-tools");
	}
	if (model) {
		args.push("--model", model);
	}
	args.push(
		"--append-system-prompt", promptPath,
		task,
	);

	try {
		const output = await new Promise<string>((resolve, reject) => {
			const proc = cp.spawn(command, args, {
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 30000,
			});

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
			proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

			proc.on("error", (err: Error) => reject(err));
			proc.on("close", () => resolve(stdout));
		});

		// Parse JSON stream to find the final assistant message
		let content = "";
		const lines = output.split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const evt = JSON.parse(line);
				if (evt.type === "message_end" && evt.message?.role === "assistant") {
					const msg = evt.message.content;
					content = typeof msg === "string"
						? msg
						: Array.isArray(msg)
							? msg.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
							: "";
				}
			} catch {}
		}

		if (!content.trim()) {
			return { allowed: false, reason: "Guardian returned no response; blocked for safety." };
		}

		const verdict = parseGuardianVerdict(content);
		if (verdict === "unclear") {
			return { allowed: false, reason: "Guardian returned ambiguous response; blocked for safety." };
		}
		return verdict;
	} catch (err: any) {
		return { allowed: false, reason: `Guardian error: ${err.message || String(err)}` };
	} finally {
		// Cleanup temp dir
		try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
	}
}
