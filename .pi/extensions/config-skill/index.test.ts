import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { skillMenuLabel } from "./diff.ts";
import { GitError, type Git } from "./git.ts";
import {
	applySkill,
	buildMenu,
	buildSkillPreview,
	cacheDirFor,
	checkAll,
	removeSkill,
	runBackgroundCheck,
	runUpdateSkillFlow,
	skillsDirFor,
	stateDirFor,
	updateAllOrder,
	type SkillCheck,
	type UpdateSkillUI,
} from "./index.ts";
import updateSkillExtension from "./index.ts";
import { listTrackedSkills, installDirFor, type TrackedSkill } from "./sources.ts";
import { loadState, saveState, getPinned, type UpdateSkillState } from "./state.ts";

const HEAD = "abcdef0123456789";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeRepo {
	url: string;
	head: string;
	/** "path/SKILL.md" → content; the fake's source of truth for upstream existence. */
	files: Map<string, string>;
	/** "path" → commits the fake reports between pinned and head. */
	behind: Map<string, number>;
}

/** In-memory git: one repo per cache dir, real files materialized for applySkill. */
class FakeGit implements Git {
	repos = new Map<string, FakeRepo>();
	/** Paths reported as deleted upstream (`pathExistsAtRef` → false). */
	removed = new Set<string>();
	calls: string[] = [];
	fetchThrows = false;
	checkoutThrows = false;

	repo(dir: string): FakeRepo {
		let repo = this.repos.get(dir);
		if (!repo) {
			repo = { url: "", head: HEAD, files: new Map(), behind: new Map() };
			this.repos.set(dir, repo);
		}
		return repo;
	}

	async ensureClone(dir: string, url: string): Promise<void> {
		this.calls.push(`ensureClone ${url}`);
		const repo = this.repo(dir);
		repo.url = url;
		mkdirSync(dir, { recursive: true });
		// Materialize every manifest skill of this source on disk (idempotent),
		// so applySkill's copy step has real files to copy.
		for (const skill of listTrackedSkills().filter((s) => s.url === url)) {
			const file = `${skill.path}/SKILL.md`;
			if (!repo.files.has(file)) {
				repo.files.set(
					file,
					`---\nname: ${skill.name}\ndescription: fake upstream description\n---\n\n# ${skill.name}\n\nfake upstream\n`,
				);
			}
			mkdirSync(join(dir, skill.path), { recursive: true });
			writeFileSync(join(dir, skill.path, "SKILL.md"), repo.files.get(file)!, "utf8");
		}
	}

	async fetch(dir: string): Promise<void> {
		this.calls.push(`fetch ${dir}`);
		if (this.fetchThrows) throw new GitError("fetch failed", "fatal: unable to access");
	}

	async revParse(dir: string, _ref: string): Promise<string> {
		this.calls.push(`revParse ${dir}`);
		return this.repo(dir).head;
	}

	async pathExistsAtRef(dir: string, _ref: string, path: string): Promise<boolean> {
		this.calls.push(`ls-tree ${path}`);
		return this.repo(dir).files.has(`${path}/SKILL.md`) && !this.removed.has(path);
	}

	async logOneline(dir: string, _range: string, path: string): Promise<string> {
		const n = this.repo(dir).behind.get(path) ?? 0;
		return Array.from({ length: n }, (_, i) => `abc12${i} feat(${i}): change`).join("\n");
	}

	async diffStat(dir: string, _range: string, path: string): Promise<string> {
		return ` ${path}/SKILL.md | 2 +-`;
	}

	async diffSkillMarkdown(dir: string, _range: string, path: string): Promise<string> {
		return `@@ -1,1 +1,1 @@\n-old ${path}\n+new ${path}`;
	}

	async checkout(dir: string, ref: string): Promise<void> {
		this.calls.push(`checkout ${ref}`);
		if (this.checkoutThrows) throw new GitError("checkout failed", "cache missing");
	}
}

function fakeUi(selects: (string | undefined)[], confirmResult = true): UpdateSkillUI {
	const select = vi.fn();
	for (const s of selects) select.mockResolvedValueOnce(s);
	return {
		select,
		confirm: vi.fn().mockResolvedValue(confirmResult),
		notify: vi.fn(),
	} as unknown as UpdateSkillUI;
}

