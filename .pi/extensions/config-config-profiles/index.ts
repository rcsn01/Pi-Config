/**
 * Config Profiles Extension - Recreates Codex's profile-based configuration
 *
 * Commands:
 *   /profile                    - Show current profile
 *   /profile list               - List all profiles
 *   /profile switch <name>      - Switch to a different profile
 *   /profile create <name>      - Create a new profile
 *   /profile delete <name>      - Delete a profile
 *
 * Profiles are stored as ~/.pi/profiles/<name>.json
 * Active profile is stored in ~/.pi/active-profile
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isSafeName } from "../_shared/security.ts";

const PROFILES_DIR = path.join(os.homedir(), ".pi", "profiles");
const ACTIVE_PROFILE_FILE = path.join(os.homedir(), ".pi", "active-profile");

const DEFAULT_PROFILE = "default";

function getActiveProfile(): string {
	try {
		if (fs.existsSync(ACTIVE_PROFILE_FILE)) {
			return fs.readFileSync(ACTIVE_PROFILE_FILE, "utf-8").trim();
		}
	} catch {
		// Ignore
	}
	return DEFAULT_PROFILE;
}

function setActiveProfile(name: string): void {
	const dir = path.dirname(ACTIVE_PROFILE_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(ACTIVE_PROFILE_FILE, name);
}

function listProfiles(): string[] {
	try {
		if (!fs.existsSync(PROFILES_DIR)) return [DEFAULT_PROFILE];
		const files = fs.readdirSync(PROFILES_DIR);
		return [DEFAULT_PROFILE, ...files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""))];
	} catch {
		return [DEFAULT_PROFILE];
	}
}

function profilePath(name: string): string {
	return path.join(PROFILES_DIR, `${name}.json`);
}

function createProfile(name: string): void {
	if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
	fs.writeFileSync(profilePath(name), JSON.stringify({ created: Date.now(), name }, null, 2));
}

function deleteProfile(name: string): void {
	const p = profilePath(name);
	if (fs.existsSync(p)) fs.unlinkSync(p);
}

export default function (pi: ExtensionAPI) {
	let activeProfile = getActiveProfile();

	// ── Status widget ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		activeProfile = getActiveProfile();
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("profile", activeProfile !== DEFAULT_PROFILE ? `👤 ${activeProfile}` : undefined);
	});

	// ── Command: /profile ─────────────────────────────────────────────────

	pi.registerCommand("profile", {
		description: "Manage config profiles (list|switch|create|delete)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const profileName = parts.slice(1).join(" ");
			if (profileName && !isSafeName(profileName)) {
				ctx.ui.notify("Profile names may only contain letters, numbers, dots, underscores, and dashes.", "warning");
				return;
			}

			const profiles = listProfiles();

			switch (subcmd) {
				case "list": {
					const lines = ["Config Profiles:"];
					for (const p of profiles) {
						const active = p === activeProfile ? " ● (active)" : "   ";
						lines.push(`${active} ${p}`);
					}
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				case "switch": {
					if (!profileName) {
						ctx.ui.notify("Usage: /profile switch <name>", "warning");
						return;
					}

					if (!profiles.includes(profileName) && profileName !== DEFAULT_PROFILE) {
						ctx.ui.notify(
							`Profile "${profileName}" not found. Use /profile create ${profileName} first.`,
							"warning",
						);
						return;
					}

					if (profileName === activeProfile) {
						ctx.ui.notify(`Already using profile "${profileName}".`, "info");
						return;
					}

					setActiveProfile(profileName);
					activeProfile = profileName;

					ctx.ui.notify(
						`Switched to profile "${profileName}". Restart pi or /reload to apply fully.`,
						"info",
					);
					return;
				}

				case "create": {
					if (!profileName) {
						ctx.ui.notify("Usage: /profile create <name>", "warning");
						return;
					}
					if (profiles.includes(profileName)) {
						ctx.ui.notify(`Profile "${profileName}" already exists.`, "warning");
						return;
					}
					createProfile(profileName);
					ctx.ui.notify(
						`Profile "${profileName}" created. Use /profile switch ${profileName} to activate.`,
						"info",
					);
					return;
				}

				case "delete": {
					if (!profileName) {
						ctx.ui.notify("Usage: /profile delete <name>", "warning");
						return;
					}
					if (profileName === DEFAULT_PROFILE) {
						ctx.ui.notify("Cannot delete the default profile.", "warning");
						return;
					}
					if (profileName === activeProfile) {
						ctx.ui.notify(
							"Cannot delete the active profile. Switch to another first.",
							"warning",
						);
						return;
					}
					if (!profiles.includes(profileName)) {
						ctx.ui.notify(`Profile "${profileName}" not found.`, "warning");
						return;
					}
					deleteProfile(profileName);
					ctx.ui.notify(`Profile "${profileName}" deleted.`, "info");
					return;
				}

				default: {
					// Show active profile
					const lines = [
						`Active profile: ${activeProfile}`,
						"",
						"Commands: /profile list|switch|create|delete",
					];
					if (profiles.length > 0) {
						lines.push("");
						lines.push("Available profiles:");
						for (const p of profiles) {
							const active = p === activeProfile ? " ● (active)" : "   ";
							lines.push(`${active} ${p}`);
						}
					}
					ctx.ui.notify(lines.join("\n"), "info");
				}
			}
		},
	});
}
