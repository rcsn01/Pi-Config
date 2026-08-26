import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { pickGuiOption } from "../_shared/gui-option-list.ts";
import {
	CodexCredentialSlotError,
	CodexCredentialSlotStore,
	OPENAI_CODEX_PROVIDER_ID,
	type CodexCredentialSlotInfo,
	type CodexCredentialSlotInspection,
	type CodexCredentialSlotMutation,
} from "./credential-slots.ts";

const NEW_SLOT_ACTION = "\u0000new-empty-slot";
const CODEX_USAGE = "Usage: /codex [list | use <name> | new <name> | remove <name>]";

export type CodexCredentialSlotStoreLike = Pick<
	CodexCredentialSlotStore,
	"inspect" | "createAndSwitch" | "switchTo" | "remove"
>;

export interface CodexExtensionDependencies {
	store?: CodexCredentialSlotStoreLike;
}

function statusLabel(slot: CodexCredentialSlotInfo): string {
	if (slot.active) return slot.hasCredential ? "active" : "active, empty";
	return slot.hasCredential ? "saved" : "empty";
}

export function formatSlotList(inspection: CodexCredentialSlotInspection): string {
	return [
		"Codex credential slots:",
		...inspection.slots.map((slot) => `${slot.active ? "*" : " "} ${slot.name} (${statusLabel(slot)})`),
		"",
		`Active slot: ${inspection.activeSlotName}`,
	].join("\n");
}

function safeError(error: unknown): string {
	if (error instanceof CodexCredentialSlotError) return error.message;
	return "Could not read or update Codex credential slots.";
}

function findSlot(inspection: CodexCredentialSlotInspection, name: string): CodexCredentialSlotInfo | undefined {
	const wanted = name.toLowerCase();
	return inspection.slots.find((slot) => slot.name.toLowerCase() === wanted);
}

function activeSlot(result: CodexCredentialSlotInspection): CodexCredentialSlotInfo | undefined {
	return result.slots.find((slot) => slot.active);
}

async function refreshRuntime(ctx: ExtensionCommandContext): Promise<void> {
	try {
		const refresh = await ctx.modelRegistry.refresh({
			allowNetwork: false,
			providers: [OPENAI_CODEX_PROVIDER_ID],
		});
		if (refresh.aborted || refresh.errors.get(OPENAI_CODEX_PROVIDER_ID)) {
			ctx.ui.notify(
				"The Codex credential changed, but Pi could not refresh its local authentication view.",
				"warning",
			);
		}
	} catch {
		// The auth transaction already committed. Do not make a successful switch
		// look like it was rolled back because a best-effort view refresh failed.
		ctx.ui.notify(
			"The Codex credential changed, but Pi could not refresh its local authentication view.",
			"warning",
		);
	}
}

async function waitForIdle(ctx: ExtensionCommandContext): Promise<boolean> {
	try {
		await ctx.waitForIdle();
		return true;
	} catch {
		ctx.ui.notify("Codex credential switching was cancelled before it changed the active credential.", "warning");
		return false;
	}
}

function notifyMutation(ctx: ExtensionCommandContext, result: CodexCredentialSlotMutation, verb: string): void {
	const active = activeSlot(result);
	const name = active?.name ?? result.activeSlotName;
	const message = `${verb} Codex slot "${name}".`;
	if (active && !active.hasCredential) {
		ctx.ui.notify(`${message}\nRun /login openai-codex to sign in to this empty slot.`, "info");
	} else {
		ctx.ui.notify(message, "info");
	}
}

async function createSlot(
	name: string,
	ctx: ExtensionCommandContext,
	store: CodexCredentialSlotStoreLike,
): Promise<void> {
	if (!(await waitForIdle(ctx))) return;
	try {
		const result = await store.createAndSwitch(name);
		await refreshRuntime(ctx);
		notifyMutation(ctx, result, "Created and switched to");
	} catch (error) {
		ctx.ui.notify(safeError(error), "error");
	}
}

async function switchSlot(
	name: string,
	ctx: ExtensionCommandContext,
	store: CodexCredentialSlotStoreLike,
	inspection = store.inspect(),
): Promise<void> {
	const selected = findSlot(inspection, name);
	if (selected?.active) {
		ctx.ui.notify(`Codex slot "${selected.name}" is already active.`, "info");
		return;
	}
	if (!selected) {
		try {
			await store.switchTo(name);
		} catch (error) {
			ctx.ui.notify(safeError(error), "error");
		}
		return;
	}
	if (!(await waitForIdle(ctx))) return;
	try {
		const result = await store.switchTo(selected.name);
		await refreshRuntime(ctx);
		notifyMutation(ctx, result, "Switched to");
	} catch (error) {
		ctx.ui.notify(safeError(error), "error");
	}
}

