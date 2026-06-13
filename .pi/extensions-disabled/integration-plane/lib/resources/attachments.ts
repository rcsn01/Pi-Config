import * as path from "node:path"
import { readFile, stat } from "node:fs/promises"
import type { PlaneClient } from "../plane/client.ts"

export type PlaneAttachment = {
	id: string
	attributes?: {
		name?: string
		type?: string
		size?: number
	}
	asset?: string
	entity_type?: string
	external_source?: string | null
	external_id?: string | null
	size?: number
	is_uploaded?: boolean
	storage_metadata?: Record<string, unknown>
	project?: string
	issue?: string
	workspace?: string
	created_at?: string
	updated_at?: string
}

type AttachmentCreateResponse = {
	upload_data: {
		url: string
		fields: Record<string, string>
	}
	asset_id: string
	attachment: PlaneAttachment
	asset_url?: string
}

export type AttachWorkItemFileInput = {
	projectId: string
	issueId: string
	filePath: string
	cwd: string
	mimeType?: string
	externalSource?: string
	externalId?: string
}

const extensionToMime: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/plain",
	".markdown": "text/plain",
	".json": "application/json",
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".csv": "text/csv",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

const resolveWorkspaceFile = (cwd: string, filePath: string) => {
	const root = path.resolve(cwd)
	const resolved = path.resolve(cwd, filePath)
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Refusing to attach file outside workspace: ${filePath}`)
	}
	return resolved
}

const inferMimeType = (filePath: string, explicit?: string) => {
	if (explicit === "text/markdown") return "text/plain"
	if (explicit) return explicit
	return extensionToMime[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
}

const uploadToPresignedTarget = async (
	createResponse: AttachmentCreateResponse,
	fileName: string,
	mimeType: string,
	contents: Buffer,
) => {
	const form = new FormData()
	for (const [key, value] of Object.entries(createResponse.upload_data.fields)) {
		form.append(key, value)
	}
	form.append("file", new Blob([contents], { type: mimeType }), fileName)

	const response = await fetch(createResponse.upload_data.url, {
		method: "POST",
		body: form,
	})
	if (!response.ok) {
		const body = await response.text()
		throw new Error(
			`Plane attachment storage upload failed (${response.status}): ${body.slice(0, 500)}`,
		)
	}
}

export const listWorkItemAttachments = (
	client: PlaneClient,
	projectId: string,
	issueId: string,
) =>
	client.request<PlaneAttachment[]>(
		"GET",
		`/projects/${projectId}/issues/${issueId}/issue-attachments/`,
	)

export const attachWorkItemFile = async (
	client: PlaneClient,
	input: AttachWorkItemFileInput,
) => {
	const resolvedPath = resolveWorkspaceFile(input.cwd, input.filePath)
	const [fileStats, contents] = await Promise.all([stat(resolvedPath), readFile(resolvedPath)])
	if (!fileStats.isFile()) throw new Error(`Not a file: ${input.filePath}`)

	const fileName = path.basename(resolvedPath)
	const mimeType = inferMimeType(resolvedPath, input.mimeType)
	const metadata: Record<string, string | number> = {
		name: fileName,
		type: mimeType,
		size: fileStats.size,
	}
	if (input.externalSource) metadata.external_source = input.externalSource
	if (input.externalId) metadata.external_id = input.externalId

	const createResponse = await client.request<AttachmentCreateResponse>(
		"POST",
		`/projects/${input.projectId}/issues/${input.issueId}/issue-attachments/`,
		{ body: metadata, isWrite: true },
	)

	await uploadToPresignedTarget(createResponse, fileName, mimeType, contents)

	await client.request<void>(
		"PATCH",
		`/projects/${input.projectId}/issues/${input.issueId}/issue-attachments/${createResponse.asset_id}/`,
		{ body: { is_uploaded: true }, isWrite: true },
	)

	const attachments = await listWorkItemAttachments(client, input.projectId, input.issueId)
	const attachment = attachments.find((item) => item.id === createResponse.asset_id) ?? createResponse.attachment

	return {
		status: attachment?.is_uploaded === false ? "created_but_not_verified" : "attached",
		asset_id: createResponse.asset_id,
		file_name: fileName,
		mime_type: mimeType,
		size: fileStats.size,
		attachment,
	}
}
