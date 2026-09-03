import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openInBrowser } from "../_shared/browser.ts";
import { getObservabilityService } from "../_shared/observability.ts";
import { registerAnalysisObservationAdapter } from "./observation-adapter.ts";
import {
	getPersistentAnalysisRuntime,
	persistentAnalysisRuntime,
	type AnalysisRuntime,
	type AnalysisRuntimeStore,
} from "./runtime.ts";

export interface AnalysisExtensionDependencies {
	createRuntime?: (notify: (message: string) => void) => AnalysisRuntime;
	/** Best-effort opener for the dashboard URL; must not throw. Defaults to spawning the platform browser opener. */
	openUrl?: (url: string) => void;
}

export function createAnalysisExtension(dependencies: AnalysisExtensionDependencies = {}) {
	return (pi: ExtensionAPI) => {
		let notify = (_message: string) => {};
		const usesPersistentRuntime = !dependencies.createRuntime;
		const runtime = dependencies.createRuntime?.((message) => notify(message))
			?? getPersistentAnalysisRuntime((message) => notify(message));
		const lifecycle = runtime as Partial<Pick<AnalysisRuntimeStore, "isActive" | "setNotify">>;
		const observability = getObservabilityService();
		registerAnalysisObservationAdapter(pi, { observability });
		let unsubscribe: (() => void) | undefined;
		let locallyActive = false;
		const attach = () => {
			lifecycle.setNotify?.((message) => notify(message));
			if (!(lifecycle.isActive?.() ?? locallyActive) || unsubscribe) return;
			unsubscribe = observability.activate((event) => runtime.observe(event));
		};
		const detach = () => {
			unsubscribe?.();
			unsubscribe = undefined;
			lifecycle.setNotify?.(undefined);
		};
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
					(dependencies.openUrl ?? openInBrowser)(url);
					locallyActive = true;
					attach();
					ctx.ui.notify(`Provider request analysis is active. Treat this URL as a secret:\n${url}`, "info");
				} catch (error) {
					ctx.ui.notify(`Could not start request analysis: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		});

		pi.on("session_start", (_event, ctx) => {
			notify = (message) => ctx.ui.notify(message, "warning");
			attach();
		});
		pi.on("session_shutdown", async (event) => {
			detach();
			locallyActive = false;
			if (usesPersistentRuntime) {
				await persistentAnalysisRuntime.dispose(runtime as AnalysisRuntimeStore, {
					permanent: event.reason === "quit",
				});
				return;
			}
			if (event.reason === "quit") await runtime.close();
		});
	};
}

export default createAnalysisExtension();
