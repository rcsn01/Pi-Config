/**
 * Feature Flags Extension — Directory-based extension toggling
 *
 * /features — interactive toggle UI (or: list|enable|disable|reset|status <name>)
 *
 * Scans .pi/extensions/ and .pi/extensions-disabled/ to discover extensions.
 * Enabling moves the extension folder into .pi/extensions/.
 * Disabling moves it to .pi/extensions-disabled/.
 * Run /reload after toggling for changes to take effect.
 *
 * Protected extensions (_shared, system-feature-flags) cannot be disabled.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { pickGuiOptions } from "../_shared/gui-option-list.ts";

const EXTENSIONS_DIR = ".pi/extensions";
const DISABLED_DIR = ".pi/extensions-disabled";

/** Extensions that cannot be disabled (infrastructure). */
const PROTECTED = new Set(["_shared", "system-feature-flags"]);

interface ExtensionInfo {
	name: string;
	enabled: boolean;
	protected: boolean;
}

// ── Directory scanning ──────────────────────────────────────────────────────

function scanExtensions(cwd: string): ExtensionInfo[] {
	const result: ExtensionInfo[] = [];
	const enabledDirs = listExtensionDirs(cwd, EXTENSIONS_DIR);
	const disabledDirs = listExtensionDirs(cwd, DISABLED_DIR);

	for (const name of enabledDirs) {
		result.push({ name, enabled: true, protected: PROTECTED.has(name) });
	}
	for (const name of disabledDirs) {
		if (!enabledDirs.has(name)) {
			result.push({ name, enabled: false, protected: PROTECTED.has(name) });
		}
	}

	result.sort((a, b) => a.name.localeCompare(b.name));
	return result;
}

/** List extension directory names (subdirectories containing index.ts). */
function listExtensionDirs(cwd: string, dir: string): Set<string> {
	const names = new Set<string>();
	const full = path.join(cwd, dir);
	try {
		for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const indexPath = path.join(full, entry.name, "index.ts");
			if (fs.existsSync(indexPath)) names.add(entry.name);
		}
	} catch {
		// Directory doesn't exist yet — fine.
	}
	return names;
}

// ── Enable / disable ────────────────────────────────────────────────────────

function enableExtension(cwd: string, name: string): boolean {
	const disabledPath = path.join(cwd, DISABLED_DIR, name);
	const enabledPath = path.join(cwd, EXTENSIONS_DIR, name);
	try {
		fs.mkdirSync(path.join(cwd, EXTENSIONS_DIR), { recursive: true });
		fs.renameSync(disabledPath, enabledPath);
		return true;
	} catch (err) {
		console.error(`Failed to enable ${name}:`, err);
		return false;
	}
}

function disableExtension(cwd: string, name: string): boolean {
	const enabledPath = path.join(cwd, EXTENSIONS_DIR, name);
	const disabledPath = path.join(cwd, DISABLED_DIR, name);
	try {
		fs.mkdirSync(path.join(cwd, DISABLED_DIR), { recursive: true });
		fs.renameSync(enabledPath, disabledPath);
		return true;
	} catch (err) {
		console.error(`Failed to disable ${name}:`, err);
		return false;
	}
}

function resetExtension(cwd: string, name: string): boolean {
	// Default state: enabled (move to extensions/).
	return enableExtension(cwd, name);
}

// ── Interactive toggle UI ───────────────────────────────────────────────────

async function featuresToggleUI(ctx: ExtensionContext): Promise<void> {
	const cwd = ctx.cwd;
	const extensions = scanExtensions(cwd);

	if (extensions.length === 0) {
		ctx.ui.notify("No toggleable extensions found.", "info");
		return;
	}

	// Build pending state from current filesystem state.
	const pending = new Map<string, boolean>();
	for (const ext of extensions) {
		pending.set(ext.name, ext.enabled);
	}

	const selected = await pickGuiOptions(ctx, {
		title: "Extension Toggles",
		message: `Repository: ${cwd}\nRun /reload after toggling for changes to take effect.`,
		options: extensions.map((ext) => ({
			label: ext.name,
			value: ext.name,
			description: ext.protected
				? "[protected] cannot be disabled"
				: ext.enabled
					? "enabled"
					: "disabled",
			checked: ext.enabled,
		})),
		minimumSelected: 0,
	});

	if (selected) {
		const selectedSet = new Set(selected);

		let moved = 0;
		for (const ext of extensions) {
			if (ext.protected) continue; // Never move protected extensions.
			const wantsEnabled = selectedSet.has(ext.name);
			if (wantsEnabled && !ext.enabled) {
				if (enableExtension(cwd, ext.name)) moved++;
			} else if (!wantsEnabled && ext.enabled) {
				if (disableExtension(cwd, ext.name)) moved++;
			}
		}

		if (moved > 0) {
			ctx.ui.notify(`${moved} extension(s) moved. Run /reload to apply.`, "info");
		} else {
			ctx.ui.notify("No changes needed.", "info");
		}
	} else {
		ctx.ui.notify("Changes discarded.", "info");
	}
}

// ── Plain-text list (non-interactive fallback) ─────────────────────────────

function featuresListText(cwd: string): string {
	const extensions = scanExtensions(cwd);
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
		lines.push(`  ${ext.enabled ? "●" : "○"} ${status}  ${ext.name}${ext.protected ? " (cannot disable)" : ""}`);
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
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const extName = parts.slice(1).join(" ");

			// ── No args: launch interactive toggle UI ──────────────────────────
			if (!trimmed) {
				if (ctx.hasUI) {
					return featuresToggleUI(ctx);
				}
				ctx.ui.notify(featuresListText(cwd), "info");
				return;
			}

			// ── Subcommands ────────────────────────────────────────────────────
			if (["enable", "disable", "reset", "status"].includes(subcmd) && !extName) {
				ctx.ui.notify(`Usage: /features ${subcmd} <extension-name>`, "warning");
				return;
			}

			const extensions = scanExtensions(cwd);
			const found = extensions.find((e) => e.name === extName);

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
					if (enableExtension(cwd, extName)) {
						ctx.ui.notify(`"${extName}" enabled. Run /reload to apply.`, "info");
					} else {
						ctx.ui.notify(`Failed to enable "${extName}".`, "error");
					}
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
					if (disableExtension(cwd, extName)) {
						ctx.ui.notify(`"${extName}" disabled. Run /reload to apply.`, "info");
					} else {
						ctx.ui.notify(`Failed to disable "${extName}".`, "error");
					}
					return;
				}
				case "reset": {
					if (found!.protected) {
						ctx.ui.notify(`"${extName}" is protected and cannot be changed.`, "warning");
						return;
					}
					if (resetExtension(cwd, extName)) {
						ctx.ui.notify(`"${extName}" reset to default (enabled). Run /reload to apply.`, "info");
					} else {
						ctx.ui.notify(`Failed to reset "${extName}".`, "error");
					}
					return;
				}
				case "status": {
					ctx.ui.notify(
						`${extName}: ${found!.enabled ? "enabled" : "disabled"}${found!.protected ? " (protected)" : ""}`,
						"info",
					);
					return;
				}
				case "list":
				default:
					ctx.ui.notify(featuresListText(cwd), "info");
			}
		},
	});
}
