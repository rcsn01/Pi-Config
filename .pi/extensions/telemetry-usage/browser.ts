import { spawn } from "node:child_process";

/** Platform-specific commands that open a URL in the default browser. */
const OPENERS: Record<string, readonly string[]> = {
	darwin: ["open"],
	win32: ["cmd", "/c", "start", ""],
};

/**
 * Best-effort: opens the URL with the default browser and never throws.
 * Failures (headless hosts, missing opener binaries) are swallowed because
 * the dashboard URL is always shown in the notification as a fallback.
 */
export function openInBrowser(url: string): void {
	const command = OPENERS[process.platform];
	if (!command) return;
	try {
		const child = spawn(command[0], [...command.slice(1), url], { stdio: "ignore", detached: true });
		// Swallow async failures such as a missing binary (ENOENT).
		child.once("error", () => {});
		child.unref();
	} catch {
		// Best-effort: the dashboard URL stays in the notification.
	}
}