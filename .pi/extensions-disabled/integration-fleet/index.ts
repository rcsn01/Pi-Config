/**
 * Fleet Integration Extension
 *
 * Registers fleet/minion integrations and provides Fleet Mode via /fleet.
 * Codex is the primary fleet minion backend and is mounted from
 * ./integration-codex.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerCodexIntegration from "./integration-codex/index.ts";

interface FleetState {
	active: boolean;
	status: "idle" | "planning" | "deploying" | "stopped";
	objective?: string;
	setAt: number;
	stoppedAt?: number;
	shutdownCount?: number;
}

interface ManagedWorktreeSummary {
	branch?: string;
	path: string;
	branchId?: string;
	head?: string;
	managed: boolean;
}

const FLEET_CUSTOM_TYPE = "fleet-mode-state";
const WORKTREE_DIR = path.join(".pi", "worktrees");

const FLEET_MODE_PROMPT = `

## Fleet Mode Active

You are in FLEET MODE. Act as a fleet coordinator for multi-agent work.

When the user describes a goal, you MUST first coordinate rather than immediately implement:

1. **Understand the objective** — inspect only what is needed. If the user references Plane, use Plane tools to inspect the relevant project/module/work items.
2. **Decompose the work** — split the goal into independent work items suitable for separate minions.
3. **Plan the fleet** — decide:
   - how many worktrees are needed
   - safe branch/worktree IDs
   - how many Codex workers/minions are needed
   - what each worker should do
   - what each worker should verify
   - merge/review order and conflict risks
4. **Wait for approval** — present the fleet deployment plan and wait for explicit user approval before creating worktrees or launching write-capable Codex workers.
5. **Deploy after approval** — use worktree_create for each implementation workstream, then run codex_exec with cwd set to that specific worktree path. Do not run multiple write-capable minions in the same worktree.
6. **Report status** — summarize created worktrees, worker assignments, Codex outcomes, verification, remaining risks, and next merge/review steps.

Guardrails:
- Do not create worktrees or run codex_exec until the user approves the fleet plan.
- Use Codex as the primary fleet minion backend.
- Use worktree_list before creating or removing managed fleet worktrees.
- Keep each worker's file/module ownership explicit and non-overlapping.
- Never let separate minions edit the same checkout/worktree.
- /fleet toggles Fleet Mode. /fleet off shuts down Fleet Mode/fleet state after confirmation. /fleet status reports current fleet state.
`;

function isApprovalLike(text: string): boolean {
	return /^(approved|approve|go ahead|proceed|yes|y|ok|okay)\b/i.test(text.trim());
}

function reconstructFleetState(ctx: ExtensionContext): FleetState {
	let state: FleetState = { active: false, status: "idle", setAt: Date.now() };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== FLEET_CUSTOM_TYPE) continue;
		const data = entry.data as FleetState | undefined;
		if (data) state = data;
	}
	return state;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]) {
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0) {
		throw new Error(result.stderr?.trim() || result.stdout?.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function parseManagedWorktrees(stdout: string, root: string): ManagedWorktreeSummary[] {
	const base = path.join(root, WORKTREE_DIR);
	const worktrees: ManagedWorktreeSummary[] = [];
	let current: ManagedWorktreeSummary | undefined;

	const finish = () => {
		if (!current) return;
		const rel = path.relative(base, current.path);
		current.managed = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
		if (current.managed) current.branchId = rel.split(path.sep)[0];
		worktrees.push(current);
		current = undefined;
	};

	for (const line of stdout.split("\n")) {
		if (!line.trim()) {
			finish();
			continue;
		}
		const [key, ...rest] = line.split(" ");
		const value = rest.join(" ");
		if (key === "worktree") {
			finish();
			current = { path: value, managed: false };
		} else if (current && key === "branch") {
			current.branch = value.replace(/^refs\/heads\//, "");
		} else if (current && key === "HEAD") {
			current.head = value;
		}
	}
	finish();
	return worktrees.filter((wt) => wt.managed);
}

async function managedWorktrees(pi: ExtensionAPI, cwd: string): Promise<ManagedWorktreeSummary[]> {
	const root = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
	const stdout = await git(pi, root, ["worktree", "list", "--porcelain"]);
	return parseManagedWorktrees(stdout, root);
}

function formatStatus(state: FleetState, worktrees: ManagedWorktreeSummary[] | undefined, error?: string): string {
	const lines = [
		"Fleet Status",
		"============",
		`Mode:      ${state.active ? "active" : "inactive"}`,
		`State:     ${state.status}`,
		`Objective: ${state.objective || "(none recorded)"}`,
		`Set at:    ${new Date(state.setAt).toLocaleString()}`,
	];
	if (state.stoppedAt) lines.push(`Stopped:   ${new Date(state.stoppedAt).toLocaleString()}`);
	if (state.shutdownCount) lines.push(`Shutdowns: ${state.shutdownCount}`);
	lines.push("");
	lines.push("Managed worktrees:");
	if (error) {
		lines.push(`  Error: ${error}`);
	} else if (!worktrees || worktrees.length === 0) {
		lines.push("  (none)");
	} else {
		for (const wt of worktrees) {
			lines.push(`  - ${wt.branchId || "unknown"} (${wt.branch || "detached"})`);
			lines.push(`    path: ${wt.path}`);
			if (wt.head) lines.push(`    head: ${wt.head.slice(0, 12)}`);
		}
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	let fleetState: FleetState = { active: false, status: "idle", setAt: Date.now() };

	const persist = () => pi.appendEntry(FLEET_CUSTOM_TYPE, { ...fleetState });

	registerCodexIntegration(pi);

	pi.on("session_start", async (_event, ctx) => {
		fleetState = reconstructFleetState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		fleetState = reconstructFleetState(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("fleet", fleetState.active ? "🚢 FLEET" : undefined);
	});

	pi.on("before_agent_start", async (event) => {
		if (!fleetState.active) return;
		const prompt = event.prompt.trim();
		if (prompt && !prompt.startsWith("/") && !isApprovalLike(prompt)) {
			fleetState = {
				...fleetState,
				status: fleetState.status === "deploying" ? "deploying" : "planning",
				objective: prompt,
			};
			persist();
		}
		return { systemPrompt: event.systemPrompt + FLEET_MODE_PROMPT };
	});

	pi.registerCommand("fleet", {
		description: "Toggle Fleet Mode, shut down fleet, or show fleet status",
		handler: async (args, ctx) => {
			const sub = (args || "").trim().toLowerCase();

			if (sub === "status") {
				try {
					ctx.ui.notify(formatStatus(fleetState, await managedWorktrees(pi, ctx.cwd)), "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(formatStatus(fleetState, undefined, message), "warning");
				}
				return;
			}

			if (sub === "off") {
				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						"Shut down fleet?",
						"This exits Fleet Mode and marks the fleet as stopped. Existing .pi/worktrees/* checkouts and git branches are preserved.",
					);
					if (!ok) return;
				} else {
					ctx.ui.notify("Fleet shutdown requires interactive confirmation.", "warning");
					return;
				}

				fleetState = {
					...fleetState,
					active: false,
					status: "stopped",
					setAt: Date.now(),
					stoppedAt: Date.now(),
					shutdownCount: (fleetState.shutdownCount || 0) + 1,
				};
				persist();
				pi.events.emit("fleet:shutdown", { ...fleetState });
				ctx.ui.setStatus("fleet", undefined);
				ctx.ui.notify("Fleet shut down. Worktrees and branches were preserved.", "info");
				return;
			}

			if (sub) {
				ctx.ui.notify("Usage: /fleet | /fleet off | /fleet status", "warning");
				return;
			}

			fleetState = {
				...fleetState,
				active: !fleetState.active,
				status: fleetState.active ? "idle" : "planning",
				setAt: Date.now(),
			};
			persist();

			ctx.ui.notify(
				fleetState.active
					? "🚢 Fleet Mode active. Describe the objective; Pi will propose a fleet plan before deploying minions."
					: "Fleet Mode exited. Existing worktrees and branches were preserved.",
				"info",
			);
		},
	});
}
