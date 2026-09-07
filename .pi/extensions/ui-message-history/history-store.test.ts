import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHistoryStore } from "./history-store.ts";

// Observe every save while keeping the real atomic write, so assertions can
// check both the persisted file and the number of write operations.
const writes = vi.hoisted(() => ({ count: 0 }));
vi.mock("../_shared/settings-document.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../_shared/settings-document.ts")>();
	return {
		...actual,
		writeSettingsDocument: (path: string, document: Record<string, unknown>) => {
			writes.count++;
			actual.writeSettingsDocument(path, document);
		},
	};
});

const CWD = "/tmp/project-a";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "history-store-"));
	file = join(dir, "previous-message-history.json");
	writes.count = 0;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function persisted(): Record<string, string[]> {
	return JSON.parse(readFileSync(file, "utf8")) as Record<string, string[]>;
}

describe("history store", () => {
	it("records submissions and skips consecutive duplicates", async () => {
		const store = createHistoryStore({ file });
		store.record(CWD, "first");
		store.record(CWD, "second");
		store.record(CWD, "second");
		expect(store.listFor(CWD)).toEqual(["second", "first"]);
	});

	it("moves a re-submitted older entry to the top", () => {
		const store = createHistoryStore({ file });
		store.record(CWD, "alpha");
		store.record(CWD, "beta");
		store.record(CWD, "alpha");
		expect(store.listFor(CWD)).toEqual(["alpha", "beta"]);
	});

	it("caps the per-directory history at 200 entries", () => {
		const store = createHistoryStore({ file });
		for (let i = 0; i < 205; i++) store.record(CWD, `message-${i}`);
		const list = store.listFor(CWD);
		expect(list).toHaveLength(200);
		expect(list[0]).toBe("message-204");
		expect(list.at(-1)).toBe("message-5");
	});

	it("loads entries persisted by a previous run", () => {
		writeFileSync(file, JSON.stringify({ [CWD]: ["persisted"] }), "utf8");
		const store = createHistoryStore({ file });
		store.load();
		expect(store.listFor(CWD)).toEqual(["persisted"]);
	});

	it("merges entries written by another instance since load", async () => {
		vi.useFakeTimers();
		try {
			const store = createHistoryStore({ file });
			store.record(CWD, "ours");

			// Another pi instance in another project writes while our save is pending.
			writeFileSync(file, JSON.stringify({ "/tmp/project-b": ["theirs"] }), "utf8");

			await vi.runAllTimersAsync();

			const onDisk = persisted();
			expect(onDisk[CWD]).toEqual(["ours"]);
			expect(onDisk["/tmp/project-b"]).toEqual(["theirs"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("coalesces debounced saves into one write", async () => {
		vi.useFakeTimers();
		try {
			const store = createHistoryStore({ file });
			store.record(CWD, "first");
			store.record(CWD, "second");
			expect(writes.count).toBe(0);

			await vi.runAllTimersAsync();

			expect(writes.count).toBe(1);
			expect(persisted()[CWD]).toEqual(["second", "first"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("flush() persists the pending debounce immediately", () => {
		vi.useFakeTimers();
		try {
			const store = createHistoryStore({ file });
			store.record(CWD, "pending");
			store.flush();

			expect(writes.count).toBe(1);
			expect(persisted()[CWD]).toEqual(["pending"]);

			// A later flush without pending writes is a no-op.
			store.flush();
			expect(writes.count).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});