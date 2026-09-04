import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { dangerousCommandReason } from "./security.ts";

export type ExecPolicyAction = "allow" | "prompt" | "block";
export type ApprovalMode = "read-only" | "default" | "auto-review" | "full-access";

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

const RULES_FILE = path.join(os.homedir(), ".pi", "execpolicy.json");

const READ_ONLY_COMMAND_RE = /^(ls|cat|head|tail|find|grep|rg|git\s+(log|status|diff|show|branch|tag|stash\s+list)|wc|sort|uniq|file|which|type|echo|pwd|whoami|date|env|printenv|du|df|ps|top|htop|tree|stat|pnpm|npm|npx|node|python|python3|pip|pip3|make|cargo|go|rustc|cc|gcc|clang)\b/;

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

const NETWORK_TOOL_NAMES = new Set([
	"ddg_search",
	"ddg_fetch",
	"web_search",
	"web_fetch",
]);

const NETWORK_COMMAND_PATTERNS = [
	/\bcurl\b/,
	/\bwget\b/,
	/\bssh\b/,
	/\bscp\b/,
	/\brsync\b/,
	/\bnc\b/,
	/\bnetcat\b/,
	/\btelnet\b/,
	/\bfetch\b/,
	/\bgit\s+(fetch|pull|push|clone|remote|ls-remote)\b/,
	/\bnpm\s+(install|uninstall|remove|publish|login|logout|whoami|access|deprecate|audit)\b/,
	/\bpnpm\s+(install|uninstall|remove|publish|login|logout|add|update|audit)\b/,
	/\byarn\s+(install|add|publish|login|logout|upgrade)\b/,
	/\bpip\s+(install|download)\b/,
	/\bpip3\s+(install|download)\b/,
	/\bcargo\s+(install|build|publish)\b/,
	/\bgo\s+(get|install|download)\b/,
	/\bdocker\s+(pull|push|run|login)\b/,
	/\bbrew\s+(install|update|upgrade)\b/,
	/\bapt\b/,
	/\byum\b/,
	/\bzypper\b/,
	/\bdnf\b/,
	/\bgh\s+(pr|issue|repo|release)\b/,
	/\bgcloud\b/,
	/\baws\b/,
	/\baz\b/,
	/\bdig\b/,
	/\bnslookup\b/,
	/\bhost\b/,
	/\bping\b/,
	/\btraceroute\b/,
	/\bnpx\s+(?!-).*\b/,
	/\bopen\b/,
	/\bxdg-open\b/,
];

const GITHUB_SNAPSHOT_HELPER_PATH = ".pi/skills/github-repo-explorer/scripts/github-repo-snapshot.mjs";
const GITHUB_SNAPSHOT_HELPER_BASENAME = "github-repo-snapshot.mjs";
const SNAPSHOT_COMMAND_UNSAFE_CHARS = new Set([
	";", "&", "|", "`", "$", "(", ")", "<", ">", "!", "'", "\"", "#",
	"*", "?", "[", "]", "{", "}", "\\", "~", "\r", "\n",
]);

const SENSITIVE_PATH_PATTERNS = [
	/(^|\/)\.env(?:\.|$)/,
	/(^|\/)\.ssh(?:\/|$)/,
	/(^|\/)\.gnupg(?:\/|$)/,
	/(^|\/)\.aws(?:\/|$)/,
	/(^|\/)\.config\/gh(?:\/|$)/,
	/(^|\/)\.npmrc$/,
	/(^|\/)\.pypirc$/,
	/(^|\/)credentials$/,
	/(^|\/)credentials\.json$/,
	/(^|\/)token(?:s)?(?:\.json)?$/,
];

// ── Path utilities ─────────────────────────────────────────────────────

/**
 * Resolve a tool input path against cwd. Handles ~, relative, and absolute.
 * Returns the absolute resolved path.
 */
export function resolveToolPath(inputPath: string, cwd: string): string {
	if (inputPath.startsWith("~")) {
		inputPath = inputPath.replace(/^~/, process.env.HOME || os.homedir());
	}
	if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
	return path.resolve(cwd, inputPath);
}

/**
 * Check whether a resolved absolute path is within (or equal to) the workspace root.
 * Resolves symlinks for robust containment testing.
 */
export function isPathWithinCwd(targetPath: string, cwd: string): boolean {
	const resolvedTarget = resolveToolPath(targetPath, cwd);
	const resolvedCwd = path.resolve(cwd);

	// Symlink-aware: resolve real paths before accepting an existing path.
	try {
		const realCwd = fs.realpathSync(resolvedCwd);
		const realTarget = fs.realpathSync(resolvedTarget);
		if (realTarget === realCwd) return true;
		if (realTarget.startsWith(realCwd + path.sep)) return true;
		return false;
	} catch {
		// realpathSync can fail if the target does not exist yet (new file write).
		// Resolve the parent directory so symlinks in the path are still caught.
		try {
			const parent = path.dirname(resolvedTarget);
			const realParent = fs.realpathSync(parent);
			const realCwd = fs.realpathSync(resolvedCwd);
			if (realParent === realCwd) return true;
			if (realParent.startsWith(realCwd + path.sep)) return true;
			return false;
		} catch {
			// If neither target nor parent exists, fall back to lexical containment.
		}
	}

	return resolvedTarget === resolvedCwd || resolvedTarget.startsWith(resolvedCwd + path.sep);
}

