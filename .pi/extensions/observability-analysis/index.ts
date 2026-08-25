import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAnalysisRuntime, type AnalysisRuntime } from "./runtime.ts";

export interface AnalysisExtensionDependencies {
	createRuntime?: (notify: (message: string) => void) => AnalysisRuntime;
}

export function createAnalysisExtension(dependencies: AnalysisExtensionDependencies = {}) {
	return (pi: ExtensionAPI) => {
		let notify = (_message: string) => {};
		const runtime = dependencies.createRuntime?.((message) => notify(message))
			?? createAnalysisRuntime({ notify: (message) => notify(message) });

		pi.registerCommand("analysis", {
			description: "Start the local provider request analysis dashboard",
			handler: async (args, ctx) => {
				notify = (message) => ctx.ui.notify(message, "warning");
				if (args.trim()) {
					ctx.ui.notify("Usage: /analysis", "warning");
					return;
				}
				try {
					const { url } = await runtime.start();
					ctx.ui.notify(`Provider request analysis is active. Treat this URL as a secret:\n${url}`, "info");
				} catch (error) {
					ctx.ui.notify(`Could not start request analysis: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		});

		pi.on("agent_start", (event) => runtime.observe({ type: "agent_start" }));
		pi.on("turn_start", (event) => runtime.observe({ type: "turn_start", turnIndex: event.turnIndex, at: event.timestamp }));
		pi.on("before_provider_request", (event, ctx) => {
			const model = ctx.model;
			if (!model) return;
			runtime.observe({
				type: "request",
				provider: model.provider,
				api: model.api,
				model: model.id,
				payload: event.payload,
			});
			// Observation only. Returning undefined preserves the provider payload.
		});
		pi.on("after_provider_response", (event) => {
			runtime.observe({ type: "response", status: event.status });
		});
		pi.on("message_end", (event) => {
			if (event.message.role === "assistant") runtime.observe({ type: "assistant", message: event.message });
			// Observation only. Returning undefined preserves the finalized message.
		});
		pi.on("session_shutdown", async () => runtime.close());
	};
}

export default createAnalysisExtension();
