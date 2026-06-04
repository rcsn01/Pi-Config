import type { PlaneClient } from "../plane/client.ts"
import type { PlaneState } from "../plane/types.ts"

export const listStates = (client: PlaneClient, projectId: string) =>
	client.listAll<PlaneState>(`/projects/${projectId}/states/`)

export const resolveStateId = (states: PlaneState[], status: string): string | null => {
	const normalized = status.trim().toLowerCase()
	const byName = states.find((s) => s.name.trim().toLowerCase() === normalized)
	if (byName) return byName.id

	const fallback: Record<string, string[]> = {
		done: ["done", "completed", "complete"],
		"in progress": ["in progress", "started", "doing"],
		planned: ["planned", "backlog", "todo", "unstarted"],
	}
	for (const [key, aliases] of Object.entries(fallback)) {
		if (!aliases.includes(normalized)) continue
		const match = states.find((s) => aliases.includes(s.name.trim().toLowerCase()))
		if (match) return match.id
		if (key === normalized) {
			const groupMatch = states.find((s) => s.group?.toLowerCase() === key.replace(" ", "-"))
			if (groupMatch) return groupMatch.id
		}
	}
	return states[0]?.id ?? null
}
