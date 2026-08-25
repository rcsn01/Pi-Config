import { describe, expect, it, vi } from "vitest";
import { GuardianSessionCache } from "./guardian-session-cache.ts";

function session(name: string) {
	return { name, dispose: vi.fn() };
}

describe("GuardianSessionCache", () => {
	it("reuses a session while the effective configuration key is unchanged", async () => {
		const cache = new GuardianSessionCache<ReturnType<typeof session>>();
		const first = session("first");
		const create = vi.fn(async () => first);

		expect(await cache.get("same", create)).toBe(first);
		expect(await cache.get("same", create)).toBe(first);
		expect(create).toHaveBeenCalledOnce();
		expect(first.dispose).not.toHaveBeenCalled();
	});

	it("disposes the previous session only after replacement succeeds", async () => {
		const cache = new GuardianSessionCache<ReturnType<typeof session>>();
		const first = session("first");
		const second = session("second");
		await cache.get("first", async () => first);

		await expect(cache.get("broken", async () => { throw new Error("unavailable"); })).rejects.toThrow("unavailable");
		expect(first.dispose).not.toHaveBeenCalled();
		expect(await cache.get("first", async () => second)).toBe(first);

		expect(await cache.get("second", async () => second)).toBe(second);
		expect(first.dispose).toHaveBeenCalledOnce();
		cache.dispose();
		expect(second.dispose).toHaveBeenCalledOnce();
		const third = session("third");
		expect(await cache.get("second", async () => third)).toBe(third);
	});
});
