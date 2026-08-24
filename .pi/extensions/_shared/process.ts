import type { ChildProcess } from "node:child_process";

export function killProcessGroup(child: ChildProcess): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill("SIGKILL");
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		try { child.kill("SIGKILL"); } catch { /* already exited */ }
	}
}
