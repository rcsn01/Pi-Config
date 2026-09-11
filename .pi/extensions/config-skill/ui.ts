import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import {
	createSelectListTheme,
	fitUiLines,
	renderSelectorFrame,
	selectorHint,
} from "../_shared/ui-style.ts";
import type { SkillStatus } from "./diff.ts";
import type {
	SkillActionIntent,
	SkillActionView,
	SkillConfirmation,
	SkillMenuIntent,
	SkillMenuRefresh,
	SkillMenuView,
	SkillPreview,
	SkillUpdateInteractionAdapter,
	SkillUpdateNotice,
} from "./skill-update-lifecycle.ts";

const MENU_TITLE = "update-skill — which skill?";
const CHECK_NOW_LABEL = "* Check now (fetch upstream)";
const CANCEL_LABEL = "Cancel";
const ACTION_LABELS: Record<SkillActionIntent["kind"], string> = {
	install: "Install",
	update: "Update",
	uninstall: "Uninstall",
	back: "Back",
};

type MenuValue = SkillMenuIntent | { kind: "check-now" };
interface MenuEntry {
	label: string;
	value: MenuValue;
}

/** Adapt Pi rendering and persistent selectors to the lifecycle's semantic seam. */
export function createPiSkillUpdateInteraction(
	ctx: ExtensionCommandContext,
): SkillUpdateInteractionAdapter {
	return {
		chooseSkill: (view, refresh) => chooseSkill(ctx, view, refresh),
		chooseAction: (view, prepare) => chooseAction(ctx, view, prepare),
		confirm: (request) => confirm(ctx, request),
		report: (notice) => report(ctx, notice),
	};
}

function statusLabel(status: SkillStatus, commitsBehind: number): string {
	switch (status) {
		case "up-to-date":
			return "up to date";
		case "behind":
			return `${commitsBehind} commit${commitsBehind === 1 ? "" : "s"} behind`;
		case "not-installed":
			return "not installed";
		case "removed":
			return "removed upstream";
	}
}

function menuEntries(view: SkillMenuView): MenuEntry[] {
	const entries: MenuEntry[] = [];
	if (view.updateAllCount > 0) {
		entries.push({
			label: `* Update all (${view.updateAllCount})`,
			value: { kind: "update-all" },
		});
	}
	const nameWidth = Math.max(0, ...view.rows.map((row) => row.name.length));
	for (const row of view.rows) {
		const label = view.kind === "local"
			? `${row.name.padEnd(nameWidth)}  ${row.installed ? "installed locally" : "not installed"}`
			: `${row.name.padEnd(nameWidth)}  ${statusLabel(row.status ?? "up-to-date", row.commitsBehind ?? 0)}`;
		entries.push({ label, value: { kind: "open-skill", name: row.name } });
	}
	entries.push({ label: CHECK_NOW_LABEL, value: { kind: "check-now" } });
	entries.push({ label: CANCEL_LABEL, value: { kind: "close" } });
	return entries;
}

async function chooseSkill(
	ctx: ExtensionCommandContext,
	initialView: SkillMenuView,
	refresh: () => Promise<SkillMenuRefresh>,
): Promise<SkillMenuIntent> {
	if (ctx.mode === "tui") return selectPersistentMenu(ctx, initialView, refresh);

	let view = initialView;
	for (;;) {
		const entries = menuEntries(view);
		const selected = await ctx.ui.select(MENU_TITLE, entries.map((entry) => entry.label));
		if (selected === undefined) return { kind: "close" };
		const value = entries.find((entry) => entry.label === selected)?.value;
		if (value === undefined || value.kind === "close") return { kind: "close" };
		if (value.kind !== "check-now") return value;

		ctx.ui.setWidget("update-skill", [
			"update-skill",
			...entries.map((entry) => `  ${entry.label}`),
			"",
			"Checking upstream...",
		]);
		try {
			view = (await refresh()).view;
		} finally {
			ctx.ui.setWidget("update-skill", undefined);
		}
	}
}

