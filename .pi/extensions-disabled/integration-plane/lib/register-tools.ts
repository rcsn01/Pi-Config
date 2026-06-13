import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { loadPlaneConfig, configSummary } from "./plane/config.ts"
import { createPlaneClient } from "./plane/client.ts"
import { PlaneConfigError, PlaneApiError } from "./plane/errors.ts"
import { listProjects } from "./resources/projects.ts"
import { findWorkItemByExternal, upsertWorkItem, listWorkItems } from "./resources/work-items.ts"
import { listStates, resolveStateId } from "./resources/states.ts"
import { attachWorkItemFile, listWorkItemAttachments } from "./resources/attachments.ts"
import { syncNormalizedWorkspace } from "./sync/orchestrator.ts"
import { priorityFromProgress } from "./sync/mapping.ts"
import type { NormalizeOutput } from "./plane/types.ts"

const formatError = (error: unknown) => {
	if (error instanceof PlaneConfigError) return `Config: ${error.message}`
	if (error instanceof PlaneApiError)
		return `API ${error.status}: ${error.message}\n${error.body.slice(0, 500)}`
	return error instanceof Error ? error.message : String(error)
}

const withClient = async <T>(
	cwd: string,
	fn: (client: ReturnType<typeof createPlaneClient>) => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; text: string }> => {
	try {
		const config = loadPlaneConfig(cwd)
		const client = createPlaneClient(config)
		const data = await fn(client)
		return { ok: true, data }
	} catch (error) {
		return { ok: false, text: formatError(error) }
	}
}

