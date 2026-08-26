import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open, rename, rm, chmod, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createModels, type Credential, type CredentialStore, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const STATE_PROVIDER_ID = "provider-codex/state";
export const SLOT_PROVIDER_PREFIX = "provider-codex/slot/";

const STATE_ENV_NAME = "PROVIDER_CODEX_STATE";
const DEFAULT_SLOT_ID = "default";
const DEFAULT_SLOT_NAME = "default";
const STATE_VERSION = 1;
const SLOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SLOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOCK_STALE_MS = 30_000;

type OAuthCredential = Extract<Credential, { type: "oauth" }>;
type AuthDocument = Record<string, Credential>;

interface ProperLockfileRetryOptions {
	retries: number;
	factor: number;
	minTimeout: number;
	maxTimeout: number;
}

interface ProperLockfileModule {
	lock(
		file: string,
		options: {
			realpath: false;
			stale: number;
			update: number;
			retries: ProperLockfileRetryOptions;
			onCompromised: (error: unknown) => void;
		},
	): Promise<() => Promise<void>>;
}

// proper-lockfile is CommonJS and the package does not ship declarations. Keep
// that untyped edge here so the store itself has a typed locking interface.
const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as ProperLockfileModule;

export type CodexCredentialSlotStatus = "active" | "saved" | "empty";

export interface CodexCredentialSlotInfo {
	id: string;
	name: string;
	active: boolean;
	hasCredential: boolean;
	status: CodexCredentialSlotStatus;
}

export interface CodexCredentialRequestAuth {
	readonly headers: Readonly<{
		Authorization: string;
		"chatgpt-account-id": string;
	}>;
	readonly cacheIdentity: string;
}

export interface CodexCredentialSlotInspection {
	revision: string;
	activeSlotId: string;
	activeSlotName: string;
	slots: readonly CodexCredentialSlotInfo[];
}

export interface CodexCredentialSlotMutation extends CodexCredentialSlotInspection {
	changed: boolean;
	created?: string;
	removed?: string;
}

type AtomicWriter = (authPath: string, contents: string) => Promise<void>;

export interface CodexCredentialSlotStoreOptions {
	authPath?: string;
	idSource?: () => string;
	/** @internal Test seam for verifying failed writes leave auth.json unchanged. */
	atomicWriter?: AtomicWriter;
	/** @internal Test seam for exercising slot resolution without network OAuth. */
	provider?: Provider;
}

export type CodexCredentialSlotErrorCode =
	| "INVALID_AUTH"
	| "INVALID_STATE"
	| "INVALID_SLOT_NAME"
	| "INVALID_SLOT_ID"
	| "SLOT_EXISTS"
	| "SLOT_NOT_FOUND"
	| "DEFAULT_SLOT"
	| "ACTIVE_SLOT"
	| "REVISION_MISMATCH"
	| "ORPHANED_SLOT"
	| "NOT_OAUTH"
	| "AUTH_REFRESH_FAILED"
	| "AUTH_UNAVAILABLE"
	| "LOCK_FAILED";

export class CodexCredentialSlotError extends Error {
	readonly code: CodexCredentialSlotErrorCode;

	constructor(code: CodexCredentialSlotErrorCode, message: string) {
		super(message);
		this.name = "CodexCredentialSlotError";
		this.code = code;
	}
}

interface SlotMetadata {
	id: string;
	name: string;
}

interface SlotState {
	version: 1;
	activeSlotId: string;
	slots: SlotMetadata[];
}

interface AuthSnapshot {
	raw: string;
	revision: string;
	data: AuthDocument;
	state: SlotState | undefined;
}

interface MutationPlan {
	data: AuthDocument;
	changed: boolean;
	created?: string;
	removed?: string;
}

interface LockedDocumentPlan<T> {
	data: AuthDocument;
	changed: boolean;
	value: T;
}

