import type { NormalizedFeature } from "../plane/types.ts"

export const buildWorkItemDescription = (item: NormalizedFeature) => {
	const lines = [
		`<p><strong>Progress:</strong> ${item.progress}%</p>`,
		`<p><strong>Phase:</strong> ${item.phase}</p>`,
		`<p><strong>Status:</strong> ${item.status}</p>`,
	]
	if (item.points != null) lines.push(`<p><strong>Points:</strong> ${item.points}</p>`)
	if (item.category) lines.push(`<p><strong>Category:</strong> ${item.category}</p>`)
	if (item.located) lines.push(`<p><strong>Located:</strong> ${item.located}</p>`)
	lines.push(`<p><strong>Source:</strong> ${item.source_path}</p>`)
	lines.push(`<p><strong>External ID:</strong> ${item.external_id}</p>`)
	return lines.join("\n")
}

export const priorityFromProgress = (progress: number): string | undefined => {
	if (progress >= 100) return "low"
	if (progress >= 50) return "medium"
	if (progress > 0) return "high"
	return "none"
}
