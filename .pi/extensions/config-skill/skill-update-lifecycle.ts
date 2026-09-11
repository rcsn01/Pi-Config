/**
 * Deep lifecycle for curated Skill updates. It owns local and upstream state,
 * check and apply ordering, persistence, confirmations, and expected failures.
 * Pi rendering and Git process execution remain behind adapters.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { classifyStatus, countCommits, type SkillStatus } from "./diff.ts";
import type { Git } from "./git.ts";
import { getPinned, loadState, saveState, type UpdateSkillState } from "./state.ts";
import { listTrackedSkills, type TrackedSkill } from "./sources.ts";

const CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PREVIEW_COMMIT_LIMIT = 15;
const PREVIEW_DIFF_LINE_LIMIT = 30;

export type SkillBackgroundCheckOutcome =
	| { kind: "skipped"; reason: "cooldown" }
	| { kind: "checked"; ok: boolean; updates: readonly string[] };

export type SkillMenuIntent =
	| { kind: "update-all" }
	| { kind: "open-skill"; name: string }
	| { kind: "close" };

export type SkillActionIntent =
	| { kind: "install" }
	| { kind: "update" }
	| { kind: "uninstall" }
	| { kind: "back" };

export interface SkillMenuRow {
	name: string;
	installed: boolean;
	status?: SkillStatus;
	commitsBehind?: number;
}

export interface SkillMenuView {
	kind: "local" | "checked";
	rows: readonly SkillMenuRow[];
	updateAllCount: number;
}

export interface SkillActionView {
	name: string;
	actions: readonly SkillActionIntent["kind"][];
	requiresPreparation: boolean;
}

export interface SkillMenuRefresh {
	view: SkillMenuView;
	completion: "complete" | "warning";
}

export interface SkillPreview {
	commitLines: readonly string[];
	changedFileLines: readonly string[];
	skillMarkdownDiffLines: readonly string[];
	totalCommits: number;
	truncated: boolean;
}

export type SkillConfirmation =
	| { kind: "install"; name: string; sourceId: string; sourcePath: string }
	| {
			kind: "update";
			name: string;
			sourceId: string;
			branch: string;
			commitsBehind: number;
			preview?: SkillPreview;
	  }
	| { kind: "uninstall"; name: string }
	| {
			kind: "update-all";
			skills: readonly { name: string; status: SkillStatus; commitsBehind: number }[];
	  };

export type SkillUpdateNotice =
	| { kind: "check-warning" }
	| { kind: "installed" | "updated" | "uninstalled"; name: string }
	| { kind: "update-all-complete"; names: readonly string[] }
	| { kind: "removed-upstream"; name: string }
	| { kind: "already-current"; name: string }
	| { kind: "preview-failure" | "apply-failure"; name: string; error: string };

export interface SkillUpdateInteractionAdapter {
	chooseSkill(
		view: SkillMenuView,
		refresh: () => Promise<SkillMenuRefresh>,
	): Promise<SkillMenuIntent>;
	chooseAction(
		view: SkillActionView,
		prepare: () => Promise<void>,
	): Promise<SkillActionIntent>;
	confirm(request: SkillConfirmation): Promise<boolean>;
	report(notice: SkillUpdateNotice): void;
}

export interface SkillUpdateLifecycle {
	checkInBackground(now: number): Promise<SkillBackgroundCheckOutcome>;
	runInteractive(interaction: SkillUpdateInteractionAdapter): Promise<void>;
}

export interface CreateSkillUpdateLifecycleOptions {
	projectRoot: string;
	extensionDir: string;
	git: Git;
}

interface CheckedRow extends SkillMenuRow {
	skill: TrackedSkill;
	status: SkillStatus;
	commitsBehind: number;
	complete: boolean;
	head: string | null;
	pinned: string | null;
}

interface CheckSnapshot {
	rows: readonly CheckedRow[];
	ok: boolean;
}

export function createSkillUpdateLifecycle(
	options: CreateSkillUpdateLifecycleOptions,
): SkillUpdateLifecycle {
	const { projectRoot, extensionDir, git } = options;
	const trackedSkills = listTrackedSkills();
	const stateDir = join(extensionDir, "update-skill");
	const skillsDir = join(projectRoot, CONFIG_DIR_NAME, "skills");
	const cacheDir = (sourceId: string): string => join(stateDir, "cache", sourceId);
	const isInstalled = (name: string): boolean => existsSync(join(skillsDir, name));
	let state: UpdateSkillState;
	let snapshot: CheckSnapshot | null = null;

	async function checkAll(): Promise<CheckSnapshot> {
		const bySource = new Map<string, TrackedSkill[]>();
		for (const skill of trackedSkills) {
			const skills = bySource.get(skill.sourceId) ?? [];
			skills.push(skill);
			bySource.set(skill.sourceId, skills);
		}

		const rows: CheckedRow[] = [];
		let ok = true;
		for (const [sourceId, skills] of bySource) {
			const dir = cacheDir(sourceId);
			let head: string | null = null;
			let sourceComplete = true;
			try {
				await git.ensureClone(dir, skills[0].url);
				await git.fetch(dir);
				head = await git.revParse(dir, `origin/${skills[0].branch}`);
			} catch (error) {
				sourceComplete = false;
				ok = false;
				console.error(`update-skill: check failed for ${sourceId}:`, error);
			}

			for (const skill of skills) {
				const installed = isInstalled(skill.name);
				const pinned = getPinned(state, skill.name) ?? null;
				let complete = sourceComplete;
				let existsUpstream = true;
				let commitsBehind = 0;

				if (complete) {
					try {
						existsUpstream = await git.pathExistsAtRef(
							dir,
							`origin/${skill.branch}`,
							skill.path,
						);
					} catch (error) {
						complete = false;
						ok = false;
						console.error(`[update-skill] ls-tree failed for ${skill.name}:`, error);
					}
				}

				if (complete && installed && pinned !== null && existsUpstream) {
					try {
						const log = await git.logOneline(
							dir,
							`${pinned}..origin/${skill.branch}`,
							skill.path,
						);
						commitsBehind = countCommits(log);
					} catch (error) {
						complete = false;
						ok = false;
						console.error(`[update-skill] log failed for ${skill.name}:`, error);
					}
				}

				const status = complete
					? classifyStatus({ installed, pinned, head, existsUpstream }, commitsBehind)
					: installed
						? "up-to-date"
						: "not-installed";
				rows.push({
					skill,
					name: skill.name,
					installed,
					status,
					commitsBehind: complete ? commitsBehind : 0,
					complete,
					head,
					pinned,
				});
			}
		}
		return { rows, ok };
	}

	function buildMenuView(): SkillMenuView {
		if (snapshot === null) {
			return {
				kind: "local",
				rows: trackedSkills
					.map((skill) => ({ name: skill.name, installed: isInstalled(skill.name) }))
					.sort((a, b) => a.name.localeCompare(b.name)),
				updateAllCount: 0,
			};
		}

		const updateAllCount = snapshot.rows.filter(
			(row) => row.complete && (row.status === "behind" || row.status === "not-installed"),
		).length;
		return {
			kind: "checked",
			rows: snapshot.rows
				.map(({ name, installed, status, commitsBehind }) => ({
					name,
					installed,
					status,
					commitsBehind,
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
			updateAllCount,
		};
	}

	async function refresh(
		interaction: SkillUpdateInteractionAdapter,
	): Promise<SkillMenuRefresh> {
		const fresh = await checkAll();
		if (fresh.ok) {
			const nextState = { ...state, lastCheckedAt: new Date().toISOString() };
			saveState(stateDir, nextState);
			state = nextState;
		} else {
			interaction.report({ kind: "check-warning" });
		}
		snapshot = fresh;
		return {
			view: buildMenuView(),
			completion: fresh.ok ? "complete" : "warning",
		};
	}

	// Callback-driven refreshes can replace the snapshot while a selector remains mounted.
	function currentSnapshot(): CheckSnapshot | null {
		return snapshot;
	}

	function replaceCheckedRow(name: string, patch: Partial<CheckedRow>): void {
		if (snapshot === null) return;
		snapshot = {
			...snapshot,
			rows: snapshot.rows.map((row) => row.name === name ? { ...row, ...patch } : row),
		};
	}

	async function applySkill(
		row: CheckedRow,
		interaction: SkillUpdateInteractionAdapter,
	): Promise<boolean> {
		try {
			const destination = join(skillsDir, row.name);
			const ref = `origin/${row.skill.branch}`;
			const sourceCache = cacheDir(row.skill.sourceId);
			await git.checkout(sourceCache, ref);

			const wasInstalled = existsSync(destination);
			const licenseLine = readLicenseLine(join(destination, "SKILL.md"));
			rmSync(destination, { recursive: true, force: true });
			cpSync(join(sourceCache, row.skill.path), destination, { recursive: true });
			reinsertLicenseLine(join(destination, "SKILL.md"), licenseLine);

			const head = await git.revParse(sourceCache, ref);
			const nextState = {
				...state,
				skills: { ...state.skills, [row.name]: { commit: head } },
			};
			saveState(stateDir, nextState);
			state = nextState;
			replaceCheckedRow(row.name, {
				installed: true,
				status: "up-to-date",
				commitsBehind: 0,
				head,
				pinned: head,
				complete: true,
			});
			interaction.report({ kind: wasInstalled ? "updated" : "installed", name: row.name });
			return true;
		} catch (error) {
			interaction.report({ kind: "apply-failure", name: row.name, error: String(error) });
			snapshot = null;
			return false;
		}
	}

	async function buildPreview(row: CheckedRow): Promise<SkillPreview> {
		const dir = cacheDir(row.skill.sourceId);
		const range = `${row.pinned}..origin/${row.skill.branch}`;
		const [log, stat, diff] = await Promise.all([
			git.logOneline(dir, range, row.skill.path),
			git.diffStat(dir, range, row.skill.path),
			git.diffSkillMarkdown(dir, range, row.skill.path),
		]);
		const commits = log.split("\n").map((line) => line.trim()).filter(Boolean);
		const changedFiles = stat.split("\n").filter((line) => line.trim().length > 0);
		const diffLines = splitOutputLines(diff);
		return {
			commitLines: commits.slice(0, PREVIEW_COMMIT_LIMIT),
			changedFileLines: changedFiles,
			skillMarkdownDiffLines: diffLines.slice(0, PREVIEW_DIFF_LINE_LIMIT),
			totalCommits: commits.length,
			truncated: diffLines.length > PREVIEW_DIFF_LINE_LIMIT,
		};
	}

	async function performSkillAction(
		name: string,
		action: SkillActionIntent["kind"],
		offeredView: SkillActionView,
		interaction: SkillUpdateInteractionAdapter,
	): Promise<void> {
		const skill = trackedSkills.find((candidate) => candidate.name === name);
		if (skill === undefined || action === "back" || !offeredView.actions.includes(action)) return;

		const installed = isInstalled(name);
		if (action === "uninstall") {
			if (!installed || !await interaction.confirm({ kind: "uninstall", name })) return;
			rmSync(join(skillsDir, name), { recursive: true, force: true });
			const skills = { ...state.skills };
			delete skills[name];
			const nextState = { ...state, skills };
			saveState(stateDir, nextState);
			state = nextState;
			replaceCheckedRow(name, {
				installed: false,
				status: "not-installed",
				pinned: null,
				commitsBehind: 0,
			});
			interaction.report({ kind: "uninstalled", name });
			return;
		}

		if ((action === "install" && installed) || (action === "update" && !installed)) return;
		const row = snapshot?.rows.find((candidate) => candidate.name === name);
		if (row === undefined || !row.complete) return;

		if (action === "install") {
			if (row.status !== "not-installed") return;
			const confirmed = await interaction.confirm({
				kind: "install",
				name,
				sourceId: skill.sourceId,
				sourcePath: skill.path,
			});
			if (confirmed) await applySkill(row, interaction);
			return;
		}

		if (row.status === "removed") {
			interaction.report({ kind: "removed-upstream", name });
			return;
		}
		if (row.status === "up-to-date") {
			interaction.report({ kind: "already-current", name });
			return;
		}

		let preview: SkillPreview | undefined;
		if (row.status === "behind") {
			try {
				preview = await buildPreview(row);
			} catch (error) {
				interaction.report({ kind: "preview-failure", name, error: String(error) });
				return;
			}
		}
		const confirmed = await interaction.confirm({
			kind: "update",
			name,
			sourceId: skill.sourceId,
			branch: skill.branch,
			commitsBehind: row.commitsBehind,
			preview,
		});
		if (confirmed) await applySkill(row, interaction);
	}

	return {
		async checkInBackground(now) {
			if (!Number.isFinite(now)) {
				throw new TypeError("now must be a finite epoch-millisecond value");
			}
			state = loadState(stateDir);
			snapshot = null;
			const lastChecked = state.lastCheckedAt === null
				? Number.NaN
				: Date.parse(state.lastCheckedAt);
			if (!Number.isNaN(lastChecked) && now - lastChecked <= CHECK_COOLDOWN_MS) {
				return { kind: "skipped", reason: "cooldown" };
			}

			const fresh = await checkAll();
			if (fresh.ok) {
				const nextState = { ...state, lastCheckedAt: new Date(now).toISOString() };
				saveState(stateDir, nextState);
				state = nextState;
			}
			return {
				kind: "checked",
				ok: fresh.ok,
				updates: fresh.rows
					.filter((row) => row.complete && row.status === "behind")
					.map((row) => row.name)
					.sort(),
			};
		},

		async runInteractive(interaction) {
			state = loadState(stateDir);
			snapshot = null;
			for (;;) {
				const presentedView = buildMenuView();
				const intent = await interaction.chooseSkill(
					presentedView,
					() => refresh(interaction),
				);
				if (intent.kind === "close") return;

				if (intent.kind === "update-all") {
					const activeSnapshot = currentSnapshot();
					if (activeSnapshot === null || buildMenuView().kind !== "checked") continue;
					const pending = activeSnapshot.rows
						.filter((row) =>
							row.complete && (row.status === "behind" || row.status === "not-installed"),
						)
						.sort((a, b) => {
							if (a.status === b.status) return a.name.localeCompare(b.name);
							return a.status === "behind" ? -1 : 1;
						});
					if (pending.length === 0) continue;
					const confirmed = await interaction.confirm({
						kind: "update-all",
						skills: pending.map((row) => ({
							name: row.name,
							status: row.status,
							commitsBehind: row.commitsBehind,
						})),
					});
					if (!confirmed) continue;

					const completed: string[] = [];
					for (const row of pending) {
						if (await applySkill(row, interaction)) completed.push(row.name);
					}
					if (completed.length > 0) {
						interaction.report({ kind: "update-all-complete", names: completed });
					}
					continue;
				}

				const skill = trackedSkills.find((candidate) => candidate.name === intent.name);
				if (skill === undefined) continue;
				const installed = isInstalled(skill.name);
				const activeSnapshot = currentSnapshot();
				const checkedRow = activeSnapshot?.rows.find((row) => row.name === skill.name);
				const actions: SkillActionIntent["kind"][] = activeSnapshot === null
					? installed
						? ["update", "uninstall"]
						: ["install"]
					: checkedRow?.complete
						? installed
							? ["update", "uninstall"]
							: ["install"]
						: installed
							? ["uninstall"]
							: [];
				const actionView: SkillActionView = {
					name: skill.name,
					actions,
					requiresPreparation: activeSnapshot === null
						&& actions.some((action) => action === "install" || action === "update"),
				};
				let prepared = false;
				const action = await interaction.chooseAction(actionView, async () => {
					if (!actionView.requiresPreparation) return;
					await refresh(interaction);
					prepared = true;
				});
				if (action.kind === "back") continue;
				if (
					actionView.requiresPreparation
					&& !prepared
					&& (action.kind === "install" || action.kind === "update")
				) continue;
				await performSkillAction(skill.name, action.kind, actionView, interaction);
			}
		},
	};
}

function splitOutputLines(output: string): string[] {
	if (output.length === 0) return [];
	const lines = output.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function readLicenseLine(path: string): string | null {
	try {
		const lines = readFileSync(path, "utf8").split("\n", 20);
		const line = lines.find((candidate) => /^license\s*:/i.test(candidate.trimStart()));
		return line?.trimEnd() ?? null;
	} catch {
		return null;
	}
}

function reinsertLicenseLine(path: string, line: string | null): void {
	if (line === null) return;
	const text = readFileSync(path, "utf8");
	if (/^license:/im.test(text)) return;
	const lines = text.split("\n");
	if (lines[0].trim() !== "---") return;
	let closingDelimiter = -1;
	for (let index = 1; index < lines.length && index < 50; index++) {
		if (lines[index].trim() === "---") {
			closingDelimiter = index;
			break;
		}
	}
	if (closingDelimiter <= 0) return;
	lines.splice(closingDelimiter, 0, line);
	writeFileSync(path, lines.join("\n"), "utf8");
}