const roots: string[] = [];

function tmpRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "update-skill-flow-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installOnDisk(root: string, name: string, content = "# x\n"): void {
	mkdirSync(join(skillsDirFor(root), name), { recursive: true });
	writeFileSync(join(skillsDirFor(root), name, "SKILL.md"), content, "utf8");
}

function findCheck(checks: SkillCheck[], name: string): SkillCheck {
	return checks.find((c) => c.skill.name === name)!;
}

function skillNamed(name: string): TrackedSkill {
	return listTrackedSkills().find((s) => s.name === name)!;
}

function savePinned(dir: string, state: UpdateSkillState): void {
	saveState(dir, state);
}

/** Ensure the fake cache clone exists on disk before applySkill is called. */
async function materializeCache(git: FakeGit, root: string, skill: TrackedSkill): Promise<void> {
	await git.ensureClone(cacheDirFor(root, skill.sourceId), skill.url);
}

// ---------------------------------------------------------------------------
// Manifest mapping
// ---------------------------------------------------------------------------

describe("manifest", () => {
	it("maps every tracked skill path to a unique install basename", () => {
		const names = listTrackedSkills().map((s) => s.name);
		expect(names).toHaveLength(21);
		expect(new Set(names).size).toBe(21);
		expect(names).toContain("code-review");
		expect(names).toContain("unslop");
		for (const skill of listTrackedSkills()) {
			expect(skill.name).not.toContain("/");
		}
	});

	it("install dir is .pi/skills/<basename>", () => {
		expect(installDirFor("/x", "code-review")).toBe("/x/code-review");
	});
});

// ---------------------------------------------------------------------------
// checkAll
// ---------------------------------------------------------------------------

describe("checkAll", () => {
	it("reports everything not-installed on a fresh project", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));

		const { checks, ok } = await checkAll(git, root, state);

		expect(ok).toBe(true);
		expect(checks).toHaveLength(21);
		for (const check of checks) {
			expect(check.status).toBe("not-installed");
			expect(check.head).toBe(HEAD);
		}
	});

	it("reports behind when pinned commits trail upstream for that path", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));

		installOnDisk(root, "code-review");
		state.skills["code-review"] = { commit: "old000" };
		git.repo(cacheDirFor(root, "mattpocock")).behind.set("skills/engineering/code-review", 2);

		const { checks } = await checkAll(git, root, state);

		const codeReview = findCheck(checks, "code-review");
		expect(codeReview.status).toBe("behind");
		expect(codeReview.commitsBehind).toBe(2);

		// Unrelated head movement with no commits for this path stays up-to-date.
		expect(findCheck(checks, "tdd").status).toBe("not-installed");
	});

	it("reports removed upstream", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		installOnDisk(root, "unslop");
		state.skills.unslop = { commit: HEAD };
		git.removed.add("pstack/skills/unslop");

		const { checks } = await checkAll(git, root, state);
		expect(findCheck(checks, "unslop").status).toBe("removed");
	});

	it("never reports updates when the fetch fails, and ok is false", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		git.fetchThrows = true;
		const state = loadState(stateDirFor(root));
		installOnDisk(root, "code-review");
		savePinned(stateDirFor(root), { ...state, skills: { "code-review": { commit: "old000" } } });

		const { checks, ok } = await checkAll(git, root, state);
		expect(ok).toBe(false);
		expect(findCheck(checks, "code-review").status).toBe("up-to-date");
		expect(findCheck(checks, "tdd").status).toBe("not-installed");
	});
});

// ---------------------------------------------------------------------------
// Background check
// ---------------------------------------------------------------------------

