export type PlaneConfig = {
	baseUrl: string
	workspaceSlug: string
	apiKey: string
}

export type PlanePaginated<T> = {
	results: T[]
	next_cursor?: string
	prev_cursor?: string
	next_page_results?: boolean
	prev_page_results?: boolean
	count?: number
	total_pages?: number
	total_results?: number
}

export type PlaneProject = {
	id: string
	name: string
	identifier?: string
}

export type PlaneState = {
	id: string
	name: string
	group?: string
}

export type PlaneWorkItem = {
	id: string
	name: string
	description_html?: string
	state?: string
	priority?: string
	external_source?: string | null
	external_id?: string | null
	sequence_id?: number
}

export type PlaneModule = {
	id: string
	name: string
}

export type PlanePage = {
	id: string
	name: string
	external_source?: string | null
	external_id?: string | null
}

export type NormalizedFeature = {
	project_name: string
	source_path: string
	external_source: string
	external_id: string
	feature_id: string
	name: string
	progress: number
	status: string
	phase: string
	points?: number | null
	category?: string | null
	located?: string
}

export type NormalizeOutput = {
	root: string
	sources: Array<{
		source_path: string
		project_name: string
		adapter: string
		items: NormalizedFeature[]
	}>
}

export type SyncReport = {
	projectId: string
	projectName: string
	created: number
	updated: number
	skipped: number
	errors: string[]
	viewsManual: boolean
	modulesCreated: number
	pagesCreated: number
}
