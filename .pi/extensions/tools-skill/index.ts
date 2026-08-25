/**
 * update-skill — manage the mattpocock + pstack skills from this repo.
 *
 * Installs the 20 tracked mattpocock skills and `unslop` into
 * `.pi/skills/<name>/`, checks upstream once per day (session start, 24h
 * cooldown, never on every session), notifies when updates exist, and
 * `/update-skill` drives a menu: pick a skill → see what the update is
 * (commit messages + diff stat + bounded SKILL.md preview) → confirm →
 * apply. Updates are never automatic.
 *
 * Design notes:
 * - Tracking is commit-based per skill path on the source's `main`, mirroring
 *   how pi's own git packages pin commits (cursor/plugins has no releases).
 * - Cache clones live in `.pi/update-skill/cache/<sourceId>/`; state in
 *   `.pi/update-skill/state.json` (both gitignored). Installed skills in
 *   `.pi/skills/` stay tracked — they are the point of this repo.
 * - The `Git` seam keeps every flow function testable with a fake layer.
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	classifyStatus,
	countCommits,
	buildUpdatePreview,
	skillMenuLabel,
	statusLabel,
	type SkillFacts,
	type SkillStatus,
} from "./diff.ts";
import { createGit, type Git } from "./git.ts";
import {
	getPinned,
	loadState,
	saveState,
	setPinned,
	shouldCheck,
	unpin,
	type UpdateSkillState,
} from "./state.ts";
import { listTrackedSkills, type TrackedSkill } from "./sources.ts";

/** Background checks run at most once per 24h per project. */
const CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The subset of `ctx.ui` update-skill uses (fully typed, easy to fake). */
export interface UpdateSkillUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Result of one skill's status evaluation. */
export interface SkillCheck {
	skill: TrackedSkill;
	status: SkillStatus;
	/** Commits between the pinned commit and origin/<branch>, when known. */
	commitsBehind: number;
	/** Current upstream head commit for the skill's source branch (null on fetch failure). */
	head: string | null;
	/** Pinned commit from state (null when never installed via update-skill). */
	pinned: string | null;
}

