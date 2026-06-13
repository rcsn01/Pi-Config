import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
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
	pi.registerMessageRenderer(CUSTOM_TYPE, (message: any, _options: any, theme: any) => {
		const c = new Container();
		c.addChild(new Text(theme.fg("toolTitle", theme.bold("Workflow result")), 0, 0));
		c.addChild(new Spacer(1));
		c.addChild(new Markdown(String(message.content || ""), 0, 0, getMarkdownTheme()));
		return c;
	});

	registerWorkflowCommands(pi);
}
