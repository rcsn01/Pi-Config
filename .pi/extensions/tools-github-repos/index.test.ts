import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryStore, Snapshot } from "./contract.ts";
import { formatAcquired, registerGitHubReposExtension } from "./index.ts";

const snapshot: Snapshot = {
	schemaVersion: 1,
	id: `ghr_${"a".repeat(24)}`,
	repository: "owner/repo",
	requestedRef: "main",
	resolvedRef: "refs/heads/main",
	commit: "b".repeat(40),
	acquiredAt: "2026-01-01T00:00:00.000Z",
	fileCount: 1234,
	byteCount: 8_600_000,
	symlinksConverted: 0,
	submodulesSkipped: [],
	path: "/project/.pi/repos/owner/repo/commit/source",
	reused: false,
};

function setup() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const store: RepositoryStore = {
		acquire: vi.fn(async () => snapshot),
		list: vi.fn(async () => [{ ...snapshot }]),
		remove: vi.fn(async (id: string) => ({ id, repository: snapshot.repository, commit: snapshot.commit, removed: true as const })),
	};
	registerGitHubReposExtension({
		on: (event: string, handler: any) => events.set(event, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
	} as any, () => store);
	return { tools, commands, events, store };
}

describe("GitHub repository tools", () => {
	it("publishes the companion exploration skill through resource discovery", () => {
		const { events } = setup();
		const discover = events.get("resources_discover");
		expect(discover).toBeTypeOf("function");

		const result = discover({ cwd: "/project", reason: "startup" }, {});
		expect(result.skillPaths).toHaveLength(1);
		const skillPath = result.skillPaths[0] as string;
		expect(skillPath).toMatch(/tools-github-repos[\\/]SKILL\.md$/);
		expect(existsSync(skillPath)).toBe(true);
		expect(readFileSync(skillPath, "utf8")).toMatch(/^---\nname: github-repo-explorer\ndescription: .+\n---\n/);
	});

	it("registers three small tools and returns concise acquisition metadata", async () => {
		const { tools, store } = setup();
		expect([...tools.keys()]).toEqual(["github_repo_acquire", "github_repo_list", "github_repo_remove"]);
		const update = vi.fn();
		const result = await tools.get("github_repo_acquire").execute("call", { repository: "owner/repo", ref: "main" }, undefined, update, { cwd: "/project" });
		expect(store.acquire).toHaveBeenCalledWith({ repository: "owner/repo", ref: "main" }, undefined);
		expect(update).toHaveBeenCalled();
		expect(result.content[0].text).toContain("Repository snapshot ready.");
		expect(result.content[0].text).toContain(`id: ${snapshot.id}`);
		expect(result.content[0].text).toContain("Do not run repository code.");
	});

	it("lists and removes snapshots through tools", async () => {
		const { tools, store } = setup();
		const ctx = { cwd: "/project" };
		const listed = await tools.get("github_repo_list").execute("call", {}, undefined, undefined, ctx);
		expect(listed.content[0].text).toContain("owner/repo @ bbbbbbbbbbbb");
		await tools.get("github_repo_remove").execute("call", { id: snapshot.id }, undefined, undefined, ctx);
		expect(store.remove).toHaveBeenCalledWith(snapshot.id, undefined);
	});

	it("uses selection and confirmation for TUI command removal", async () => {
		const { commands, store } = setup();
		const notify = vi.fn();
		const select = vi.fn(async (_title: string, values: string[]) => values[0]);
		const confirm = vi.fn(async () => true);
		await commands.get("repos").handler("remove", { cwd: "/project", mode: "tui", hasUI: true, ui: { notify, select, confirm } });
		expect(select).toHaveBeenCalled();
		expect(confirm).toHaveBeenCalled();
		expect(store.remove).toHaveBeenCalledWith(snapshot.id);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Removed owner/repo"), "info");
	});

	it("formats counts and persistence guidance", () => {
		const output = formatAcquired(snapshot);
		expect(output).toContain("files: 1,234");
		expect(output).toContain("bytes: 8.2 MB");
		expect(output).toContain("remains until github_repo_remove");
	});
});
