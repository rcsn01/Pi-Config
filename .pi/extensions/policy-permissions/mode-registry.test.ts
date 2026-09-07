import { describe, expect, it } from "vitest";
import {
	APPROVAL_MODES,
	approvalDisposition,
	isApprovalMode,
	modePickerDescription,
	modeStatusLabel,
	modeSwitchConfirmation,
	modeSystemPrompt,
	resolveModeInput,
} from "./mode-registry.ts";

describe("APPROVAL_MODES", () => {
	it("pins the canonical order", () => {
		expect([...APPROVAL_MODES]).toEqual(["read-only", "default", "auto-review", "full-access"]);
	});
});

describe("isApprovalMode", () => {
	it("accepts the four canonical ids", () => {
		expect(isApprovalMode("read-only")).toBe(true);
		expect(isApprovalMode("default")).toBe(true);
		expect(isApprovalMode("auto-review")).toBe(true);
		expect(isApprovalMode("full-access")).toBe(true);
	});

	it("is exact: no aliases, no case folding, no whitespace tolerance (persisted values)", () => {
		expect(isApprovalMode("AUTO")).toBe(false);
		expect(isApprovalMode(" default")).toBe(false);
		expect(isApprovalMode("ro")).toBe(false);
		expect(isApprovalMode("")).toBe(false);
		expect(isApprovalMode("bogus")).toBe(false);
		expect(isApprovalMode(null)).toBe(false);
		expect(isApprovalMode(42)).toBe(false);
		expect(isApprovalMode({})).toBe(false);
	});
});

describe("resolveModeInput", () => {
	it("resolves all four aliases, pinning the auto→default quirk", () => {
		expect(resolveModeInput("auto")).toEqual({ ok: true, mode: "default" });
		expect(resolveModeInput("full")).toEqual({ ok: true, mode: "full-access" });
		expect(resolveModeInput("ro")).toEqual({ ok: true, mode: "read-only" });
		expect(resolveModeInput("review")).toEqual({ ok: true, mode: "auto-review" });
	});

	it("resolves the four canonical ids", () => {
		expect(resolveModeInput("read-only")).toEqual({ ok: true, mode: "read-only" });
		expect(resolveModeInput("default")).toEqual({ ok: true, mode: "default" });
		expect(resolveModeInput("auto-review")).toEqual({ ok: true, mode: "auto-review" });
		expect(resolveModeInput("full-access")).toEqual({ ok: true, mode: "full-access" });
	});

	it("trims and lowercases command input", () => {
		expect(resolveModeInput("FULL")).toEqual({ ok: true, mode: "full-access" });
		expect(resolveModeInput(" default")).toEqual({ ok: true, mode: "default" });
		expect(resolveModeInput(" review ")).toEqual({ ok: true, mode: "auto-review" });
	});

	it("rejects empty and unknown input", () => {
		expect(resolveModeInput("")).toEqual({ ok: false });
		expect(resolveModeInput("   ")).toEqual({ ok: false });
		expect(resolveModeInput("bogus")).toEqual({ ok: false });
	});
});

describe("approvalDisposition", () => {
	const deny = (reason: string) => ({ kind: "decided", result: { allowed: false, reason } });
	const allow = { kind: "decided", result: { allowed: true } };
	const prompt = { kind: "prompt" };

	it("pins the 4×2 mode × hasUI truth table", () => {
		expect(approvalDisposition("read-only", true)).toEqual(deny("Read-only mode."));
		expect(approvalDisposition("read-only", false)).toEqual(deny("Read-only mode."));
		expect(approvalDisposition("default", true)).toEqual(prompt);
		expect(approvalDisposition("default", false)).toEqual(deny("No UI available for approval."));
		expect(approvalDisposition("auto-review", true)).toEqual(allow);
		expect(approvalDisposition("auto-review", false)).toEqual(allow);
		expect(approvalDisposition("full-access", true)).toEqual(allow);
		expect(approvalDisposition("full-access", false)).toEqual(allow);
	});

	it("reaches the prompt outcome only for default mode with a UI", () => {
		expect([true, false].flatMap((hasUI) => APPROVAL_MODES.map((mode) =>
			approvalDisposition(mode, hasUI).kind === "prompt" ? mode : null,
		))).toEqual([null, "default", null, null, null, null, null, null]);
	});
});

