/**
 * Pure permission classification for the Safety Permissions extension.
 *
 * `classifyToolCall` classifies one tool call for the current mode into an
 * ordered verdict: block decisions and interaction asks (user prompts, Guardian
 * reviews) as data. It performs no interaction — the permission enforcement
 * lifecycle resolves asks through its adapter seam, in order, short-circuiting
 * on the first denial. Verdicts are precomputable from
 * (input, mode, cwd, execPolicy); the execpolicy no-UI fail-closed block stays
 * classification-side.
 */
import {
	dangerousShellReason,
	evaluateExecPolicy,
	extractExternalPathsFromCommand,
	githubRepositorySnapshotOperation,
	isNetworkCommand,
	isNetworkToolName,
	isReadOnlyShellCommand,
	mentionsGithubRepositorySnapshotHelper,
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
import type { EvaluateContext, PermissionAsk, PermissionStep, ToolCallInput } from "./policy-types.ts";

function commandOf(input: ToolCallInput): string {
	return (input.input && typeof input.input === "object"
		? (input.input as Record<string, unknown>).command
		: undefined) as string | undefined ?? "";
}

/** User prompt: the denial record titles with the prompt; the reason comes from the approval result. */
function userAsk(
	title: string,
	message: string,
	denialMessage: string,
	fallback: string,
): PermissionAsk {
	return {
		kind: "ask",
		channel: "user",
		title,
		message,
		denial: { title, message: denialMessage },
		declinedReason: { kind: "fallback", reason: fallback },
	};
}

/** Guardian review: triggers travel with the ask; the denial record may differ from the prompt. */
function guardianAsk(
	title: string,
	message: string,
	triggers: readonly string[],
	denialTitle: string,
	denialMessage: string,
	fallback: string,
): PermissionAsk {
	return {
		kind: "ask",
		channel: "guardian",
		title,
		message,
		triggers,
		denial: { title: denialTitle, message: denialMessage },
		declinedReason: { kind: "fallback", reason: fallback },
	};
}

/**
 * Classify a tool call into an ordered verdict. Empty list = allowed by policy.
 * Order of checks preserved from the original handler:
 *  1. execpolicy (bash, all modes)
 *  2. read-only: block write/network tools + path containment
 *  3. default: sensitive-path reads
 *  4. bash: read-only-command check + dangerous/network/external-path
 *  5. default: network tools
 *  6. default/auto-review: external path writes
 */
export function classifyToolCall(
	input: ToolCallInput,
	ctx: EvaluateContext,
): readonly PermissionStep[] {
	const steps: PermissionStep[] = [];
	const { toolName } = input;
	const { mode, cwd, hasUI, execPolicy } = ctx;

	// ── ExecPolicy check (bash only, all modes) ────────────────────
	if (toolName === "bash") {
		const command = commandOf(input);
		const policy = evaluateExecPolicy(command, execPolicy);
		if (policy.matched || execPolicy.defaultAction !== "allow") {
			if (policy.action === "block") {
				steps.push({
					kind: "block",
					reason: `Execpolicy blocked: ${policy.rule?.reason || "default block"}`,
				});
			} else if (policy.action === "prompt") {
				if (!hasUI) {
					steps.push({
						kind: "block",
						reason: `Execpolicy requires prompt: ${policy.rule?.reason || "default prompt"}`,
					});
				} else {
					steps.push({
						kind: "ask",
						channel: "user",
						title: policy.matched ? "Execpolicy Check" : "Execpolicy - Default Prompt",
						message: `${policy.matched ? `Rule matched: ${policy.rule?.reason || policy.rule?.pattern}` : "No allow rule matched; default action is prompt."}\n\nCommand: ${command.slice(0, 200)}\n\nProceed?`,
						denial: { title: "Execpolicy Check", message: command.slice(0, 200) },
						declinedReason: { kind: "fixed", reason: "User declined via execpolicy prompt." },
					});
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
			steps.push({
				kind: "block",
				reason: `Approval mode is read-only. Tool \`${toolName}\` is blocked. Use /permissions default to allow modifications.`,
			});
		}

		// Block network tools
		if (isNetworkToolName(toolName)) {
			steps.push({
				kind: "block",
				reason: `Approval mode is read-only. Network tool \`${toolName}\` is blocked.`,
			});
		}

		// Restrict path-based read tools to cwd only
		if (ALL_PATH_TOOLS.has(toolName)) {
			const inputPaths = extractPathsFromInput(toolName, input.input);
			for (const inputPath of inputPaths) {
				if (!isPathWithinCwd(inputPath, cwd)) {
					steps.push({
						kind: "block",
						reason: `Read-only mode: path "${inputPath}" is outside current directory (${cwd}). Only paths within the workspace are accessible.`,
					});
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
				steps.push(userAsk("Sensitive Path", message, message, "Sensitive path access blocked."));
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
			steps.push({
				kind: "block",
				reason: "Unrecognized GitHub snapshot helper command. Use the exact command shown by the github-repo-explorer skill.",
			});
		}

		// Read-only bash: only read-only commands allowed
		if (mode === "read-only" && !isReadOnlyShellCommand(trimmedCmd)) {
			steps.push({
				kind: "block",
				reason: `Approval mode is read-only. Command blocked: ${trimmedCmd.slice(0, 80)}. Use /permissions default to allow writes.`,
			});
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
					const message = `Command: ${trimmedCmd}\n\nConcerns:\n${concerns.join("\n")}`;
					steps.push(guardianAsk("Command Review", message, triggers, "Command Review", message, "Auto-review: command blocked."));
				}
			} else {
				// Default mode: per-trigger user prompts (unchanged)
				if (dangerReason) {
					steps.push(userAsk(
						"Dangerous Command",
						`Default mode detected: ${dangerReason}\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
						trimmedCmd.slice(0, 200),
						"Blocked.",
					));
				}
				if (network) {
					steps.push(userAsk(
						"Network Access",
						`Command appears to require network access.\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
						trimmedCmd.slice(0, 200),
						"Network access blocked.",
					));
				}
				if (snapshotOperation === "remove") {
					steps.push(userAsk(
						"Repository Snapshot Removal",
						`This command deletes a stored repository source snapshot.\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
						trimmedCmd.slice(0, 200),
						"Repository snapshot removal blocked.",
					));
				}
			}
		}
	}

	// ── Network tool checks for default ────────────────────────────
	if (mode === "default" && isNetworkToolName(toolName)) {
		const message = `Tool \`${toolName}\` requires network access.`;
		steps.push(userAsk("Network Tool", message, message, "Network access blocked."));
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
				steps.push(guardianAsk(
					"External Write",
					message,
					["external-write"],
					"External Path",
					externalWrites[0].path,
					"Auto-review: external write blocked.",
				));
			}
		} else {
			// Default mode: per-path user prompts (unchanged)
			for (const inputPath of inputPaths) {
				if (inputPath && isExternalWritePath(inputPath)) {
					steps.push(userAsk(
						"External Path",
						`Default mode: path "${inputPath}" is outside workspace.\nAllow write?`,
						inputPath,
						"Write to external path blocked.",
					));
				}
				// Also catch non-external paths that are still outside cwd
				if (inputPath && !isPathWithinCwd(inputPath, cwd) && !isExternalWritePath(inputPath)) {
					const resolved = resolveToolPath(inputPath, cwd);
					steps.push(userAsk(
						"External Path",
						`Default mode: path "${inputPath}" (resolved: ${resolved}) is outside workspace.\nAllow write?`,
						inputPath,
						"Write to external path blocked.",
					));
				}
			}
		}
	}

	return steps;
}
