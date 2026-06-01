import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as cp from "node:child_process";
import { dangerousCommandReason } from "./security.ts";

export type ExecPolicyAction = "allow" | "prompt" | "block";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ExecPolicyRule {
	id: string;
	pattern: string;
	action: ExecPolicyAction;
	reason: string;
}

export interface ExecPolicyConfig {
	rules: ExecPolicyRule[];
	defaultAction: ExecPolicyAction;
}

export interface SandboxState {
	mode: SandboxMode;
	setAt: number;
}

const RULES_FILE = path.join(os.homedir(), ".pi", "execpolicy.json");

const READ_ONLY_COMMAND_RE = /^(ls|cat|head|tail|find|grep|rg|git\s+(log|status|diff|show|branch|tag|stash\s+list)|wc|sort|uniq|file|which|type|echo|pwd|whoami|date|env|printenv|du|df|ps|top|htop|tree|stat)\b/;

const EXTERNAL_WRITE_PATH_PATTERNS = [
	/^\/etc\//,
	/^\/usr\//,
	/^\/bin\//,
	/^\/sbin\//,
	/^\/opt\//,
	/^\/var\//,
	/^\/tmp\//,
	/^\/System\//,
	/^\/Library\//,
	/^~\/\.ssh\//,
	/^~\/\.gnupg\//,
	/^~\/\.aws\//,
];

export function isReadOnlyShellCommand(command: string): boolean {
	return READ_ONLY_COMMAND_RE.test(command.trim());
}

export function dangerousShellReason(command: string): string | undefined {
	return dangerousCommandReason(command);
}

export function isExternalWritePath(inputPath: string): boolean {
	const resolved = inputPath.startsWith("~")
		? inputPath.replace(/^~/, process.env.HOME || "/Users")
		: inputPath;
	return EXTERNAL_WRITE_PATH_PATTERNS.some((pattern) => pattern.test(resolved));
}

export function loadExecPolicy(): ExecPolicyConfig {
	try {
		if (fs.existsSync(RULES_FILE)) {
			const data = JSON.parse(fs.readFileSync(RULES_FILE, "utf-8"));
			return {
				rules: data.rules || [],
				defaultAction: data.defaultAction || "allow",
			};
		}
	} catch {
		// Corrupt file, start fresh.
	}
	return { rules: [], defaultAction: "allow" };
}

export function saveExecPolicy(config: ExecPolicyConfig): void {
	const dir = path.dirname(RULES_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(RULES_FILE, JSON.stringify(config, null, 2));
}

export function evaluateExecPolicy(command: string, config = loadExecPolicy()): { matched: boolean; action: ExecPolicyAction; rule?: ExecPolicyRule } {
	for (const rule of config.rules) {
		try {
			const regex = new RegExp(rule.pattern, "i");
			if (regex.test(command)) return { matched: true, action: rule.action, rule };
		} catch {
			// Invalid regexes are skipped; /execpolicy add validates new ones.
		}
	}
	return { matched: false, action: config.defaultAction };
}

export function detectSandboxTools(): { available: boolean; tool: string } {
	if (process.platform === "darwin") return { available: true, tool: "sandbox-exec" };
	if (process.platform === "linux") {
		try {
			cp.execFileSync("which", ["bwrap"], { timeout: 2000 });
			return { available: true, tool: "bwrap" };
		} catch {
			try {
				cp.execFileSync("which", ["firejail"], { timeout: 2000 });
				return { available: true, tool: "firejail" };
			} catch {
				return { available: false, tool: "none" };
			}
		}
	}
	return { available: false, tool: "none" };
}

function generateMacOSSandboxProfile(mode: SandboxMode, cwd: string): string {
	const escapedCwd = cwd.replace(/"/g, "\\\"");
	const escapedTmp = os.tmpdir().replace(/"/g, "\\\"");
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
(allow file-read* (subpath "${escapedCwd}"))
`;

	if (mode === "read-only") return baseProfile + `(deny file-write*)\n`;
	if (mode === "workspace-write") {
		return baseProfile + `(allow file-write* (subpath "${escapedCwd}"))
(allow file-write* (subpath "${escapedTmp}"))
`;
	}
	return "";
}

function generateLinuxSandboxArgs(mode: SandboxMode, cwd: string): string[] {
	if (mode === "danger-full-access") return [];
	const args = [
		"--unshare-all",
		"--share-net",
		"--die-with-parent",
		"--proc", "/proc",
		"--dev", "/dev",
		"--bind", cwd, cwd,
		"--chdir", cwd,
		"--bind", "/usr", "/usr",
		"--bind", "/bin", "/bin",
		"--bind", "/lib", "/lib",
		"--bind", "/lib64", "/lib64",
		"--ro-bind", "/etc", "/etc",
	];
	if (mode === "workspace-write") args.push("--bind", os.tmpdir(), os.tmpdir());
	return args;
}

export async function runSandboxedCommand(command: string, mode: SandboxMode, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		let proc: cp.ChildProcess;

		if (mode === "danger-full-access") {
			proc = cp.spawn("bash", ["-c", command], { cwd });
		} else if (process.platform === "darwin") {
			const profile = generateMacOSSandboxProfile(mode, cwd);
			const profilePath = path.join(os.tmpdir(), `pi-sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}.sb`);
			fs.writeFileSync(profilePath, profile);
			proc = cp.spawn("sandbox-exec", ["-f", profilePath, "bash", "-c", command], { cwd });
			proc.on("close", () => { try { fs.unlinkSync(profilePath); } catch {} });
		} else if (process.platform === "linux") {
			const sandbox = detectSandboxTools();
			if (sandbox.tool === "bwrap") proc = cp.spawn("bwrap", [...generateLinuxSandboxArgs(mode, cwd), "bash", "-c", command], { cwd });
			else if (sandbox.tool === "firejail") proc = cp.spawn("firejail", ["--quiet", "bash", "-c", command], { cwd });
			else proc = cp.spawn("bash", ["-c", command], { cwd });
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