describe("runBackgroundCheck", () => {
	it("returns the behind skills and advances lastCheckedAt only on success", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		installOnDisk(root, "code-review");
		installOnDisk(root, "tdd");
		state.skills["code-review"] = { commit: "old000" };
		state.skills.tdd = { commit: "old000" };
		git.repo(cacheDirFor(root, "mattpocock")).behind.set("skills/engineering/code-review", 1);
		git.repo(cacheDirFor(root, "mattpocock")).behind.set("skills/engineering/tdd", 3);

		const now = Date.now();
		const result = await runBackgroundCheck(git, root, state, now);

		expect(result.ok).toBe(true);
		expect(result.updates).toEqual(["code-review", "tdd"]);
		expect(state.lastCheckedAt).toBe(new Date(now).toISOString());
		expect(loadState(stateDirFor(root)).lastCheckedAt).toBe(state.lastCheckedAt);
	});

	it("keeps the old lastCheckedAt when the check fails", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		git.fetchThrows = true;
		const state: UpdateSkillState = {
			lastCheckedAt: "2020-01-01T00:00:00.000Z",
			skills: {},
		};
		const result = await runBackgroundCheck(git, root, state, Date.now());
		expect(result.ok).toBe(false);
		expect(state.lastCheckedAt).toBe("2020-01-01T00:00:00.000Z");
	});
});

// ---------------------------------------------------------------------------
// apply / remove
// ---------------------------------------------------------------------------

describe("applySkill", () => {
	it("copies the skill dir, replaces stale files, and pins the head commit", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		const skill = skillNamed("code-review");
		await materializeCache(git, root, skill);

		// Stale local copy with extra file.
		installOnDisk(root, "code-review", "# old local\n");
		writeFileSync(join(skillsDirFor(root), "code-review", "stale.txt"), "stale", "utf8");

		const result = await applySkill(git, root, state, skill);

		expect(result.action).toBe("updated");
		expect(result.head).toBe(HEAD);
		expect(readFileSync(join(skillsDirFor(root), "code-review", "SKILL.md"), "utf8")).toBe(
			"---\nname: code-review\ndescription: fake upstream description\n---\n\n# code-review\n\nfake upstream\n",
		);
		expect(existsSync(join(skillsDirFor(root), "code-review", "stale.txt"))).toBe(false);
		expect(getPinned(state, "code-review")).toBe(HEAD);
		expect(loadState(stateDirFor(root)).skills["code-review"]?.commit).toBe(HEAD);
	});

	it("preserves a local license: frontmatter line across updates (unslop)", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		const unslop = skillNamed("unslop");
		await materializeCache(git, root, unslop);

		installOnDisk(
			root,
			"unslop",
			"---\nname: unslop\ndescription: old local description\nlicense: MIT\n---\n\n# Unslop\n\nlocal-only body\n",
		);

		await applySkill(git, root, state, unslop);

		const out = readFileSync(join(skillsDirFor(root), "unslop", "SKILL.md"), "utf8");
		expect(out).toContain("license: MIT");
		expect(out).toContain("# unslop");
		expect(out).not.toContain("local-only body");
	});

	it("installs fresh without a license line when none existed", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		await materializeCache(git, root, skillNamed("tdd"));

		const result = await applySkill(git, root, state, skillNamed("tdd"));

		expect(result.action).toBe("installed");
		const out = readFileSync(join(skillsDirFor(root), "tdd", "SKILL.md"), "utf8");
		expect(out).toContain("# tdd");
		expect(out).not.toContain("license:");
	});
});

