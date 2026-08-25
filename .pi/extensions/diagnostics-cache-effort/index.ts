import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { createChildTrialRunner } from "./child-runner.ts";
import {
	plannedCallCount,
	runExperiment,
	transportsForProvider,
	type ExperimentConfig,
	type ExperimentResult,
} from "./experiment.ts";
import {
	isExperimentResult,
	REPORT_ENTRY_TYPE,
	renderExperimentReport,
} from "./report.ts";
import { selectExperimentConfig } from "./selection.ts";

export interface CacheEffortExtensionDependencies {
	selectConfig?: (ctx: ExtensionCommandContext) => Promise<ExperimentConfig | undefined>;
	run?: (
		config: ExperimentConfig,
		options: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void },
	) => Promise<ExperimentResult>;
}

async function defaultRun(
	config: ExperimentConfig,
	options: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void },
): Promise<ExperimentResult> {
	return runExperiment(config, {
		runTrial: createChildTrialRunner({ provider: config.provider, modelId: config.modelId }),
		onProgress: (completed, total) => options.onProgress?.(completed, total),
	}, { signal: options.signal });
}

export function createCacheEffortExtension(dependencies: CacheEffortExtensionDependencies = {}) {
	const choose = dependencies.selectConfig ?? selectExperimentConfig;
	const run = dependencies.run ?? defaultRun;

	return (pi: ExtensionAPI) => {
		pi.registerEntryRenderer<ExperimentResult>(REPORT_ENTRY_TYPE, (entry, { expanded }, theme) => {
			return isExperimentResult(entry.data) ? renderExperimentReport(entry.data, expanded, theme) : undefined;
		});

		pi.registerCommand("cache-effort-test", {
			description: "Test whether changing OpenAI reasoning effort preserves prompt-cache reuse",
			handler: async (args, ctx) => {
				if (args.trim()) {
					ctx.ui.notify("Usage: /cache-effort-test", "warning");
					return;
				}
				if (ctx.mode !== "tui" || !ctx.hasUI) {
					ctx.ui.notify("/cache-effort-test requires the interactive TUI.", "warning");
					return;
				}

				let config: ExperimentConfig | undefined;
				try {
					config = await choose(ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
				if (!config) return;

				const calls = plannedCallCount(config.provider, config.runSize);
				const transports = transportsForProvider(config.provider).join(" + ");
				const confirmed = await ctx.ui.confirm(
					"Run prompt-cache effort test?",
					[
						`${config.provider}/${config.modelId} · ${config.effortA} ↔ ${config.effortB}`,
						`${config.runSize} · ${transports} · ${calls} sequential provider calls`,
						"This may consume subscription quota or incur API charges.",
						"The active model, tools, system prompt, and conversation context will not be changed.",
					].join("\n"),
				);
				if (!confirmed) return;
				await ctx.waitForIdle();

				const result = await ctx.ui.custom<ExperimentResult | undefined>((tui, theme, _keybindings, done) => {
					const loader = new BorderedLoader(
						tui,
						theme,
						`Testing prompt cache with ${calls} controlled calls...`,
					);
					loader.onAbort = () => {
						ctx.ui.setStatus("cache-effort", "cancelling cache test");
					};
					run(config!, {
						signal: loader.signal,
						onProgress: (completed, total) => ctx.ui.setStatus("cache-effort", `cache test ${completed}/${total}`),
					}).then(done).catch((error) => {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
						done(undefined);
					});
					return loader;
				});
				ctx.ui.setStatus("cache-effort", undefined);
				if (!result) return;
				pi.appendEntry(REPORT_ENTRY_TYPE, result);
			},
		});
	};
}

export default createCacheEffortExtension();
