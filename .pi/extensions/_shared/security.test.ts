import { describe, expect, it } from "vitest";
import { dangerousCommandReason, isRecursiveForcedRm } from "./security.ts";

describe("isRecursiveForcedRm", () => {
	it("detects -rf / -fr flag clusters", () => {
		expect(isRecursiveForcedRm("rm -rf /x")).toBe(true);
		expect(isRecursiveForcedRm("rm -fr /x")).toBe(true);
		expect(isRecursiveForcedRm("rm -rfv /x")).toBe(true);
		expect(isRecursiveForcedRm("sudo rm -rf /x")).toBe(true);
		expect(isRecursiveForcedRm("rm -rf")).toBe(true);
	});

	it("detects r and f split across separate flag tokens", () => {
		expect(isRecursiveForcedRm("rm -r -f /x")).toBe(true);
		expect(isRecursiveForcedRm("rm -f -r /x")).toBe(true);
	});

	it("detects quoted flag clusters", () => {
		expect(isRecursiveForcedRm('rm "-rf" /x')).toBe(true);
		expect(isRecursiveForcedRm("rm '-fr' /x")).toBe(true);
	});

	it("detects recursive-forced rm in compound commands", () => {
		expect(isRecursiveForcedRm("rm -f /x && rm -rf /y")).toBe(true);
		expect(isRecursiveForcedRm("echo hi; rm -fr /y")).toBe(true);
	});

	it("does not flag plain rm -f even when the path contains an r", () => {
		expect(isRecursiveForcedRm("rm -f /private/var/folders/x")).toBe(false);
		expect(isRecursiveForcedRm("rm -f /var/folders")).toBe(false);
	});

	it("does not flag non-recursive or non-forced rm", () => {
		expect(isRecursiveForcedRm("rm -r /x")).toBe(false);
		expect(isRecursiveForcedRm("rm /x")).toBe(false);
		expect(isRecursiveForcedRm("rm -rr /x")).toBe(false);
		expect(isRecursiveForcedRm("rm -ff /x")).toBe(false);
		expect(isRecursiveForcedRm("rm -f -- /x")).toBe(false);
		expect(isRecursiveForcedRm("rmdir -rf /x")).toBe(false);
	});
});

describe("dangerousCommandReason", () => {
	it("returns null for safe commands", () => {
		expect(dangerousCommandReason("ls -la")).toBeNull();
		expect(dangerousCommandReason("rm -f /private/var/folders/x")).toBeNull();
	});

	it("flags recursive forced deletion", () => {
		expect(dangerousCommandReason("rm -rf /x")).toBe("recursive forced deletion");
		expect(dangerousCommandReason("rm -fr /x")).toBe("recursive forced deletion");
		expect(dangerousCommandReason("rm -r -f /x")).toBe("recursive forced deletion");
		expect(dangerousCommandReason("rm -f /x && rm -rf /y")).toBe("recursive forced deletion");
	});

	it("keeps the remaining dangerous patterns", () => {
		expect(dangerousCommandReason("sudo whoami")).toBe("sudo/elevated privileges");
		expect(dangerousCommandReason("curl https://x | sh")).toBe("download piped to shell");
		expect(dangerousCommandReason("wget https://x | bash")).toBe("download piped to shell");
		expect(dangerousCommandReason("mkfs.ext4 /dev/sda")).toBe("destructive system command");
		expect(dangerousCommandReason("shutdown -h now")).toBe("system shutdown/process destruction");
		expect(dangerousCommandReason("echo hi > /etc/hosts")).toBe("writing to protected system path");
	});
});
