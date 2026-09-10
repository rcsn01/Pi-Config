import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import {
	createSelectListTheme,
	fitUiLines,
	renderSelectorFrame,
	selectorHint,
} from "../_shared/ui-style.ts";
import type {
	CheckAllResult,
	MenuEntry,
	UpdateSkillActionSelection,
	UpdateSkillMenuRefresh,
	UpdateSkillUI,
} from "./index.ts";

/** Adapt Pi's UI to the update-skill flow, including an in-place refreshable menu. */
export function createUpdateSkillUI(ctx: ExtensionCommandContext): UpdateSkillUI {
	return {
		select: (title, options) => ctx.ui.select(title, options),
		confirm: (title, message) => ctx.ui.confirm(title, message),
		notify: (message, type) => ctx.ui.notify(message, type),
		setWidget: (id, lines) => ctx.ui.setWidget(id, lines),
		selectPersistent: (title, entries, refresh) =>
			selectPersistentMenu(ctx, title, entries, refresh),
		selectActionPersistent: (title, options, checkAction, check) =>
			selectPersistentAction(ctx, title, options, checkAction, check),
	};
}

async function selectPersistentAction(
	ctx: ExtensionCommandContext,
	title: string,
	options: string[],
	checkAction: string,
	check: () => Promise<CheckAllResult>,
): Promise<UpdateSkillActionSelection> {
	if (ctx.mode !== "tui") {
		return { action: await ctx.ui.select(title, options) };
	}

	return ctx.ui.custom<UpdateSkillActionSelection>((tui, theme, keybindings, done) => {
		let busy = false;
		let status = "Choose an action.";
		const list = new SelectList(
			options.map((option) => ({ value: option, label: option })),
			options.length,
			createSelectListTheme(theme),
		);
		list.onCancel = () => done({ action: undefined });
		list.onSelect = (item) => {
			if (busy) return;
			if (item.value !== checkAction) {
				done({ action: item.value });
				return;
			}
			busy = true;
			status = "Checking upstream...";
			tui.requestRender();
			void check()
				.then((checkResult) => done({ action: item.value, checkResult }))
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
					title,
					body: [
						...fitUiLines(list.render(safeWidth), safeWidth),
						"",
						busy ? theme.fg("warning", status) : theme.fg("muted", status),
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

async function selectPersistentMenu(
	ctx: ExtensionCommandContext,
	title: string,
	initialEntries: MenuEntry[],
	refresh: () => Promise<UpdateSkillMenuRefresh>,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		return ctx.ui.select(title, initialEntries.map((entry) => entry.label));
	}

	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		let entries = [...initialEntries];
		let list: SelectList;
		let busy = false;
		let status = "Select a skill or check upstream for updates.";

		const items = (): SelectItem[] => entries.map((entry, index) => ({
			value: String(index),
			label: entry.label,
		}));

		const rebuild = (selectedIndex = 0): void => {
			list = new SelectList(
				items(),
				Math.min(Math.max(entries.length, 1), 16),
				createSelectListTheme(theme),
			);
			list.setSelectedIndex(Math.max(0, Math.min(selectedIndex, entries.length - 1)));
			list.onCancel = () => done(undefined);
			list.onSelect = (item) => {
				if (busy) return;
				const index = Number(item.value);
				const entry = entries[index];
				if (!entry) return;
				if (entry.action.kind !== "check-now") {
					done(entry.label);
					return;
				}

				busy = true;
				status = "Checking upstream...";
				tui.requestRender();
				void refresh()
					.then((result) => {
						entries = [...result.entries];
						busy = false;
						status = result.status;
						const checkIndex = entries.findIndex((candidate) => candidate.action.kind === "check-now");
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
				const statusLine = busy
					? theme.fg("warning", status)
					: theme.fg("muted", status);
				return renderSelectorFrame(theme, safeWidth, {
					title,
					body: [...fitUiLines(list.render(safeWidth), safeWidth), "", statusLine],
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
