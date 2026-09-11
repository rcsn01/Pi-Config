import { describe, expect, it } from "vitest";
import { classifyStatus, countCommits, type SkillFacts } from "./diff.ts";

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

	it("gives local absence precedence over upstream removal", () => {
		expect(classifyStatus({ ...base, installed: false, existsUpstream: false }, 0))
			.toBe("not-installed");
	});

	it("never reports updates when the head is unknown", () => {
		expect(classifyStatus({ ...base, head: null }, 99)).toBe("up-to-date");
	});

	it("reports upstream removal before a missing pin", () => {
		expect(classifyStatus({ ...base, pinned: null, existsUpstream: false }, 3)).toBe("removed");
	});

	it("reports an installed but unpinned skill as not installed", () => {
		expect(classifyStatus({ ...base, pinned: null }, 0)).toBe("not-installed");
	});

	it("is current when the pin equals the head", () => {
		expect(classifyStatus({ ...base, pinned: "bbb" }, 0)).toBe("up-to-date");
	});

	it("is current when no commits touched the path", () => {
		expect(classifyStatus(base, 0)).toBe("up-to-date");
	});

	it("is behind when commits touched the path", () => {
		expect(classifyStatus(base, 2)).toBe("behind");
	});
});
