import { describe, expect, it } from "vitest";
import {
	APPROVAL_MODES,
	approvalDisposition,
	isApprovalMode,
	modePickerDescription,
	modeRequestMarker,
	modeStatusLabel,
	modeSwitchConfirmation,
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

describe("modeRequestMarker", () => {
	it("returns only the read-only marker while read-only mode is active", () => {
		expect(modeRequestMarker("read-only")).toBe("Read-only");
	});

	it("returns no marker for other modes", () => {
		for (const mode of ["default", "auto-review", "full-access"] as const) {
			expect(modeRequestMarker(mode)).toBeUndefined();
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