import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	CodexCredentialSlotError,
	CodexCredentialSlotStore,
	OPENAI_CODEX_PROVIDER_ID,
	SLOT_PROVIDER_PREFIX,
	STATE_PROVIDER_ID,
} from "./credential-slots.ts";

const ACCOUNT_A = {
	type: "oauth" as const,
	access: "access-a",
	refresh: "refresh-a",
	expires: 1_900_000_000_000,
	account: "account-a",
};
const ACCOUNT_B = {
	type: "oauth" as const,
	access: "access-b",
	refresh: "refresh-b",
	expires: 1_900_000_000_000,
	account: "account-b",
};
const ACCOUNT_B_REFRESHED = {
	type: "oauth" as const,
	access: "access-b-refreshed",
	refresh: "refresh-b-refreshed",
	expires: 2_000_000_000_000,
	account: "account-b",
};
const UUID_ONE = "11111111-1111-4111-8111-111111111111";
const UUID_TWO = "22222222-2222-4222-8222-222222222222";

const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function authFile(initial: Record<string, unknown> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "provider-codex-test-"));
	roots.push(root);
	const nested = join(root, "nested");
	mkdirSync(nested);
	const path = join(nested, "auth.json");
	writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
	return path;
}

function readAuth(path: string): Record<string, any> {
	return JSON.parse(readFileSync(path, "utf8"));
}

function stateOf(path: string): { version: number; activeSlotId: string; slots: Array<{ id: string; name: string }> } {
	return JSON.parse(readAuth(path)[STATE_PROVIDER_ID].env.PROVIDER_CODEX_STATE);
}

