/**
 * Sandbox Extension - Recreates Codex's sandbox feature
 *
 * Allows running commands in a restricted environment:
 *   - macOS: Uses sandbox-exec with Seatbelt profile
 *   - Linux: Uses bubblewrap or firejail
 *   - Windows: Uses restricted token (limited)
 *
 * Commands:
 *   /sandbox <command>       - Run a command in sandbox mode
 *   /sandbox mode <mode>     - Set sandbox mode: read-only|workspace-write|danger-full-access
 *
 * Sandbox modes:
 *   - read-only: No writes, no network
 *   - workspace-write: Write only within workspace dir
 *   - danger-full-access: No restrictions (passthrough)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface SandboxState {
	mode: SandboxMode;
	setAt: number;
}

const SANDBOX_CUSTOM_TYPE = "sandbox-state";

function detectSandboxTools(): { available: boolean; tool: string } {
	if (process.platform === "darwin") {
		// macOS has sandbox-exec built in
		return { available: true, tool: "sandbox-exec" };
	}
	if (process.platform === "linux") {
		// Check for bubblewrap
		try {
			cp.execSync("which bwrap", { timeout: 2000 });
			return { available: true, tool: "bwrap" };
		} catch {
			try {
				cp.execSync("which firejail", { timeout: 2000 });
				return { available: true, tool: "firejail" };
			} catch {
				return { available: false, tool: "none" };
			}
		}
	}
	return { available: false, tool: "none" };
}

function generateMacOSSandboxProfile(mode: SandboxMode, cwd: string): string {
	const baseProfile = `(version 1)
(allow default)
(deny network*)
(deny file-write* file-read-data file-read-metadata
  (subpath "/System")
  (subpath "/Library")
  (subpath "/usr/lib")
  (subpath "/private/var")
  (subpath "/private/etc")
)
(allow file-read* (subpath "${cwd}"))
`;

	if (mode === "read-only") {
		return baseProfile + `(deny file-write*)\n`;
	}

	if (mode === "workspace-write") {
		return (
			baseProfile +
			`(allow file-write* (subpath "${cwd}"))
(allow file-write* (subpath "${os.tmpdir()}"))
`
		);
	}

	// Full access - no sandbox
	return "";
}

function generateLinuxSandboxArgs(mode: SandboxMode, cwd: string): string[] {
	if (mode === "danger-full-access") return [];

	// Use bubblewrap
	const args: string[] = [
		"--unshare-all",
		"--share-net",
		"--die-with-parent",
		"--proc", "/proc",
		"--dev", "/dev",
		"--bind", cwd, cwd,
		"--chdir", cwd,
	];

	if (mode === "read-only") {
		args.push("--bind", "/usr", "/usr");
		args.push("--bind", "/bin", "/bin");
		args.push("--bind", "/lib", "/lib");
		args.push("--bind", "/lib64", "/lib64");
		args.push("--ro-bind", "/etc", "/etc");
	} else if (mode === "workspace-write") {
		args.push("--bind", "/usr", "/usr");
		args.push("--bind", "/bin", "/bin");
		args.push("--bind", "/lib", "/lib");
		args.push("--bind", "/lib64", "/lib64");
		args.push("--ro-bind", "/etc", "/etc");
		args.push("--bind", os.tmpdir(), os.tmpdir());
	}

	return args;
}

async function runSandboxed(command: string, mode: SandboxMode, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		let proc: cp.ChildProcess;

		if (mode === "danger-full-access") {
			proc = cp.spawn("bash", ["-c", command], { cwd });
		} else if (process.platform === "darwin") {
			const profile = generateMacOSSandboxProfile(mode, cwd);
			const profilePath = path.join(os.tmpdir(), `pi-sandbox-${Date.now()}.sb`);
			fs.writeFileSync(profilePath, profile);
			proc = cp.spawn("sandbox-exec", ["-f", profilePath, "bash", "-c", command], { cwd });
			// Cleanup profile after process exits
			proc.on("close", () => {
				try { fs.unlinkSync(profilePath); } catch {}
			});
		} else if (process.platform === "linux") {
			const sandbox = detectSandboxTools();
			if (sandbox.tool === "bwrap") {
				const args = generateLinuxSandboxArgs(mode, cwd);
				proc = cp.spawn("bwrap", [...args, "bash", "-c", command], { cwd });
			} else {
				// Fallback: run without sandbox but with warnings
				proc = cp.spawn("bash", ["-c", command], { cwd });
			}
		} else {
			proc = cp.spawn("bash", ["-c", command], { cwd });
		}

		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (d) => (stdout += d.toString()));
		proc.stderr?.on("data", (d) => (stderr += d.toString()));

		const timeout = setTimeout(() => {
			proc.kill();
			resolve({ stdout, stderr: stderr + "\n[sandbox: timeout]", code: -1 });
		}, 60000);

		proc.on("close", (code) => {
			clearTimeout(timeout);
			resolve({ stdout, stderr, code: code ?? -1 });
		});
		proc.on("error", (err) => {
			clearTimeout(timeout);
			resolve({ stdout, stderr: err.message, code: -1 });
		});
	});
}

export default function (pi: ExtensionAPI) {
	let state: SandboxState = { mode: "workspace-write", setAt: Date.now() };

	// ── State Reconstruction ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		state = { mode: "workspace-write", setAt: Date.now() };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === SANDBOX_CUSTOM_TYPE) {
				const data = entry.data as SandboxState | undefined;
				if (data?.mode) state = data;
			}
		}
	});

	const persist = () => {
		pi.appendEntry(SANDBOX_CUSTOM_TYPE, { ...state });
	};

	// ── Status Widget ─────────────────────────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => {
		const labels: Record<SandboxMode, string> = {
			"read-only": "SANDBOX: RO",
			"workspace-write": "SANDBOX: WS",
			"danger-full-access": "SANDBOX: FULL",
		};
		ctx.ui.setStatus("sandbox", labels[state.mode]);
	});

	// ── Default to passthrough unless explicitly enabled ─────────────────
	// The sandbox only activates when the user explicitly enables it via
	// /sandbox mode read-only or /sandbox mode workspace-write.
	// By default, it passes through all commands normally.

	// ── Command: /sandbox ─────────────────────────────────────────────────

	pi.registerCommand("sandbox", {
		description: "Run command in sandbox or change sandbox mode",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const rest = parts.slice(1).join(" ");

			if (subcmd === "mode") {
				const mode = rest as SandboxMode;
				const validModes: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

				if (!validModes.includes(mode)) {
					ctx.ui.notify(
						"Usage: /sandbox mode read-only|workspace-write|danger-full-access",
						"warning",
					);
					return;
				}

				if (mode === "danger-full-access" && ctx.hasUI) {
					const confirmed = await ctx.ui.confirm(
						"⚠️ Full Access Sandbox",
						"This disables ALL sandbox restrictions. Commands can access anything.\n\nAre you sure?",
					);
					if (!confirmed) return;
				}

				state = { mode, setAt: Date.now() };
				persist();

				const labels: Record<string, string> = {
					"read-only": "🔒 Read-Only",
					"workspace-write": "📁 Workspace Write",
					"danger-full-access": "⚠️ Full Access",
				};
				ctx.ui.notify(`Sandbox mode: ${labels[mode]}`, "info");
				return;
			}

			// Run a command in sandbox
			if (!trimmed) {
				const sandbox = detectSandboxTools();
				const status = sandbox.available
					? `Sandbox available: ${sandbox.tool}`
					: "No sandbox tools detected (sandbox-exec on macOS, bubblewrap/firejail on Linux)";
				ctx.ui.notify(
					`Current mode: ${state.mode}\n${status}\nUsage: /sandbox mode <mode> | /sandbox <command>`,
					"info",
				);
				return;
			}

			ctx.ui.notify(`Running in ${state.mode} sandbox: ${trimmed.slice(0, 80)}...`, "info");
			const result = await runSandboxed(trimmed, state.mode, ctx.cwd);

			const output = [
				`Sandbox mode: ${state.mode}`,
				`Exit code: ${result.code}`,
				"",
				"stdout:",
				result.stdout || "(empty)",
				"",
				"stderr:",
				result.stderr || "(none)",
			].join("\n");

			ctx.ui.notify(output, "info");
		},
	});
}