interface LockedDocumentResult<T> {
	data: AuthDocument;
	raw: string;
	value: T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidAuth(providerId: string): CodexCredentialSlotError {
	return new CodexCredentialSlotError(
		"INVALID_AUTH",
		`Auth file contains an invalid credential for provider "${providerId}".`,
	);
}

function invalidState(): CodexCredentialSlotError {
	return new CodexCredentialSlotError("INVALID_STATE", "Codex credential slot state is invalid.");
}

function validateCredential(value: unknown, providerId: string): Credential {
	if (!isRecord(value)) throw invalidAuth(providerId);

	if (value.type === "api_key") {
		if (value.key !== undefined && typeof value.key !== "string") throw invalidAuth(providerId);
		if (value.env !== undefined) {
			if (!isRecord(value.env) || !Object.values(value.env).every((entry) => typeof entry === "string")) {
				throw invalidAuth(providerId);
			}
		}
		return value as unknown as Credential;
	}

	if (
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	) {
		return value as unknown as Credential;
	}

	throw invalidAuth(providerId);
}

function parseAuthDocument(raw: string): AuthDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CodexCredentialSlotError("INVALID_AUTH", "Auth file is not valid JSON.");
	}
	if (!isRecord(parsed)) throw new CodexCredentialSlotError("INVALID_AUTH", "Auth file must contain an object.");

	const data: AuthDocument = {};
	for (const [providerId, value] of Object.entries(parsed)) {
		data[providerId] = validateCredential(value, providerId);
	}
	return data;
}

function validateSlotName(name: string): void {
	if (!SLOT_NAME_RE.test(name)) {
		throw new CodexCredentialSlotError(
			"INVALID_SLOT_NAME",
			"Codex slot names must be 1-64 characters using letters, numbers, dots, underscores, or hyphens, and must start with a letter or number.",
		);
	}
}

function validateSlotId(id: string): void {
	if (id !== DEFAULT_SLOT_ID && !SLOT_ID_RE.test(id)) {
		throw new CodexCredentialSlotError("INVALID_SLOT_ID", "Codex credential slot state contains an invalid slot ID.");
	}
}

function slotProviderId(id: string): string {
	return `${SLOT_PROVIDER_PREFIX}${id}`;
}

function stateCredential(state: SlotState): Credential {
	return {
		type: "api_key",
		env: { [STATE_ENV_NAME]: JSON.stringify(state) },
	};
}

function virtualState(): SlotState {
	return {
		version: STATE_VERSION,
		activeSlotId: DEFAULT_SLOT_ID,
		slots: [{ id: DEFAULT_SLOT_ID, name: DEFAULT_SLOT_NAME }],
	};
}

function effectiveState(state: SlotState | undefined): SlotState {
	return state ?? virtualState();
}

function slotMetadata(state: SlotState | undefined, slotId: string): SlotMetadata {
	const slot = effectiveState(state).slots.find((entry) => entry.id.toLowerCase() === slotId.toLowerCase());
	if (!slot) throw new CodexCredentialSlotError("SLOT_NOT_FOUND", "Codex credential slot was not found.");
	return slot;
}

function slotCredentialProviderId(state: SlotState | undefined, slotId: string): string {
	const effective = effectiveState(state);
	const slot = slotMetadata(effective, slotId);
	return slot.id === effective.activeSlotId ? OPENAI_CODEX_PROVIDER_ID : slotProviderId(slot.id);
}

function credentialForSlot(data: AuthDocument, state: SlotState | undefined, slotId: string): Credential | undefined {
	return data[slotCredentialProviderId(state, slotId)];
}

function setCredentialForSlot(
	data: AuthDocument,
	state: SlotState | undefined,
	slotId: string,
	credential: Credential,
): void {
	const effective = effectiveState(state);
	const slot = slotMetadata(effective, slotId);
	const providerId = slot.id === effective.activeSlotId ? OPENAI_CODEX_PROVIDER_ID : slotProviderId(slot.id);
	data[providerId] = credential;
	if (providerId === OPENAI_CODEX_PROVIDER_ID) delete data[slotProviderId(slot.id)];
}

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

