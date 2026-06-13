import type { PlaneClient } from "../plane/client.ts"
import type { PlaneProject } from "../plane/types.ts"

export const listProjects = (client: PlaneClient) =>
	client.listAll<PlaneProject>("/projects/")

export const findProjectByName = async (client: PlaneClient, name: string) => {
	const needle = name.trim().toLowerCase()
	const projects = await listProjects(client)
	return projects.find((p) => p.name.trim().toLowerCase() === needle) ?? null
}