/**
 * Check if a path is intended for writing outside the workspace.
 */
export function isExternalWritePath(inputPath: string): boolean {
	const resolved = inputPath.startsWith("~")
		? inputPath.replace(/^~/, process.env.HOME || "/Users")
		: inputPath;
	return EXTERNAL_WRITE_PATH_PATTERNS.some((pattern) => pattern.test(resolved));
}

export function isSensitivePath(inputPath: string): boolean {
	const normalized = inputPath
		.replace(/^~/, process.env.HOME || os.homedir())
		.split(path.sep)
		.join("/");
	return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

// ── External path extraction from bash commands ────────────────────────

/**
 * Scan a shell command string for absolute paths and return those that
 * fall outside the workspace. Used by auto-review mode to flag commands
 * that may write/delete outside cwd (e.g., rm -rf /some/path, npm -g).
 */
export function extractExternalPathsFromCommand(command: string, cwd: string): string[] {
	// Match absolute Unix paths (/foo/bar), home paths (~/foo/bar), Windows paths (C:\foo)
	// Exclude single-char paths like /c from "cmd.exe /c"
	const pathPattern = /(?:^|[\s;|&`$()!])((?:\/[^\s;|&`$()!*?"'<>{}[\]\\#]{2,})|~\/[^\s;|&`$()!*?"'<>{}[\]\\#]+|[A-Z]:\\[^\s;|&`$()!*?"'<>{}[\]\\#]+)/g;
	const external: string[] = [];
	const seen = new Set<string>();

	let match: RegExpExecArray | null;
	while ((match = pathPattern.exec(command)) !== null) {
		let rawPath = match[1];
		// Expand ~ to home
		if (rawPath.startsWith("~")) {
			rawPath = rawPath.replace(/^~/, process.env.HOME || os.homedir());
		}
		// Normalize
		const resolved = path.resolve(rawPath);
		if (seen.has(resolved)) continue;
		seen.add(resolved);

		// Check if it's outside the workspace
		if (!isPathWithinCwd(resolved, cwd)) {
			external.push(resolved);
		}
	}
	return external;
}

// ── Network detection ──────────────────────────────────────────────────

export function isNetworkToolName(toolName: string): boolean {
	return NETWORK_TOOL_NAMES.has(toolName);
}

function normalizeShellCommand(command: string): string {
	return command.replace(/\\\n/g, " ").trim();
}

function containsSnapshotCommandSyntax(command: string): boolean {
	for (const character of command) {
		if (SNAPSHOT_COMMAND_UNSAFE_CHARS.has(character)) return true;
	}
	return false;
}

/**
 * True for both canonical helper invocations and commands that mention the
 * helper in a wrapper or compound command. Callers should fail closed when
 * this is true but githubRepositorySnapshotOperation() returns undefined.
 */
export function mentionsGithubRepositorySnapshotHelper(command: string): boolean {
	return normalizeShellCommand(command).includes(GITHUB_SNAPSHOT_HELPER_BASENAME);
}

export function githubRepositorySnapshotOperation(command: string): "acquire" | "list" | "remove" | undefined {
	const normalized = normalizeShellCommand(command);
	if (containsSnapshotCommandSyntax(normalized)) return undefined;
	const args = normalized.split(/[ \t]+/);
	if (args[0] !== "node" || args[1] !== GITHUB_SNAPSHOT_HELPER_PATH) return undefined;

	switch (args[2]) {
		case "list":
			return args.length === 3 ? "list" : undefined;
		case "acquire":
			return args.length === 4 || (args.length === 6 && args[4] === "--ref") ? "acquire" : undefined;
		case "remove":
			return args.length === 5 && /^ghr_[0-9a-f]{24}$/.test(args[3]) && args[4] === "--confirm" ? "remove" : undefined;
		default:
			return undefined;
	}
}

export function isNetworkCommand(command: string): boolean {
	const normalized = normalizeShellCommand(command);
	const snapshotOperation = githubRepositorySnapshotOperation(normalized);
	const malformedSnapshotCommand = mentionsGithubRepositorySnapshotHelper(normalized) && snapshotOperation === undefined;
	return snapshotOperation === "acquire" || malformedSnapshotCommand || NETWORK_COMMAND_PATTERNS.some((re) => re.test(normalized));
}

// ── Shell classification exports ───────────────────────────────────────

export function isReadOnlyShellCommand(command: string): boolean {
	const trimmed = command.trim();
	const snapshotOperation = githubRepositorySnapshotOperation(trimmed);
	if (snapshotOperation) return snapshotOperation === "list";
	if (mentionsGithubRepositorySnapshotHelper(trimmed)) return false;
	return READ_ONLY_COMMAND_RE.test(trimmed);
}

export function dangerousShellReason(command: string): string | undefined {
	return dangerousCommandReason(command) ?? undefined;
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
