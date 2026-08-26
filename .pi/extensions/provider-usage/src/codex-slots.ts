import {
	CodexCredentialSlotError,
	CodexCredentialSlotStore,
	type CodexCredentialRequestAuth,
	type CodexCredentialSlotInfo,
	type CodexCredentialSlotInspection,
} from "../../provider-codex/credential-slots.ts";
import { formatQuotaText } from "./render.ts";
import { isStale } from "./probe.ts";
import { probeQuota, type CodexQuotaRequestHeaders } from "./quota-client.ts";
import type { QuotaProbeResult } from "./types.ts";

export type CodexCachePolicy = "prefer" | "refresh" | "bypass";

export interface CodexSlotQuotaResult {
	readonly slot: CodexCredentialSlotInfo;
	readonly result: QuotaProbeResult;
}

export interface CodexSlotQuotaBatch {
	readonly slots: readonly CodexSlotQuotaResult[];
	readonly anySuccess: boolean;
}

export interface CodexSlotQueryOptions {
	cache?: CodexCachePolicy;
	signal?: AbortSignal;
}

export interface CodexSlotUsageClientLike {
	inspect(): CodexCredentialSlotInspection;
	query(options?: CodexSlotQueryOptions): Promise<CodexSlotQuotaBatch>;
}

type SlotStore = Pick<CodexCredentialSlotStore, "inspect" | "withRequestAuth">;
type Probe = (options: {
	headers: CodexQuotaRequestHeaders;
	signal?: AbortSignal;
}) => Promise<QuotaProbeResult>;

export interface CodexSlotUsageClientOptions {
	store?: SlotStore;
	probe?: Probe;
	now?: () => Date;
}

function slotStatusLabel(slot: CodexCredentialSlotInfo): string {
	if (slot.active) return slot.hasCredential ? "active" : "active, empty";
	return slot.hasCredential ? "saved" : "empty";
}

function slotLabel(slot: CodexCredentialSlotInfo): string {
	return `ChatGPT Codex · Slot: ${slot.name}${slot.active ? " (active)" : ""}`;
}

function emptySlotResult(): QuotaProbeResult {
	return {
		state: "auth-required",
		message: "This Codex slot has no saved credential. Select it with `/codex use <name>` and run `/login openai-codex`.",
	};
}

function unavailableSlotResult(error: unknown): QuotaProbeResult {
	if (error instanceof CodexCredentialSlotError) {
		if (error.code === "SLOT_NOT_FOUND") {
			return { state: "auth-required", message: "This Codex slot no longer exists." };
		}
		if (error.code === "AUTH_REFRESH_FAILED") {
			return {
				state: "auth-required",
				message: "This Codex credential could not be refreshed. Select the slot with `/codex use <name>` and run `/login openai-codex`.",
			};
		}
	}
	return {
		state: "auth-required",
		message: "This Codex slot does not contain a usable credential. Select it with `/codex use <name>` and run `/login openai-codex`.",
	};
}

function formatSlotResult(entry: CodexSlotQuotaResult, now: Date): string {
	const label = slotLabel(entry.slot);
	if (entry.result.state === "ok") return formatQuotaText(entry.result.snapshot, now, label);
	return `${label}\nCodex usage: ${entry.result.state}\n${entry.result.message}`;
}

export function formatCodexAuthStatus(inspection: CodexCredentialSlotInspection): string {
	return [
		"Pi Codex credential slots",
		...inspection.slots.map((slot) => `${slot.active ? "*" : " "} ${slot.name} (${slotStatusLabel(slot)})`),
		"",
		`Active slot: ${inspection.activeSlotName}`,
	].join("\n");
}

export function formatCodexProbeResults(batch: CodexSlotQuotaBatch, now = new Date()): string {
	return batch.slots.map((entry) => formatSlotResult(entry, now)).join("\n\n");
}

export class CodexSlotUsageClient implements CodexSlotUsageClientLike {
	private readonly store: SlotStore;
	private readonly probe: Probe;
	private readonly now: () => Date;
	private readonly cache = new Map<string, Extract<QuotaProbeResult, { state: "ok" }>>();

	constructor(options: CodexSlotUsageClientOptions = {}) {
		this.store = options.store ?? new CodexCredentialSlotStore();
		this.probe = options.probe ?? (probeQuota as Probe);
		this.now = options.now ?? (() => new Date());
	}

	inspect(): CodexCredentialSlotInspection {
		try {
			return this.store.inspect();
		} catch (error) {
			if (error instanceof CodexCredentialSlotError) throw error;
			throw new Error("Could not read Codex credential slots.");
		}
	}

	async query(options: CodexSlotQueryOptions = {}): Promise<CodexSlotQuotaBatch> {
		const cachePolicy = options.cache ?? "prefer";
		options.signal?.throwIfAborted();
		const inspection = this.inspect();
		const requests = new Map<string, Promise<QuotaProbeResult>>();
		const slots = await Promise.all(
			inspection.slots.map(async (slot): Promise<CodexSlotQuotaResult> => {
				if (!slot.hasCredential) return { slot, result: emptySlotResult() };
				try {
					const result = await this.store.withRequestAuth(
						slot.id,
						async (auth) => {
							options.signal?.throwIfAborted();
							let request = requests.get(auth.cacheIdentity);
							if (!request) {
								request = this.fetchAccount(auth, cachePolicy, options.signal);
								requests.set(auth.cacheIdentity, request);
							}
							return request;
						},
						{ signal: options.signal },
					);
					return { slot, result };
				} catch (error) {
					options.signal?.throwIfAborted();
					return { slot, result: unavailableSlotResult(error) };
				}
			}),
		);
		options.signal?.throwIfAborted();
		return {
			slots,
			anySuccess: slots.some((entry) => entry.result.state === "ok"),
		};
	}

	private async fetchAccount(
		auth: CodexCredentialRequestAuth,
		cachePolicy: CodexCachePolicy,
		signal: AbortSignal | undefined,
	): Promise<QuotaProbeResult> {
		if (cachePolicy === "prefer") {
			const cached = this.cache.get(auth.cacheIdentity);
			if (cached && !isStale(cached.snapshot.fetchedAt, this.now())) return cached;
		}
		const result = await this.probe({ headers: auth.headers, signal });
		signal?.throwIfAborted();
		if (cachePolicy !== "bypass" && result.state === "ok") {
			this.cache.set(auth.cacheIdentity, result);
		}
		return result;
	}
}
