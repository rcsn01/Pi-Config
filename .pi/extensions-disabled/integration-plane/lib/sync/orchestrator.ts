import type { PlaneClient } from "../plane/client.ts"
import type { NormalizeOutput, SyncReport } from "../plane/types.ts"
import { findProjectByName } from "../resources/projects.ts"
import { listStates, resolveStateId } from "../resources/states.ts"
import { upsertWorkItem } from "../resources/work-items.ts"
import { buildWorkItemDescription, priorityFromProgress } from "./mapping.ts"

export const syncNormalizedWorkspace = async (
	client: PlaneClient,
	normalized: NormalizeOutput,
): Promise<SyncReport[]> => {
	const reports: SyncReport[] = []

	for (const source of normalized.sources) {
		const report: SyncReport = {
			projectId: "",
			projectName: source.project_name,
			created: 0,
			updated: 0,
			skipped: 0,
			errors: [],
			viewsManual: true,
			modulesCreated: 0,
			pagesCreated: 0,
		}

		const project = await findProjectByName(client, source.project_name)
		if (!project) {
			report.errors.push(`Project not found in Plane: ${source.project_name}`)
			reports.push(report)
			continue
		}
		report.projectId = project.id

		const states = await listStates(client, project.id)

		for (const item of source.items) {
			try {
				const stateId = resolveStateId(states, item.status)
				if (!stateId) {
					report.skipped += 1
					report.errors.push(`No state for ${item.external_id} (status: ${item.status})`)
					continue
				}

				const result = await upsertWorkItem(client, project.id, {
					name: item.name,
					description_html: buildWorkItemDescription(item),
					state: stateId,
					external_source: item.external_source,
					external_id: item.external_id,
					priority: priorityFromProgress(item.progress),
				})

				if (result.action === "created") report.created += 1
				else report.updated += 1
			} catch (error) {
				report.skipped += 1
				const message = error instanceof Error ? error.message : String(error)
				report.errors.push(`${item.external_id}: ${message}`)
			}
		}

		reports.push(report)
	}

	return reports
}
