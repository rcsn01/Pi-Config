/**
 * ui-terminal-name — keep the terminal title as "<repo name> - Pi".
 *
 * Pi's default terminal title is `pi - <session name> - <cwd>`. This
 * extension replaces it with a stable, repo-centric title so every pi
 * window is identifiable by project at a glance.
 *
 * The repo name is resolved as:
 * - the basename of the git repository root (`git rev-parse
 *   --show-toplevel`), so launching pi from a subdirectory still shows
 *   the repo name, or
 * - the basename of the current working directory when not inside a git
 *   repository.
 *
 * Two triggers:
 * - `session_start`: sets the title on launch and on every session
 *   switch (`/new`, `/resume`, `/reload`, fork).
 * - `session_info_changed`: re-applies the title after a session is
 *   named or renamed, since pi (and other extensions such as
 *   session-auto-name) update the terminal title on that event.
 *
 * `ctx.hasUI` guards print/JSON modes where `setTitle` is unavailable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { basename } from "node:path";

/**
 * Resolve the repo name for a working directory.
 *
 * Prefers the git repository root's basename; falls back to the cwd's
 * basename when the directory is not inside a git repository (or git is
 * unavailable).
 */
function resolveRepoName(cwd: string): string {
	try {
		const top = execSync("git rev-parse --show-toplevel", {
			cwd,
			stdio: "pipe",
		})
			.toString()
			.trim();
		if (top) return basename(top);
	} catch {
		// Not a git repository — fall through to the cwd basename.
	}
	return basename(cwd);
}

export default function (pi: ExtensionAPI) {
	const applyTitle = (ctx: { cwd: string; hasUI: boolean; ui: { setTitle: (title: string) => void } }) => {
		if (!ctx.hasUI) return;
		ctx.ui.setTitle(`${resolveRepoName(ctx.cwd)} - Pi`);
	};

	pi.on("session_start", (_event, ctx) => {
		applyTitle(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => {
		applyTitle(ctx);
	});
}
