import type { PlaneClient } from "../plane/client.ts"
import type { PlanePage } from "../plane/types.ts"

export const findPageByExternal = async (
	client: PlaneClient,
	projectId: string,
	externalSource: string,
	externalId: string,
) => {
	const pages = await client.listAll<PlanePage>(`/projects/${projectId}/pages/`)
	return (
		pages.find(
			(p) => p.external_source === externalSource && p.external_id === externalId,
		) ?? null
	)
}

export const createPage = (
	client: PlaneClient,
	projectId: string,
	input: { name: string; external_source: string; external_id: string },
) =>
	client.request<PlanePage>("POST", `/projects/${projectId}/pages/`, {
		body: input,
		isWrite: true,
	})
