import type { PlaneConfig, PlanePaginated } from "./types.ts"
import { PlaneApiError } from "./errors.ts"

const WRITE_DELAY_MS = 750
const RETRY_DELAY_MS = 30_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class PlaneClient {
	private lastWriteAt = 0

	constructor(private readonly config: PlaneConfig) {}

	private buildUrl(path: string, query?: Record<string, string | undefined>) {
		const base = this.config.baseUrl.replace(/\/$/, "")
		const normalizedPath = path.startsWith("/") ? path : `/${path}`
		const url = new URL(`${base}/api/v1/workspaces/${this.config.workspaceSlug}${normalizedPath}`)
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value != null && value !== "") url.searchParams.set(key, value)
			}
		}
		return url.toString()
	}

	private async throttleWrite() {
		const elapsed = Date.now() - this.lastWriteAt
		if (elapsed < WRITE_DELAY_MS) await sleep(WRITE_DELAY_MS - elapsed)
		this.lastWriteAt = Date.now()
	}

	async request<T>(
		method: string,
		path: string,
		options: {
			body?: unknown
			query?: Record<string, string | undefined>
			isWrite?: boolean
		} = {},
	): Promise<T> {
		if (options.isWrite) await this.throttleWrite()

		const run = async (): Promise<T> => {
			const response = await fetch(this.buildUrl(path, options.query), {
				method,
				headers: {
					"X-API-Key": this.config.apiKey,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: options.body == null ? undefined : JSON.stringify(options.body),
			})

			const text = await response.text()
			if (!response.ok) {
				throw new PlaneApiError(
					`Plane API ${method} ${path} failed (${response.status})`,
					response.status,
					text.slice(0, 2000),
				)
			}
			if (!text) return undefined as T
			return JSON.parse(text) as T
		}

		try {
			return await run()
		} catch (error) {
			if (error instanceof PlaneApiError && error.status === 429) {
				await sleep(RETRY_DELAY_MS)
				return run()
			}
			throw error
		}
	}

	async listAll<T>(path: string, query?: Record<string, string | undefined>): Promise<T[]> {
		const items: T[] = []
		let cursor: string | undefined
		do {
			const page = await this.request<PlanePaginated<T>>("GET", path, {
				query: { ...query, per_page: "100", cursor },
			})
			items.push(...(page.results ?? []))
			cursor = page.next_page_results ? page.next_cursor : undefined
		} while (cursor)
		return items
	}

	get workspaceSlug() {
		return this.config.workspaceSlug
	}

	get baseUrl() {
		return this.config.baseUrl
	}
}

export const createPlaneClient = (config: PlaneConfig) => new PlaneClient(config)
