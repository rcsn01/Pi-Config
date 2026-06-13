/**
 * Integration Plane — Pi extension for Plane REST API + project-manager skills.
 *
 * Commands:
 *   /plane                  - Help
 *   /plane on|off           - Toggle Plane guidance in the system prompt
 *   /plane status           - Show Plane API config + connectivity
 *   /plane sync             - Normalize local progress and sync to Plane (REST)
 *   /plane normalize        - Run read-only progress normalizer (JSON)
 *   /plane plan-surfaces    - Run read-only Plane surface planner (JSON)
 *   /plane doc <mapping|surfaces|runbook> - Print a reference doc
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import * as fs from "node:fs"
import * as path from "node:path"
import { loadPlaneConfig, configSummary } from "./lib/plane/config.ts"
import { createPlaneClient } from "./lib/plane/client.ts"
import { PlaneConfigError } from "./lib/plane/errors.ts"
import { registerPlaneTools, formatSyncReports } from "./lib/register-tools.ts"
import { syncNormalizedWorkspace } from "./lib/sync/orchestrator.ts"
import type { NormalizeOutput } from "./lib/plane/types.ts"

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname)
const SKILL_DIR = path.join(EXT_DIR, "skills", "plane-project-manager")
const SKILL_PATH = path.join(SKILL_DIR, "SKILL.md")
const SCRIPTS_DIR = path.join(SKILL_DIR, "scripts")
const REFERENCES_DIR = path.join(SKILL_DIR, "references")

const PLANE_GUIDANCE_HEADER = `

## Plane Project Manager (integration-plane)

You are helping sync or manage Project-Manager-style progress in **Plane** using the bundled REST tools (\`plane_*\`).
Plane is the UI; do not build a separate dashboard.

Workflow:
1. \`plane_normalize_sources\` or \`/plane normalize\` — local progress JSON (read-only).
2. \`plane_plan_surfaces\` or \`/plane plan-surfaces\` — modules/pages/cycles plan (read-only).
3. \`plane_sync_workspace\` or \`/plane sync\` — upsert work items by external_source + external_id.
4. \`plane_status\`, \`plane_list_projects\`, \`plane_find_work_item\`, \`plane_upsert_work_item\` for targeted edits.

References: \`/plane doc runbook|mapping|surfaces\`. Saved **Views** have no public create API — create them manually in Plane.

Guardrails: no parallel Plane writes; never log API keys; writes are throttled (429 retries once after 30s).
`

const readText = (filePath: string) => fs.readFileSync(filePath, "utf8")

const runPythonScript = async (
	pi: ExtensionAPI,
	scriptName: string,
	cwd: string,
): Promise<string> => {
	const scriptPath = path.join(SCRIPTS_DIR, scriptName)
	if (!fs.existsSync(scriptPath)) {
		throw new Error(`Missing script: ${scriptPath}`)
	}
	const result = await pi.exec("python3", [scriptPath, "--root", cwd, "--json"], { cwd })
	if (result.code !== 0) {
		throw new Error(
			result.stderr?.trim() || result.stdout?.trim() || `Script failed: ${scriptName}`,
		)
	}
	return result.stdout.trim()
}

const printReference = (
	ctx: { ui: { notify: (message: string, level: string) => void } },
	name: string,
) => {
	const files: Record<string, string> = {
		mapping: "plane_mapping.md",
		surfaces: "plane_surfaces.md",
		runbook: "sync_runbook.md",
	}
	const file = files[name]
	if (!file) {
		ctx.ui.notify("Usage: /plane doc <mapping|surfaces|runbook>", "warning")
		return
	}
	const filePath = path.join(REFERENCES_DIR, file)
	if (!fs.existsSync(filePath)) {
		ctx.ui.notify(`Reference not found: ${file}`, "error")
		return
	}
	ctx.ui.notify(readText(filePath), "info")
}

const showPlaneStatus = async (
	ctx: { cwd: string; ui: { notify: (message: string, level: string) => void } },
) => {
	try {
		const config = loadPlaneConfig(ctx.cwd)
		const summary = configSummary(config)
		const client = createPlaneClient(config)
		await client.request("GET", "/projects/", { query: { per_page: "1" } })
		ctx.ui.notify(
			[
				"Plane REST API",
				`  workspace: ${summary.workspaceSlug}`,
				`  base URL:  ${summary.baseUrl}`,
				`  API key:   configured`,
				`  reachable: yes`,
			].join("\n"),
			"info",
		)
	} catch (error) {
		const message =
			error instanceof PlaneConfigError
				? error.message
				: error instanceof Error
					? error.message
					: String(error)
		ctx.ui.notify(`Plane not ready:\n${message}`, "warning")
	}
}

const runPlaneSync = async (pi: ExtensionAPI, cwd: string) => {
	const json = await runPythonScript(pi, "normalize_progress_sources.py", cwd)
	const normalized = JSON.parse(json) as NormalizeOutput
	const config = loadPlaneConfig(cwd)
	const client = createPlaneClient(config)
	const reports = await syncNormalizedWorkspace(client, normalized)
	return formatSyncReports(reports)
}

export default function (pi: ExtensionAPI) {
	let planeGuidanceActive = false

	registerPlaneTools(pi)

	pi.on("before_agent_start", async (event) => {
		if (!planeGuidanceActive) return
		const skill = fs.existsSync(SKILL_PATH) ? readText(SKILL_PATH) : ""
		return {
			systemPrompt: `${event.systemPrompt}${PLANE_GUIDANCE_HEADER}\n\n${skill}`,
		}
	})

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("plane", planeGuidanceActive ? "✈ PLANE" : undefined)
	})

	pi.registerTool({
		name: "plane_normalize_sources",
		label: "Plane Normalize Sources",
		description:
			"Normalize local .project-manager and roadmap.ts progress sources into JSON for Plane sync planning. Read-only; does not call Plane.",
		promptSnippet: "Normalize local progress sources for Plane",
		promptGuidelines: [
			"Use before a Plane sync to inspect local feature rows, phases, progress, and stable external IDs.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const json = await runPythonScript(pi, "normalize_progress_sources.py", ctx.cwd)
				return {
					content: [{ type: "text", text: json }],
					details: { script: "normalize_progress_sources.py" },
				}
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error)
				return { content: [{ type: "text", text: `Error: ${message}` }] }
			}
		},
	})

	pi.registerTool({
		name: "plane_plan_surfaces",
		label: "Plane Plan Surfaces",
		description:
			"Plan Plane modules, views, pages, cycles, and intake policy from local repo data. Read-only; does not call Plane.",
		promptSnippet: "Plan Plane modules, views, pages, cycles",
		promptGuidelines: [
			"Use before enriching a Plane project with modules, views, pages, cycles, or intake beyond plain work items.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const json = await runPythonScript(pi, "plan_plane_surfaces.py", ctx.cwd)
				return {
					content: [{ type: "text", text: json }],
					details: { script: "plan_plane_surfaces.py" },
				}
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error)
				return { content: [{ type: "text", text: `Error: ${message}` }] }
			}
		},
	})

	const showHelp = (ctx: { ui: { notify: (message: string, level: string) => void } }) => {
		ctx.ui.notify(
			[
				"integration-plane — Plane Project Manager (REST API)",
				"",
				"/plane on|off        Toggle Plane guidance",
				"/plane status        Config + API connectivity",
				"/plane sync          Normalize + sync work items to Plane",
				"/plane normalize     Local progress JSON",
				"/plane plan-surfaces Modules/views/pages plan JSON",
				"/plane doc mapping|surfaces|runbook",
				"",
				"Config: PLANE_API_KEY, PLANE_WORKSPACE_SLUG, PLANE_BASE_URL",
				"        or .pi/plane.json (see plane.json.example)",
				"Views: create manually in Plane UI (no public create API).",
			].join("\n"),
			"info",
		)
	}

	pi.registerCommand("plane", {
		description: "Plane project-manager integration (REST sync, normalize, plan surfaces)",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean)
			const sub = (parts[0] || "").toLowerCase()

			if (!sub) {
				showHelp(ctx)
				return
			}

			if (sub === "on") {
				planeGuidanceActive = true
				ctx.ui.notify("Plane guidance enabled for subsequent turns.", "info")
				return
			}

			if (sub === "off") {
				planeGuidanceActive = false
				ctx.ui.notify("Plane guidance disabled.", "info")
				return
			}

			if (sub === "status") {
				await showPlaneStatus(ctx)
				return
			}

			if (sub === "sync") {
				planeGuidanceActive = true
				try {
					const report = await runPlaneSync(pi, ctx.cwd)
					ctx.ui.notify(report, "info")
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error)
					ctx.ui.notify(message, "error")
				}
				return
			}

			if (sub === "normalize") {
				try {
					const json = await runPythonScript(pi, "normalize_progress_sources.py", ctx.cwd)
					if (json.length > 6000 && ctx.hasUI) {
						pi.sendUserMessage(
							`Here is the normalized local progress JSON for Plane sync planning:\n\`\`\`json\n${json.slice(0, 12000)}\n\`\`\``,
						)
					} else {
						ctx.ui.notify(json, "info")
					}
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error)
					ctx.ui.notify(message, "error")
				}
				return
			}

			if (sub === "plan-surfaces" || sub === "plan") {
				try {
					const json = await runPythonScript(pi, "plan_plane_surfaces.py", ctx.cwd)
					if (json.length > 6000 && ctx.hasUI) {
						pi.sendUserMessage(
							`Here is the Plane surface plan JSON:\n\`\`\`json\n${json.slice(0, 12000)}\n\`\`\``,
						)
					} else {
						ctx.ui.notify(json, "info")
					}
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error)
					ctx.ui.notify(message, "error")
				}
				return
			}

			if (sub === "doc") {
				printReference(ctx, (parts[1] || "").toLowerCase())
				return
			}

			if (sub === "help") {
				showHelp(ctx)
				return
			}

			ctx.ui.notify(`Unknown /plane subcommand: ${sub}. Use /plane help.`, "warning")
		},
	})
}