describe("modeStatusLabel", () => {
	it("is the identity label for each mode (status line)", () => {
		expect(modeStatusLabel("read-only")).toBe("read-only");
		expect(modeStatusLabel("default")).toBe("default");
		expect(modeStatusLabel("auto-review")).toBe("auto-review");
		expect(modeStatusLabel("full-access")).toBe("full-access");
	});
});

describe("modePickerDescription", () => {
	it("pins the long /permissions picker descriptions", () => {
		expect(modePickerDescription("read-only")).toBe("Read-only browsing – read in current directory only");
		expect(modePickerDescription("default")).toBe("Default – read, edit, and run commands in workspace; approval for internet and external writes");
		expect(modePickerDescription("auto-review")).toBe("Auto-review – full auto; only prompts you for edits outside the workspace");
		expect(modePickerDescription("full-access")).toBe("Full Access – no restrictions, no approval prompts (use with caution)");
	});
});

describe("modeSystemPrompt", () => {
	const READ_ONLY_WORKSPACE = `\n\n## Permission Mode: READ-ONLY\nYou are in read-only browsing mode, limited to the current directory.\n- You CAN read files, search code, list directories, and run read-only commands within the workspace.\n- You CANNOT modify files, run write commands, execute shell commands that change the system, or access the network.\n- Do NOT attempt to use write, edit, or bash for destructive operations.\n- Inform the user if a task requires write access. They can switch mode with /permissions default.`;
	const READ_ONLY_CURRENT_DIRECTORY = `\n\n## Permission Mode: READ-ONLY\nYou are in read-only browsing mode, limited to the current directory.\n- You CAN read files, search code, list directories, and run read-only commands within the current directory.\n- You CANNOT modify files, run write commands, execute shell commands that change the system, or access the network.\n- Do NOT attempt to use write, edit, or bash for destructive operations.\n- Inform the user if a task requires write access. They can switch mode with /permissions default.`;
	const DEFAULT_SECTION = `\n\n## Permission Mode: DEFAULT\nYou may read, write, and edit files within the current workspace, and run commands.\nApproval is required to:\n- Access the internet (curl, fetch, package installs, git push/pull/clone, etc.)\n- Write or edit files outside the workspace\n- Run dangerous commands (sudo, rm -rf, curl piped to shell)\nPrefer safe alternatives when possible.`;
	const AUTO_REVIEW_SECTION = `\n\n## Permission Mode: AUTO-REVIEW\nFull auto — no restrictions on reading, writing within the workspace, web searches, or running commands.\nA guardian LLM reviews dangerous commands, network installs, and writes outside the workspace.\nSafe actions pass silently. Risky actions may trigger a user prompt.`;
	const FULL_ACCESS_SECTION = `\n\n## Permission Mode: FULL ACCESS\nNo restrictions. You have full access to read, write, and execute any command, including network access and writing outside the workspace.\nExercise caution and always inform the user of destructive operations.`;

	it("pins the read-only section under the workspace phrasing", () => {
		expect(modeSystemPrompt("read-only", "workspace")).toBe(READ_ONLY_WORKSPACE);
	});

	it("pins the read-only section under the current-directory phrasing", () => {
		expect(modeSystemPrompt("read-only", "current-directory")).toBe(READ_ONLY_CURRENT_DIRECTORY);
	});

	it("pins the other three sections regardless of the phrasing argument", () => {
		for (const phrasing of ["workspace", "current-directory"] as const) {
			expect(modeSystemPrompt("default", phrasing)).toBe(DEFAULT_SECTION);
			expect(modeSystemPrompt("auto-review", phrasing)).toBe(AUTO_REVIEW_SECTION);
			expect(modeSystemPrompt("full-access", phrasing)).toBe(FULL_ACCESS_SECTION);
		}
	});
});

describe("modeSwitchConfirmation", () => {
	it("requires the full-access confirmation with today's exact copy", () => {
		expect(modeSwitchConfirmation("full-access")).toEqual({
			title: "⚠️ Full Access Mode",
			message: "This removes ALL restrictions. The agent can run any command, write anywhere, and access the network without confirmation.\n\nExercise caution when using.\n\nAre you sure?",
		});
	});

	it("switches directly into the other three modes", () => {
		expect(modeSwitchConfirmation("read-only")).toBeUndefined();
		expect(modeSwitchConfirmation("default")).toBeUndefined();
		expect(modeSwitchConfirmation("auto-review")).toBeUndefined();
	});
});