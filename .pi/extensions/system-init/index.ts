/**
 * Init Extension - Recreates Codex's `/init` command
 *
 * Generates an AGENTS.md scaffold in the current directory with
 * project context, instructions, and conventions for the agent.
 *
 * Commands:
 *   /init              - Generate AGENTS.md in current dir
 *   /init <dir>        - Generate AGENTS.md in specified subdirectory
 *   /init --global     - Generate global AGENTS.md in ~/.pi/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { safeJoin } from "../_shared/security.ts";

const AGENTS_TEMPLATE = `# Project Context

## Project Overview
<!-- Brief description of what this project is and its goals -->

## Tech Stack
<!-- Languages, frameworks, build tools, and infrastructure -->

## Project Structure
<!-- Key directories and their purposes -->

## Conventions
<!-- Coding style, naming conventions, patterns to follow -->

## Build & Test
<!-- How to build, test, lint, and run the project -->

## Environment Setup
<!-- Required tools, environment variables, initialization steps -->

## Key Constraints
<!-- Rules the agent should always follow (do's and don'ts) -->

## External Dependencies
<!-- APIs, services, or libraries the project depends on -->

## Notes
<!-- Gotchas, historical context, or important decisions -->

---

<!-- Edit this file with project-specific instructions. -->
<!-- The agent reads this file each session for context. -->
`;

const GLOBAL_TEMPLATE = `# Global Agent Instructions

## About Me
<!-- Your preferences, tools you use, your coding style -->

## Always
<!-- Rules that apply in every project -->

## Never
<!-- Things the agent should avoid in all projects -->

## My Environment
<!-- OS, shell, editor, and other defaults -->

## License Preferences
<!-- Preferred license type -->

## Git Preferences
<!-- Branch naming, commit style, workflow -->

---

<!-- This applies to ALL projects. -->
<!-- Override per-project with AGENTS.md in the project root. -->
`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "Generate an AGENTS.md scaffold with project context",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();

			if (trimmed === "--global") {
				const globalDir = path.join(os.homedir(), ".pi");
				const globalPath = path.join(globalDir, "AGENTS.md");

				if (!fs.existsSync(globalDir)) {
					fs.mkdirSync(globalDir, { recursive: true });
				}

				if (fs.existsSync(globalPath)) {
					if (ctx.hasUI) {
						const overwrite = await ctx.ui.confirm(
							"Overwrite?",
							`Global AGENTS.md already exists at ${globalPath}. Overwrite?`,
						);
						if (!overwrite) {
							ctx.ui.notify("Keeping existing global AGENTS.md.", "info");
							return;
						}
					} else {
						ctx.ui.notify(`Global AGENTS.md already exists at ${globalPath}.`, "warning");
						return;
					}
				}

				fs.writeFileSync(globalPath, GLOBAL_TEMPLATE);
				ctx.ui.notify(`Created global AGENTS.md at ${globalPath}`, "info");
				return;
			}

			const targetDir = trimmed
				? safeJoin(ctx.cwd, trimmed)
				: ctx.cwd;
			if (!targetDir) {
				ctx.ui.notify("/init only writes inside the current workspace. Use /init --global for global instructions.", "warning");
				return;
			}

			const agentsPath = path.join(targetDir, "AGENTS.md");

			if (!fs.existsSync(targetDir)) {
				ctx.ui.notify(`Directory does not exist: ${targetDir}`, "warning");
				return;
			}

			if (fs.existsSync(agentsPath)) {
				if (ctx.hasUI) {
					const overwrite = await ctx.ui.confirm(
						"Overwrite?",
						`AGENTS.md already exists at ${agentsPath}. Overwrite?`,
					);
					if (!overwrite) {
						ctx.ui.notify("Keeping existing AGENTS.md.", "info");
						return;
					}
				} else {
					ctx.ui.notify(`AGENTS.md already exists at ${agentsPath}.`, "warning");
					return;
				}
			}

			// Try to infer project name from directory
			const projectName = path.basename(targetDir);
			let template = AGENTS_TEMPLATE;
			if (projectName && projectName !== ".") {
				template = template.replace(
					"## Project Overview\n<!-- Brief description",
					`## Project Overview\n**${projectName}** - Brief description`,
				);
			}

			fs.writeFileSync(agentsPath, template);
			ctx.ui.notify(`Created AGENTS.md at ${agentsPath}\nEdit it with project-specific instructions.`, "info");
		},
	});
}
