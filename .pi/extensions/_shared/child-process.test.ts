import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createLineReader, killProcessGroup, resolvePiInvocation, spawnInGroup, terminateChildProcess, type LineReader, type SpawnProcess } from "./child-process.ts";

const realPlatform = process.platform;

function setPlatform(platform: string): void {
	Object.defineProperty(process, "platform", { value: platform });
}

interface FakeChild extends ChildProcess {
	pid?: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill: Mock<(signal?: NodeJS.Signals | number) => boolean>;
}

function fakeChild(options: { pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null } = {}): FakeChild {
	const child = new EventEmitter() as unknown as FakeChild;
	child.pid = options.pid;
	child.exitCode = options.exitCode ?? null;
	child.signalCode = options.signalCode ?? null;
	child.kill = vi.fn(() => true);
	return child;
}

function mockGroupKill(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process, "kill").mockImplementation(() => true);
}

describe("resolvePiInvocation", () => {
	const realArgv1 = process.argv[1];
	const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
	const roots: string[] = [];

	function setArgv1(value: string | undefined): void {
		if (value === undefined) delete process.argv[1];
		else process.argv[1] = value;
	}

	function setBun(value: string | undefined): void {
		Object.defineProperty(process.versions, "bun", { value, configurable: true });
	}

	function createEntryRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-process-invocation-"));
		roots.push(root);
		return root;
	}

	afterEach(() => {
		setArgv1(realArgv1);
		if (bunDescriptor) Object.defineProperty(process.versions, "bun", bunDescriptor);
		else delete (process.versions as { bun?: string }).bun;
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	it("resolves JavaScript entries through their real path, case-insensitively", () => {
		const root = createEntryRoot();
		for (const name of ["entry.mjs", "entry.cjs", "entry.js", "entry.JS", "entry.MJS", "entry.CJS"]) {
			const entry = path.join(root, name);
			fs.writeFileSync(entry, "export {};");
			expect(resolvePiInvocation(entry)).toEqual({
				command: process.execPath,
				baseArgs: [fs.realpathSync(entry)],
				exact: true,
			});
		}
	});

	it("classifies a symlink by its real target path, not its link name", () => {
		const root = createEntryRoot();
		const linkType = process.platform === "win32" ? "junction" : undefined;
		const target = path.join(root, "target.mjs");
		if (linkType) fs.mkdirSync(target);
		else fs.writeFileSync(target, "export {};");
		const unlabeledLink = path.join(root, "entry-link");
		fs.symlinkSync(target, unlabeledLink, linkType);
		expect(resolvePiInvocation(unlabeledLink)).toEqual({
			command: process.execPath,
			baseArgs: [fs.realpathSync(target)],
			exact: true,
		});

		const plain = path.join(root, "plain.txt");
		if (linkType) fs.mkdirSync(plain);
		else fs.writeFileSync(plain, "text");
		const misleadingLink = path.join(root, "misleading.js");
		fs.symlinkSync(plain, misleadingLink, linkType);
		expect(resolvePiInvocation(misleadingLink)).toEqual({ command: "pi", baseArgs: [], exact: false });
	});

	it("classifies a directory with a JavaScript suffix as exact, without a regular-file check", () => {
		const root = createEntryRoot();
		const entry = path.join(root, "directory.js");
		fs.mkdirSync(entry);
		expect(resolvePiInvocation(entry)).toEqual({
			command: process.execPath,
			baseArgs: [fs.realpathSync(entry)],
			exact: true,
		});
	});

	it("falls back to PATH pi for non-JavaScript, missing, and empty entries", () => {
		const root = createEntryRoot();
		const plain = path.join(root, "entry.txt");
		fs.writeFileSync(plain, "text");
		for (const entry of [plain, path.join(root, "missing.js"), ""]) {
			expect(resolvePiInvocation(entry)).toEqual({ command: "pi", baseArgs: [], exact: false });
		}
	});

	it("uses process.argv[1] for omitted and explicit-undefined arguments", () => {
		const root = createEntryRoot();
		const jsEntry = path.join(root, "argv-entry.js");
		fs.writeFileSync(jsEntry, "export {};");
		const plain = path.join(root, "argv-entry.txt");
		fs.writeFileSync(plain, "text");

		setArgv1(jsEntry);
		for (const invocation of [resolvePiInvocation(), resolvePiInvocation(undefined)]) {
			expect(invocation).toEqual({ command: process.execPath, baseArgs: [fs.realpathSync(jsEntry)], exact: true });
		}

		setArgv1(plain);
		expect(resolvePiInvocation()).toEqual({ command: "pi", baseArgs: [], exact: false });

		setArgv1("");
		expect(resolvePiInvocation()).toEqual({ command: "pi", baseArgs: [], exact: false });

		setArgv1(path.join(root, "missing.js"));
		expect(resolvePiInvocation()).toEqual({ command: "pi", baseArgs: [], exact: false });

		setArgv1(undefined);
		expect(resolvePiInvocation()).toEqual({ command: "pi", baseArgs: [], exact: false });
	});

	it("lets a defined explicit argvEntry, including an empty string, take precedence over process.argv[1]", () => {
		const root = createEntryRoot();
		const jsEntry = path.join(root, "explicit.js");
		fs.writeFileSync(jsEntry, "export {};");
		const plain = path.join(root, "explicit.txt");
		fs.writeFileSync(plain, "text");

		setArgv1(jsEntry);
		expect(resolvePiInvocation(plain)).toEqual({ command: "pi", baseArgs: [], exact: false });
		expect(resolvePiInvocation("")).toEqual({ command: "pi", baseArgs: [], exact: false });

		setArgv1(plain);
		expect(resolvePiInvocation(jsEntry)).toEqual({
			command: process.execPath,
			baseArgs: [fs.realpathSync(jsEntry)],
			exact: true,
		});
	});

	it("uses the Bun executable for every fallthrough case under Bun", () => {
		const root = createEntryRoot();
		const plain = path.join(root, "entry.txt");
		fs.writeFileSync(plain, "text");
		setBun("1.2.0");
		setArgv1(undefined);
		for (const entry of [plain, path.join(root, "missing.js"), "", undefined]) {
			expect(resolvePiInvocation(entry)).toEqual({ command: process.execPath, baseArgs: [], exact: true });
		}
		for (const argvValue of [plain, "", undefined]) {
			setArgv1(argvValue);
			expect(resolvePiInvocation()).toEqual({ command: process.execPath, baseArgs: [], exact: true });
			expect(resolvePiInvocation(undefined)).toEqual({ command: process.execPath, baseArgs: [], exact: true });
		}
	});

	it("lets a JavaScript entry win over the Bun fallback", () => {
		const root = createEntryRoot();
		const entry = path.join(root, "entry.js");
		fs.writeFileSync(entry, "export {};");
		setBun("1.2.0");
		expect(resolvePiInvocation(entry)).toEqual({
			command: process.execPath,
			baseArgs: [fs.realpathSync(entry)],
			exact: true,
		});
		setArgv1(entry);
		expect(resolvePiInvocation(undefined)).toEqual({
			command: process.execPath,
			baseArgs: [fs.realpathSync(entry)],
			exact: true,
		});
	});
});

describe("createLineReader", () => {
	function collect(options?: { maxLineBytes?: number }): { reader: LineReader; lines: string[] } {
		const lines: string[] = [];
		return { reader: createLineReader((line) => lines.push(line), options), lines };
	}

	it("delivers multiple lines from one chunk and reassembles a line split across chunks", () => {
		const first = collect();
		first.reader.push(Buffer.from("a\nbb\nccc\n"));
		expect(first.lines).toEqual(["a", "bb", "ccc"]);

		const second = collect();
		second.reader.push(Buffer.from("head"));
		second.reader.push(Buffer.from("er\nnext\n"));
		expect(second.lines).toEqual(["header", "next"]);
	});

	it("preserves a CJK or emoji code point split at every interior byte boundary", () => {
		for (const text of ["こんにちは", "ok👍done"]) {
			const bytes = Buffer.from(text, "utf8");
			for (let split = 1; split < bytes.length; split++) {
				const { reader, lines } = collect();
				reader.push(bytes.subarray(0, split));
				reader.push(bytes.subarray(split));
				reader.push("\n");
				expect(lines, `${text} split at byte ${split}`).toEqual([text]);
			}
		}
	});

	it("keeps ordering across a Buffer-to-string-to-Buffer transition with replacement characters", () => {
		const { reader, lines } = collect();
		const eAcute = Buffer.from("é", "utf8");
		reader.push(Buffer.concat([Buffer.from("a", "utf8"), eAcute.subarray(0, 1)]));
		reader.push("b");
		reader.push(Buffer.concat([eAcute.subarray(1), Buffer.from("c\n", "utf8")]));
		expect(lines).toEqual(["a\uFFFDb\uFFFDc"]);

		const invalid = collect();
		invalid.reader.push(Buffer.from([0xff, 0x0a]));
		expect(invalid.lines).toEqual(["\uFFFD"]);
	});

	it("removes one CR before LF and at the tail while retaining other whitespace", () => {
		const { reader, lines } = collect();
		reader.push(" a \r\n");
		reader.push("b\r\r\n");
		reader.push(Buffer.from("c\n"));
		reader.push("tail \r");
		reader.end();
		expect(lines).toEqual([" a ", "b\r", "c", "tail "]);
	});

	it("skips empty lines and delivers whitespace-only lines", () => {
		const { reader, lines } = collect();
		reader.push("\n\n \n\t\n");
		reader.end();
		expect(lines).toEqual([" ", "\t"]);
	});

	it("drops a lone-CR tail as empty", () => {
		const { reader, lines } = collect();
		reader.push("\r");
		reader.end();
		expect(lines).toEqual([]);
	});

	it("delivers a tail without LF once and ignores repeated end and later pushes", () => {
		const { reader, lines } = collect();
		reader.push("tail");
		reader.end();
		expect(lines).toEqual(["tail"]);
		reader.end();
		reader.push("x\n");
		expect(lines).toEqual(["tail"]);
	});

	it("throws for invalid byte limits before accepting input", () => {
		for (const maxLineBytes of [0, -1, -5, 1.5, Infinity, -Infinity, NaN]) {
			expect(() => createLineReader(() => undefined, { maxLineBytes })).toThrow(/maxLineBytes/);
		}
	});

	it("buffers unboundedly without maxLineBytes", () => {
		const { reader, lines } = collect();
		const big = "x".repeat(9 * 1024 * 1024);
		reader.push(Buffer.from(`${big}\n`));
		expect(lines).toEqual([big]);
	});

	it("delivers lines at the limit, discards lines over it, and recovers after LF", () => {
		const { reader, lines } = collect({ maxLineBytes: 4 });
		reader.push("abc\n");
		reader.push("abcd\n");
		reader.push("abcde\n");
		reader.push("xy\n");
		reader.push(Buffer.from("ab"));
		reader.push(Buffer.from("cdefg\n"));
		reader.push("ok");
		reader.end();
		expect(lines).toEqual(["abc", "abcd", "xy", "ok"]);
	});

	it("counts a trailing CR and whitespace toward the byte limit", () => {
		const { reader, lines } = collect({ maxLineBytes: 3 });
		reader.push("ab\r\n");
		reader.push("abc\r\n");
		reader.push(" a\n");
		expect(lines).toEqual(["ab", " a"]);
	});

	it("accounts multibyte characters against the byte limit", () => {
		const { reader, lines } = collect({ maxLineBytes: 4 });
		reader.push(Buffer.from("éé\n"));
		reader.push(Buffer.from("ééé\n"));
		reader.push("ok\n");
		expect(lines).toEqual(["éé", "ok"]);
	});

	it("discards an overlong tail and accepts a tail at exactly the limit", () => {
		const overlong = collect({ maxLineBytes: 3 });
		overlong.reader.push(Buffer.from("abcdef"));
		overlong.reader.end();
		expect(overlong.lines).toEqual([]);

		const exact = collect({ maxLineBytes: 3 });
		exact.reader.push(Buffer.from("abc"));
		exact.reader.end();
		expect(exact.lines).toEqual(["abc"]);
	});

	it("propagates onLine exceptions from push and end", () => {
		const boom = new Error("boom");
		let calls = 0;
		const reader = createLineReader(() => {
			calls++;
			throw boom;
		});
		expect(() => reader.push("a\n")).toThrow(boom);
		expect(calls).toBe(1);

		const tailReader = createLineReader(() => {
			throw boom;
		});
		tailReader.push("tail");
		expect(() => tailReader.end()).toThrow(boom);
	});
});

describe("killProcessGroup", () => {
	beforeEach(() => setPlatform("linux"));

	afterEach(() => {
		setPlatform(realPlatform);
		vi.restoreAllMocks();
	});

	it("does nothing without a pid", () => {
		const killSpy = mockGroupKill();
		const child = fakeChild();
		expect(() => killProcessGroup(child)).not.toThrow();
		expect(killSpy).not.toHaveBeenCalled();
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("signals the POSIX process group", () => {
		const killSpy = mockGroupKill();
		const child = fakeChild({ pid: 4242 });
		killProcessGroup(child);
		expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("signals the pid on Windows", () => {
		setPlatform("win32");
		const killSpy = mockGroupKill();
		const child = fakeChild({ pid: 4242 });
		killProcessGroup(child);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(killSpy).not.toHaveBeenCalled();
	});

	it("falls back to the pid signal when the group signal throws and contains both failures", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("ESRCH");
		});
		const child = fakeChild({ pid: 4242 });
		expect(() => killProcessGroup(child)).not.toThrow();
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");

		const broken = fakeChild({ pid: 4243 });
		broken.kill.mockImplementation(() => {
			throw new Error("gone");
		});
		expect(() => killProcessGroup(broken)).not.toThrow();
	});
});

describe("terminateChildProcess", () => {
	beforeEach(() => setPlatform("linux"));

	afterEach(() => {
		setPlatform(realPlatform);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("resolves without signaling an already-exited or already-signaled child", async () => {
		const killSpy = mockGroupKill();
		const exited = fakeChild({ pid: 123, exitCode: 0 });
		await expect(terminateChildProcess(exited, { graceMs: 1000, group: true })).resolves.toBeUndefined();
		expect(exited.kill).not.toHaveBeenCalled();
		expect(killSpy).not.toHaveBeenCalled();
		expect(exited.listenerCount("exit")).toBe(0);

		const signaled = fakeChild({ pid: 123, signalCode: "SIGKILL" });
		await expect(terminateChildProcess(signaled, { graceMs: 1000 })).resolves.toBeUndefined();
		expect(signaled.kill).not.toHaveBeenCalled();
	});

	it("sends SIGTERM immediately and SIGKILL exactly at the grace deadline", async () => {
		vi.useFakeTimers();
		for (const graceMs of [1000, 3000]) {
			const child = fakeChild({ pid: 123 });
			let settled = false;
			const settledPromise = terminateChildProcess(child, { graceMs }).then(() => { settled = true; });
			expect(child.kill).toHaveBeenCalledTimes(1);
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			await vi.advanceTimersByTimeAsync(graceMs - 1);
			expect(child.kill).toHaveBeenCalledTimes(1);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(child.kill).toHaveBeenCalledWith("SIGKILL");
			expect(settled).toBe(false);
			child.emit("exit", 0, null);
			await settledPromise;
			expect(settled).toBe(true);
		}
	});

	it("sends TERM then KILL in one turn at zero grace", () => {
		const child = fakeChild({ pid: 123 });
		void terminateChildProcess(child, { graceMs: 0 });
		expect(child.kill.mock.calls.map((call) => call[0])).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("settles on exit or close before the grace deadline and cancels escalation", async () => {
		vi.useFakeTimers();
		const child = fakeChild({ pid: 123 });
		child.kill.mockImplementation(() => {
			child.exitCode = 0;
			child.emit("exit", 0, null);
			return true;
		});
		await expect(terminateChildProcess(child, { graceMs: 1000 })).resolves.toBeUndefined();
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		await vi.advanceTimersByTimeAsync(5000);
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.listenerCount("exit")).toBe(0);
		expect(child.listenerCount("close")).toBe(0);

		const closeChild = fakeChild({ pid: 124 });
		const closeSettled = terminateChildProcess(closeChild, { graceMs: 1000 });
		closeChild.emit("close", 0);
		await closeSettled;
		await vi.advanceTimersByTimeAsync(5000);
		expect(closeChild.kill).toHaveBeenCalledTimes(1);
	});

	it("resolves early when exit arrives after SIGKILL but before the post-kill deadline", async () => {
		vi.useFakeTimers();
		const child = fakeChild({ pid: 123 });
		let settled = false;
		const settledPromise = terminateChildProcess(child, { graceMs: 100, killWaitMs: 1000 }).then(() => { settled = true; });
		await vi.advanceTimersByTimeAsync(100);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		setTimeout(() => child.emit("close", 0), 500);
		await vi.advanceTimersByTimeAsync(500);
		await settledPromise;
		expect(settled).toBe(true);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(child.kill).toHaveBeenCalledTimes(2);
	});

	it("resolves a stubborn child at SIGKILL plus killWaitMs, removing listeners and timers", async () => {
		vi.useFakeTimers();
		const child = fakeChild({ pid: 123 });
		let settled = false;
		const settledPromise = terminateChildProcess(child, { graceMs: 1000, killWaitMs: 1000 }).then(() => { settled = true; });
		await vi.advanceTimersByTimeAsync(1999);
		expect(settled).toBe(false);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		await vi.advanceTimersByTimeAsync(1);
		await settledPromise;
		expect(settled).toBe(true);
		expect(child.listenerCount("exit")).toBe(0);
		expect(child.listenerCount("close")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not resolve a stubborn child merely because SIGKILL was attempted without killWaitMs", async () => {
		vi.useFakeTimers();
		const child = fakeChild({ pid: 123 });
		let settled = false;
		const settledPromise = terminateChildProcess(child, { graceMs: 1000 }).then(() => { settled = true; });
		await vi.advanceTimersByTimeAsync(5000);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(settled).toBe(false);
		child.emit("exit", null, "SIGKILL");
		await settledPromise;
		expect(settled).toBe(true);
	});

	it("resolves immediately after the SIGKILL attempt with killWaitMs 0", async () => {
		vi.useFakeTimers();
		const child = fakeChild({ pid: 123 });
		let settled = false;
		const settledPromise = terminateChildProcess(child, { graceMs: 500, killWaitMs: 0 }).then(() => { settled = true; });
		await vi.advanceTimersByTimeAsync(501);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		await settledPromise;
		expect(settled).toBe(true);
	});

	it("targets the process group on POSIX for TERM and KILL", async () => {
		vi.useFakeTimers();
		const killSpy = mockGroupKill();
		const child = fakeChild({ pid: 4242 });
		void terminateChildProcess(child, { graceMs: 1000, group: true });
		expect(killSpy).toHaveBeenNthCalledWith(1, -4242, "SIGTERM");
		expect(child.kill).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(killSpy).toHaveBeenNthCalledWith(2, -4242, "SIGKILL");
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("falls back to pid signaling when group signaling throws", async () => {
		vi.useFakeTimers();
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("ESRCH");
		});
		const child = fakeChild({ pid: 4242 });
		void terminateChildProcess(child, { graceMs: 1000, group: true });
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		await vi.advanceTimersByTimeAsync(1000);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("signals the pid on Windows even when group is requested", async () => {
		vi.useFakeTimers();
		setPlatform("win32");
		const killSpy = mockGroupKill();
		const child = fakeChild({ pid: 4242 });
		void terminateChildProcess(child, { graceMs: 1000, group: true });
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(killSpy).not.toHaveBeenCalled();
	});

	it("falls back to child.kill when group is requested without a pid", async () => {
		const child = fakeChild();
		await expect(terminateChildProcess(child, { graceMs: 0, killWaitMs: 0, group: true })).resolves.toBeUndefined();
		expect(child.kill.mock.calls.map((call) => call[0])).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it.each([-1, 1.5, Infinity, -Infinity, NaN])("throws synchronously for invalid graceMs %s before signaling", (graceMs) => {
		const child = fakeChild({ pid: 123 });
		expect(() => terminateChildProcess(child, { graceMs })).toThrow(/graceMs/);
		expect(child.kill).not.toHaveBeenCalled();
	});

	it.each([-1, 0.5, Infinity, NaN])("throws synchronously for invalid killWaitMs %s before signaling", (killWaitMs) => {
		const child = fakeChild({ pid: 123 });
		expect(() => terminateChildProcess(child, { graceMs: 1000, killWaitMs })).toThrow(/killWaitMs/);
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("contains signal failures and still follows exit or the kill wait without unhandled rejections", async () => {
		vi.useFakeTimers();
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => { unhandled.push(error); };
		process.on("unhandledRejection", onUnhandled);
		try {
			const failing = fakeChild({ pid: 1 });
			failing.kill.mockImplementation(() => {
				throw new Error("ESRCH");
			});
			let settled = false;
			const settledPromise = terminateChildProcess(failing, { graceMs: 100, killWaitMs: 50 }).then(() => { settled = true; });
			await vi.advanceTimersByTimeAsync(150);
			await settledPromise;
			expect(settled).toBe(true);
			expect(failing.kill).toHaveBeenCalledTimes(2);
			await Promise.resolve();
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

describe("spawnInGroup", () => {
	beforeEach(() => setPlatform("linux"));

	type SpawnMock = Mock<(command: string, args: readonly string[], options: SpawnOptions) => FakeChild>;

	/** `typeof spawn`'s overloads cannot accept a mock returning a fake child, so
	 *  the injection seam carries the cast, matching child-runner.test.ts. */
	function fakeSpawnSpy(makeChild: () => FakeChild): { spawnProcess: SpawnProcess; mock: SpawnMock } {
		const mock: SpawnMock = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => makeChild());
		return { spawnProcess: mock as unknown as SpawnProcess, mock };
	}

	function fakeSpawnProcess(makeChild: () => FakeChild): SpawnProcess {
		return fakeSpawnSpy(makeChild).spawnProcess;
	}

	function fakeChildWithStreams(options: Parameters<typeof fakeChild>[0] = {}): FakeChild {
		const child = fakeChild(options);
		child.stdout = new EventEmitter() as unknown as FakeChild["stdout"];
		child.stderr = new EventEmitter() as unknown as FakeChild["stderr"];
		return child;
	}

	afterEach(() => {
		setPlatform(realPlatform);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("spawns through spawnProcess with command, args, cwd, env, and stdio passed verbatim", async () => {
		const child = fakeChild();
		const { spawnProcess, mock } = fakeSpawnSpy(() => child);
		const pending = spawnInGroup({
			command: "/bin/tool",
			args: ["-x", "y"],
			cwd: "/tmp/dir",
			env: { PATH: "/bin" },
			stdio: ["ignore", "pipe", "pipe"],
			spawnProcess,
		});
		expect(mock).toHaveBeenCalledOnce();
		expect(mock.mock.calls[0]?.[0]).toBe("/bin/tool");
		expect(mock.mock.calls[0]?.[1]).toEqual(["-x", "y"]);
		expect(mock.mock.calls[0]?.[2]).toMatchObject({
			cwd: "/tmp/dir",
			env: { PATH: "/bin" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.emit("close", 0);
		await expect(pending).resolves.toEqual({ kind: "exit", exitCode: 0 });
	});

	it("spawns detached on POSIX and not on Windows", async () => {
		const posixChild = fakeChild();
		const posix = fakeSpawnSpy(() => posixChild);
		const posixPending = spawnInGroup({ command: "c", args: [], stdio: "ignore", spawnProcess: posix.spawnProcess });
		expect(posix.mock.mock.calls[0]?.[2]?.detached).toBe(true);
		posixChild.emit("close", 0);
		await expect(posixPending).resolves.toEqual({ kind: "exit", exitCode: 0 });

		setPlatform("win32");
		const winChild = fakeChild();
		const win = fakeSpawnSpy(() => winChild);
		const winPending = spawnInGroup({ command: "c", args: [], stdio: "ignore", spawnProcess: win.spawnProcess });
		expect(win.mock.mock.calls[0]?.[2]?.detached).toBe(false);
		winChild.emit("close", 0);
		await expect(winPending).resolves.toEqual({ kind: "exit", exitCode: 0 });
	});

	it("resolves the close event's exit code, including null for a signaled child", async () => {
		const codeChild = fakeChild();
		const codePending = spawnInGroup({ command: "c", args: [], stdio: "ignore", spawnProcess: fakeSpawnProcess(() => codeChild) });
		codeChild.emit("close", 7);
		await expect(codePending).resolves.toEqual({ kind: "exit", exitCode: 7 });

		const signaledChild = fakeChild();
		const signaledPending = spawnInGroup({ command: "c", args: [], stdio: "ignore", spawnProcess: fakeSpawnProcess(() => signaledChild) });
		signaledChild.emit("close", null, "SIGKILL");
		await expect(signaledPending).resolves.toEqual({ kind: "exit", exitCode: null });
	});

	it("resolves spawn-error with the raw error from a synchronous spawn throw and from a child error event", async () => {
		const thrown = new Error("spawn threw");
		const syncPending = spawnInGroup({
			command: "c",
			args: [],
			stdio: "ignore",
			spawnProcess: fakeSpawnProcess(() => {
				throw thrown;
			}),
		});
		await expect(syncPending).resolves.toEqual({ kind: "spawn-error", error: thrown });

		const child = fakeChild();
		const eventError = new Error("ENOENT");
		const eventPending = spawnInGroup({ command: "c", args: [], stdio: "ignore", spawnProcess: fakeSpawnProcess(() => child) });
		child.emit("error", eventError);
		await expect(eventPending).resolves.toEqual({ kind: "spawn-error", error: eventError });
	});

	it("resolves aborted without spawning when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const killSpy = mockGroupKill();
		const spawnMock = vi.fn(() => fakeChild({ pid: 4242 }));
		await expect(
			spawnInGroup({ command: "c", args: [], stdio: "ignore", signal: controller.signal, spawnProcess: spawnMock as unknown as SpawnProcess }),
		).resolves.toEqual({ kind: "aborted" });
		expect(spawnMock).not.toHaveBeenCalled();
		expect(killSpy).not.toHaveBeenCalled();
	});

	it("kills the group on a mid-run abort and resolves aborted from the subsequent close", async () => {
		const killSpy = mockGroupKill();
		const child = fakeChild({ pid: 4242 });
		const controller = new AbortController();
		const pending = spawnInGroup({ command: "c", args: [], stdio: "ignore", signal: controller.signal, spawnProcess: fakeSpawnProcess(() => child) });
		await Promise.resolve();
		expect(killSpy).not.toHaveBeenCalled();
		controller.abort();
		expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
		child.emit("close", null, "SIGKILL");
		await expect(pending).resolves.toEqual({ kind: "aborted" });
	});

	it("catches a same-tick abort through the post-attach listener and through the post-attach re-check", async () => {
		const killSpy = mockGroupKill();
		const listenerChild = fakeChild({ pid: 4242 });
		const listenerController = new AbortController();
		const listenerPending = spawnInGroup({
			command: "c",
			args: [],
			stdio: "ignore",
			signal: listenerController.signal,
			spawnProcess: fakeSpawnProcess(() => listenerChild),
		});
		listenerController.abort();
		expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
		listenerChild.emit("close", null, "SIGKILL");
		await expect(listenerPending).resolves.toEqual({ kind: "aborted" });

		const recheckKill = mockGroupKill();
		const recheckChild = fakeChild({ pid: 4243 });
		const recheckController = new AbortController();
		const recheckPending = spawnInGroup({
			command: "c",
			args: [],
			stdio: "ignore",
			signal: recheckController.signal,
			spawnProcess: fakeSpawnProcess(() => {
				recheckController.abort();
				return recheckChild;
			}),
		});
		expect(recheckKill).toHaveBeenCalledWith(-4243, "SIGKILL");
		recheckChild.emit("close", null, "SIGKILL");
		await expect(recheckPending).resolves.toEqual({ kind: "aborted" });
	});

	it("kills the group when the deadline fires and resolves timed-out", async () => {
		vi.useFakeTimers();
		const killSpy = mockGroupKill();
		const child = fakeChild({ pid: 4242 });
		const pending = spawnInGroup({ command: "c", args: [], stdio: "ignore", timeoutSeconds: 2, spawnProcess: fakeSpawnProcess(() => child) });
		await vi.advanceTimersByTimeAsync(1999);
		expect(killSpy).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
		child.emit("close", null, "SIGKILL");
		await expect(pending).resolves.toEqual({ kind: "timed-out" });
	});

	it("reports aborted over timed-out in both precedence orders because marks accumulate", async () => {
		vi.useFakeTimers();
		const killSpy = mockGroupKill();
		const lateAbortChild = fakeChild({ pid: 4242 });
		const lateAbortController = new AbortController();
		const lateAbortPending = spawnInGroup({
			command: "c",
			args: [],
			stdio: "ignore",
			signal: lateAbortController.signal,
			timeoutSeconds: 2,
			spawnProcess: fakeSpawnProcess(() => lateAbortChild),
		});
		await vi.advanceTimersByTimeAsync(2000);
		expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
		lateAbortController.abort();
		expect(killSpy).toHaveBeenCalledTimes(2);
		lateAbortChild.emit("close", null, "SIGKILL");
		await expect(lateAbortPending).resolves.toEqual({ kind: "aborted" });

		const lateDeadlineKill = killSpy;
		lateDeadlineKill.mockClear();
		const lateDeadlineChild = fakeChild({ pid: 4243 });
		const lateDeadlineController = new AbortController();
		const lateDeadlinePending = spawnInGroup({
			command: "c",
			args: [],
			stdio: "ignore",
			signal: lateDeadlineController.signal,
			timeoutSeconds: 2,
			spawnProcess: fakeSpawnProcess(() => lateDeadlineChild),
		});
		lateDeadlineController.abort();
		expect(lateDeadlineKill).toHaveBeenCalledWith(-4243, "SIGKILL");
		await vi.advanceTimersByTimeAsync(2000);
		expect(lateDeadlineKill).toHaveBeenCalledTimes(2);
		lateDeadlineChild.emit("close", null, "SIGKILL");
		await expect(lateDeadlinePending).resolves.toEqual({ kind: "aborted" });
	});

	it("settles once: the first of error and close wins regardless of order", async () => {
		const errorChild = fakeChild();
		const errorPending = spawnInGroup({ command: "c", args: [], stdio: "ignore", spawnProcess: fakeSpawnProcess(() => errorChild) });
		const boom = new Error("boom");
		errorChild.emit("error", boom);
		errorChild.emit("close", 1);
		await expect(errorPending).resolves.toEqual({ kind: "spawn-error", error: boom });

		const closeChild = fakeChild();
		const closePending = spawnInGroup({ command: "c", args: [], stdio: "ignore", spawnProcess: fakeSpawnProcess(() => closeChild) });
		closeChild.emit("close", 3);
		closeChild.emit("error", new Error("late"));
		await expect(closePending).resolves.toEqual({ kind: "exit", exitCode: 3 });
	});

	it("ignores aborts and deadline firings after settle", async () => {
		vi.useFakeTimers();
		const killSpy = mockGroupKill();
		const child = fakeChild({ pid: 4242 });
		const controller = new AbortController();
		const pending = spawnInGroup({
			command: "c",
			args: [],
			stdio: "ignore",
			signal: controller.signal,
			timeoutSeconds: 5,
			spawnProcess: fakeSpawnProcess(() => child),
		});
		child.emit("close", 0);
		await expect(pending).resolves.toEqual({ kind: "exit", exitCode: 0 });
		controller.abort();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(killSpy).not.toHaveBeenCalled();
		await expect(pending).resolves.toEqual({ kind: "exit", exitCode: 0 });
	});

	it("kills the group at settle when killGroupOnSettle is set, on close and on error, and never when absent", async () => {
		const killSpy = mockGroupKill();
		const closeChild = fakeChild({ pid: 4242 });
		const closePending = spawnInGroup({ command: "c", args: [], stdio: "ignore", killGroupOnSettle: true, spawnProcess: fakeSpawnProcess(() => closeChild) });
		closeChild.emit("close", 0);
		await expect(closePending).resolves.toEqual({ kind: "exit", exitCode: 0 });
		expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");

		const errorChild = fakeChild({ pid: 4243 });
		const errorPending = spawnInGroup({ command: "c", args: [], stdio: "ignore", killGroupOnSettle: true, spawnProcess: fakeSpawnProcess(() => errorChild) });
		const boom = new Error("boom");
		errorChild.emit("error", boom);
		await expect(errorPending).resolves.toEqual({ kind: "spawn-error", error: boom });
		expect(killSpy).toHaveBeenCalledWith(-4243, "SIGKILL");

		const plainChild = fakeChild({ pid: 4244 });
		const plainPending = spawnInGroup({ command: "c", args: [], stdio: "ignore", spawnProcess: fakeSpawnProcess(() => plainChild) });
		plainChild.emit("close", 0);
		await expect(plainPending).resolves.toEqual({ kind: "exit", exitCode: 0 });
		expect(killSpy).toHaveBeenCalledTimes(2);
	});

	it("clears the deadline timer at settle so a close before the deadline never yields timed-out", async () => {
		vi.useFakeTimers();
		const killSpy = mockGroupKill();
		const child = fakeChild({ pid: 4242 });
		const pending = spawnInGroup({ command: "c", args: [], stdio: "ignore", timeoutSeconds: 5, spawnProcess: fakeSpawnProcess(() => child) });
		child.emit("close", 0);
		await expect(pending).resolves.toEqual({ kind: "exit", exitCode: 0 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(killSpy).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("removes the abort listener at settle so a later abort triggers no kill", async () => {
		const killSpy = mockGroupKill();
		const child = fakeChild({ pid: 4242 });
		const controller = new AbortController();
		const pending = spawnInGroup({ command: "c", args: [], stdio: "ignore", signal: controller.signal, spawnProcess: fakeSpawnProcess(() => child) });
		child.emit("close", 0);
		await expect(pending).resolves.toEqual({ kind: "exit", exitCode: 0 });
		controller.abort();
		expect(killSpy).not.toHaveBeenCalled();
	});

	it("delivers raw stdout and stderr chunks to the callbacks in emission order and accumulates nothing itself", async () => {
		const child = fakeChildWithStreams();
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const pending = spawnInGroup({
			command: "c",
			args: [],
			stdio: ["ignore", "pipe", "pipe"],
			onStdout: (chunk) => stdout.push(chunk),
			onStderr: (chunk) => stderr.push(chunk),
			spawnProcess: fakeSpawnProcess(() => child),
		});
		const first = Buffer.from("out-1");
		const second = Buffer.from("err-1");
		const third = Buffer.from("out-2");
		(child.stdout as unknown as EventEmitter).emit("data", first);
		(child.stderr as unknown as EventEmitter).emit("data", second);
		(child.stdout as unknown as EventEmitter).emit("data", third);
		child.emit("close", 0);
		await expect(pending).resolves.toEqual({ kind: "exit", exitCode: 0 });
		expect(stdout).toEqual([first, third]);
		expect(stderr).toEqual([second]);
	});
});
