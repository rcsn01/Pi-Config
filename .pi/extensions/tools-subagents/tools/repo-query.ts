import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { discoverFiles } from "../../_shared/file-discovery.ts";
import {
	collectGitFacts,
	collectWorkingTreeDiff,
	type GitFacts,
} from "../../_shared/git.ts";
import {
	executeRepoQuery,
	type RepoQueryOperationOutput,
	type ResolvedRepoQueryOperation,
} from "../repo-query.ts";

const RepoQueryOperationSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable label for this operation" })),
	kind: StringEnum([
		"read",
		"grep",
		"find",
		"ls",
		"files",
		"git_status",
		"git_diff",
	] as const),
	path: Type.Optional(Type.String({ description: "File or directory path" })),
	pattern: Type.Optional(Type.String({ description: "Search pattern or glob" })),
	glob: Type.Optional(Type.String({ description: "File glob for grep" })),
	query: Type.Optional(Type.String({ description: "Fuzzy filename query" })),
	offset: Type.Optional(Type.Number({ description: "Read start line, 1-indexed" })),
	limit: Type.Optional(Type.Number({ description: "Operation result limit" })),
	context: Type.Optional(Type.Number({ description: "Grep context lines" })),
	ignoreCase: Type.Optional(Type.Boolean()),
	literal: Type.Optional(Type.Boolean()),
	includeHidden: Type.Optional(Type.Boolean()),
	mode: Type.Optional(StringEnum(["summary", "staged", "unstaged", "uncommitted"] as const)),
	paths: Type.Optional(Type.Array(Type.String(), {
		description: "One to 100 literal file or directory paths relative to the child working directory",
		minItems: 1,
		maxItems: 100,
	})),
});

export const RepoQueryParameters = Type.Object({
	operations: Type.Array(RepoQueryOperationSchema, {
		description: "One to 24 independent read-only repository operations",
	}),
});

export interface RepoQueryToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
}

export function createRepoQueryExecutor(cwd: string) {
	const read = createReadTool(cwd);
	const grep = createGrepTool(cwd);
	const find = createFindTool(cwd);
	const ls = createLsTool(cwd);

	return async function execute(
		operation: ResolvedRepoQueryOperation,
		signal?: AbortSignal,
	): Promise<RepoQueryOperationOutput> {
		switch (operation.kind) {
			case "read": {
				const result = await read.execute(
					`repo-query:${operation.id}`,
					{ path: operation.path!, offset: operation.offset, limit: operation.limit },
					signal,
					undefined,
				);
				return extractToolText(result, imageNotice(operation.path!));
			}
			case "grep": {
				const result = await grep.execute(
					`repo-query:${operation.id}`,
					{
						pattern: operation.pattern!,
						path: operation.path!,
						glob: operation.glob,
						ignoreCase: operation.ignoreCase,
						literal: operation.literal,
						context: operation.context,
						limit: operation.limit,
					},
					signal,
					undefined,
				);
				return extractToolText(result);
			}
			case "find": {
				const result = await find.execute(
					`repo-query:${operation.id}`,
					{ pattern: operation.pattern!, path: operation.path!, limit: operation.limit },
					signal,
					undefined,
				);
				return extractToolText(result);
			}
			case "ls": {
				const result = await ls.execute(
					`repo-query:${operation.id}`,
					{ path: operation.path!, limit: operation.limit },
					signal,
					undefined,
				);
				return extractToolText(result);
			}
			case "files": {
				const files = await discoverFiles(cwd, {
					query: operation.query,
					maxResults: operation.limit,
					includeHidden: operation.includeHidden,
					signal,
				});
				return files.length > 0 ? files.join("\n") : "No files found";
			}
			case "git_status":
				return formatGitStatus(await collectGitFacts(cwd, { signal }));
			case "git_diff":
				return collectWorkingTreeDiff(cwd, operation.mode!, {
					signal,
					includeUntrackedContent: false,
					paths: operation.paths,
				});
		}
	};
}

export function extractToolText(result: any, imageFallback?: string): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	if (content.some((item: any) => item?.type === "image")) {
		return imageFallback ?? "[Image result omitted. Use the normal read tool to inspect it.]";
	}
	return content
		.filter((item: any) => item?.type === "text" && typeof item.text === "string")
		.map((item: any) => item.text)
		.join("\n");
}

function imageNotice(filePath: string | undefined): string {
	return `[Image result omitted from repo_query. Use the normal read tool to inspect ${filePath ?? "the image"}.]`;
}

function formatGitStatus(facts: GitFacts): string {
	if (!facts.isRepository) return "Not a Git repository";

	const lines = [
		`Repository: ${facts.root ?? "(unknown root)"}`,
		`Branch: ${facts.branch ?? "(detached or unborn)"}`,
		`HEAD: ${facts.head ?? "(no commit)"}`,
		`Working tree: ${facts.clean ? "clean" : `${facts.status.length} changed path${facts.status.length === 1 ? "" : "s"}`}`,
	];
	if (facts.status.length > 0) {
		lines.push("Changes:");
		for (const entry of facts.status) {
			const displayPath = entry.originalPath ? `${entry.originalPath} -> ${entry.path}` : entry.path;
			lines.push(`${entry.indexStatus}${entry.workTreeStatus} ${oneLine(displayPath)}`);
		}
	}
	return lines.join("\n");
}

function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ");
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "repo_query",
		label: "Repository query",
		description: "Run independent read-only repository searches and reads in one bounded batch.",
		promptSnippet: "Batch repository evidence",
		promptGuidelines: [
			"Use 1-24 independent read, grep, find, ls, files, or fixed Git operations per batch.",
			"Paths must stay inside the subagent working directory; repo_query never writes or runs shell commands.",
		],
		parameters: RepoQueryParameters,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<RepoQueryToolResult> {
			const result = await executeRepoQuery(
				params,
				{ cwd: ctx.cwd, signal },
				createRepoQueryExecutor(ctx.cwd),
			);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});
}
