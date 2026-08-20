import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeTranscriptContent, renderTranscriptCard } from "../_shared/transcript-card.ts";
import { registerWorkflowCommands } from "./lib/commands.ts";

export { defineWorkflow } from "./lib/definition.ts";
export type {
	WorkflowBudget,
	WorkflowCapabilities,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowAgentOptions,
	WorkflowParallelOptions,
	WorkflowPhaseDefinition,
} from "./lib/definition.ts";
export { loadAgents, runSubagent, runSubagentsParallel } from "./lib/subagent-runner.ts";

const CUSTOM_TYPE = "workflow-result";

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer(CUSTOM_TYPE, (message: any, options: any, theme: any) => {
		const details = message.details as {
			workflow?: string;
			runId?: string;
			background?: boolean;
		} | undefined;
		const workflow = details?.workflow ?? "workflow";
		return renderTranscriptCard(theme, {
			title: "Workflow result",
			state: "success",
			body: normalizeTranscriptContent(message.content),
			summary: `${workflow} completed · expand to view`,
			metadata: [
				`workflow: ${workflow}`,
				details?.runId ? `run: ${details.runId}` : undefined,
				details?.background ? "mode: background" : undefined,
			].filter((line): line is string => Boolean(line)),
			expanded: Boolean(options?.expanded),
		});
	});

	registerWorkflowCommands(pi);
}
