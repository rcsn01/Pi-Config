import { describe, expect, it } from "vitest";
import {
	buildUpdatePreview,
	classifyStatus,
	countCommits,
	skillMenuLabel,
	statusLabel,
	truncateDiff,
	type SkillFacts,
} from "./diff.ts";

describe("countCommits", () => {
	it("counts non-empty lines", () => {
		expect(countCommits("")).toBe(0);
		expect(countCommits("abc123 feat: one")).toBe(1);
		expect(countCommits("abc123 feat: one\ndef456 fix: two\n")).toBe(2);
		expect(countCommits(" \n\nabc123 feat: one\n\t\n")).toBe(1);
	});
});

describe("classifyStatus", () => {
	const base: SkillFacts = {
		installed: true,
		pinned: "aaa",
		head: "bbb",
		existsUpstream: true,
	};

	it("not installed wins over everything", () => {
		expect(classifyStatus({ ...base, installed: false, existsUpstream: false }, 0)).toBe(
			"not-installed",
		);
	});

	it("head unknown (fetch failed) never reports updates", () => {
		expect(classifyStatus({ ...base, head: null }, 99)).toBe("up-to-date");
	});

	it("removed upstream", () => {
		expect(classifyStatus({ ...base, existsUpstream: false }, 3)).toBe("removed");
	});

	it("installed but never pinned reads as not-installed", () => {
		expect(classifyStatus({ ...base, pinned: null }, 0)).toBe("not-installed");
	});

	it("up to date when pinned equals head", () => {
		expect(classifyStatus({ ...base, pinned: "bbb" }, 0)).toBe("up-to-date");
	});

	it("up to date when head moved but no commits touched this path", () => {
		expect(classifyStatus({ ...base }, 0)).toBe("up-to-date");
	});

	it("behind when commits exist between pinned and head", () => {
		expect(classifyStatus({ ...base }, 2)).toBe("behind");
	});
});

describe("statusLabel / skillMenuLabel", () => {
	it("labels each status", () => {
		expect(statusLabel("up-to-date", 0)).toBe("up to date");
		expect(statusLabel("not-installed", 0)).toBe("not installed");
		expect(statusLabel("removed", 0)).toBe("removed upstream");
		expect(statusLabel("behind", 1)).toBe("1 commit behind");
		expect(statusLabel("behind", 4)).toBe("4 commits behind");
	});

	it("menu labels combine name and status", () => {
		expect(skillMenuLabel("tdd", "behind", 2)).toBe("tdd — 2 commits behind");
		expect(skillMenuLabel("unslop", "up-to-date", 0)).toBe("unslop — up to date");
	});
});

describe("buildUpdatePreview", () => {
	const LOG = "abc123 feat: refresh prompts\nabc124 fix: typos\n";
	const STAT = " skills/engineering/tdd/SKILL.md | 14 ++++++++------\n 1 file changed";
	const DIFF =
		"@@ -1,5 +1,5 @@\n -old line\n+new line\n -another old\n+another new\n context\n";

	it("sections: commits, changed files, SKILL.md preview", () => {
		const preview = buildUpdatePreview(LOG, STAT, DIFF);
		expect(preview).toContain("Commits (2):");
		expect(preview).toContain("  abc123 feat: refresh prompts");
		expect(preview).toContain("Changed files:");
		expect(preview).toContain("SKILL.md preview:");
		expect(preview).toContain("+new line");
	});

	it("caps the commit list at 15 entries", () => {
		const many = Array.from({ length: 20 }, (_, i) => `abc${i} commit ${i}`).join("\n");
		const preview = buildUpdatePreview(many, "", "");
		expect(preview).toContain("Commits (20):");
		expect(preview).toContain("  abc14 commit 14");
		expect(preview).not.toContain("  abc15 commit 15");
	});

	it("truncates long diffs with a footer", () => {
		const longDiff = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const preview = buildUpdatePreview("", "", longDiff, 10);
		expect(preview).toContain("line 9");
		expect(preview).not.toContain("line 10");
		expect(preview).toContain("… (diff truncated)");
	});

	it("keeps short diffs whole", () => {
		const preview = buildUpdatePreview("", "", DIFF, 30);
		expect(preview).toContain("+another new");
		expect(preview).not.toContain("(diff truncated)");
	});
});

describe("truncateDiff", () => {
	it("returns text unchanged when within the limit", () => {
		const text = "a\nb\nc";
		expect(truncateDiff(text, 5)).toBe(text);
	});

	it("cuts after maxLines and appends a footer", () => {
		const text = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
		expect(truncateDiff(text, 5)).toBe("l0\nl1\nl2\nl3\nl4\n… (diff truncated)");
	});
});
