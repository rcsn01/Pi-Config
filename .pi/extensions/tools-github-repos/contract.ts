export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type RepositoryErrorCode =
	| "INVALID_REPOSITORY"
	| "INVALID_REF"
	| "AMBIGUOUS_REF"
	| "REPOSITORY_NOT_FOUND"
	| "REF_NOT_FOUND"
	| "AUTH_REQUIRED"
	| "GIT_UNAVAILABLE"
	| "NETWORK_ERROR"
	| "TIMEOUT"
	| "LIMIT_EXCEEDED"
	| "UNSAFE_TREE"
	| "SNAPSHOT_NOT_FOUND"
	| "STORAGE_ERROR"
	| "CANCELLED";

const ERROR_MESSAGES: Record<RepositoryErrorCode, string> = {
	INVALID_REPOSITORY: "The repository locator is invalid. Use owner/repo or a public github.com URL.",
	INVALID_REF: "The Git ref is invalid. Use a branch, tag, full refs/... name, or a 40-character commit SHA.",
	AMBIGUOUS_REF: "The ref matches both a branch and a tag. Use refs/heads/... or refs/tags/....",
	REPOSITORY_NOT_FOUND: "The public GitHub repository was not found.",
	REF_NOT_FOUND: "The requested Git ref was not found.",
	AUTH_REQUIRED: "The repository requires authentication. V1 supports public repositories only.",
	GIT_UNAVAILABLE: "Git is not available on this system.",
	NETWORK_ERROR: "GitHub could not be reached.",
	TIMEOUT: "Repository acquisition exceeded the time limit.",
	LIMIT_EXCEEDED: "The repository exceeds a snapshot safety limit.",
	UNSAFE_TREE: "The repository tree contains a path or entry that cannot be materialized safely.",
	SNAPSHOT_NOT_FOUND: "No completed repository snapshot has that ID.",
	STORAGE_ERROR: "The repository snapshot could not be stored safely.",
	CANCELLED: "Repository acquisition was cancelled.",
};

export class RepositoryError extends Error {
	readonly code: RepositoryErrorCode;

	constructor(code: RepositoryErrorCode, message = ERROR_MESSAGES[code], options?: ErrorOptions) {
		super(message, options);
		this.name = "RepositoryError";
		this.code = code;
	}
}

export function repositoryError(code: RepositoryErrorCode, detail?: string): RepositoryError {
	return new RepositoryError(code, detail ? `${ERROR_MESSAGES[code]} ${detail}` : ERROR_MESSAGES[code]);
}

export interface AcquireInput {
	repository: string;
	ref?: string;
}

export interface RepositoryLocator {
	owner: string;
	repo: string;
	canonical: string;
	remoteUrl: string;
}

export interface ResolvedRevision {
	requestedRef: string | null;
	resolvedRef: string;
	commit: string;
}

export interface SnapshotManifest {
	schemaVersion: 1;
	id: string;
	repository: string;
	requestedRef: string | null;
	resolvedRef: string;
	commit: string;
	acquiredAt: string;
	fileCount: number;
	byteCount: number;
	symlinksConverted: number;
	submodulesSkipped: string[];
}

export interface Snapshot extends SnapshotManifest {
	path: string;
	reused: boolean;
}

export type SnapshotSummary = SnapshotManifest & { path: string };

export interface RemoveResult {
	id: string;
	repository: string;
	commit: string;
	removed: true;
}

export interface SnapshotLimits {
	deadlineMs: number;
	maxStagingBytes: number;
	maxTreeBytes: number;
	maxEntries: number;
	maxBlobBytes: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
	maxListEntries: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
	deadlineMs: 120_000,
	maxStagingBytes: 1024 * 1024 * 1024,
	maxTreeBytes: 512 * 1024 * 1024,
	maxEntries: 50_000,
	maxBlobBytes: 25 * 1024 * 1024,
	maxStdoutBytes: 256 * 1024 * 1024,
	maxStderrBytes: 1024 * 1024,
	maxListEntries: 100,
});

export interface MaterializeResult {
	fileCount: number;
	byteCount: number;
	symlinksConverted: number;
	submodulesSkipped: string[];
}

export interface MaterializeRequest {
	remoteUrl: string;
	revision: ResolvedRevision;
	stagingPath: string;
	deadline: number;
	limits: SnapshotLimits;
	signal?: AbortSignal;
}

export interface SnapshotAdapter {
	resolve(remoteUrl: string, requestedRef: string | null, deadline: number, limits: SnapshotLimits, signal?: AbortSignal): Promise<ResolvedRevision>;
	materialize(request: MaterializeRequest): Promise<MaterializeResult>;
}

export interface RepositoryStore {
	acquire(input: AcquireInput, signal?: AbortSignal): Promise<Snapshot>;
	list(): Promise<SnapshotSummary[]>;
	remove(id: string, signal?: AbortSignal): Promise<RemoveResult>;
}