async function chooseAction(
	ctx: ExtensionCommandContext,
	view: SkillActionView,
	prepare: () => Promise<void>,
): Promise<SkillActionIntent> {
	if (ctx.mode === "tui") return selectPersistentAction(ctx, view, prepare);

	const actions = [...view.actions, "back" as const];
	const selected = await ctx.ui.select(
		`${view.name} — action`,
		actions.map((action) => ACTION_LABELS[action]),
	);
	const action = actions.find((candidate) => ACTION_LABELS[candidate] === selected) ?? "back";
	if (view.requiresPreparation && (action === "install" || action === "update")) {
		ctx.ui.setWidget("update-skill", [
			"update-skill",
			...actions.map((candidate) => `  ${ACTION_LABELS[candidate]}`),
			"",
			"Checking upstream...",
		]);
		try {
			await prepare();
		} finally {
			ctx.ui.setWidget("update-skill", undefined);
		}
	}
	return { kind: action };
}

function selectPersistentMenu(
	ctx: ExtensionCommandContext,
	initialView: SkillMenuView,
	refresh: () => Promise<SkillMenuRefresh>,
): Promise<SkillMenuIntent> {
	return ctx.ui.custom<SkillMenuIntent>((tui, theme, keybindings, done) => {
		let entries = menuEntries(initialView);
		let list: SelectList;
		let busy = false;
		let status = "Select a skill or check upstream for updates.";

		const rebuild = (selectedIndex = 0): void => {
			const items: SelectItem[] = entries.map((entry, index) => ({
				value: String(index),
				label: entry.label,
			}));
			list = new SelectList(
				items,
				Math.min(Math.max(entries.length, 1), 16),
				createSelectListTheme(theme),
			);
			list.setSelectedIndex(Math.max(0, Math.min(selectedIndex, entries.length - 1)));
			list.onCancel = () => done({ kind: "close" });
			list.onSelect = (item) => {
				if (busy) return;
				const value = entries[Number(item.value)]?.value;
				if (value === undefined) return;
				if (value.kind !== "check-now") {
					done(value);
					return;
				}

				busy = true;
				status = "Checking upstream...";
				tui.requestRender();
				void refresh()
					.then((result) => {
						entries = menuEntries(result.view);
						busy = false;
						status = result.completion === "complete"
							? "Upstream check complete."
							: "Check finished with warnings.";
						const checkIndex = entries.findIndex((entry) => entry.value.kind === "check-now");
						rebuild(checkIndex >= 0 ? checkIndex : 0);
						tui.requestRender();
					})
					.catch((error) => {
						busy = false;
						status = `Check failed: ${error instanceof Error ? error.message : String(error)}`;
						tui.requestRender();
					});
			};
		};
		rebuild();

		return {
			render(width: number): string[] {
				const safeWidth = Math.max(1, width);
				return renderSelectorFrame(theme, safeWidth, {
					title: MENU_TITLE,
					body: [
						...fitUiLines(list.render(safeWidth), safeWidth),
						"",
						theme.fg(busy ? "warning" : "muted", status),
					],
					hint: busy
						? "Checking upstream; the list will refresh when finished"
						: selectorHint(keybindings, { confirmVerb: "select", cancelVerb: "close" }),
				});
			},
			invalidate(): void {
				list.invalidate();
			},
			handleInput(data: string): void {
				if (busy) return;
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function selectPersistentAction(
	ctx: ExtensionCommandContext,
	view: SkillActionView,
	prepare: () => Promise<void>,
): Promise<SkillActionIntent> {
	return ctx.ui.custom<SkillActionIntent>((tui, theme, keybindings, done) => {
		const actions = [...view.actions, "back" as const];
		let busy = false;
		let status = "Choose an action.";
		const list = new SelectList(
			actions.map((action) => ({ value: action, label: ACTION_LABELS[action] })),
			actions.length,
			createSelectListTheme(theme),
		);
		list.onCancel = () => done({ kind: "back" });
		list.onSelect = (item) => {
			if (busy) return;
			const action = item.value as SkillActionIntent["kind"];
			if (!view.requiresPreparation || (action !== "install" && action !== "update")) {
				done({ kind: action });
				return;
			}

			busy = true;
			status = "Checking upstream...";
			tui.requestRender();
			void prepare()
				.then(() => done({ kind: action }))
				.catch((error) => {
					busy = false;
					status = `Check failed: ${error instanceof Error ? error.message : String(error)}`;
					tui.requestRender();
				});
		};

		return {
			render(width: number): string[] {
				const safeWidth = Math.max(1, width);
				return renderSelectorFrame(theme, safeWidth, {
					title: `${view.name} — action`,
					body: [
						...fitUiLines(list.render(safeWidth), safeWidth),
						"",
						theme.fg(busy ? "warning" : "muted", status),
					],
					hint: busy
						? "Checking upstream; this action will continue when finished"
						: selectorHint(keybindings, { confirmVerb: "select", cancelVerb: "back" }),
				});
			},
			invalidate(): void {
				list.invalidate();
			},
			handleInput(data: string): void {
				if (busy) return;
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function confirm(
	ctx: ExtensionCommandContext,
	request: SkillConfirmation,
): Promise<boolean> {
	switch (request.kind) {
		case "install":
			return ctx.ui.confirm(
				`Install ${request.name}?`,
				`Copy ${request.sourcePath} from ${request.sourceId} into .pi/skills/${request.name}/`,
			);
		case "uninstall":
			return ctx.ui.confirm(
				`Uninstall ${request.name}?`,
				`Delete the local copy at .pi/skills/${request.name}/?`,
			);
		case "update-all":
			return ctx.ui.confirm(
				`Update all (${request.skills.length})?`,
				`Installing/updating:\n${request.skills
					.map((skill) => `  ${skill.name} (${statusLabel(skill.status, skill.commitsBehind)})`)
					.join("\n")}`,
			);
		case "update":
			return ctx.ui.confirm(
				`Update ${request.name}?${request.commitsBehind > 0
					? ` (${request.commitsBehind} commit${request.commitsBehind === 1 ? "" : "s"} behind)`
					: ""}`,
				request.preview
					? renderPreview(request.preview)
					: `Replace the local copy with ${request.sourceId}'s latest ${request.branch} version.`,
			);
	}
}

function renderPreview(preview: SkillPreview): string {
	const sections: string[] = [];
	if (preview.commitLines.length > 0) {
		sections.push(
			`Commits (${preview.totalCommits}):\n${preview.commitLines
				.map((line) => `  ${line}`)
				.join("\n")}`,
		);
	}
	if (preview.changedFileLines.length > 0) {
		sections.push(
			`Changed files:\n${preview.changedFileLines
				.map((line) => `  ${line}`)
				.join("\n")}`,
		);
	}
	let diff = preview.skillMarkdownDiffLines.join("\n").trimEnd();
	if (preview.truncated) diff += "\n… (diff truncated)";
	sections.push(`SKILL.md preview:\n${diff}`);
	return sections.join("\n\n");
}

function report(ctx: ExtensionCommandContext, notice: SkillUpdateNotice): void {
	switch (notice.kind) {
		case "check-warning":
			ctx.ui.notify("update-skill: upstream check failed — showing last known status", "warning");
			break;
		case "installed":
		case "updated":
		case "uninstalled":
			ctx.ui.notify(`update-skill: ${notice.kind} ${notice.name}`, "info");
			break;
		case "update-all-complete":
			ctx.ui.notify(`update-skill: ${notice.names.join(", ")} updated`, "info");
			break;
		case "removed-upstream":
			ctx.ui.notify(
				`update-skill: ${notice.name} was removed upstream; uninstall it instead`,
				"warning",
			);
			break;
		case "already-current":
			ctx.ui.notify(`update-skill: ${notice.name} is already up to date`, "info");
			break;
		case "preview-failure":
			ctx.ui.notify(
				`update-skill: could not build the preview for ${notice.name} (${notice.error})`,
				"error",
			);
			break;
		case "apply-failure":
			ctx.ui.notify(
				`update-skill: failed to update ${notice.name} (${notice.error})`,
				"error",
			);
			break;
	}
}
