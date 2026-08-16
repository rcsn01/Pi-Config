/**
 * Pure permission classification for the Safety Permissions extension.
 *
 * `evaluateToolCall` decides whether a single tool call is allowed or blocked
 * for the current mode. All side effects (user prompts, guardian runs, denial
 * tracking) are delegated to the injected `EvaluateDeps`, keeping this module
 * pure and table-testable.
 */
import {
	dangerousShellReason,
	evaluateExecPolicy,
	extractExternalPathsFromCommand,
	isNetworkCommand,
	isNetworkToolName,
	isReadOnlyShellCommand,
} from "../_shared/command-policy.ts";
import {
	ALL_PATH_TOOLS,
	PATH_READ_TOOLS,
	WRITE_TOOLS,
	extractPathsFromInput,
	isExternalWritePath,
	isPathWithinCwd,
	isSensitivePath,
	resolveToolPath,
} from "./path-policy.ts";
import type { EvaluateContext, EvaluateDeps, PermissionDecision, ToolCallInput } from "./policy-types.ts";

/** Stable identity for a tool call, used for one-shot /approve tracking. */
export function actionKey(toolName: string, input: unknown): string {
	return `${toolName}:${JSON.stringify(input ?? {})}`;
}

function commandOf(input: ToolCallInput): string {
	return (input.input && typeof input.input === "object"
		? (input.input as Record<string, unknown>).command
		: undefined) as string | undefined ?? "";
}

/**
 * Decide whether a tool call is allowed for the current mode.
 * Order of checks preserved from the original handler:
 *  1. execpolicy (bash, all modes)
 *  2. read-only: block write/network tools + path containment
 *  3. default: sensitive-path reads
 *  4. bash: read-only-command check + dangerous/network/external-path
 *  5. default: network tools
 *  6. default/auto-review: external path writes
 */