function accountIdFromAccessToken(accessToken: string): string | undefined {
	const payload = accessToken.split(".")[1];
	if (!payload) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		const auth = isRecord(decoded) ? decoded[JWT_CLAIM_PATH] : undefined;
		const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function cacheIdentityForAccount(accountId: string): string {
	return createHash("sha256").update(accountId, "utf8").digest("hex");
}

function nativeCodexProvider(): Provider {
	const provider = builtinProviders().find((entry) => entry.id === OPENAI_CODEX_PROVIDER_ID);
	if (!provider) throw new CodexCredentialSlotError("AUTH_REFRESH_FAILED", "Pi's native Codex provider is unavailable.");
	return provider;
}

function parseStateCredential(credential: Credential | undefined): SlotState | undefined {
	if (credential === undefined) return undefined;
	if (credential.type !== "api_key" || credential.key !== undefined || !credential.env) throw invalidState();
	const envKeys = Object.keys(credential.env);
	if (envKeys.length !== 1 || credential.env[STATE_ENV_NAME] === undefined) throw invalidState();

	let parsed: unknown;
	try {
		parsed = JSON.parse(credential.env[STATE_ENV_NAME]);
	} catch {
		throw invalidState();
	}
	if (!isRecord(parsed) || parsed.version !== STATE_VERSION || typeof parsed.activeSlotId !== "string" || !Array.isArray(parsed.slots)) {
		throw invalidState();
	}
	if (Object.keys(parsed).some((key) => !["version", "activeSlotId", "slots"].includes(key))) throw invalidState();

	const slots: SlotMetadata[] = [];
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const value of parsed.slots) {
		if (!isRecord(value) || Object.keys(value).some((key) => key !== "id" && key !== "name")) throw invalidState();
		if (typeof value.id !== "string" || typeof value.name !== "string") throw invalidState();
		validateSlotId(value.id);
		try {
			validateSlotName(value.name);
		} catch {
			throw invalidState();
		}
		const idKey = value.id.toLowerCase();
		const nameKey = value.name.toLowerCase();
		if (ids.has(idKey) || names.has(nameKey)) throw invalidState();
		ids.add(idKey);
		names.add(nameKey);
		slots.push({ id: value.id, name: value.name });
	}

	const defaultSlot = slots.find((slot) => slot.id === DEFAULT_SLOT_ID);
	if (!defaultSlot || defaultSlot.name !== DEFAULT_SLOT_NAME) throw invalidState();
	if (!slots.some((slot) => slot.id === parsed.activeSlotId)) throw invalidState();

	return { version: STATE_VERSION, activeSlotId: parsed.activeSlotId, slots };
}

function validateManagedSlotCredentials(data: AuthDocument, state: SlotState | undefined): void {
	if (!state) return;
	for (const slot of state.slots) {
		const credential = data[slotProviderId(slot.id)];
		if (credential === undefined) continue;
		if (slot.id === state.activeSlotId) throw invalidState();
		if (credential.type !== "oauth") throw invalidAuth(slotProviderId(slot.id));
	}
}

function readSnapshot(authPath: string): AuthSnapshot {
	let raw: string;
	try {
		raw = readFileSync(authPath, "utf8");
	} catch (error) {
		throw new CodexCredentialSlotError(
			"INVALID_AUTH",
			error instanceof Error ? "Could not read auth.json." : "Could not read auth.json.",
		);
	}
	const data = parseAuthDocument(raw);
	const state = parseStateCredential(data[STATE_PROVIDER_ID]);
	validateManagedSlotCredentials(data, state);
	return { raw, revision: revisionOf(raw), data, state };
}

function revisionOf(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}

function findSlot(state: SlotState, name: string): SlotMetadata | undefined {
	const wanted = name.toLowerCase();
	return state.slots.find((slot) => slot.name.toLowerCase() === wanted);
}

function copyDocument(data: AuthDocument): AuthDocument {
	return { ...data };
}

