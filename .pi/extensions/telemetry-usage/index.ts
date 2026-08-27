import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	closePersistentTelemetryUsageRuntime,
	getPersistentTelemetryUsageRuntime,
	releasePersistentTelemetryUsageRuntime,
	type TelemetryUsageRuntime,
	type TelemetryUsageRuntimeStore,
} from "./runtime.ts";

export interface TelemetryUsageExtensionDependencies {
	createRuntime?: () => TelemetryUsageRuntime;
}

export function createTelemetryUsageExtension(
	dependencies: TelemetryUsageExtensionDependencies = {},
) {
	return (pi: ExtensionAPI) => {
		const usesPersistentRuntime = !dependencies.createRuntime;
		const runtime = dependencies.createRuntime?.() ?? getPersistentTelemetryUsageRuntime();

		pi.registerCommand("global-usage", {
			description: "Start the local global usage dashboard",
			handler: async (args, ctx) => {
				if (args.trim()) {
					ctx.ui.notify("Usage: /global-usage", "warning");
					return;
				}
				try {
					const { url } = await runtime.start();
					ctx.ui.notify(`Global usage dashboard is active. Treat this URL as a secret:\n${url}`, "info");
				} catch (error) {
					ctx.ui.notify(
						`Could not start global usage dashboard: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});

		pi.on("session_shutdown", async (event) => {
			if (usesPersistentRuntime) {
				const persistent = runtime as TelemetryUsageRuntimeStore;
				if (event.reason === "quit") await closePersistentTelemetryUsageRuntime(persistent);
				else releasePersistentTelemetryUsageRuntime(persistent);
				return;
			}
			if (event.reason === "quit") await runtime.close();
		});
	};
}

export default createTelemetryUsageExtension();
