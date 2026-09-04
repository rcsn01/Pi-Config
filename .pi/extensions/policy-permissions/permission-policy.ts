/**
 * Pure permission classification for the Safety Permissions extension.
 *
 * `evaluateToolCall` classifies one tool call for the current mode. The
 * permission enforcement lifecycle owns its ordering, side effects, and state;
 * this file keeps path and command classification readable.
 */
import {
	dangerousShellReason,
	evaluateExecPolicy,
	extractExternalPathsFromCommand,
	githubRepositorySnapshotOperation,
	mentionsGithubRepositorySnapshotHelper,
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
		const readOnlySnapshotOperation = toolName === "bash" ? githubRepositorySnapshotOperation(commandOf(input)) : undefined;

		// Block write/mutating tools entirely. Snapshot listing is a read-only
		// helper command even though it runs through the built-in bash tool.
		if (WRITE_TOOLS.has(toolName) && !(toolName === "bash" && readOnlySnapshotOperation === "list")) {
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
		const snapshotOperation = githubRepositorySnapshotOperation(trimmedCmd);
		const mentionsSnapshotHelper = mentionsGithubRepositorySnapshotHelper(trimmedCmd);

		// Do not let wrappers, aliases, path variants, or compound commands
		// bypass the helper's network/removal classifications.
		if ((mode === "default" || mode === "auto-review") && mentionsSnapshotHelper && !snapshotOperation) {
			return {
				action: "block",
				reason: "Unrecognized GitHub snapshot helper command. Use the exact command shown by the github-repo-explorer skill.",
			};
		}

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
			const network = isNetworkCommand(trimmedCmd);
			const externalPaths = mode === "auto-review"
				? extractExternalPathsFromCommand(trimmedCmd, cwd)
				: [];

			if (mode === "auto-review") {
				// Batch every concern into ONE guardian review per command.
				const triggers: string[] = [];
				const concerns: string[] = [];
				if (dangerReason) {
					triggers.push("dangerous");
					concerns.push(`- Dangerous: ${dangerReason}`);
				}
				if (network) {
					triggers.push("network");
					concerns.push("- Network: command may install/modify software outside the workspace");
				}
				if (snapshotOperation === "remove") {
					triggers.push("repository-snapshot-removal");
					concerns.push("- Repository snapshot removal: deletes a stored source snapshot");
				}
				if (externalPaths.length > 0) {
					triggers.push("external-path");
					const pathList = externalPaths.slice(0, 5).map((p) => `  - ${p}`).join("\n");
					const extra = externalPaths.length > 5 ? `\n  ... and ${externalPaths.length - 5} more` : "";
					concerns.push(`- External paths (outside workspace):\n${pathList}${extra}`);
				}
				if (triggers.length > 0) {
					const message = `Command: ${trimmedCmd.slice(0, 200)}\n\nConcerns:\n${concerns.join("\n")}`;
					const { allowed, reason } = await deps.guardianReview("Command Review", message, triggers);
					if (!allowed) {
						deps.onDenied(input, "Command Review", message);
						return { action: "block", reason: reason ?? "Auto-review: command blocked." };
					}
				}
			} else {
				// Default mode: per-trigger user prompts (unchanged)
				if (dangerReason) {
					const { allowed, reason } = await deps.requestApproval(
						"Dangerous Command",
						`Default mode detected: ${dangerReason}\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
					);
					if (!allowed) {
						deps.onDenied(input, "Dangerous Command", trimmedCmd.slice(0, 200));
						return { action: "block", reason: reason ?? "Blocked." };
					}
				}
				if (network) {
					const { allowed, reason } = await deps.requestApproval(
						"Network Access",
						`Command appears to require network access.\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
					);
					if (!allowed) {
						deps.onDenied(input, "Network Access", trimmedCmd.slice(0, 200));
						return { action: "block", reason: reason ?? "Network access blocked." };
					}
				}
				if (snapshotOperation === "remove") {
					const { allowed, reason } = await deps.requestApproval(
						"Repository Snapshot Removal",
						`This command deletes a stored repository source snapshot.\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
					);
					if (!allowed) {
						deps.onDenied(input, "Repository Snapshot Removal", trimmedCmd.slice(0, 200));
						return { action: "block", reason: reason ?? "Repository snapshot removal blocked." };
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

		if (mode === "auto-review") {
			// Batch every external path into ONE guardian review per tool call.
			const externalWrites: Array<{ path: string; detail: string }> = [];
			for (const inputPath of inputPaths) {
				if (!inputPath) continue;
				if (isExternalWritePath(inputPath)) {
					externalWrites.push({ path: inputPath, detail: `- ${inputPath} (outside the workspace)` });
				} else if (!isPathWithinCwd(inputPath, cwd)) {
					const resolved = resolveToolPath(inputPath, cwd);
					externalWrites.push({ path: inputPath, detail: `- ${inputPath} (resolved: ${resolved}, outside the workspace)` });
				}
			}
			if (externalWrites.length > 0) {
				const message = `Paths outside the workspace:\n${externalWrites.map((w) => w.detail).join("\n")}`;
				const { allowed, reason } = await deps.guardianReview("External Write", message, ["external-write"]);
				if (!allowed) {
					deps.onDenied(input, "External Path", externalWrites[0].path);
					return { action: "block", reason: reason ?? "Auto-review: external write blocked." };
				}
			}
		} else {
			// Default mode: per-path user prompts (unchanged)
			for (const inputPath of inputPaths) {
				if (inputPath && isExternalWritePath(inputPath)) {
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
	}

	return { action: "allow" };
}
