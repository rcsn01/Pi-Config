import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Git } from "./git.ts";
import {
	createSkillUpdateLifecycle,
	type SkillActionView,
	type SkillConfirmation,
	type SkillMenuView,
	type SkillUpdateInteractionAdapter,
	type SkillUpdateNotice,
} from "./skill-update-lifecycle.ts";
import { listTrackedSkills } from "./sources.ts";

const HEAD = "abcdef0123456789";
const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "skill-lifecycle-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

class FakeGit implements Git {
	readonly calls: string[] = [];
	readonly logs = new Map<string, string>();
	readonly removed = new Set<string>();
	readonly pathFailures = new Set<string>();
	readonly logFailures = new Set<string>();
	diff = "";
	stat = "";
	previewFailure = false;
	checkoutFailure = false;

	async ensureClone(dir: string, url: string): Promise<void> {
		this.calls.push(`clone ${url}`);
		for (const skill of listTrackedSkills().filter((candidate) => candidate.url === url)) {
			const skillDir = join(dir, skill.path);
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---\nname: ${skill.name}\n---\n\n# ${skill.name}\n`,
				"utf8",
			);
		}
	}

	async fetch(dir: string): Promise<void> {
		this.calls.push(`fetch ${dir}`);
	}

	async revParse(dir: string, ref: string): Promise<string> {
		this.calls.push(`head ${dir} ${ref}`);
		return HEAD;
	}

	async pathExistsAtRef(_dir: string, _ref: string, path: string): Promise<boolean> {
		this.calls.push(`path ${path}`);
		if (this.pathFailures.has(path)) throw new Error(`path failure: ${path}`);
		return !this.removed.has(path);
	}

	async logOneline(_dir: string, _range: string, path: string): Promise<string> {
		this.calls.push(`log ${path}`);
		if (this.logFailures.has(path)) throw new Error(`log failure: ${path}`);
		return this.logs.get(path) ?? "";
	}

	async diffStat(): Promise<string> {
		if (this.previewFailure) throw new Error("preview failed");
		return this.stat;
	}

	async diffSkillMarkdown(): Promise<string> {
		if (this.previewFailure) throw new Error("preview failed");
		return this.diff;
	}

	async checkout(): Promise<void> {
		this.calls.push("checkout");
		if (this.checkoutFailure) throw new Error("checkout failed");
	}
}

function statePath(extensionRoot: string): string {
	return join(extensionRoot, "update-skill", "state.json");
}

function saveStateFile(
	extensionRoot: string,
	state: { lastCheckedAt: string | null; skills: Record<string, { commit: string }> },
): void {
	mkdirSync(join(extensionRoot, "update-skill"), { recursive: true });
	writeFileSync(statePath(extensionRoot), JSON.stringify(state), "utf8");
}

