import { inspectCodexAuth } from "./codex-auth.ts";
import type { CodexAuthInspection, CodexAuthStatus } from "./types.ts";

export const CODEX_AUTH_CHECK_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

export async function checkCodexAuthentication(options: {
	inspect?: () => Promise<CodexAuthInspection>;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
} = {}): Promise<CodexAuthStatus> {
	const inspection = await (options.inspect ?? inspectCodexAuth)();
	if (inspection.state !== "ready") {
		return { ...inspection, credentialAccepted: false };
	}

	options.signal?.throwIfAborted();
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error("timeout")),
		options.timeoutMs ?? 15_000,
	);
	const abort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		let response: Response;
		try {
			response = await (options.fetchImpl ?? fetch)(CODEX_AUTH_CHECK_ENDPOINT, {
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${inspection.credential.accessToken}`,
					"chatgpt-account-id": inspection.credential.accountId,
				},
				redirect: "error",
				signal: controller.signal,
			});
		} catch {
			return {
				state: "unavailable",
				path: inspection.path,
				fileFound: true,
				accessTokenPresent: true,
				accountIdPresent: true,
				credentialAccepted: false,
				message: "Could not contact ChatGPT to validate the credential. Check the network and try again.",
			};
		}

		if (response.ok) {
			return {
				state: "accepted",
				path: inspection.path,
				fileFound: true,
				accessTokenPresent: true,
				accountIdPresent: true,
				credentialAccepted: true,
			};
		}
		if (response.status === 401 || response.status === 403) {
			return {
				state: "rejected",
				path: inspection.path,
				fileFound: true,
				accessTokenPresent: true,
				accountIdPresent: true,
				credentialAccepted: false,
				statusCode: response.status,
				message: `ChatGPT rejected the Codex credential (HTTP ${response.status}). Run \`codex login\` and try again.`,
			};
		}
		return {
			state: "unavailable",
			path: inspection.path,
			fileFound: true,
			accessTokenPresent: true,
			accountIdPresent: true,
			credentialAccepted: false,
			statusCode: response.status,
			message: `ChatGPT credential validation is temporarily unavailable (HTTP ${response.status}).`,
		};
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
	}
}
