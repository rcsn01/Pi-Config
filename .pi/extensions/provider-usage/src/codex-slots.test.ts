import { describe, expect, it, vi } from "vitest";
import type {
	CodexCredentialRequestAuth,
	CodexCredentialSlotInfo,
	CodexCredentialSlotInspection,
} from "../../provider-codex/credential-slots.ts";
import {
	CodexSlotUsageClient,
	formatCodexAuthStatus,
	formatCodexProbeResults,
	type CodexSlotQuotaBatch,
} from "./codex-slots.ts";
import type { CodexQuotaRequestHeaders } from "./quota-client.ts";
import type { QuotaProbeResult } from "./types.ts";

const headersA: CodexQuotaRequestHeaders = {
	Authorization: "Bearer SECRET_ACCESS_A",
	"chatgpt-account-id": "account-a",
};
const headersB: CodexQuotaRequestHeaders = {
	Authorization: "Bearer SECRET_ACCESS_B",
	"chatgpt-account-id": "account-b",
};

function slot(id: string, name: string, active: boolean, hasCredential: boolean): CodexCredentialSlotInfo {
	return { id, name, active, hasCredential, status: active ? "active" : hasCredential ? "saved" : "empty" };
}

function inspection(slots: CodexCredentialSlotInfo[]): CodexCredentialSlotInspection {
	const active = slots.find((entry) => entry.active)!;
	return {
		revision: "revision-without-secrets",
		activeSlotId: active.id,
		activeSlotName: active.name,
		slots,
	};
}

function auth(headers: CodexQuotaRequestHeaders, cacheIdentity: string): CodexCredentialRequestAuth {
	return { headers, cacheIdentity };
}

function okResult(fetchedAt: string, usedPercent = 20): QuotaProbeResult {
	return {
		state: "ok",
		fetchedAt,
		snapshot: {
			plan: "Plus",
			session: { usedPercent, windowMinutes: 300, resetsAt: "2026-08-17T15:00:00.000Z" },
			weekly: { usedPercent: 40, windowMinutes: 10_080, resetsAt: "2026-08-24T14:30:00.000Z" },
			fetchedAt,
		},
	};
}

function fakeStore(
	currentInspection: CodexCredentialSlotInspection,
	authBySlot: Record<string, CodexCredentialRequestAuth>,
) {
	return {
		inspect: vi.fn(() => currentInspection),
		withRequestAuth: vi.fn(async <T>(slotId: string, fn: (value: CodexCredentialRequestAuth) => Promise<T>) => {
			const value = authBySlot[slotId];
			if (!value) throw new Error("credential is unavailable");
			return fn(value);
		}),
	} as any;
}

