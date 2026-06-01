import * as path from "node:path";

const SECRET_PATTERNS: Array<[RegExp, string | ((match: string) => string)]> = [
	[/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "sk-[REDACTED]"],
	[/\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "xox-[REDACTED]"],
	[/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "gh_[REDACTED]"],
	[/\b(AKIA[0-9A-Z]{16})\b/g, "AKIA[REDACTED]"],
	[/\b([A-Za-z0-9+/]{32,}={0,2})\b/g, (m) => (looksLikeSecretBlob(m) ? "[REDACTED_SECRET]" : m)],
	[/(api[_-]?key|token|secret|password|passwd|pwd)(\s*[:=]\s*)([^\s'\"]+)/gi, "$1$2[REDACTED]"],
];

function looksLikeSecretBlob(value: string): boolean {
	if (value.length < 40) return false;
	if (/^[0-9]+$/.test(value)) return false;
	let classes = 0;
	if (/[a-z]/.test(value)) classes++;
	if (/[A-Z]/.test(value)) classes++;
	if (/[0-9]/.test(value)) classes++;
	if (/[+/=_-]/.test(value)) classes++;
	return classes >= 3;
}

export function redactSecrets(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		out = typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
	}
	return out;
}

export function containsLikelySecret(text: string): boolean {
	return redactSecrets(text) !== text;
}

export function isSafeName(name: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) && !name.includes("..");
}

export function safeJoin(baseDir: string, requested: string): string | null {
	const resolved = path.resolve(baseDir, requested);
	const base = path.resolve(baseDir);
	return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null;
}

export function dangerousCommandReason(command: string): string | null {
	const normalized = command.replace(/\\\n/g, " ").trim();
	const checks: Array<[RegExp, string]> = [
		[/\bsudo\b/, "sudo/elevated privileges"],
		[/\brm\s+[^\n;|&]*-[^\n;|&]*r[^\n;|&]*f|\brm\s+[^\n;|&]*-[^\n;|&]*f[^\n;|&]*r/, "recursive forced deletion"],
		[/\bcurl\b[^|]*\|\s*(?:ba)?sh\b|\bwget\b[^|]*\|\s*(?:ba)?sh\b/, "download piped to shell"],
		[/\bmkfs\b|\bdd\s+if=|:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, "destructive system command"],
		[/\bshutdown\b|\breboot\b|\binit\s+0\b|\bkill\s+-9\s+1\b/, "system shutdown/process destruction"],
		[/>\s*\/(?:etc|System|Library|usr|bin|sbin)\b/, "writing to protected system path"],
	];
	for (const [pattern, reason] of checks) {
		if (pattern.test(normalized)) return reason;
	}
	return null;
}
