import type { PlaneClient } from "../plane/client.ts"
import type { PlaneModule } from "../plane/types.ts"

export const listModules = (client: PlaneClient, projectId: string) =>
	client.listAll<PlaneModule>(`/projects/${projectId}/modules/`)

export const findModuleByName = async (client: PlaneClient, projectId: string, name: string) => {
	const needle = name.trim().toLowerCase()
	const modules = await listModules(client, projectId)
	return modules.find((m) => m.name.trim().toLowerCase() === needle) ?? null
}

export const createModule = (client: PlaneClient, projectId: string, name: string) =>
	client.request<PlaneModule>("POST", `/projects/${projectId}/modules/`, {
		body: { name },
		isWrite: true,
	})

export const addWorkItemsToModule = (
	client: PlaneClient,
	projectId: string,
	moduleId: string,
	workItemIds: string[],
) =>
	client.request("POST", `/projects/${projectId}/modules/${moduleId}/module-issues/`, {
		body: { issues: workItemIds },
		isWrite: true,
	})
