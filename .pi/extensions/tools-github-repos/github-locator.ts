import { repositoryError, type RepositoryLocator } from "./contract.ts";

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?!-)){0,37}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;

export function parseGitHubRepository(input: string): RepositoryLocator {
	if (typeof input !== "string" || input !== input.trim() || input.length === 0) {
		throw repositoryError("INVALID_REPOSITORY");
	}

	let owner: string;
	let repo: string;
	if (!input.includes("://") && !input.includes(":")) {
		const parts = input.split("/");
		if (parts.length !== 2) throw repositoryError("INVALID_REPOSITORY");
		[owner, repo] = parts;
	} else {
		let url: URL;
		try {
			url = new URL(input);
		} catch {
			throw repositoryError("INVALID_REPOSITORY");
		}
		if (
			url.protocol !== "https:" ||
			url.hostname.toLowerCase() !== "github.com" ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) throw repositoryError("INVALID_REPOSITORY");
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length !== 2) throw repositoryError("INVALID_REPOSITORY");
		[owner, repo] = parts.map((part) => decodePathPart(part));
	}

	if (repo.endsWith(".git")) repo = repo.slice(0, -4);
	if (!OWNER_RE.test(owner) || !REPOSITORY_RE.test(repo) || repo === "." || repo === ".." || repo.includes("..") || repo.endsWith(".")) {
		throw repositoryError("INVALID_REPOSITORY");
	}
	owner = owner.toLowerCase();
	repo = repo.toLowerCase();
	const canonical = `${owner}/${repo}`;
	return { owner, repo, canonical, remoteUrl: `https://github.com/${owner}/${repo}.git` };
}

function decodePathPart(part: string): string {
	try {
		const decoded = decodeURIComponent(part);
		if (decoded.includes("/") || decoded.includes("\\")) throw new Error("separator");
		return decoded;
	} catch {
		throw repositoryError("INVALID_REPOSITORY");
	}
}

export function validateGitRef(input: string | undefined): string | null {
	if (input === undefined) return null;
	if (typeof input !== "string" || input.length === 0 || input !== input.trim()) {
		throw repositoryError("INVALID_REF");
	}
	if (FULL_SHA_RE.test(input)) return input.toLowerCase();
	if (input === "@") throw repositoryError("INVALID_REF");
	if (/^[0-9a-fA-F]{4,39}$/.test(input)) throw repositoryError("INVALID_REF");
	if (
		input.length > 1024 ||
		input.startsWith("-") ||
		input.startsWith("/") ||
		input.endsWith("/") ||
		input.endsWith(".") ||
		input.endsWith(".lock") ||
		input.includes("..") ||
		input.includes("@{") ||
		input.includes("//") ||
		/[\x00-\x20\x7f~^:?*[\\]/.test(input)
	) throw repositoryError("INVALID_REF");
	if (input.startsWith("refs/") && input.split("/").length < 3) throw repositoryError("INVALID_REF");
	if (input.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
		throw repositoryError("INVALID_REF");
	}
	return input;
}

export function isFullCommit(value: string): boolean {
	return FULL_SHA_RE.test(value);
}