describe("CodexSlotUsageClient", () => {
	it("queries every slot, coalesces duplicate accounts, and keeps empty or failed slots visible", async () => {
		const currentInspection = inspection([
			slot("default", "default", true, true),
			slot("work", "work", false, true),
			slot("broken", "broken", false, true),
			slot("empty", "empty", false, false),
		]);
		const store = fakeStore(currentInspection, {
			default: auth(headersA, "hash-a"),
			work: auth(headersA, "hash-a"),
			broken: auth(headersB, "hash-b"),
		});
		const probe = vi.fn(async ({ headers }: { headers: CodexQuotaRequestHeaders; signal?: AbortSignal }) => {
			if (headers["chatgpt-account-id"] === "account-b") {
				return { state: "unavailable", message: "ChatGPT usage is unavailable." } satisfies QuotaProbeResult;
			}
			return okResult("2026-08-17T12:00:00.000Z");
		});
		const client = new CodexSlotUsageClient({ store, probe });

		const result = await client.query({ cache: "bypass" });

		expect(probe).toHaveBeenCalledTimes(2);
		expect(result.anySuccess).toBe(true);
		expect(result.slots.map((entry) => [entry.slot.name, entry.result.state])).toEqual([
			["default", "ok"],
			["work", "ok"],
			["broken", "unavailable"],
			["empty", "auth-required"],
		]);
		expect(JSON.stringify(result)).not.toContain("SECRET_ACCESS");
		expect(JSON.stringify(result)).not.toContain("account-a");
	});

	it("implements prefer, refresh, and bypass cache policies with a stale check", async () => {
		const currentInspection = inspection([slot("default", "default", true, true)]);
		const store = fakeStore(currentInspection, { default: auth(headersA, "hash-a") });
		let now = new Date("2026-08-17T12:00:00.000Z");
		let call = 0;
		const probe = vi.fn(async () => {
			call++;
			return okResult(`2026-08-17T12:0${call}:00.000Z`, call);
		});
		const client = new CodexSlotUsageClient({ store, probe, now: () => now });

		await client.query({ cache: "prefer" });
		await client.query({ cache: "prefer" });
		expect(probe).toHaveBeenCalledOnce();

		await client.query({ cache: "refresh" });
		await client.query({ cache: "bypass" });
		expect(probe).toHaveBeenCalledTimes(3);
		const afterBypass = await client.query({ cache: "prefer" });
		expect(afterBypass.slots[0]?.result).toMatchObject({ state: "ok", snapshot: { session: { usedPercent: 2 } } });
		expect(probe).toHaveBeenCalledTimes(3);

		now = new Date("2026-08-17T12:20:00.000Z");
		await client.query({ cache: "prefer" });
		expect(probe).toHaveBeenCalledTimes(4);
	});

	it("renders an independent named block for each slot without exposing slot IDs or auth data", () => {
		const batch: CodexSlotQuotaBatch = {
			slots: [
				{ slot: slot("default", "default", true, true), result: okResult("2026-08-17T12:00:00.000Z") },
				{ slot: slot("work-id-secret", "work", false, true), result: { state: "auth-required", message: "Select this slot and sign in." } },
				{ slot: slot("empty-id", "empty", false, false), result: { state: "auth-required", message: "This slot is empty." } },
			],
			anySuccess: true,
		};

		const output = formatCodexProbeResults(batch, new Date("2026-08-17T12:00:00.000Z"));
		expect(output).toContain("ChatGPT Codex · Slot: default (active)");
		expect(output).toContain("ChatGPT Codex · Slot: work");
		expect(output).toContain("ChatGPT Codex · Slot: empty");
		expect(output).toContain("5-hour session limit");
		expect(output).not.toContain("work-id-secret");
		expect(output).not.toContain("SECRET_ACCESS");

		const status = formatCodexAuthStatus(inspection(batch.slots.map((entry) => entry.slot)));
		expect(status).toContain("default (active)");
		expect(status).toContain("work (saved)");
		expect(status).toContain("empty (empty)");
		expect(status).not.toContain("work-id-secret");
	});

	it("maps a per-slot auth failure to a safe result while preserving successful slots", async () => {
		const currentInspection = inspection([
			slot("default", "default", true, true),
			slot("failed", "failed", false, true),
		]);
		const store = fakeStore(currentInspection, {
			default: auth(headersA, "hash-a"),
			failed: auth(headersB, "hash-b"),
		});
		store.withRequestAuth.mockImplementation(async (slotId: string, fn: (value: CodexCredentialRequestAuth) => Promise<unknown>) => {
			if (slotId === "failed") throw new Error("refresh token SECRET_REFRESH");
			return fn(auth(headersA, "hash-a"));
		});
		const client = new CodexSlotUsageClient({
			store,
			probe: async () => okResult("2026-08-17T12:00:00.000Z"),
		});

		const result = await client.query({ cache: "bypass" });
		expect(result.anySuccess).toBe(true);
		expect(result.slots[0]?.result.state).toBe("ok");
		expect(result.slots[1]?.result).toMatchObject({ state: "auth-required" });
		expect(JSON.stringify(result)).not.toContain("SECRET_REFRESH");
	});
});
