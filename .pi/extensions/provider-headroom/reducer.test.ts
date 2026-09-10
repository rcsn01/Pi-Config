import { describe, expect, it } from "vitest";
import { hasHeadroomMarker, looksLikeSourceCode, reduceToolOutput } from "./reducer.ts";

describe("reduceToolOutput", () => {
	it("minifies JSON without changing its data in lossless mode", () => {
		const original = JSON.stringify(
			[
				{ id: 1, status: "ok", nested: { enabled: true } },
				{ id: 2, status: "ok", nested: { enabled: false } },
			],
			null,
			2,
		);

		const result = reduceToolOutput(original, { mode: "lossless", allowLossy: false });

		expect(result.strategy).toBe("json_minify");
		expect(result.losslessChanged).toBe(true);
		expect(result.lossyChanged).toBe(false);
		expect(JSON.parse(result.text)).toEqual(JSON.parse(original));
		expect(result.text.length).toBeLessThan(original.length);
	});

	it("folds repeated log lines without using a lossy selector", () => {
		const original = [
			"2026-01-01T00:00 INFO starting",
			"2026-01-01T00:01 INFO cache warm",
			"2026-01-01T00:01 INFO cache warm",
			"2026-01-01T00:01 INFO cache warm",
			"2026-01-01T00:02 ERROR request failed",
		].join("\n");

		const result = reduceToolOutput(original, { mode: "lossless", allowLossy: false });

		expect(result.kind).toBe("log");
		expect(result.strategy).toBe("log_lossless");
		expect(result.lossyChanged).toBe(false);
		expect(result.text).toContain("... (repeated 3 times)");
		expect(result.text).toContain("ERROR request failed");
	});

	it("groups repeated search paths losslessly", () => {
		const original = [
			"src/auth.ts:10:export function login() {}",
			"src/auth.ts:20:export function logout() {}",
			"src/http.ts:8:fetch('/login')",
		].join("\n");

		const result = reduceToolOutput(original, { mode: "lossless", allowLossy: false });

		expect(result.kind).toBe("search");
		expect(result.strategy).toBe("search_lossless");
		expect(result.text).toContain("src/auth.ts:\n10:export function login() {}");
		expect(result.text).toContain("src/http.ts:\n8:fetch('/login')");
	});

	it("keeps boundaries and priority rows when sampling a large JSON array", () => {
		const original = JSON.stringify(
			Array.from({ length: 32 }, (_item, index) => ({
				id: index,
				message: index === 17 ? "ERROR: database unavailable" : `ordinary result ${index}`,
			})),
		);

		const result = reduceToolOutput(original, {
			mode: "lossless_then_lossy",
			maxItems: 6,
		});

		const reduced = JSON.parse(result.text) as Array<Record<string, unknown>>;
		expect(result.strategy).toBe("json_sample");
		expect(result.lossyChanged).toBe(true);
		expect(result.omitted).toBeGreaterThan(0);
		expect(reduced[0]?.id).toBe(0);
		expect(reduced.some((item) => item.id === 31)).toBe(true);
		expect(reduced.some((item) => item.id === 17)).toBe(true);
		expect(reduced.at(-1)?._headroom_omitted).toBe(result.omitted);
	});

	it("samples search matches by row and keeps priority matches", () => {
		const rows = Array.from({ length: 18 }, (_item, index) =>
			index === 11
				? `src/error.ts:${index + 1}:ERROR connection refused`
				: `src/file-${index % 3}.ts:${index + 1}:ordinary match ${index}`,
		);
		const result = reduceToolOutput(rows.join("\n"), {
			mode: "lossless_then_lossy",
			maxSearchMatches: 5,
		});

		expect(result.kind).toBe("search");
		expect(result.strategy).toBe("search_sample");
		expect(result.text).toContain("src/error.ts:");
		expect(result.text).toContain("ERROR connection refused");
		expect(result.omitted).toBeGreaterThan(0);
	});

	it("keeps important log lines when sampling a large log", () => {
		const lines = Array.from({ length: 24 }, (_item, index) =>
			index === 13 ? "2026-01-01T00:13 ERROR database timeout" : `2026-01-01T00:${String(index).padStart(2, "0")} INFO progress ${index}`,
		);
		const result = reduceToolOutput(lines.join("\n"), {
			mode: "lossless_then_lossy",
			maxLines: 6,
		});

		expect(result.kind).toBe("log");
		expect(result.lossyChanged).toBe(true);
		expect(result.text).toContain("ERROR database timeout");
		expect(result.omitted).toBeGreaterThan(0);
	});

	it("does not sample source-like text", () => {
		const source = [
			"import { readFile } from 'node:fs/promises';",
			"export function load(path: string) {",
			"\treturn readFile(path, 'utf8');",
			"}",
		].join("\n");

		expect(looksLikeSourceCode(source)).toBe(true);
		expect(reduceToolOutput(source, { mode: "lossless_then_lossy", maxLines: 1 }).strategy).toBe("code_protected");
	});

	it("recognizes its inline markers so a later context pass is idempotent", () => {
		expect(hasHeadroomMarker("[Headroom omitted 4 log lines.]")) .toBe(true);
		expect(hasHeadroomMarker("normal output")) .toBe(false);
	});
});