describe("removeSkill", () => {
	it("deletes the local dir and unpins", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		await materializeCache(git, root, skillNamed("unslop"));
		await applySkill(git, root, state, skillNamed("unslop"));
		expect(existsSync(join(skillsDirFor(root), "unslop"))).toBe(true);

		removeSkill(root, state, skillNamed("unslop"));

		expect(existsSync(join(skillsDirFor(root), "unslop"))).toBe(false);
		expect(getPinned(state, "unslop")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

describe("buildMenu / updateAllOrder", () => {
	function check(name: string, status: SkillCheck["status"], behind = 0): SkillCheck {
		return {
			skill: { name, sourceId: "mattpocock", path: `skills/engineering/${name}`, url: "u", branch: "main" },
			status,
			commitsBehind: behind,
			head: HEAD,
			pinned: HEAD,
		};
	}

	it("update-all order: behind first (alpha), then not-installed (alpha)", () => {
		const checks = [
			check("zeta", "not-installed"),
			check("alpha", "behind", 2),
			check("mid", "behind", 1),
			check("done", "up-to-date"),
		];
		expect(updateAllOrder(checks).map((c) => c.skill.name)).toEqual(["alpha", "mid", "zeta"]);
	});

	it("menu lists pending count, then skills, then check-now/cancel", () => {
		const checks = [check("alpha", "behind", 2), check("done", "up-to-date")];
		const menu = buildMenu(checks);
		expect(menu.map((e) => e.label)).toEqual([
			"* Update all (1)",
			"alpha — 2 commits behind",
			"done — up to date",
			"* Check now (fetch upstream)",
			"Cancel",
		]);
	});

	it("no Update all entry when nothing is pending", () => {
		const entries = buildMenu([check("done", "up-to-date")]);
		expect(entries.some((e) => e.action.kind === "update-all")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe("buildSkillPreview", () => {
	it("combines commits, stat and SKILL.md diff", async () => {
		const git = new FakeGit();
		const check = {
			skill: skillNamed("tdd"),
			status: "behind" as const,
			commitsBehind: 2,
			head: HEAD,
			pinned: "old000",
		};
		git.repo(cacheDirFor("/proj", "mattpocock")).behind.set("skills/engineering/tdd", 2);
		const preview = await buildSkillPreview(git, "/proj", check);
		expect(preview).toContain("Commits (2):");
		expect(preview).toContain("+new skills/engineering/tdd");
	});
});

// ---------------------------------------------------------------------------
// Full interactive flow
// ---------------------------------------------------------------------------

describe("runUpdateSkillFlow", () => {
	it("update-all installs every pending skill and pins state", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		const ui = fakeUi(["* Update all (21)", "Cancel"]);

		await runUpdateSkillFlow(git, root, state, ui);

		for (const skill of listTrackedSkills()) {
			expect(existsSync(join(skillsDirFor(root), skill.name, "SKILL.md"))).toBe(true);
			expect(getPinned(state, skill.name)).toBe(HEAD);
		}
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("updated"), "info");
		// The menu after the update has no pending entry; Cancel ends the loop.
		expect(ui.select).toHaveBeenCalledTimes(2);
	});

	it("single behind skill: preview confirm then update", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		installOnDisk(root, "code-review");
		state.skills["code-review"] = { commit: "old000" };
		git.repo(cacheDirFor(root, "mattpocock")).behind.set("skills/engineering/code-review", 3);

		const { checks } = await checkAll(git, root, state);
		const label = skillMenuLabel("code-review", findCheck(checks, "code-review").status, 3);
		const ui = fakeUi([label, "Cancel"]);

		await runUpdateSkillFlow(git, root, state, ui);

		expect(ui.confirm).toHaveBeenCalledTimes(1);
		const [title, message] = (ui.confirm as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
		expect(title).toContain("Update code-review?");
		expect(title).toContain("3 commits behind");
		expect(message).toContain("Commits (3):");
		expect(message).toContain("Changed files:");
		expect(message).toContain("SKILL.md preview:");
		expect(ui.notify).toHaveBeenCalledWith("update-skill: updated code-review", "info");
		expect(getPinned(state, "code-review")).toBe(HEAD);
	});

	it("install flow with confirm, and no-op with cancel", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		const label = "unslop — not installed";

		const cancelled = fakeUi([label, "Cancel"], false);
		await runUpdateSkillFlow(git, root, state, cancelled);
		expect(existsSync(join(skillsDirFor(root), "unslop"))).toBe(false);

		const ui = fakeUi([label, "Cancel"], true);
		await runUpdateSkillFlow(git, root, state, ui);
		expect(existsSync(join(skillsDirFor(root), "unslop", "SKILL.md"))).toBe(true);
		expect(ui.notify).toHaveBeenCalledWith("update-skill: installed unslop", "info");
	});

	it("removed skill: confirm deletes the local copy", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		await materializeCache(git, root, skillNamed("unslop"));
		await applySkill(git, root, state, skillNamed("unslop"));
		git.removed.add("pstack/skills/unslop");

		const { checks } = await checkAll(git, root, state);
		const label = skillMenuLabel("unslop", findCheck(checks, "unslop").status, 0);
		const ui = fakeUi([label, "Cancel"]);

		await runUpdateSkillFlow(git, root, state, ui);

		expect(existsSync(join(skillsDirFor(root), "unslop"))).toBe(false);
		expect(getPinned(state, "unslop")).toBeUndefined();
		expect(ui.notify).toHaveBeenCalledWith("update-skill: removed unslop", "info");
	});

	it("check-now re-fetches upstream inside the menu loop", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		const ui = fakeUi(["* Check now (fetch upstream)", "Cancel"]);

		await runUpdateSkillFlow(git, root, state, ui);

		const fetches = git.calls.filter((c) => c.startsWith("fetch"));
		expect(fetches).toHaveLength(4); // initial (2 sources) + check-now (2 sources)
	});

	it("escaping the menu does nothing", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const state = loadState(stateDirFor(root));
		const ui = fakeUi([undefined]);

		await runUpdateSkillFlow(git, root, state, ui);

		expect(ui.confirm).not.toHaveBeenCalled();
		expect(ui.notify).not.toHaveBeenCalled();
	});

	it("apply failures notify an error and keep the menu loop alive", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		git.checkoutThrows = true;
		const state = loadState(stateDirFor(root));
		const ui = fakeUi(["unslop — not installed", "Cancel"]);

		await runUpdateSkillFlow(git, root, state, ui);

		expect(ui.confirm).toHaveBeenCalledTimes(1);
		expect(ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("failed to update unslop"),
			"error",
		);
		expect(existsSync(join(skillsDirFor(root), "unslop"))).toBe(false);
		expect(ui.select).toHaveBeenCalledTimes(2); // menu again after the error
	});
});

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

describe("updateSkillExtension", () => {
	function fakePi(): ExtensionAPI & { on: ReturnType<typeof vi.fn>; registerCommand: ReturnType<typeof vi.fn> } {
		return { on: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI & {
			on: ReturnType<typeof vi.fn>;
			registerCommand: ReturnType<typeof vi.fn>;
		};
	}

	function sessionStartHandler(pi: ReturnType<typeof fakePi>): (event: unknown, ctx: any) => void {
		const call = pi.on.mock.calls.find(([event]) => event === "session_start")!;
		return call[1];
	}

	it("registers the /update-skill command", () => {
		const pi = fakePi();
		updateSkillExtension(pi);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"update-skill",
			expect.objectContaining({ description: expect.stringContaining("mattpocock") }),
		);
	});

	it("session_start notifies about updates and advances the cooldown", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const pi = fakePi();
		updateSkillExtension(pi, () => git, { extensionDir: root });

		// Stale last-checked state plus one behind skill.
		const state = loadState(stateDirFor(root));
		state.lastCheckedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		saveState(stateDirFor(root), state);
		installOnDisk(root, "code-review");
		savePinned(stateDirFor(root), {
			...state,
			skills: { "code-review": { commit: "old000" } },
		});
		git.repo(cacheDirFor(root, "mattpocock")).behind.set("skills/engineering/code-review", 1);

		const notify = vi.fn();
		const handler = sessionStartHandler(pi);
		handler({}, { cwd: root, ui: { notify } });

		await vi.waitFor(() => {
			expect(notify).toHaveBeenCalledWith(
				"update-skill: 1 skill has updates (code-review). Run /update-skill",
				"info",
			);
		});
		expect(loadState(stateDirFor(root)).lastCheckedAt).not.toBeNull();
	});

	it("session_start stays quiet within the cooldown", async () => {
		const root = tmpRoot();
		const git = new FakeGit();
		const pi = fakePi();
		updateSkillExtension(pi, () => git, { extensionDir: root });

		const state = loadState(stateDirFor(root));
		state.lastCheckedAt = new Date().toISOString();
		saveState(stateDirFor(root), state);

		const notify = vi.fn();
		const handler = sessionStartHandler(pi);
		handler({}, { cwd: root, ui: { notify } });

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(notify).not.toHaveBeenCalled();
		expect(git.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Helpers (shared above; kept together at the end)
// ---------------------------------------------------------------------------

