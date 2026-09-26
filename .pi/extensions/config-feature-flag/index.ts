/**
 * Feature Flags Extension — Directory-based extension toggling
 *
 * /features — interactive toggle UI (or: list|enable|disable|reset|status <name>)
 *
 * Run /reload after toggling for changes to take effect.
 * Protected extensions (_shared, config-feature-flag) cannot be disabled.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { pickGuiOptions } from "../_shared/gui-option-list.ts";
import { loadExtensionCatalog, type ExtensionCatalog } from "./catalog.ts";
import {
	createExtensionToggleSession,
	type ExtensionInfo,
	type ExtensionToggleResult,
	type ExtensionToggleSession,
} from "./extension-toggle.ts";

const EXTENSIONS_DIR = ".pi/extensions";
const DISABLED_DIR = ".pi/extensions-disabled";

// ── Interactive toggle UI ───────────────────────────────────────────────────

async function featuresToggleUI(
	ctx: ExtensionContext,
	session: ExtensionToggleSession,
): Promise<void> {
	const cwd = ctx.cwd;
	const extensions = session.extensions;

	if (extensions.length === 0) {
		ctx.ui.notify("No toggleable extensions found.", "info");
		return;
	}

	const selected = await pickGuiOptions(ctx, {
		title: "Extension toggles",
		message: `Repository: ${cwd}\nRun /reload after toggling for changes to take effect.`,
		options: extensions.map((ext) => ({
			label: ext.metadata?.displayName ?? ext.name,
			value: ext.name,
			description: ext.protected
				? "[protected] cannot be disabled"
				: `${ext.enabled ? "enabled" : "disabled"} · ${ext.metadata?.pack ?? "uncataloged"}`,
			checked: ext.enabled,
			disabled: ext.protected,
		})),
	});

	if (selected === undefined) {
		ctx.ui.notify("Changes discarded.", "info");
		return;
	}

	const desiredEnabled = new Set(selected);
	for (const ext of extensions) {
		if (ext.protected) desiredEnabled.add(ext.name);
	}
	notifyPickerResult(ctx, session.apply(desiredEnabled));
}

function notifyPickerResult(ctx: ExtensionContext, result: ExtensionToggleResult): void {
	if (result.status === "rejected") {
		ctx.ui.notify(`Extension changes blocked:\n${result.issues.join("\n")}`, "warning");
		return;
	}

	const moved = result.outcomes.filter(({ status }) => status === "moved");
	const unsuccessful = result.outcomes.filter(({ status }) => status !== "moved");
	if (unsuccessful.length > 0) {
		const failedNames = unsuccessful.map(({ name, direction }) => `${name} (${direction})`).join(", ");
		if (moved.length > 0) {
			const movedNames = moved.map(({ name, direction }) => `${name} (${direction})`).join(", ");
			ctx.ui.notify(
				`Moved: ${movedNames}\nFailed or skipped: ${failedNames}\nRun /reload to apply successful moves.`,
				"warning",
			);
		} else {
			ctx.ui.notify(`Could not apply extension changes. Failed or skipped: ${failedNames}.`, "error");
		}
		return;
	}

	if (moved.length === 0) {
		ctx.ui.notify("No changes needed.", "info");
		return;
	}
	ctx.ui.notify(`${moved.length} extension(s) moved. Run /reload to apply.`, "info");
}

// ── Plain-text list (non-interactive fallback) ─────────────────────────────

function featuresListText(cwd: string, extensions: readonly ExtensionInfo[]): string {
	if (extensions.length === 0) {
		return "No toggleable extensions found.";
	}

	const lines = [
		"Extension Toggles:",
		`Repository: ${cwd}`,
		`Extensions:  ${path.join(cwd, EXTENSIONS_DIR)}`,
		`Disabled:     ${path.join(cwd, DISABLED_DIR)}`,
		"─".repeat(60),
	];

	for (const ext of extensions) {
		const status = ext.protected ? "protected" : ext.enabled ? "enabled " : "disabled";
		const pack = ext.metadata?.pack ?? "uncataloged";
		const defaultState = ext.metadata?.defaultEnabled ? "on" : "off";
		lines.push(
			`  ${ext.enabled ? "●" : "○"} ${status}  ${ext.name} [${pack}, default ${defaultState}]${ext.protected ? " (cannot disable)" : ""}`,
		);
	}

	lines.push("", "Commands: /features enable|disable|reset <name>");
	lines.push("Run /reload after changes.");
	return lines.join("\n");
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("features", {
		description: "Manage extension toggles — interactive UI (or: list|enable|disable|reset|status <name>)",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			let catalog: ExtensionCatalog;
			try {
				catalog = loadExtensionCatalog(cwd);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Cannot manage extensions: ${message}`, "error");
				return;
			}
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const extName = parts.slice(1).join(" ");

			if (!trimmed) {
				const session = createExtensionToggleSession(cwd, catalog);
				if (ctx.hasUI) return featuresToggleUI(ctx, session);
				ctx.ui.notify(featuresListText(cwd, session.extensions), "info");
				return;
			}

			if (["enable", "disable", "reset", "status"].includes(subcmd) && !extName) {
				ctx.ui.notify(`Usage: /features ${subcmd} <extension-name>`, "warning");
				return;
			}

			const session = createExtensionToggleSession(cwd, catalog);
			const extensions = session.extensions;
			const found = extensions.find((extension) => extension.name === extName);
			if (extName && !found) {
				ctx.ui.notify(`Unknown extension: "${extName}". Use /features list to see available extensions.`, "warning");
				return;
			}

			switch (subcmd) {
				case "enable": {
					if (found!.protected) {
						ctx.ui.notify(`"${extName}" is protected and cannot be disabled.`, "warning");
						return;
					}
					if (found!.enabled) {
						ctx.ui.notify(`"${extName}" is already enabled.`, "info");
						return;
					}
					const desired = enabledExtensionNames(extensions);
					desired.add(extName);
					notifyCommandResult(
						ctx,
						session.apply(desired),
						`"${extName}" enabled. Run /reload to apply.`,
						`"${extName}" is already enabled.`,
						`Failed to enable "${extName}".`,
					);
					return;
				}
				case "disable": {
					if (found!.protected) {
						ctx.ui.notify(`"${extName}" is protected and cannot be disabled.`, "warning");
						return;
					}
					if (!found!.enabled) {
						ctx.ui.notify(`"${extName}" is already disabled.`, "info");
						return;
					}
					const desired = enabledExtensionNames(extensions);
					desired.delete(extName);
					notifyCommandResult(
						ctx,
						session.apply(desired),
						`"${extName}" disabled. Run /reload to apply.`,
						`"${extName}" is already disabled.`,
						`Failed to disable "${extName}".`,
					);
					return;
				}
				case "reset": {
					if (found!.protected) {
						ctx.ui.notify(`"${extName}" is protected and cannot be changed.`, "warning");
						return;
					}
					const defaultEnabled = found!.metadata?.defaultEnabled ?? false;
					if (found!.enabled === defaultEnabled) {
						ctx.ui.notify(`"${extName}" already matches its default (${defaultEnabled ? "enabled" : "disabled"}).`, "info");
						return;
					}
					const desired = enabledExtensionNames(extensions);
					if (defaultEnabled) desired.add(extName);
					else desired.delete(extName);
					notifyCommandResult(
						ctx,
						session.apply(desired),
						`"${extName}" reset to default (${defaultEnabled ? "enabled" : "disabled"}). Run /reload to apply.`,
						`"${extName}" already matches its default (${defaultEnabled ? "enabled" : "disabled"}).`,
						`Failed to reset "${extName}" (${defaultEnabled ? "enable" : "disable"}).`,
					);
					return;
				}
				case "status": {
					const metadata = found!.metadata;
					ctx.ui.notify(
						[
							`${extName}: ${found!.enabled ? "enabled" : "disabled"}${found!.protected ? " (protected)" : ""}`,
							metadata ? `Pack: ${metadata.pack}; default: ${metadata.defaultEnabled ? "enabled" : "disabled"}` : "Not present in catalog.",
							metadata?.requires.length ? `Requires: ${metadata.requires.join(", ")}` : "Requires: none",
							metadata?.conflicts.length ? `Conflicts: ${metadata.conflicts.join(", ")}` : "Conflicts: none",
						].join("\n"),
						"info",
					);
					return;
				}
				case "list":
				default:
					ctx.ui.notify(featuresListText(cwd, extensions), "info");
			}
		},
	});
}

function enabledExtensionNames(extensions: readonly ExtensionInfo[]): Set<string> {
	return new Set(extensions.filter((extension) => extension.enabled).map((extension) => extension.name));
}

function notifyCommandResult(
	ctx: ExtensionContext,
	result: ExtensionToggleResult,
	successMessage: string,
	unchangedMessage: string,
	failureMessage: string,
): void {
	if (result.status === "rejected") {
		ctx.ui.notify(`Extension change blocked:\n${result.issues.join("\n")}`, "warning");
	} else if (result.status === "unchanged") {
		ctx.ui.notify(unchangedMessage, "info");
	} else if (result.status === "applied") {
		ctx.ui.notify(successMessage, "info");
	} else {
		ctx.ui.notify(failureMessage, "error");
	}
}
