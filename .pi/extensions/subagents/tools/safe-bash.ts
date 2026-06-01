/**
 * Safe bash extension for worker subagent.
 * Wraps the built-in bash tool with dangerous command blocking.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dangerousShellReason } from "../../_shared/command-policy.ts";

export default function (pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd());

	pi.registerTool({
		name: "safe_bash",
		label: "Safe Bash",
		description:
			"Execute a bash command. Blocks dangerous commands (rm -rf /, sudo, mkfs, etc.).",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const danger = dangerousShellReason(params.command);
			if (danger) {
				throw new Error(`Command blocked by safe_bash: ${danger}`);
			}
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