function install(projectRoot: string, name: string, content = "# local\n"): void {
	const dir = join(projectRoot, ".pi", "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), content, "utf8");
}

interface ScriptOverrides {
	chooseSkill?: SkillUpdateInteractionAdapter["chooseSkill"];
	chooseAction?: SkillUpdateInteractionAdapter["chooseAction"];
	confirm?: SkillUpdateInteractionAdapter["confirm"];
}

function scripted(overrides: ScriptOverrides = {}) {
	const views: SkillMenuView[] = [];
	const actionViews: SkillActionView[] = [];
	const confirmations: SkillConfirmation[] = [];
	const notices: SkillUpdateNotice[] = [];
	const adapter: SkillUpdateInteractionAdapter = {
		chooseSkill: overrides.chooseSkill ?? (async (view) => {
			views.push(view);
			return { kind: "close" };
		}),
		chooseAction: overrides.chooseAction ?? (async (view) => {
			actionViews.push(view);
			return { kind: "back" };
		}),
		confirm: async (request) => {
			confirmations.push(request);
			return overrides.confirm ? overrides.confirm(request) : false;
		},
		report: (notice) => notices.push(notice),
	};
	return { adapter, views, actionViews, confirmations, notices };
}

function lifecycle(projectRoot: string, extensionRoot: string, git: Git) {
	return createSkillUpdateLifecycle({ projectRoot, extensionDir: extensionRoot, git });
}

describe("Skill update lifecycle", () => {
	it("shows the 22-skill local view without Git and keeps roots separate", async () => {
		const project = temporaryRoot();
		const extension = temporaryRoot();
		const git = new FakeGit();
		install(project, "tdd");
		const interaction = scripted();

		await lifecycle(project, extension, git).runInteractive(interaction.adapter);

		expect(interaction.views[0]).toMatchObject({ kind: "local", updateAllCount: 0 });
		expect(interaction.views[0].rows).toHaveLength(22);
		expect(interaction.views[0].rows.map((row) => row.name)).toEqual(
			[...interaction.views[0].rows.map((row) => row.name)].sort((a, b) => a.localeCompare(b)),
		);
		expect(interaction.views[0].rows.find((row) => row.name === "tdd")?.installed).toBe(true);
		expect(git.calls).toEqual([]);
		expect(existsSync(join(extension, "update-skill"))).toBe(false);
	});

	it.each([
		["inside", 86_400_000 - 1, "skipped"],
		["exact", 86_400_000, "skipped"],
		["beyond", 86_400_000 + 1, "checked"],
		["future", -1, "skipped"],
	] as const)("handles the %s cooldown boundary", async (_name, age, expected) => {
		const project = temporaryRoot();
		const extension = temporaryRoot();
		const git = new FakeGit();
		const now = 2_000_000_000_000;
		saveStateFile(extension, { lastCheckedAt: new Date(now - age).toISOString(), skills: {} });

		const outcome = await lifecycle(project, extension, git).checkInBackground(now);

		expect(outcome.kind).toBe(expected);
		if (expected === "skipped") expect(git.calls).toEqual([]);
	});

	it("checks missing and invalid timestamps, and rejects a non-finite instant", async () => {
		const project = temporaryRoot();
		const extension = temporaryRoot();
		const git = new FakeGit();
		saveStateFile(extension, { lastCheckedAt: "not-a-date", skills: {} });
		expect((await lifecycle(project, extension, git).checkInBackground(123)).kind).toBe("checked");
		await expect(lifecycle(project, extension, git).checkInBackground(Number.NaN)).rejects.toThrow("finite");
	});

	it("returns only sorted behind names and saves the supplied background timestamp", async () => {
		const project = temporaryRoot();
		const extension = temporaryRoot();
		const git = new FakeGit();
		install(project, "tdd");
		install(project, "code-review");
		saveStateFile(extension, {
			lastCheckedAt: null,
			skills: { tdd: { commit: "old" }, "code-review": { commit: "old" } },
		});
		git.logs.set("skills/engineering/tdd", "one");
		git.logs.set("skills/engineering/code-review", "one\ntwo");
		const now = 1_700_000_000_000;

		const outcome = await lifecycle(project, extension, git).checkInBackground(now);

		expect(outcome).toEqual({
			kind: "checked",
			ok: true,
			updates: ["code-review", "tdd"],
		});
		expect(JSON.parse(readFileSync(statePath(extension), "utf8")).lastCheckedAt)
			.toBe(new Date(now).toISOString());
		expect(git.calls.filter((call) => call.startsWith("clone "))).toHaveLength(3);
		expect(git.calls.filter((call) => call.startsWith("fetch "))).toHaveLength(3);
	});

	it("marks a path failure incomplete, warns once, preserves the timestamp, and excludes it", async () => {
		const project = temporaryRoot();
		const extension = temporaryRoot();
		const git = new FakeGit();
		const oldTimestamp = "2020-01-01T00:00:00.000Z";
		saveStateFile(extension, { lastCheckedAt: oldTimestamp, skills: {} });
		git.pathFailures.add("skills/engineering/tdd");
		vi.spyOn(console, "error").mockImplementation(() => {});
		let calls = 0;
		const interaction = scripted({
			chooseSkill: async (_view, refresh) => {
				if (calls++ === 0) {
					const result = await refresh();
					expect(result.completion).toBe("warning");
					expect(result.view.rows.find((row) => row.name === "tdd")).toMatchObject({
						installed: false,
						status: "not-installed",
					});
					expect(result.view.updateAllCount).toBe(21);
				}
				return { kind: "close" };
			},
		});

		await lifecycle(project, extension, git).runInteractive(interaction.adapter);

		expect(interaction.notices).toEqual([{ kind: "check-warning" }]);
		expect(JSON.parse(readFileSync(statePath(extension), "utf8")).lastCheckedAt).toBe(oldTimestamp);
	});

	it("accepts Update all from the replacement view produced by an in-place refresh", async () => {
		const project = temporaryRoot();
		const extension = temporaryRoot();
		const git = new FakeGit();
		let menuCalls = 0;
		const interaction = scripted({
			chooseSkill: async (_view, refresh) => {
				if (menuCalls++ === 0) {
					await refresh();
					return { kind: "update-all" };
				}
				return { kind: "close" };
			},
			confirm: async (request) => request.kind === "update-all" ? false : true,
		});

		await lifecycle(project, extension, git).runInteractive(interaction.adapter);

		expect(interaction.confirmations[0]).toMatchObject({ kind: "update-all" });
		expect(interaction.confirmations[0].kind === "update-all"
			? interaction.confirmations[0].skills
			: []).toHaveLength(22);
	});

	it("prepares and installs a missing skill, pins the applied head, and replaces the view", async () => {
		const project = temporaryRoot();
		const extension = temporaryRoot();
		const git = new FakeGit();
		let menuCalls = 0;
		const observedViews: SkillMenuView[] = [];
		const interaction = scripted({
			chooseSkill: async (view) => {
				observedViews.push(view);
				return menuCalls++ === 0
					? { kind: "open-skill", name: "tdd" }
					: { kind: "close" };
			},
			chooseAction: async (view, prepare) => {
				expect(view).toMatchObject({ actions: ["install"], requiresPreparation: true });
				await prepare();
				return { kind: "install" };
			},
			confirm: async () => true,
		});

		await lifecycle(project, extension, git).runInteractive(interaction.adapter);

		expect(readFileSync(join(project, ".pi", "skills", "tdd", "SKILL.md"), "utf8"))
			.toContain("name: tdd");
		expect(JSON.parse(readFileSync(statePath(extension), "utf8")).skills.tdd.commit).toBe(HEAD);
		expect(interaction.notices).toContainEqual({ kind: "installed", name: "tdd" });
		expect(observedViews[1].rows.find((row) => row.name === "tdd")).toMatchObject({
			installed: true,
			status: "up-to-date",
			commitsBehind: 0,
		});
	});

	it("bounds a behind preview and preserves the local license line", async () => {
		const project = temporaryRoot();
		const extension = temporaryRoot();
		const git = new FakeGit();
		install(project, "tdd", "---\nname: tdd\n  License: local-value   \n---\nold\n");
		saveStateFile(extension, { lastCheckedAt: null, skills: { tdd: { commit: "old" } } });
		git.logs.set(
			"skills/engineering/tdd",
			Array.from({ length: 16 }, (_, index) => `${index} change`).join("\n"),
		);
		git.stat = " tdd/SKILL.md | 2 +-";
		git.diff = `${Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")}\n`;
		let menuCalls = 0;
		const interaction = scripted({
			chooseSkill: async (_view, refresh) => {
				if (menuCalls++ === 0) {
					await refresh();
					return { kind: "open-skill", name: "tdd" };
				}
				return { kind: "close" };
			},
			chooseAction: async () => ({ kind: "update" }),
			confirm: async () => true,
		});

		await lifecycle(project, extension, git).runInteractive(interaction.adapter);

		const update = interaction.confirmations.find((request) => request.kind === "update");
		expect(update?.kind === "update" ? update.preview : undefined).toMatchObject({
			totalCommits: 16,
			truncated: false,
		});
		if (update?.kind === "update") {
			expect(update.preview?.commitLines).toHaveLength(15);
			expect(update.preview?.skillMarkdownDiffLines).toHaveLength(30);
		}
		expect(readFileSync(join(project, ".pi", "skills", "tdd", "SKILL.md"), "utf8"))
			.toContain("  License: local-value");
	});

	it("blocks unknown and unoffered actions without destructive effects", async () => {
		const project = temporaryRoot();
		const extension = temporaryRoot();
		const git = new FakeGit();
		let calls = 0;
		const interaction = scripted({
			chooseSkill: async () => calls++ === 0
				? { kind: "open-skill", name: "not-tracked" }
				: calls === 2
					? { kind: "open-skill", name: "tdd" }
					: { kind: "close" },
			chooseAction: async () => ({ kind: "uninstall" }),
			confirm: async () => true,
		});

		await lifecycle(project, extension, git).runInteractive(interaction.adapter);

		expect(git.calls).toEqual([]);
		expect(interaction.confirmations).toEqual([]);
		expect(existsSync(join(project, ".pi", "skills", "tdd"))).toBe(false);
	});

	it("uninstalls from a local-only view without Git and clears the pin", async () => {
		const project = temporaryRoot();
		const extension = temporaryRoot();
		const git = new FakeGit();
		install(project, "tdd");
		saveStateFile(extension, { lastCheckedAt: null, skills: { tdd: { commit: "old" } } });
		let menuCalls = 0;
		const interaction = scripted({
			chooseSkill: async () => menuCalls++ === 0
				? { kind: "open-skill", name: "tdd" }
				: { kind: "close" },
			chooseAction: async (view) => {
				expect(view).toMatchObject({
					actions: ["update", "uninstall"],
					requiresPreparation: true,
				});
				return { kind: "uninstall" };
			},
			confirm: async () => true,
		});

		await lifecycle(project, extension, git).runInteractive(interaction.adapter);

		expect(git.calls).toEqual([]);
		expect(existsSync(join(project, ".pi", "skills", "tdd"))).toBe(false);
		expect(JSON.parse(readFileSync(statePath(extension), "utf8")).skills.tdd).toBeUndefined();
		expect(interaction.notices).toContainEqual({ kind: "uninstalled", name: "tdd" });
	});

	it("reports apply failure, keeps persisted state, and returns to a local-only view", async () => {
		const project = temporaryRoot();
		const extension = temporaryRoot();
		const git = new FakeGit();
		git.checkoutFailure = true;
		const views: SkillMenuView[] = [];
		let menuCalls = 0;
		const interaction = scripted({
			chooseSkill: async (view, refresh) => {
				views.push(view);
				if (menuCalls++ === 0) {
					await refresh();
					return { kind: "open-skill", name: "tdd" };
				}
				return { kind: "close" };
			},
			chooseAction: async () => ({ kind: "install" }),
			confirm: async () => true,
		});

		await lifecycle(project, extension, git).runInteractive(interaction.adapter);

		expect(interaction.notices).toContainEqual(expect.objectContaining({
			kind: "apply-failure",
			name: "tdd",
		}));
		expect(views.at(-1)?.kind).toBe("local");
		expect(JSON.parse(readFileSync(statePath(extension), "utf8")).skills.tdd).toBeUndefined();
	});
});