function inspectionFrom(data: AuthDocument, state: SlotState | undefined, raw: string): CodexCredentialSlotInspection {
	const effectiveState = state ?? virtualState();
	const active = effectiveState.slots.find((slot) => slot.id === effectiveState.activeSlotId);
	if (!active) throw invalidState();

	const slots = effectiveState.slots.map((slot): CodexCredentialSlotInfo => {
		const isActive = slot.id === effectiveState.activeSlotId;
		const hasCredential = isActive
			? data[OPENAI_CODEX_PROVIDER_ID] !== undefined
			: data[slotProviderId(slot.id)] !== undefined;
		return {
			id: slot.id,
			name: slot.name,
			active: isActive,
			hasCredential,
			status: isActive ? "active" : hasCredential ? "saved" : "empty",
		};
	});
	return {
		revision: revisionOf(raw),
		activeSlotId: effectiveState.activeSlotId,
		activeSlotName: active.name,
		slots,
	};
}

function serializeDocument(data: AuthDocument): string {
	return `${JSON.stringify(data, null, 2)}\n`;
}

function assertMovableCredential(credential: Credential | undefined): asserts credential is OAuthCredential | undefined {
	if (credential !== undefined && credential.type !== "oauth") {
		throw new CodexCredentialSlotError(
			"NOT_OAUTH",
			"The active openai-codex credential is not a valid OAuth credential.",
		);
	}
}