function replaceCanonical(path: string, credential: unknown): void {
	const auth = readAuth(path);
	if (credential === undefined) delete auth[OPENAI_CODEX_PROVIDER_ID];
	else auth[OPENAI_CODEX_PROVIDER_ID] = credential;
	writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`);
}

function jwtAccess(accountId: string, suffix = "signature"): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
	return `header.${payload}.${suffix}`;
}

function fakeCodexProvider(
	refresh: (credential: any, signal: AbortSignal) => Promise<any> = async (credential) => credential,
): any {
	return {
		id: OPENAI_CODEX_PROVIDER_ID,
		name: "Test Codex",
		auth: {
			oauth: {
				name: "Test Codex OAuth",
				login: async () => ACCOUNT_A,
				refresh,
				toAuth: async (credential: any) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [],
		stream: () => {
			throw new Error("not used");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
}

describe("CodexCredentialSlotStore", () => {
	it("inspects an existing canonical credential without creating extension state", () => {
		const unrelated = { type: "api_key", env: { OTHER: "keep-me" } };
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: ACCOUNT_A, unrelated });
		const before = readFileSync(path, "utf8");
		const store = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_ONE });

		const inspection = store.inspect();

		expect(inspection.activeSlotName).toBe("default");
		expect(inspection.slots).toEqual([
			{ id: "default", name: "default", active: true, hasCredential: true, status: "active" },
		]);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("creates an empty slot, checks out the canonical credential, and switches back", async () => {
		const path = authFile({
			[OPENAI_CODEX_PROVIDER_ID]: ACCOUNT_A,
			otherProvider: { type: "api_key", key: "unrelated" },
		});
		const store = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_ONE });

		const created = await store.createAndSwitch("work");
		let auth = readAuth(path);
		expect(created.activeSlotName).toBe("work");
		expect(created.created).toBe("work");
		expect(auth[OPENAI_CODEX_PROVIDER_ID]).toBeUndefined();
		expect(auth[`${SLOT_PROVIDER_PREFIX}default`]).toEqual(ACCOUNT_A);
		expect(auth.otherProvider).toEqual({ type: "api_key", key: "unrelated" });
		expect(stateOf(path)).toEqual({
			version: 1,
			activeSlotId: UUID_ONE,
			slots: [
				{ id: "default", name: "default" },
				{ id: UUID_ONE, name: "work" },
			],
		});
		expect(store.inspect().slots).toEqual([
			{ id: "default", name: "default", active: false, hasCredential: true, status: "saved" },
			{ id: UUID_ONE, name: "work", active: true, hasCredential: false, status: "active" },
		]);

		// Pi's normal /login writes only the canonical provider entry.
		replaceCanonical(path, ACCOUNT_B);
		const switched = await store.switchTo("DEFAULT");
		auth = readAuth(path);
		expect(switched.activeSlotName).toBe("default");
		expect(auth[OPENAI_CODEX_PROVIDER_ID]).toEqual(ACCOUNT_A);
		expect(auth[`${SLOT_PROVIDER_PREFIX}${UUID_ONE}`]).toEqual(ACCOUNT_B);
		expect(auth[`${SLOT_PROVIDER_PREFIX}default`]).toBeUndefined();

		const back = await store.switchTo("work");
		auth = readAuth(path);
		expect(back.activeSlotName).toBe("work");
		expect(auth[OPENAI_CODEX_PROVIDER_ID]).toEqual(ACCOUNT_B);
		expect(auth[`${SLOT_PROVIDER_PREFIX}${UUID_ONE}`]).toBeUndefined();
		expect(auth[`${SLOT_PROVIDER_PREFIX}default`]).toEqual(ACCOUNT_A);
	});

	it("keeps an active slot empty after logout and carries refreshed credentials on the next switch", async () => {
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: ACCOUNT_A });
		const store = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_ONE });
		await store.createAndSwitch("work");
		replaceCanonical(path, ACCOUNT_B);
		await store.switchTo("default");

		// The default credential is active. Switch to work, then simulate an OAuth refresh.
		await store.switchTo("work");
		replaceCanonical(path, ACCOUNT_B_REFRESHED);
		await store.switchTo("default");

		const auth = readAuth(path);
		expect(auth[OPENAI_CODEX_PROVIDER_ID]).toEqual(ACCOUNT_A);
		expect(auth[`${SLOT_PROVIDER_PREFIX}${UUID_ONE}`]).toEqual(ACCOUNT_B_REFRESHED);
		expect(store.inspect().slots.find((slot) => slot.name === "work")).toMatchObject({ status: "saved", hasCredential: true });

		// Logging out while work is active leaves work empty when it is checked out again.
		await store.switchTo("work");
		replaceCanonical(path, undefined);
		await store.switchTo("default");
		expect(readAuth(path)[`${SLOT_PROVIDER_PREFIX}${UUID_ONE}`]).toBeUndefined();
		expect(readAuth(path)[OPENAI_CODEX_PROVIDER_ID]).toEqual(ACCOUNT_A);
	});

	it("rejects malformed documents and invalid credentials without changing the file", async () => {
		const malformed = authFile();
		writeFileSync(malformed, "{ not json");
		const malformedBefore = readFileSync(malformed, "utf8");
		await expect(new CodexCredentialSlotStore(malformed).createAndSwitch("work")).rejects.toMatchObject({ code: "INVALID_AUTH" });
		expect(readFileSync(malformed, "utf8")).toBe(malformedBefore);

		const invalidCredential = authFile({
			[OPENAI_CODEX_PROVIDER_ID]: { type: "oauth", access: "secret", refresh: "secret", expires: "not-a-number" },
		});
		const invalidBefore = readFileSync(invalidCredential, "utf8");
		await expect(new CodexCredentialSlotStore(invalidCredential).createAndSwitch("work")).rejects.toMatchObject({ code: "INVALID_AUTH" });
		expect(readFileSync(invalidCredential, "utf8")).toBe(invalidBefore);

		const invalidState = authFile({
			[STATE_PROVIDER_ID]: {
				type: "api_key",
				env: { PROVIDER_CODEX_STATE: JSON.stringify({ version: 99, activeSlotId: "default", slots: [] }) },
			},
		});
		const stateBefore = readFileSync(invalidState, "utf8");
		await expect(new CodexCredentialSlotStore(invalidState).switchTo("default")).rejects.toMatchObject({ code: "INVALID_STATE" });
		expect(readFileSync(invalidState, "utf8")).toBe(stateBefore);
	});

	it("leaves the previous auth document intact when the atomic write fails", async () => {
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: ACCOUNT_A, unrelated: { type: "api_key", key: "preserve" } });
		const before = readFileSync(path, "utf8");
		const atomicWriter = vi.fn(async () => {
			throw new Error("simulated write failure");
		});
		const store = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_ONE, atomicWriter });

		await expect(store.createAndSwitch("work")).rejects.toMatchObject({ code: "LOCK_FAILED" });
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(atomicWriter).toHaveBeenCalledOnce();
	});

	it("does not move an API-key canonical entry or overwrite an orphaned slot", async () => {
		const apiKey = authFile({ [OPENAI_CODEX_PROVIDER_ID]: { type: "api_key", key: "not-oauth" } });
		const apiBefore = readFileSync(apiKey, "utf8");
		await expect(new CodexCredentialSlotStore(apiKey).createAndSwitch("work")).rejects.toMatchObject({ code: "NOT_OAUTH" });
		expect(readFileSync(apiKey, "utf8")).toBe(apiBefore);

		const orphan = authFile({
			[OPENAI_CODEX_PROVIDER_ID]: ACCOUNT_A,
			[`${SLOT_PROVIDER_PREFIX}default`]: ACCOUNT_B,
		});
		const orphanBefore = readFileSync(orphan, "utf8");
		await expect(new CodexCredentialSlotStore(orphan).createAndSwitch("work")).rejects.toMatchObject({ code: "ORPHANED_SLOT" });
		expect(readFileSync(orphan, "utf8")).toBe(orphanBefore);
	});

	it("removes only an inactive slot with an expected current revision", async () => {
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: ACCOUNT_A });
		const store = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_ONE });
		await store.createAndSwitch("work");
		replaceCanonical(path, ACCOUNT_B);
		await store.switchTo("default");
		const listed = store.inspect();

		await expect(store.remove("default", listed.revision)).rejects.toMatchObject({ code: "DEFAULT_SLOT" });
		await expect(store.remove("work", listed.revision)).resolves.toMatchObject({ removed: "work", changed: true });
		expect(stateOf(path).slots).toEqual([{ id: "default", name: "default" }]);
		expect(readAuth(path)[OPENAI_CODEX_PROVIDER_ID]).toEqual(ACCOUNT_A);

		const stale = store.inspect().revision;
		replaceCanonical(path, ACCOUNT_B);
		await expect(store.remove("default", stale)).rejects.toMatchObject({ code: "REVISION_MISMATCH" });
	});

	it("validates names, blocks active removal, and leaves failed mutations intact", async () => {
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: ACCOUNT_A });
		const store = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_ONE });
		await expect(store.createAndSwitch("../escape")).rejects.toMatchObject({ code: "INVALID_SLOT_NAME" });
		await store.createAndSwitch("work");
		const before = readFileSync(path, "utf8");
		await expect(store.remove("work", store.inspect().revision)).rejects.toMatchObject({ code: "ACTIVE_SLOT" });
		expect(readFileSync(path, "utf8")).toBe(before);
		await expect(store.switchTo("missing")).rejects.toMatchObject({ code: "SLOT_NOT_FOUND" });
	});

	it("initializes a missing auth file with private permissions", () => {
		const root = mkdtempSync(join(tmpdir(), "provider-codex-missing-"));
		roots.push(root);
		const path = join(root, "agent", "auth.json");
		const store = new CodexCredentialSlotStore(path);
		const inspection = store.inspect();
		expect(inspection.activeSlotName).toBe("default");
		expect(readFileSync(path, "utf8")).toBe("{}");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("is resolved by ModelRuntime after a switch without reloading the session", async () => {
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: ACCOUNT_A });
		const runtime = await ModelRuntime.create({ authPath: path, modelsPath: null, refreshOnCreate: false });
		const store = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_ONE });

		expect((await runtime.getAuth(OPENAI_CODEX_PROVIDER_ID))?.auth.apiKey).toBe(ACCOUNT_A.access);
		await store.createAndSwitch("work");
		expect(await runtime.getAuth(OPENAI_CODEX_PROVIDER_ID)).toBeUndefined();
		await store.switchTo("default");
		expect((await runtime.getAuth(OPENAI_CODEX_PROVIDER_ID))?.auth.apiKey).toBe(ACCOUNT_A.access);
	});

	it("serializes concurrent stores without losing slots or unrelated credentials", async () => {
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: ACCOUNT_A, unrelated: { type: "api_key", key: "preserve" } });
		const first = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_ONE });
		const second = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_TWO });

		await Promise.all([first.createAndSwitch("one"), second.createAndSwitch("two")]);

		const auth = readAuth(path);
		const state = stateOf(path);
		expect(auth.unrelated).toEqual({ type: "api_key", key: "preserve" });
		expect(state.slots.map((slot) => slot.name).sort()).toEqual(["default", "one", "two"]);
		expect(new Set(state.slots.map((slot) => slot.id)).size).toBe(3);
		expect(Object.keys(auth).filter((key) => key.startsWith(SLOT_PROVIDER_PREFIX))).toHaveLength(1);
		expect(auth[`${SLOT_PROVIDER_PREFIX}default`]).toEqual(ACCOUNT_A);
	});

	it("exposes safe errors without including credential values", async () => {
		const secret = "access-token-that-must-not-escape";
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: { ...ACCOUNT_A, access: secret } });
		writeFileSync(path, "[]");
		try {
			await new CodexCredentialSlotStore(path).createAndSwitch("work");
		} catch (error) {
			expect(error).toBeInstanceOf(CodexCredentialSlotError);
			expect(String(error)).not.toContain(secret);
		}
	});

	it("exposes request headers only inside a callback for a fresh active slot", async () => {
		const access = jwtAccess("account-a");
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: { ...ACCOUNT_A, access } });
		const store = new CodexCredentialSlotStore({ authPath: path });
		const before = readFileSync(path, "utf8");

		const identity = await store.withRequestAuth("default", async (auth) => {
			expect(auth.headers).toEqual({ Authorization: `Bearer ${access}`, "chatgpt-account-id": "account-a" });
			expect(auth.cacheIdentity).toBe(createHash("sha256").update("account-a").digest("hex"));
			return auth.cacheIdentity;
		});

		expect(identity).toBe(createHash("sha256").update("account-a").digest("hex"));
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readAuth(path)[`${SLOT_PROVIDER_PREFIX}default`]).toBeUndefined();
	});

	it("refreshes an expired active slot through Pi OAuth and persists only the refreshed credential", async () => {
		const access = jwtAccess("account-a", "old");
		const refreshedAccess = jwtAccess("account-a", "refreshed");
		const refreshed = { ...ACCOUNT_A, access: refreshedAccess, refresh: "refresh-a-new", expires: Date.now() + 60 * 60 * 1000 };
		const refresh = vi.fn(async () => refreshed);
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: { ...ACCOUNT_A, access, expires: Date.now() - 1 } });
		const store = new CodexCredentialSlotStore({ authPath: path, provider: fakeCodexProvider(refresh) });

		await store.withRequestAuth("default", async (auth) => {
			expect(auth.headers.Authorization).toBe(`Bearer ${refreshedAccess}`);
		});

		expect(refresh).toHaveBeenCalledOnce();
		expect(readAuth(path)[OPENAI_CODEX_PROVIDER_ID]).toEqual(refreshed);
	});

	it("resolves a fresh inactive slot without changing the active slot", async () => {
		const access = jwtAccess("account-b", "fresh");
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: { ...ACCOUNT_A, access: jwtAccess("account-a") } });
		const store = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_ONE, provider: fakeCodexProvider() });
		await store.createAndSwitch("work");
		replaceCanonical(path, { ...ACCOUNT_B, access, expires: Date.now() + 60 * 60 * 1000 });
		await store.switchTo("default");
		const work = store.inspect().slots.find((slot) => slot.name === "work")!;
		const before = readFileSync(path, "utf8");

		await store.withRequestAuth(work.id, async (auth) => {
			expect(auth.headers).toEqual({ Authorization: `Bearer ${access}`, "chatgpt-account-id": "account-b" });
		});

		expect(readFileSync(path, "utf8")).toBe(before);
		expect(store.inspect().activeSlotName).toBe("default");
	});

	it("refreshes an expired inactive slot without changing the active slot", async () => {
		const access = jwtAccess("account-b", "old");
		const refreshedAccess = jwtAccess("account-b", "refreshed");
		const refreshed = { ...ACCOUNT_B, access: refreshedAccess, refresh: "refresh-b-new", expires: Date.now() + 60 * 60 * 1000 };
		const refresh = vi.fn(async () => refreshed);
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: { ...ACCOUNT_A, access: jwtAccess("account-a") } });
		const store = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_ONE, provider: fakeCodexProvider(refresh) });
		await store.createAndSwitch("work");
		replaceCanonical(path, { ...ACCOUNT_B, access, expires: Date.now() - 1 });
		await store.switchTo("default");
		const work = store.inspect().slots.find((slot) => slot.name === "work")!;
		const beforeActive = readAuth(path)[OPENAI_CODEX_PROVIDER_ID];

		await store.withRequestAuth(work.id, async (auth) => {
			expect(auth.headers.Authorization).toBe(`Bearer ${refreshedAccess}`);
		});

		expect(refresh).toHaveBeenCalledOnce();
		expect(readAuth(path)[OPENAI_CODEX_PROVIDER_ID]).toEqual(beforeActive);
		expect(readAuth(path)[`${SLOT_PROVIDER_PREFIX}${work.id}`]).toEqual(refreshed);
		expect(store.inspect().activeSlotName).toBe("default");
	});

	it("holds the logical-slot lock across refresh so a concurrent switch moves the refreshed credential correctly", async () => {
		const started = vi.fn();
		let releaseRefresh!: () => void;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const refreshed = { ...ACCOUNT_B, access: jwtAccess("account-b", "refreshed"), refresh: "refresh-b-new", expires: Date.now() + 60 * 60 * 1000 };
		const refresh = vi.fn(async (_credential: any, signal: AbortSignal) => {
			started();
			await Promise.race([refreshGate, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
			return refreshed;
		});
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: { ...ACCOUNT_A, access: jwtAccess("account-a") } });
		const store = new CodexCredentialSlotStore({ authPath: path, idSource: () => UUID_ONE, provider: fakeCodexProvider(refresh) });
		await store.createAndSwitch("work");
		replaceCanonical(path, { ...ACCOUNT_B, access: jwtAccess("account-b", "old"), expires: Date.now() - 1 });
		await store.switchTo("default");
		const work = store.inspect().slots.find((slot) => slot.name === "work")!;

		const usage = store.withRequestAuth(work.id, async () => "resolved");
		await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
		const switching = store.switchTo("work");
		releaseRefresh();
		await expect(usage).resolves.toBe("resolved");
		await switching;

		const auth = readAuth(path);
		expect(stateOf(path).activeSlotId).toBe(work.id);
		expect(auth[OPENAI_CODEX_PROVIDER_ID]).toEqual(refreshed);
		expect(auth[`${SLOT_PROVIDER_PREFIX}${work.id}`]).toBeUndefined();
	});

	it("keeps empty, invalid, and failed credentials visible as safe auth errors", async () => {
		const path = authFile({ [OPENAI_CODEX_PROVIDER_ID]: { ...ACCOUNT_A, access: "not-a-jwt" } });
		const store = new CodexCredentialSlotStore({ authPath: path, provider: fakeCodexProvider() });
		await expect(store.withRequestAuth("default", async () => undefined)).rejects.toMatchObject({ code: "AUTH_UNAVAILABLE" });

		const emptyPath = authFile({});
		const emptyStore = new CodexCredentialSlotStore({ authPath: emptyPath, provider: fakeCodexProvider() });
		await expect(emptyStore.withRequestAuth("default", async () => undefined)).rejects.toMatchObject({ code: "AUTH_UNAVAILABLE" });

		const secret = "refresh-secret-that-must-not-escape";
		const failedPath = authFile({
			[OPENAI_CODEX_PROVIDER_ID]: { ...ACCOUNT_A, access: jwtAccess("account-a"), expires: Date.now() - 1 },
		});
		const failedStore = new CodexCredentialSlotStore({
			authPath: failedPath,
			provider: fakeCodexProvider(async () => {
				throw new Error(secret);
			}),
		});
		try {
			await failedStore.withRequestAuth("default", async () => undefined);
			throw new Error("expected refresh failure");
		} catch (error) {
			expect(error).toMatchObject({ code: "AUTH_REFRESH_FAILED" });
			expect(String(error)).not.toContain(secret);
		}
	});

	it("propagates cancellation while native OAuth refresh is pending", async () => {
		let resolveRefreshStarted!: () => void;
		const refreshStarted = new Promise<void>((resolve) => {
			resolveRefreshStarted = resolve;
		});
		const refresh = vi.fn(async (_credential: any, signal: AbortSignal) => {
			resolveRefreshStarted();
			await new Promise<never>((_, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
			return ACCOUNT_A;
		});
		const path = authFile({
			[OPENAI_CODEX_PROVIDER_ID]: { ...ACCOUNT_A, access: jwtAccess("account-a"), expires: Date.now() - 1 },
		});
		const store = new CodexCredentialSlotStore({ authPath: path, provider: fakeCodexProvider(refresh) });
		const controller = new AbortController();
		const pending = store.withRequestAuth("default", async () => undefined, { signal: controller.signal });
		await refreshStarted;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});
});