async function removeSlot(
	name: string,
	ctx: ExtensionCommandContext,
	store: CodexCredentialSlotStoreLike,
): Promise<void> {
	let inspection: CodexCredentialSlotInspection;
	try {
		inspection = store.inspect();
	} catch (error) {
		ctx.ui.notify(safeError(error), "error");
		return;
	}
	const selected = findSlot(inspection, name);
	if (selected?.name.toLowerCase() === "default") {
		ctx.ui.notify("The default Codex credential slot cannot be removed.", "warning");
		return;
	}
	if (selected?.active) {
		ctx.ui.notify("The active Codex credential slot cannot be removed.", "warning");
		return;
	}
	if (selected?.hasCredential) {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify("Removing a saved Codex credential requires the interactive TUI confirmation.", "warning");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			`Remove Codex slot "${selected.name}"?`,
			"This permanently removes the credential saved in that inactive slot.",
		);
		if (!confirmed) return;
	}
	if (!(await waitForIdle(ctx))) return;
	try {
		const result = await store.remove(name, inspection.revision);
		await refreshRuntime(ctx);
		ctx.ui.notify(`Removed Codex slot "${result.removed ?? name}".`, "info");
	} catch (error) {
		ctx.ui.notify(safeError(error), "error");
	}
}

async function openPicker(ctx: ExtensionCommandContext, store: CodexCredentialSlotStoreLike): Promise<void> {
	let inspection: CodexCredentialSlotInspection;
	try {
		inspection = store.inspect();
	} catch (error) {
		ctx.ui.notify(safeError(error), "error");
		return;
	}
	const selected = await pickGuiOption(ctx, {
		title: "Select Codex credential slot",
		message: "The active slot is shared by every Pi process using this agent directory.",
		options: [
			...inspection.slots.map((slot) => ({
				label: slot.name,
				value: slot.id,
				description: statusLabel(slot),
				checked: slot.active,
			})),
			{
				label: "New empty slot",
				value: NEW_SLOT_ACTION,
				spacerBefore: inspection.slots.length > 0,
			},
		],
	});
	if (!selected) return;
	if (selected === NEW_SLOT_ACTION) {
		const entered = await ctx.ui.input("New Codex credential slot name", "slot-name");
		const name = entered?.trim();
		if (!name) return;
		await createSlot(name, ctx, store);
		return;
	}
	const target = inspection.slots.find((slot) => slot.id === selected);
	if (target) await switchSlot(target.name, ctx, store, inspection);
}

export async function runCodexCommand(
	rawArgs: string,
	ctx: ExtensionCommandContext,
	store: CodexCredentialSlotStoreLike = new CodexCredentialSlotStore(),
): Promise<void> {
	const args = rawArgs.trim().split(/\s+/u).filter(Boolean);
	const subcommand = args[0]?.toLowerCase();

	if (args.length === 0) {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			try {
				ctx.ui.notify(`${formatSlotList(store.inspect())}\n\n${CODEX_USAGE}`, "info");
			} catch (error) {
				ctx.ui.notify(safeError(error), "error");
			}
			return;
		}
		await openPicker(ctx, store);
		return;
	}

	if (subcommand === "list" && args.length === 1) {
		try {
			ctx.ui.notify(formatSlotList(store.inspect()), "info");
		} catch (error) {
			ctx.ui.notify(safeError(error), "error");
		}
		return;
	}
	if ((subcommand === "use" || subcommand === "new" || subcommand === "remove") && args.length === 2) {
		const name = args[1]!;
		if (subcommand === "new") {
			await createSlot(name, ctx, store);
			return;
		}
		if (subcommand === "use") {
			try {
				await switchSlot(name, ctx, store);
			} catch (error) {
				ctx.ui.notify(safeError(error), "error");
			}
			return;
		}
		await removeSlot(name, ctx, store);
		return;
	}

	ctx.ui.notify(CODEX_USAGE, "warning");
}

export function createCodexExtension(dependencies: CodexExtensionDependencies = {}) {
	return (pi: ExtensionAPI): void => {
		const store = dependencies.store ?? new CodexCredentialSlotStore();
		pi.registerCommand("codex", {
			description: "Switch between saved Codex OAuth credential slots",
			getArgumentCompletions: (prefix: string) => {
				const trimmed = prefix.trim();
				const parts = trimmed.split(/\s+/u).filter(Boolean);
				if (parts.length === 0 || (parts.length === 1 && !trimmed.endsWith(" "))) {
					return ["list", "use", "new", "remove"]
						.filter((value) => value.startsWith(parts[0] ?? ""))
						.map((value) => ({ value, label: value }));
				}
				if (parts.length === 2 && (parts[0] === "use" || parts[0] === "remove")) {
					try {
						return store.inspect().slots
						.filter((slot) => slot.name.startsWith(parts[1] ?? ""))
						.map((slot) => ({ value: `${parts[0]} ${slot.name}`, label: slot.name }));
					} catch {
						return null;
					}
				}
				return null;
			},
			handler: async (args, ctx) => runCodexCommand(args, ctx, store),
		});
	};
}

export default createCodexExtension();
