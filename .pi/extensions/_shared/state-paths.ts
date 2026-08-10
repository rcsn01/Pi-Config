import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface StatePathOptions {
	stateDir?: string;
	homeDir?: string;
}

export function projectStateRoot(cwd: string, options: StatePathOptions = {}): string {
	const root = options.stateDir ?? process.env.PI_CONFIG_STATE_DIR;
	const base = root
		? path.resolve(root)
		: path.join(options.homeDir ?? os.homedir(), ".pi", "state", "pi-config");
	return path.join(base, projectStateId(cwd));
}

export function projectStatePath(
	cwd: string,
	...segments: string[]
): string {
	return path.join(projectStateRoot(cwd), ...segments);
}

export function projectStateId(cwd: string): string {
	const normalized = normalizeProjectPath(cwd);
	return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function normalizeProjectPath(cwd: string): string {
	let resolved: string;
	try {
		resolved = fs.realpathSync.native(cwd);
	} catch {
		resolved = path.resolve(cwd);
	}
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}