export const registerPlaneTools = (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "plane_status",
		label: "Plane Status",
		description: "Check Plane REST API configuration (workspace, base URL, key present).",
		promptSnippet: "Check Plane API configuration",
		promptGuidelines: ["Use before syncing to verify Plane credentials are configured."],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			try {
				const config = loadPlaneConfig(ctx.cwd)
				const summary = configSummary(config)
				const client = createPlaneClient(config)
				await client.request("GET", "/projects/", { query: { per_page: "1" } })
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ ...summary, apiReachable: true }, null, 2),
						},
					],
				}
			} catch (error) {
				return { content: [{ type: "text", text: formatError(error) }] }
			}
		},
	})

	pi.registerTool({
		name: "plane_list_projects",
		label: "Plane List Projects",
		description: "List all projects in the configured Plane workspace.",
		promptSnippet: "List Plane projects",
		promptGuidelines: ["Use to resolve project names before upserting work items."],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const result = await withClient(ctx.cwd, listProjects)
			if (!result.ok) return { content: [{ type: "text", text: result.text }] }
			return {
				content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
			}
		},
	})

	pi.registerTool({
		name: "plane_find_work_item",
		label: "Plane Find Work Item",
		description: "Find a work item by external_source and external_id within a project.",
		promptSnippet: "Find Plane work item by external ID",
		promptGuidelines: ["Match by external_source + external_id before creating duplicates."],
		parameters: Type.Object({
			project_id: Type.String({ description: "Plane project UUID" }),
			external_source: Type.String(),
			external_id: Type.String(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withClient(ctx.cwd, (client) =>
				findWorkItemByExternal(
					client,
					params.project_id,
					params.external_source,
					params.external_id,
				),
			)
			if (!result.ok) return { content: [{ type: "text", text: result.text }] }
			return {
				content: [
					{
						type: "text",
						text: result.data ? JSON.stringify(result.data, null, 2) : "Not found",
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "plane_upsert_work_item",
		label: "Plane Upsert Work Item",
		description:
			"Create or update a work item matched by external_source + external_id.",
		promptSnippet: "Upsert Plane work item",
		promptGuidelines: [
			"Always set external_source and external_id for idempotent sync.",
			"Writes are sequential; do not parallelize Plane API calls.",
		],
		parameters: Type.Object({
			project_id: Type.String(),
			name: Type.String(),
			external_source: Type.String(),
			external_id: Type.String(),
			status: Type.Optional(Type.String({ description: "Maps to a project state name" })),
			description_html: Type.Optional(Type.String()),
			progress: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withClient(ctx.cwd, async (client) => {
				let stateId: string | undefined
				if (params.status) {
					const states = await listStates(client, params.project_id)
					stateId = resolveStateId(states, params.status) ?? undefined
				}
				return upsertWorkItem(client, params.project_id, {
					name: params.name,
					external_source: params.external_source,
					external_id: params.external_id,
					state: stateId,
					description_html: params.description_html,
					priority:
						params.progress != null
							? priorityFromProgress(params.progress)
							: undefined,
				})
			})
			if (!result.ok) return { content: [{ type: "text", text: result.text }] }
			return {
				content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
			}
		},
	})

	pi.registerTool({
		name: "plane_list_work_items",
		label: "Plane List Work Items",
		description:
			"List work items in a Plane project. Supports optional filters: name (substring match), sequence_id (number), state (state name).",
		promptSnippet: "List Plane work items in a project",
		promptGuidelines: [
			"Use to browse work items when external_source/external_id is unknown.",
			"Filter by name substring to find items by partial name match.",
		],
		parameters: Type.Object({
			project_id: Type.String({ description: "Plane project UUID" }),
			name: Type.Optional(Type.String({ description: "Filter: substring match on item name" })),
			sequence_id: Type.Optional(Type.Number({ description: "Filter: exact match on sequence ID (e.g., 9 for TTSP-9)" })),
			state: Type.Optional(Type.String({ description: "Filter: match on state name (e.g., 'Backlog', 'In Progress')" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withClient(ctx.cwd, (client) =>
				listWorkItems(client, params.project_id, {
					name: params.name,
					sequenceId: params.sequence_id,
					state: params.state,
				}),
			)
			if (!result.ok) return { content: [{ type: "text", text: result.text }] }
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result.data, null, 2),
					},
				],
			}
		},
	})

	pi.registerTool({
		name: "plane_attach_work_item_file",
		label: "Plane Attach Work Item File",
		description:
			"Attach a local file to a Plane work item/issue via the Plane attachment API.",
		promptSnippet: "Attach a local file to a Plane work item",
		promptGuidelines: [
			"Use when the user asks to upload or attach a file to a Plane work item.",
			"Resolve project_id and issue_id before attaching; sequence keys like TTSP-9 are not issue UUIDs.",
			"For Markdown files, prefer text/plain if text/markdown is rejected by the Plane server.",
		],
		parameters: Type.Object({
			project_id: Type.String({ description: "Plane project UUID" }),
			issue_id: Type.String({ description: "Plane work item/issue UUID" }),
			file_path: Type.String({ description: "Local path to the file, relative to the current workspace" }),
			mime_type: Type.Optional(Type.String({ description: "Optional MIME type override; .md defaults to text/plain" })),
			external_source: Type.Optional(Type.String({ description: "Optional external source for idempotent attachment tracking" })),
			external_id: Type.Optional(Type.String({ description: "Optional external ID for idempotent attachment tracking" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withClient(ctx.cwd, (client) =>
				attachWorkItemFile(client, {
					projectId: params.project_id,
					issueId: params.issue_id,
					filePath: params.file_path,
					cwd: ctx.cwd,
					mimeType: params.mime_type,
					externalSource: params.external_source,
					externalId: params.external_id,
				}),
			)
			if (!result.ok) return { content: [{ type: "text", text: result.text }] }
			return {
				content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
			}
		},
	})

	pi.registerTool({
		name: "plane_list_work_item_attachments",
		label: "Plane List Work Item Attachments",
		description: "List file attachments for a Plane work item/issue.",
		promptSnippet: "List Plane work item attachments",
		promptGuidelines: [
			"Use to verify files attached to a Plane work item.",
			"Requires the Plane issue UUID, not a sequence key like TTSP-9.",
		],
		parameters: Type.Object({
			project_id: Type.String({ description: "Plane project UUID" }),
			issue_id: Type.String({ description: "Plane work item/issue UUID" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withClient(ctx.cwd, (client) =>
				listWorkItemAttachments(client, params.project_id, params.issue_id),
			)
			if (!result.ok) return { content: [{ type: "text", text: result.text }] }
			return {
				content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
			}
		},
	})

	pi.registerTool({
		name: "plane_sync_workspace",
		label: "Plane Sync Workspace",
		description:
			"Sync normalized local progress JSON into Plane (work items by external_id). Pass output from plane_normalize_sources.",
		promptSnippet: "Sync normalized progress to Plane",
		promptGuidelines: [
			"Run plane_normalize_sources first.",
			"Saved Views must be created manually in the Plane UI.",
		],
		parameters: Type.Object({
			normalized: Type.Any(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withClient(ctx.cwd, (client) =>
				syncNormalizedWorkspace(client, params.normalized as NormalizeOutput),
			)
			if (!result.ok) return { content: [{ type: "text", text: result.text }] }
			return {
				content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
			}
		},
	})
}

export const formatSyncReports = (
	reports: Awaited<ReturnType<typeof syncNormalizedWorkspace>>,
) => {
	const lines: string[] = ["Plane sync complete", ""]
	for (const r of reports) {
		lines.push(`Project: ${r.projectName} (${r.projectId || "not found"})`)
		lines.push(`  created: ${r.created}, updated: ${r.updated}, skipped: ${r.skipped}`)
		if (r.viewsManual) lines.push("  views: create manually in Plane UI")
		if (r.errors.length) {
			lines.push("  errors:")
			for (const e of r.errors.slice(0, 10)) lines.push(`    - ${e}`)
			if (r.errors.length > 10) lines.push(`    ... and ${r.errors.length - 10} more`)
		}
		lines.push("")
	}
	return lines.join("\n")
}
