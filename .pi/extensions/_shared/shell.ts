import { execFile, spawn } from "node:child_process";

export function execFileText(command: string, args: string[], options: { input?: string; timeout?: number; cwd?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const child = execFile(command, args, { timeout: options.timeout, cwd: options.cwd }, (error, stdout, stderr) => {
			const code = typeof (error as any)?.code === "number" ? (error as any).code : error ? 1 : 0;
			resolve({ stdout: String(stdout || ""), stderr: String(stderr || ""), code });
		});
		if (options.input !== undefined) {
			child.stdin?.end(options.input);
		}
	});
}

export function spawnText(command: string, args: string[], options: { input?: string; timeout?: number; cwd?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd: options.cwd, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ stdout, stderr, code });
		};
		timer = options.timeout ? setTimeout(() => {
			stderr += "\n[timeout]";
			proc.kill("SIGTERM");
			setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 1000);
			finish(-1);
		}, options.timeout) : undefined;
		proc.stdout?.on("data", (d) => (stdout += d.toString()));
		proc.stderr?.on("data", (d) => (stderr += d.toString()));
		proc.on("close", (code) => finish(code ?? -1));
		proc.on("error", (err) => { stderr += err.message; finish(-1); });
		if (options.input !== undefined) proc.stdin?.end(options.input);
	});
}
