/**
 * Thin Pi adapter for the Skill update lifecycle. It assembles real Git and Pi
 * interaction adapters, registers entry points, and renders background notices.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGit, type Git } from "./git.ts";
import {
	createSkillUpdateLifecycle,
	type SkillUpdateLifecycle,
} from "./skill-update-lifecycle.ts";
import { createPiSkillUpdateInteraction } from "./ui.ts";

const DEFAULT_EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

export interface SkillUpdateExtensionDependencies {
	extensionDir?: string;
	gitFactory?: () => Git;
	lifecycleFactory?: typeof createSkillUpdateLifecycle;
}

export function createSkillUpdateExtension(
	dependencies: SkillUpdateExtensionDependencies = {},
): (pi: ExtensionAPI) => void {
	const extensionDir = dependencies.extensionDir ?? DEFAULT_EXTENSION_DIR;
	const gitFactory = dependencies.gitFactory ?? createGit;
	const lifecycleFactory = dependencies.lifecycleFactory ?? createSkillUpdateLifecycle;

	return (pi: ExtensionAPI): void => {
		let backgroundPromise: Promise<void> | null = null;
		const lifecycleFor = (projectRoot: string): SkillUpdateLifecycle => lifecycleFactory({
			projectRoot,
			extensionDir,
			git: gitFactory(),
		});

		pi.on("session_start", (_event, ctx) => {
			if (backgroundPromise !== null) return;
			backgroundPromise = (async () => {
				try {
					const outcome = await lifecycleFor(ctx.cwd).checkInBackground(Date.now());
					if (outcome.kind === "checked" && outcome.updates.length > 0) {
						const count = outcome.updates.length;
						ctx.ui.notify(
							`update-skill: ${count} skill${count === 1 ? "" : "s"} ${count === 1 ? "has" : "have"} updates (${outcome.updates.join(", ")}). Run /update-skill`,
							"info",
						);
					}
				} catch (error) {
					console.error("[update-skill] background check failed:", error);
				}
			})();
		});

		pi.registerCommand("update-skill", {
			description: "Check and update the curated upstream skills installed from this repo",
			handler: async (_args, ctx) => {
				await lifecycleFor(ctx.cwd).runInteractive(createPiSkillUpdateInteraction(ctx));
			},
		});
	};
}

export default createSkillUpdateExtension();