export async function evaluateToolCall(
	input: ToolCallInput,
	ctx: EvaluateContext,
	deps: EvaluateDeps,
): Promise<PermissionDecision> {
	const { toolName } = input;
	const { mode, cwd, hasUI, execPolicy } = ctx;

	// ── ExecPolicy check (bash only, all modes) ────────────────────
	if (toolName === "bash") {
		const command = commandOf(input);
		const policy = evaluateExecPolicy(command, execPolicy);

		if (policy.matched || execPolicy.defaultAction !== "allow") {
			if (policy.action === "block") {
				return { action: "block", reason: `Execpolicy blocked: ${policy.rule?.reason || "default block"}` };
			}
			if (policy.action === "prompt") {
				if (!hasUI) {
					return { action: "block", reason: `Execpolicy requires prompt: ${policy.rule?.reason || "default prompt"}` };
				}
				const proceed = await deps.requestApproval(
					policy.matched ? "Execpolicy Check" : "Execpolicy - Default Prompt",
					`${policy.matched ? `Rule matched: ${policy.rule?.reason || policy.rule?.pattern}` : "No allow rule matched; default action is prompt."}\n\nCommand: ${command.slice(0, 200)}\n\nProceed?`,
				);
				if (!proceed.allowed) {
					deps.onDenied(input, "Execpolicy Check", command.slice(0, 200));
					return { action: "block", reason: "User declined via execpolicy prompt." };
				}
			}
		}
	}

	// ── Read-only mode: block mutations ────────────────────────────
	if (mode === "read-only") {
		// Block write/mutating tools entirely
		if (WRITE_TOOLS.has(toolName)) {
			return {
				action: "block",
				reason: `Approval mode is read-only. Tool \`${toolName}\` is blocked. Use /permissions default to allow modifications.`,
			};
		}

		// Block network tools
		if (isNetworkToolName(toolName)) {
			return {
				action: "block",
				reason: `Approval mode is read-only. Network tool \`${toolName}\` is blocked.`,
			};
		}

		// Restrict path-based read tools to cwd only
		if (ALL_PATH_TOOLS.has(toolName)) {
			const inputPaths = extractPathsFromInput(toolName, input.input);
			for (const inputPath of inputPaths) {
				if (!isPathWithinCwd(inputPath, cwd)) {
					return {
						action: "block",
						reason: `Read-only mode: path "${inputPath}" is outside current directory (${cwd}). Only paths within the workspace are accessible.`,
					};
				}
			}
		}
	}

	// ── Sensitive path reads for default ───────────────────────────
	if (mode === "default" && PATH_READ_TOOLS.has(toolName)) {
		const inputPaths = extractPathsFromInput(toolName, input.input);
		for (const inputPath of inputPaths) {
			if (inputPath && isSensitivePath(inputPath)) {
				const message = `Tool \`${toolName}\` appears to read a sensitive path.\n\nPath: ${inputPath}`;
				const { allowed, reason } = await deps.requestApproval("Sensitive Path", message);
				if (!allowed) {
					deps.onDenied(input, "Sensitive Path", message);
					return { action: "block", reason: reason ?? "Sensitive path access blocked." };
				}
			}
		}
	}

	// ── Bash-specific checks across modes ──────────────────────────
	if (toolName === "bash") {
		const command = commandOf(input);
		const trimmedCmd = command.trim();

		// Read-only bash: only read-only commands allowed
		if (mode === "read-only" && !isReadOnlyShellCommand(trimmedCmd)) {
			return {
				action: "block",
				reason: `Approval mode is read-only. Command blocked: ${trimmedCmd.slice(0, 80)}. Use /permissions default to allow writes.`,
			};
		}

		// Default & auto-review: dangerous commands need approval
		if (mode === "default" || mode === "auto-review") {
			const dangerReason = dangerousShellReason(trimmedCmd);
			if (dangerReason) {
				if (mode === "auto-review") {
					const { allowed, reason } = await deps.guardianReview(
						"Dangerous Command",
						`Auto-review mode: ${dangerReason}\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
					);
					if (!allowed) {
						deps.onDenied(input, "Dangerous Command", trimmedCmd.slice(0, 200));
						return { action: "block", reason: reason ?? "Auto-review: dangerous command blocked." };
					}
				} else {
					const { allowed, reason } = await deps.requestApproval(
						"Dangerous Command",
						`Default mode detected: ${dangerReason}\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
					);
					if (!allowed) {
						deps.onDenied(input, "Dangerous Command", trimmedCmd.slice(0, 200));
						return { action: "block", reason: reason ?? "Blocked." };
					}
				}
			}

			// Network command detection (default: prompt; auto-review: prompt for install/modify commands)
			if (isNetworkCommand(trimmedCmd)) {
				if (mode === "auto-review") {
					const { allowed, reason } = await deps.guardianReview(
						"Network Command",
						`Command may install/modify software outside the workspace.\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
					);
					if (!allowed) {
						deps.onDenied(input, "Network Access", trimmedCmd.slice(0, 200));
						return { action: "block", reason: reason ?? "Auto-review: network command blocked." };
					}
				} else {
					const { allowed, reason } = await deps.requestApproval(
						"Network Access",
						`Command appears to require network access.\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
					);
					if (!allowed) {
						deps.onDenied(input, "Network Access", trimmedCmd.slice(0, 200));
						return { action: "block", reason: reason ?? "Network access blocked." };
					}
				}
			}

			// Auto-review: detect bash commands referencing paths outside the workspace
			if (mode === "auto-review") {
				const externalPaths = extractExternalPathsFromCommand(trimmedCmd, cwd);
				if (externalPaths.length > 0) {
					const pathList = externalPaths.slice(0, 5).join("\n");
					const extra = externalPaths.length > 5 ? `\n... and ${externalPaths.length - 5} more` : "";
					const { allowed, reason } = await deps.guardianReview(
						"External Path in Command",
						`Command references paths outside the workspace:\n${pathList}${extra}\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
					);
					if (!allowed) {
						deps.onDenied(input, "External Path", externalPaths[0]);
						return { action: "block", reason: reason ?? "Auto-review: external path command blocked." };
					}
				}
			}
		}
	}

	// ── Network tool checks for default ────────────────────────────
	if (mode === "default" && isNetworkToolName(toolName)) {
		const { allowed, reason } = await deps.requestApproval(
			"Network Tool",
			`Tool \`${toolName}\` requires network access.`,
		);
		if (!allowed) {
			deps.onDenied(input, "Network Tool", `Tool \`${toolName}\` requires network access.`);
			return { action: "block", reason: reason ?? "Network access blocked." };
		}
	}

	// ── External path writes for default / auto-review ─────────────
	if ((mode === "default" || mode === "auto-review") &&
		(toolName === "write" || toolName === "edit")) {
		const inputPaths = extractPathsFromInput(toolName, input.input);
		for (const inputPath of inputPaths) {
			if (inputPath && isExternalWritePath(inputPath)) {
				// Auto-review: prompt user directly for external writes (the ONE thing you care about)
				if (mode === "auto-review") {
					const { allowed, reason } = await deps.guardianReview(
						"External Write",
						`Path "${inputPath}" is outside the workspace.`,
					);
					if (!allowed) {
						deps.onDenied(input, "External Path", inputPath);
						return { action: "block", reason: reason ?? "Auto-review: external write blocked." };
					}
					continue;
				}
				// Default mode
				const { allowed, reason } = await deps.requestApproval(
					"External Path",
					`Default mode: path "${inputPath}" is outside workspace.\nAllow write?`,
				);
				if (!allowed) {
					deps.onDenied(input, "External Path", inputPath);
					return { action: "block", reason: reason ?? "Write to external path blocked." };
				}
			}
			// Also catch non-external paths that are still outside cwd
			if (inputPath && !isPathWithinCwd(inputPath, cwd) && !isExternalWritePath(inputPath)) {
				const resolved = resolveToolPath(inputPath, cwd);
				// Auto-review: prompt user directly
				if (mode === "auto-review") {
					const { allowed, reason } = await deps.guardianReview(
						"External Write",
						`Path "${inputPath}" (resolved: ${resolved}) is outside the workspace.`,
					);
					if (!allowed) {
						deps.onDenied(input, "External Path", inputPath);
						return { action: "block", reason: reason ?? "Auto-review: external write blocked." };
					}
					continue;
				}
				// Default mode
				const { allowed, reason } = await deps.requestApproval(
					"External Path",
					`Default mode: path "${inputPath}" (resolved: ${resolved}) is outside workspace.\nAllow write?`,
				);
				if (!allowed) {
					deps.onDenied(input, "External Path", inputPath);
					return { action: "block", reason: reason ?? "Write to external path blocked." };
				}
			}
		}
	}

	return { action: "allow" };
}
