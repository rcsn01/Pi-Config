import * as fs from "node:fs"
import * as path from "node:path"
import type { PlaneConfig } from "./types.ts"
import { PlaneConfigError } from "./errors.ts"

const DEFAULT_BASE_URL = "https://api.plane.so"

const readJsonConfig = (filePath: string): Partial<PlaneConfig> | null => {
	try {
		if (!fs.existsSync(filePath)) return null
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PlaneConfig>
		return parsed && typeof parsed === "object" ? parsed : null
	} catch {
		return null
	}
}

export const loadPlaneConfig = (cwd: string): PlaneConfig => {
	const fromFile =
		readJsonConfig(path.join(cwd, ".pi", "plane.json")) ??
		readJsonConfig(path.join(cwd, "plane.json"))

	const apiKey = process.env.PLANE_API_KEY?.trim() || fromFile?.apiKey?.trim()
	const workspaceSlug =
		process.env.PLANE_WORKSPACE_SLUG?.trim() || fromFile?.workspaceSlug?.trim()
	const baseUrl =
		process.env.PLANE_BASE_URL?.trim() || fromFile?.baseUrl?.trim() || DEFAULT_BASE_URL

	if (!apiKey) {
		throw new PlaneConfigError(
			"Plane API key missing. Set PLANE_API_KEY or create .pi/plane.json (see plane.json.example).",
		)
	}
	if (!workspaceSlug) {
		throw new PlaneConfigError(
			"Plane workspace slug missing. Set PLANE_WORKSPACE_SLUG or add workspaceSlug to .pi/plane.json.",
		)
	}

	return { apiKey, workspaceSlug, baseUrl }
}

export const configSummary = (config: PlaneConfig) => ({
	workspaceSlug: config.workspaceSlug,
	baseUrl: config.baseUrl,
	apiKeyConfigured: Boolean(config.apiKey),
})