export interface CheckAllResult {
	checks: SkillCheck[];
	/** False when a source could not be fetched — statuses may be stale. */
	ok: boolean;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function stateDirFor(projectRoot: string): string {
	return join(projectRoot, CONFIG_DIR_NAME, "update-skill");
}

export function skillsDirFor(projectRoot: string): string {
	return join(projectRoot, CONFIG_DIR_NAME, "skills");
}

export function cacheDirFor(projectRoot: string, sourceId: string): string {
	return join(stateDirFor(projectRoot), "cache", sourceId);
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * Evaluate every tracked skill against its source's `origin/<branch>`.
 * Always contacts the network (fresh clone + fetch); the cooldown lives in
 * the session-start caller, never here.
 */
export async function checkAll(
	git: Git,
	projectRoot: string,
	state: UpdateSkillState,
): Promise<CheckAllResult> {
	const skillsDir = skillsDirFor(projectRoot);
	const bySource = new Map<string, TrackedSkill[]>();
	for (const skill of listTrackedSkills()) {
		const list = bySource.get(skill.sourceId) ?? [];
		list.push(skill);
		bySource.set(skill.sourceId, list);
	}

	const checks: SkillCheck[] = [];
	let ok = true;
	for (const [sourceId, skills] of bySource) {
		const dir = cacheDirFor(projectRoot, sourceId);
		let head: string | null = null;
		try {
			await git.ensureClone(dir, skills[0].url);
			await git.fetch(dir);
			head = await git.revParse(dir, `origin/${skills[0].branch}`);
		} catch (error) {
			ok = false;
			console.error(`update-skill: check failed for ${sourceId}:`, error);
		}

		for (const skill of skills) {
			const installed = existsSync(join(skillsDir, skill.name));
			const pinned = getPinned(state, skill.name) ?? null;

			let existsUpstream = true;
			if (head !== null) {
				try {
					existsUpstream = await git.pathExistsAtRef(dir, `origin/${skill.branch}`, skill.path);
				} catch (error) {
					ok = false;
					console.error(`[update-skill] ls-tree failed for ${skill.name}:`, error);
				}
			}

			let commitsBehind = 0;
			if (installed && pinned !== null && head !== null && existsUpstream) {
				try {
					commitsBehind = countCommits(
						await git.logOneline(dir, `${pinned}..origin/${skill.branch}`, skill.path),
					);
				} catch (error) {
					// Pinned commit not resolvable locally (state drift): report as unknown.
					console.error(`[update-skill] log failed for ${skill.name}:`, error);
				}
			}

			const facts: SkillFacts = { installed, pinned, head, existsUpstream };
			checks.push({
				skill,
				status: classifyStatus(facts, commitsBehind),
				commitsBehind,
				head,
				pinned,
			});
		}
	}
	return { checks, ok };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyResult {
	/** New pinned head commit. */
	head: string;
	/** "updated" or "installed" (first time). */
	action: "updated" | "installed";
}

/**
 * Copy the skill directory from the cache worktree at `origin/<branch>` into
 * `.pi/skills/<name>/` (stale files deleted), preserve a local `license:`
 * frontmatter line if the installed copy has one (unslop), and pin the new
 * commit in state.
 */
export async function applySkill(
	git: Git,
	projectRoot: string,
	state: UpdateSkillState,
	skill: TrackedSkill,
): Promise<ApplyResult> {
	const cache = cacheDirFor(projectRoot, skill.sourceId);
	const ref = `origin/${skill.branch}`;
	await git.checkout(cache, ref);

	const dest = join(skillsDirFor(projectRoot), skill.name);
	const localLicenseLine = readLicenseLine(join(dest, "SKILL.md"));
	const wasInstalled = existsSync(dest);

	rmSync(dest, { recursive: true, force: true });
	cpSync(join(cache, skill.path), dest, { recursive: true });
	reinsertLicenseLine(join(dest, "SKILL.md"), localLicenseLine);

	const head = await git.revParse(cache, ref);
	setPinned(state, skill.name, head);
	saveState(stateDirFor(projectRoot), state);

	return { head, action: wasInstalled ? "updated" : "installed" };
}

/**
 * Delete the local copy of a skill removed upstream, unpinning it in state.
 */
export function removeSkill(
	projectRoot: string,
	state: UpdateSkillState,
	skill: TrackedSkill,
): void {
	rmSync(join(skillsDirFor(projectRoot), skill.name), { recursive: true, force: true });
	unpin(state, skill.name);
	saveState(stateDirFor(projectRoot), state);
}

/**
 * Preserve the `license:` line across updates: read it from the installed
 * copy before it is replaced.
 */
export function readLicenseLine(skillMarkdownPath: string): string | null {
	try {
		const lines = readFileSync(skillMarkdownPath, "utf8").split("\n", 20);
		const line = lines.find((l) => /^license\s*:/i.test(l.trimStart()));
		return line?.trimEnd() ?? null;
	} catch {
		return null;
	}
}

/**
 * Re-insert a previously read `license:` line into the (fresh upstream)
 * frontmatter, unless the new file already has one. No frontmatter → skip.
 */
export function reinsertLicenseLine(skillMarkdownPath: string, line: string | null): void {
	if (line === null) return;
	const text = readFileSync(skillMarkdownPath, "utf8");
	if (/^license\s*:/im.test(text)) return;

	const lines = text.split("\n");
	if (lines[0].trim() !== "---") return; // no frontmatter to amend
	let close = -1;
	for (let i = 1; i < lines.length && i < 50; i++) {
		if (lines[i].trim() === "---") {
			close = i;
			break;
		}
	}
	if (close <= 0) return;
	lines.splice(close, 0, line);
	writeFileSync(skillMarkdownPath, lines.join("\n"), "utf8");
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export type MenuAction =
	| { kind: "update-all" }
	| { kind: "check-now" }
	| { kind: "cancel" }
	| { kind: "skill"; name: string };

export interface MenuEntry {
	label: string;
	action: MenuAction;
}

const CHECK_NOW_LABEL = "* Check now (fetch upstream)";
const CANCEL_LABEL = "Cancel";

/** Skills an "Update all" would touch, in apply order: behind (alpha), then not-installed (alpha). */
export function updateAllOrder(checks: SkillCheck[]): SkillCheck[] {
	const behind = checks
		.filter((c) => c.status === "behind")
		.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
	const missing = checks
		.filter((c) => c.status === "not-installed")
		.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
	return [...behind, ...missing];
}

/**
 * Menu entries: pending skills first (behind, then not-installed, alpha
 * within each), then up-to-date, then removed; plus "Update all (N)" when
 * anything is pending, "Check now" and "Cancel" at the end.
 */
export function buildMenu(checks: SkillCheck[]): MenuEntry[] {
	const pending = new Set(updateAllOrder(checks).map((c) => c.skill.name));
	const entries: MenuEntry[] = [];

	const pendingCount = pending.size;
	if (pendingCount > 0) {
		entries.push({ label: `* Update all (${pendingCount})`, action: { kind: "update-all" } });
	}

	const sorted = [...checks].sort((a, b) => a.skill.name.localeCompare(b.skill.name));
	for (const check of sorted) {
		entries.push({
			label: skillMenuLabel(check.skill.name, check.status, check.commitsBehind),
			action: { kind: "skill", name: check.skill.name },
		});
	}

	entries.push({ label: CHECK_NOW_LABEL, action: { kind: "check-now" } });
	entries.push({ label: CANCEL_LABEL, action: { kind: "cancel" } });
	return entries;
}

export function findAction(entries: MenuEntry[], label: string): MenuAction | undefined {
	return entries.find((e) => e.label === label)?.action;
}

// ---------------------------------------------------------------------------
// Background check (session start)
// ---------------------------------------------------------------------------

export interface BackgroundCheckResult {
	/** Skills with commits behind upstream. */
	updates: string[];
	/** Whether the check completed successfully (only then the cooldown advances). */
	ok: boolean;
}

/**
 * The session-start check: fetch all sources, compare pinned commits, update
 * `lastCheckedAt` (only on success), and return what changed. Notify is the
 * caller's job so tests can assert on the returned value.
 */
export async function runBackgroundCheck(
	git: Git,
	projectRoot: string,
	state: UpdateSkillState,
	now: number,
): Promise<BackgroundCheckResult> {
	const { checks, ok } = await checkAll(git, projectRoot, state);
	if (ok) {
		state.lastCheckedAt = new Date(now).toISOString();
		saveState(stateDirFor(projectRoot), state);
	}
	const updates = checks
		.filter((c) => c.status === "behind")
		.map((c) => c.skill.name)
		.sort();
	return { updates, ok };
}

// ---------------------------------------------------------------------------
// Interactive flow
// ---------------------------------------------------------------------------

/**
 * The `/update-skill` flow. Loops on the menu so several skills can be
 * updated in one session. `ui` is `ctx.ui` in production, a fake in tests.
 */
export async function runUpdateSkillFlow(
	git: Git,
	projectRoot: string,
	state: UpdateSkillState,
	ui: UpdateSkillUI,
): Promise<void> {
	const { checks, ok } = await checkAll(git, projectRoot, state);
	if (ok) {
		state.lastCheckedAt = new Date().toISOString();
		saveState(stateDirFor(projectRoot), state);
	} else {
		ui.notify("update-skill: upstream check failed — showing last known status", "warning");
	}

	const byName = new Map(checks.map((c) => [c.skill.name, c]));

	for (;;) {
		const entries = buildMenu(checks);
		const label = await ui.select("update-skill — which skill?", entries.map((e) => e.label));
		if (label === undefined) return; // escaped
		const action = findAction(entries, label);
		if (action === undefined) return;

		if (action.kind === "cancel") return;
		if (action.kind === "check-now") {
			const fresh = await checkAll(git, projectRoot, state);
			if (fresh.ok) {
				state.lastCheckedAt = new Date().toISOString();
				saveState(stateDirFor(projectRoot), state);
			}
			for (const check of fresh.checks) {
				const slot = byName.get(check.skill.name);
				if (slot) Object.assign(slot, check);
			}
			continue;
		}
		if (action.kind === "update-all") {
			const pending = updateAllOrder(checks);
			const list = pending
				.map((c) => `  ${c.skill.name} (${statusLabel(c.status, c.commitsBehind)})`)
				.join("\n");
			const okAll = await ui.confirm(
				`Update all (${pending.length})?`,
				`Installing/updating:\n${list}`,
			);
			if (!okAll) continue;
			const done: string[] = [];
			for (const check of pending) {
				if (await tryApply(git, projectRoot, state, check, ui)) done.push(check.skill.name);
			}
			if (done.length > 0) {
				ui.notify(`update-skill: ${done.join(", ")} updated`, "info");
			}
			continue;
		}

		// Single skill.
		const check = byName.get(action.name);
		if (!check) continue;
		switch (check.status) {
			case "up-to-date":
				ui.notify(`update-skill: ${check.skill.name} is already up to date`, "info");
				continue;
			case "removed": {
				const remove = await ui.confirm(
					`${check.skill.name} was removed upstream`,
					`Delete the local copy at .pi/skills/${check.skill.name}/?`,
				);
				if (remove) {
					removeSkill(projectRoot, state, check.skill);
					check.status = "not-installed";
					check.pinned = null;
					ui.notify(`update-skill: removed ${check.skill.name}`, "info");
				}
				continue;
			}
			case "not-installed": {
				const alreadyThere = existsSync(join(skillsDirFor(projectRoot), check.skill.name));
				const install = await ui.confirm(
					`Install ${check.skill.name}?`,
					`Copy ${check.skill.path} from ${check.skill.sourceId} into .pi/skills/${check.skill.name}/${
						alreadyThere ? " — existing files will be replaced" : ""
					}`,
				);
				if (!install) continue;
				await tryApply(git, projectRoot, state, check, ui);
				continue;
			}
			case "behind": {
				let preview: string;
				try {
					preview = await buildSkillPreview(git, projectRoot, check);
				} catch (error) {
					ui.notify(
						`update-skill: could not build the preview for ${check.skill.name} (${String(error)})`,
						"error",
					);
					continue;
				}
				const okUpdate = await ui.confirm(
					`Update ${check.skill.name}? (${check.commitsBehind} commit${
						check.commitsBehind === 1 ? "" : "s"
					} behind)`,
					preview,
				);
				if (!okUpdate) continue;
				await tryApply(git, projectRoot, state, check, ui);
				continue;
			}
		}
	}
}

/**
 * Apply a skill, refresh the in-memory check, and notify. Never throws —
 * network/cache failures surface as an error notification instead of
 * crashing the command handler.
 */
async function tryApply(
	git: Git,
	projectRoot: string,
	state: UpdateSkillState,
	check: SkillCheck,
	ui: UpdateSkillUI,
): Promise<boolean> {
	try {
		const result = await applySkill(git, projectRoot, state, check.skill);
		check.status = "up-to-date";
		check.commitsBehind = 0;
		check.head = result.head;
		check.pinned = result.head;
		ui.notify(`update-skill: ${result.action} ${check.skill.name}`, "info");
		return true;
	} catch (error) {
		ui.notify(`update-skill: failed to update ${check.skill.name} (${String(error)})`, "error");
		return false;
	}
}

/** The "what does this update contain" confirm message for a behind skill. */
export async function buildSkillPreview(
	git: Git,
	projectRoot: string,
	check: SkillCheck,
): Promise<string> {
	const dir = cacheDirFor(projectRoot, check.skill.sourceId);
	const ref = `origin/${check.skill.branch}`;
	const range = `${check.pinned}..${ref}`;
	const [log, stat, diff] = await Promise.all([
		git.logOneline(dir, range, check.skill.path),
		git.diffStat(dir, range, check.skill.path),
		git.diffSkillMarkdown(dir, range, check.skill.path),
	]);
	return buildUpdatePreview(log, stat, diff);
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

/**
 * Background update check at session start, gated on the 24h cooldown.
 * Never blocks session startup and never notifies when nothing changed.
 *
 * `gitFactory` is injectable for tests (default: real git).
 */
export default function updateSkillExtension(
	pi: ExtensionAPI,
	gitFactory: () => Git = createGit,
): void {
	let backgroundPromise: Promise<void> | null = null;

	pi.on("session_start", (_event, ctx) => {
		if (backgroundPromise) return; // already checking
		backgroundPromise = (async () => {
			const root = ctx.cwd;
			const state = loadState(stateDirFor(root));
			if (!shouldCheck(state, Date.now(), CHECK_COOLDOWN_MS)) return;
			try {
				const result = await runBackgroundCheck(gitFactory(), root, state, Date.now());
				if (result.updates.length > 0) {
					ctx.ui.notify(
						`update-skill: ${result.updates.length} skill${
							result.updates.length === 1 ? "" : "s"
						} ${result.updates.length === 1 ? "has" : "have"} updates (${result.updates.join(", ")}). Run /update-skill`,
						"info",
					);
				}
			} catch (error) {
				// Offline or broken git: stay quiet, keep the old cooldown so the
				// next session retries.
				console.error("[update-skill] background check failed:", error);
			}
		})();
	});

	pi.registerCommand("update-skill", {
		description: "Check and update the mattpocock + pstack skills installed from this repo",
		handler: async (_args, ctx) => {
			await runUpdateSkillFlow(gitFactory(), ctx.cwd, loadState(stateDirFor(ctx.cwd)), ctx.ui);
		},
	});
}
