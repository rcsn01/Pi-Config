import type { PlaneClient } from "../plane/client.ts"
import type { PlaneWorkItem } from "../plane/types.ts"

export const findWorkItemByExternal = async (
	client: PlaneClient,
	projectId: string,
	externalSource: string,
	externalId: string,
) => {
	// List all and filter locally — Plane v1.2.2 CE ignores external_source/external_id query params
	const results = await client.listAll<PlaneWorkItem>(`/projects/${projectId}/issues/`)
	return results.find(
		(item) =>
			item.external_source === externalSource && item.external_id === externalId,
	) ?? null
}

export type WorkItemUpsertInput = {
	name: string
	description_html?: string
	state?: string
	external_source: string
	external_id: string
	priority?: string
}

export const createWorkItem = (
	client: PlaneClient,
	projectId: string,
	input: WorkItemUpsertInput,
) =>
	client.request<PlaneWorkItem>("POST", `/projects/${projectId}/issues/`, {
		body: input,
		isWrite: true,
	})

export const patchWorkItem = (
	client: PlaneClient,
	projectId: string,
	workItemId: string,
	input: Partial<WorkItemUpsertInput>,
) =>
	client.request<PlaneWorkItem>("PATCH", `/projects/${projectId}/issues/${workItemId}/`, {
		body: input,
		isWrite: true,
	})

export type WorkItemListOptions = {
	name?: string
	sequenceId?: number
	state?: string
}

export type WorkItemSummary = {
	id: string
	name: string
	sequence_id: number
	state: string
	priority: string | null
	external_source: string | null
	external_id: string | null
}

export const listWorkItems = async (
	client: PlaneClient,
	projectId: string,
	options: WorkItemListOptions = {},
): Promise<WorkItemSummary[]> => {
	const results = await client.listAll<PlaneWorkItem>(`/projects/${projectId}/issues/`)

	let filtered = results
	if (options.name) {
		const q = options.name.toLowerCase()
		filtered = filtered.filter((item) => item.name.toLowerCase().includes(q))
	}
	if (options.sequenceId != null) {
		filtered = filtered.filter((item) => item.sequence_id === options.sequenceId)
	}
	if (options.state) {
		const stateLower = options.state.toLowerCase()
		filtered = filtered.filter(
			(item) => (item.state ?? "").toLowerCase() === stateLower,
		)
	}

	return filtered.map((item) => ({
		id: item.id,
		name: item.name,
		sequence_id: item.sequence_id ?? 0,
		state: item.state ?? "unknown",
		priority: item.priority ?? null,
		external_source: item.external_source ?? null,
		external_id: item.external_id ?? null,
	}))
}

export const upsertWorkItem = async (
	client: PlaneClient,
	projectId: string,
	input: WorkItemUpsertInput,
) => {
	const existing = await findWorkItemByExternal(
		client,
		projectId,
		input.external_source,
		input.external_id,
	)
	if (existing) {
		const updated = await patchWorkItem(client, projectId, existing.id, input)
		return { action: "updated" as const, workItem: updated }
	}
	const created = await createWorkItem(client, projectId, input)
	return { action: "created" as const, workItem: created }
}