async function ensureAuthFile(authPath: string): Promise<void> {
	await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
	try {
		await writeFile(authPath, "{}", { encoding: "utf8", mode: 0o600, flag: "wx" });
		await chmod(authPath, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		await chmod(authPath, 0o600);
	}
}

function ensureAuthFileSync(authPath: string): void {
	mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(authPath, "{}", { encoding: "utf8", mode: 0o600, flag: "wx" });
		chmodSync(authPath, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		chmodSync(authPath, 0o600);
	}
}

async function writeAtomic(authPath: string, contents: string): Promise<void> {
	const temporaryPath = join(
		dirname(authPath),
		`.${authPath.split(/[\\/]/u).pop() ?? "auth.json"}.${process.pid}.${randomUUID()}.tmp`,
	);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(contents, { encoding: "utf8" });
		await handle.chmod(0o600);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, authPath);
	} finally {
		if (handle) await handle.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

export class CodexCredentialSlotStore {
	readonly authPath: string;
	private readonly idSource: () => string;
	private readonly atomicWriter: AtomicWriter;
	private readonly provider: Provider;

	constructor(options?: CodexCredentialSlotStoreOptions | string) {
		const normalized = typeof options === "string" ? { authPath: options } : options;
		this.authPath = resolve(normalized?.authPath ?? join(getAgentDir(), "auth.json"));
		this.idSource = normalized?.idSource ?? randomUUID;
		this.atomicWriter = normalized?.atomicWriter ?? writeAtomic;
		this.provider = normalized?.provider ?? nativeCodexProvider();
	}

	inspect(): CodexCredentialSlotInspection {
		ensureAuthFileSync(this.authPath);
		return inspectionFromSnapshot(readSnapshot(this.authPath));
	}

	/**
	 * Resolves one logical slot through Pi's native Codex OAuth implementation.
	 * The callback is the only place where request headers are available; the
	 * active slot is never changed by this operation.
	 */
	async withRequestAuth<T>(
		slotId: string,
		fn: (auth: CodexCredentialRequestAuth) => Promise<T>,
		options: { signal?: AbortSignal } = {},
	): Promise<T> {
		options.signal?.throwIfAborted();
		validateSlotId(slotId);
		const inspection = this.inspect();
		const slot = inspection.slots.find((entry) => entry.id.toLowerCase() === slotId.toLowerCase());
		if (!slot) throw new CodexCredentialSlotError("SLOT_NOT_FOUND", "Codex credential slot was not found.");
		if (!slot.hasCredential) {
			throw new CodexCredentialSlotError(
				"AUTH_UNAVAILABLE",
				"Codex credential slot does not contain a usable OAuth credential.",
			);
		}

		options.signal?.throwIfAborted();
		const models = createModels({ credentials: this.slotCredentialStore(slot.id) });
		models.setProvider(this.provider);
		let resolved: Awaited<ReturnType<typeof models.getAuth>>;
		try {
			resolved = await models.getAuth(OPENAI_CODEX_PROVIDER_ID, { signal: options.signal });
		} catch (error) {
			options.signal?.throwIfAborted();
			if (error instanceof CodexCredentialSlotError) throw error;
			throw new CodexCredentialSlotError(
				"AUTH_REFRESH_FAILED",
				"Could not refresh the Codex credential for this slot.",
			);
		}
		options.signal?.throwIfAborted();

		const accessToken = resolved?.auth.apiKey;
		const accountId = typeof accessToken === "string" ? accountIdFromAccessToken(accessToken) : undefined;
		if (!accessToken || !accountId) {
			throw new CodexCredentialSlotError(
				"AUTH_UNAVAILABLE",
				"Codex credential slot does not contain a usable OAuth credential.",
			);
		}

		const auth: CodexCredentialRequestAuth = {
			headers: Object.freeze({
				Authorization: `Bearer ${accessToken}`,
				"chatgpt-account-id": accountId,
			}),
			cacheIdentity: cacheIdentityForAccount(accountId),
		};
		const result = await fn(auth);
		options.signal?.throwIfAborted();
		return result;
	}

	private readSlotCredential(slotId: string): Credential | undefined {
		ensureAuthFileSync(this.authPath);
		const snapshot = readSnapshot(this.authPath);
		return credentialForSlot(snapshot.data, snapshot.state, slotId);
	}

	private slotCredentialStore(slotId: string): CredentialStore {
		return {
			read: async (providerId, options) => {
				options?.signal?.throwIfAborted();
				if (providerId !== OPENAI_CODEX_PROVIDER_ID) return undefined;
				const credential = this.readSlotCredential(slotId);
				options?.signal?.throwIfAborted();
				return credential ? structuredClone(credential) : undefined;
			},
			list: async (options) => {
				options?.signal?.throwIfAborted();
				const credential = this.readSlotCredential(slotId);
				options?.signal?.throwIfAborted();
				return credential
					? [{ providerId: OPENAI_CODEX_PROVIDER_ID, type: credential.type }]
					: [];
			},
			modify: async (providerId, fn, options) => {
				if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
					throw new CodexCredentialSlotError("INVALID_AUTH", "Codex usage requested an unknown provider.");
				}
				options?.signal?.throwIfAborted();
				const committed = await this.withLockedDocument(async (snapshot) => {
					const current = credentialForSlot(snapshot.data, snapshot.state, slotId);
					let next: Credential | undefined;
					try {
						next = await fn(current ? structuredClone(current) : undefined);
					} catch {
						options?.signal?.throwIfAborted();
						throw new CodexCredentialSlotError(
							"AUTH_REFRESH_FAILED",
							"Could not refresh the Codex credential for this slot.",
						);
					}
					if (next === undefined) return { data: snapshot.data, changed: false, value: current };
					const credential = validateCredential(next, providerId);
					if (credential.type !== "oauth") {
						throw new CodexCredentialSlotError(
							"AUTH_REFRESH_FAILED",
							"Could not refresh the Codex credential for this slot.",
						);
					}
					const data = copyDocument(snapshot.data);
					setCredentialForSlot(data, snapshot.state, slotId, credential);
					return { data, changed: true, value: credential };
				}, options);
				return committed.value;
			},
			delete: async () => {
				throw new CodexCredentialSlotError("LOCK_FAILED", "Codex usage authentication cannot delete credentials.");
			},
		};
	}

	async createAndSwitch(name: string): Promise<CodexCredentialSlotMutation> {
		validateSlotName(name);
		return this.withLockedMutation((snapshot) => {
			const state = snapshot.state ?? virtualState();
			if (findSlot(state, name)) {
				throw new CodexCredentialSlotError("SLOT_EXISTS", `Codex credential slot "${name}" already exists.`);
			}

			const canonical = snapshot.data[OPENAI_CODEX_PROVIDER_ID];
			assertMovableCredential(canonical);
			const oldSlotProvider = slotProviderId(state.activeSlotId);
			if (canonical !== undefined && snapshot.data[oldSlotProvider] !== undefined) {
				throw new CodexCredentialSlotError(
					"ORPHANED_SLOT",
					"The active Codex slot already has saved credential data. Refusing to overwrite it.",
				);
			}

			const id = this.newSlotId(snapshot.data, state);
			const data = copyDocument(snapshot.data);
			if (canonical !== undefined) data[oldSlotProvider] = canonical;
			delete data[OPENAI_CODEX_PROVIDER_ID];
			const nextState: SlotState = {
				version: STATE_VERSION,
				activeSlotId: id,
				slots: [...state.slots, { id, name }],
			};
			data[STATE_PROVIDER_ID] = stateCredential(nextState);
			return { data, changed: true, created: name };
		});
	}

	async switchTo(name: string): Promise<CodexCredentialSlotMutation> {
		validateSlotName(name);
		return this.withLockedMutation((snapshot) => {
			const state = snapshot.state;
			if (!state) {
				if (name.toLowerCase() === DEFAULT_SLOT_NAME) return { data: snapshot.data, changed: false };
				throw new CodexCredentialSlotError("SLOT_NOT_FOUND", `Codex credential slot "${name}" does not exist.`);
			}

			const target = findSlot(state, name);
			if (!target) throw new CodexCredentialSlotError("SLOT_NOT_FOUND", `Codex credential slot "${name}" does not exist.`);
			if (target.id === state.activeSlotId) return { data: snapshot.data, changed: false };

			const canonical = snapshot.data[OPENAI_CODEX_PROVIDER_ID];
			assertMovableCredential(canonical);
			const targetProvider = slotProviderId(target.id);
			const targetCredential = snapshot.data[targetProvider];
			if (targetCredential !== undefined && targetCredential.type !== "oauth") {
				throw new CodexCredentialSlotError("INVALID_AUTH", "The selected Codex slot contains an invalid OAuth credential.");
			}

			const data = copyDocument(snapshot.data);
			const oldSlotProvider = slotProviderId(state.activeSlotId);
			if (canonical !== undefined) data[oldSlotProvider] = canonical;
			else delete data[oldSlotProvider];
			if (targetCredential !== undefined) data[OPENAI_CODEX_PROVIDER_ID] = targetCredential;
			else delete data[OPENAI_CODEX_PROVIDER_ID];
			delete data[targetProvider];
			data[STATE_PROVIDER_ID] = stateCredential({
				version: STATE_VERSION,
				activeSlotId: target.id,
				slots: state.slots,
			});
			return { data, changed: true };
		});
	}

	async remove(name: string, expectedRevision: string): Promise<CodexCredentialSlotMutation> {
		validateSlotName(name);
		return this.withLockedMutation((snapshot) => {
			if (snapshot.revision !== expectedRevision) {
				throw new CodexCredentialSlotError(
					"REVISION_MISMATCH",
					"Codex credential slots changed since they were listed. List them again and retry.",
				);
			}
			if (name.toLowerCase() === DEFAULT_SLOT_NAME) {
				throw new CodexCredentialSlotError("DEFAULT_SLOT", "The default Codex credential slot cannot be removed.");
			}
			const state = snapshot.state;
			if (!state) throw new CodexCredentialSlotError("SLOT_NOT_FOUND", `Codex credential slot "${name}" does not exist.`);
			const target = findSlot(state, name);
			if (!target) throw new CodexCredentialSlotError("SLOT_NOT_FOUND", `Codex credential slot "${name}" does not exist.`);
			if (target.id === state.activeSlotId) {
				throw new CodexCredentialSlotError("ACTIVE_SLOT", "The active Codex credential slot cannot be removed.");
			}

			const data = copyDocument(snapshot.data);
			delete data[slotProviderId(target.id)];
			data[STATE_PROVIDER_ID] = stateCredential({
				version: STATE_VERSION,
				activeSlotId: state.activeSlotId,
				slots: state.slots.filter((slot) => slot.id !== target.id),
			});
			return { data, changed: true, removed: target.name };
		});
	}

	private newSlotId(data: AuthDocument, state: SlotState): string {
		for (let attempt = 0; attempt < 20; attempt++) {
			const id = this.idSource();
			if (!SLOT_ID_RE.test(id)) continue;
			if (state.slots.some((slot) => slot.id.toLowerCase() === id.toLowerCase())) continue;
			if (data[slotProviderId(id)] !== undefined) continue;
			return id;
		}
		throw new CodexCredentialSlotError("INVALID_SLOT_ID", "Could not allocate a unique Codex credential slot ID.");
	}

	private async withLockedDocument<T>(
		plan: (snapshot: AuthSnapshot) => LockedDocumentPlan<T> | Promise<LockedDocumentPlan<T>>,
		options: { signal?: AbortSignal } = {},
	): Promise<LockedDocumentResult<T>> {
		options.signal?.throwIfAborted();
		await ensureAuthFile(this.authPath);
		let release: (() => Promise<void>) | undefined;
		let compromised: Error | undefined;
		try {
			release = await lockfile.lock(this.authPath, {
				realpath: false,
				stale: LOCK_STALE_MS,
				update: LOCK_STALE_MS / 2,
				retries: { retries: 20, factor: 1.5, minTimeout: 20, maxTimeout: 500 },
				onCompromised: (error) => {
					compromised = error instanceof Error ? error : new Error("Auth file lock was compromised.");
				},
			});
			const acquiredCompromise = compromised;
			if (acquiredCompromise) throw new CodexCredentialSlotError("LOCK_FAILED", acquiredCompromise.message);

			options.signal?.throwIfAborted();
			const snapshot = readSnapshot(this.authPath);
			const outcome = await plan(snapshot);
			options.signal?.throwIfAborted();
			const plannedCompromise = compromised;
			if (plannedCompromise) throw new CodexCredentialSlotError("LOCK_FAILED", plannedCompromise.message);
			const state = parseStateCredential(outcome.data[STATE_PROVIDER_ID]);
			validateManagedSlotCredentials(outcome.data, state);
			const raw = outcome.changed ? serializeDocument(outcome.data) : snapshot.raw;
			const beforeWriteCompromise = compromised;
			if (beforeWriteCompromise) throw new CodexCredentialSlotError("LOCK_FAILED", beforeWriteCompromise.message);
			if (outcome.changed) await this.atomicWriter(this.authPath, raw);
			options.signal?.throwIfAborted();
			const writtenCompromise = compromised;
			if (writtenCompromise) throw new CodexCredentialSlotError("LOCK_FAILED", writtenCompromise.message);
			return { data: outcome.data, raw, value: outcome.value };
		} catch (error) {
			options.signal?.throwIfAborted();
			if (error instanceof CodexCredentialSlotError) throw error;
			throw new CodexCredentialSlotError("LOCK_FAILED", "Could not update Codex credential slots.");
		} finally {
			if (release) await release().catch(() => undefined);
		}
	}

	private async withLockedMutation(
		plan: (snapshot: AuthSnapshot) => MutationPlan,
	): Promise<CodexCredentialSlotMutation> {
		const committed = await this.withLockedDocument((snapshot) => {
			const outcome = plan(snapshot);
			return { data: outcome.data, changed: outcome.changed, value: outcome };
		});
		const state = parseStateCredential(committed.data[STATE_PROVIDER_ID]);
		const inspection = inspectionFrom(committed.data, state, committed.raw);
		return {
			...inspection,
			changed: committed.value.changed,
			created: committed.value.created,
			removed: committed.value.removed,
		};
	}
}

function inspectionFromSnapshot(snapshot: AuthSnapshot): CodexCredentialSlotInspection {
	return inspectionFrom(snapshot.data, snapshot.state, snapshot.raw);
}
