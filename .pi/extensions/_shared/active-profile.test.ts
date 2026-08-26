import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CONFIG_PROFILES_ENTRY_TYPE,
	clearSessionProfileHandoff,
	createSessionProfileContext,
	parseActiveProfileName,
	profilePath,
	readActiveProfileName,
	sessionProfileName,
	stageSessionProfileHandoff,
	validateProfileName,
	type SessionProfileBinding,
} from "./active-profile.ts";

const roots: string[] = [];

function fixture(marker?: unknown) {
	const root = mkdtempSync(join(tmpdir(), "active-profile-"));
	roots.push(root);
	const settingsPath = join(root, "settings.json");
	const profilesDirectory = join(root, "profiles");
	mkdirSync(profilesDirectory);
	writeFileSync(settingsPath, `${JSON.stringify(marker === undefined ? {} : marker, null, 2)}\n`);
	return { root, settingsPath, profilesDirectory };
}

const entry = (active: unknown) => ({ type: "custom", customType: CONFIG_PROFILES_ENTRY_TYPE, data: { active } });

function lifecycle(
	entries: readonly unknown[],
	reason: SessionStartEvent["reason"],
	previousSessionFile?: string,
) {
	const event = { type: "session_start", reason, previousSessionFile } as SessionStartEvent;
	const getBranch = vi.fn(() => entries);
	const ctx = { sessionManager: { getBranch } } as unknown as ExtensionContext;
	return { event, ctx, getBranch };
}

function enter(
	context: ReturnType<typeof createSessionProfileContext>,
	entries: readonly unknown[],
	reason: SessionStartEvent["reason"],
	previousSessionFile?: string,
): SessionProfileBinding {
	const { event, ctx } = lifecycle(entries, reason, previousSessionFile);
	return context.enter(event, ctx);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("active profile helpers", () => {
	it("validates profile names", () => {
		expect(validateProfileName("dsv4-flash")).toBe("dsv4-flash");
		expect(() => validateProfileName("../secret")).toThrow(/Invalid profile name/);
	});

	it("reads the marker from settings.json, tolerating absence and invalid values", () => {
		const { settingsPath } = fixture({ configProfiles: { active: "focused" } });
		expect(readActiveProfileName(settingsPath)).toBe("focused");
		expect(readActiveProfileName(join(settingsPath, "..", "missing.json"))).toBeUndefined();
		expect(readActiveProfileName(fixture({ configProfiles: { active: "../bad" } }).settingsPath)).toBeUndefined();
		expect(readActiveProfileName(fixture({ configProfiles: { active: 3 } }).settingsPath)).toBeUndefined();
		expect(readActiveProfileName(fixture({ configProfiles: "nope" }).settingsPath)).toBeUndefined();
	});

	it("parses the marker from a supplied settings document", () => {
		expect(parseActiveProfileName({ configProfiles: { active: "focused" } })).toBe("focused");
		expect(parseActiveProfileName({})).toBeUndefined();
		expect(parseActiveProfileName({ configProfiles: { active: 3 } })).toBeUndefined();
		expect(parseActiveProfileName({ configProfiles: "nope" })).toBeUndefined();
		expect(parseActiveProfileName({ configProfiles: { active: "../bad" } })).toBeUndefined();
	});

	it("reads the last configProfiles session entry, validated", () => {
		expect(sessionProfileName([])).toBeUndefined();
		expect(sessionProfileName([entry("default")])).toBe("default");
		expect(sessionProfileName([entry("default"), entry("focused")])).toBe("focused");
		expect(sessionProfileName([entry("default"), { type: "custom", customType: "other", data: { active: "x" } }]))
			.toBe("default");
		expect(sessionProfileName([entry("../bad")])).toBeUndefined();
		expect(sessionProfileName([{ type: "custom", customType: CONFIG_PROFILES_ENTRY_TYPE, data: {} }])).toBeUndefined();
	});

	it("builds profile paths from validated names", () => {
		expect(profilePath("/p", "focused")).toBe(join("/p", "focused.json"));
		expect(() => profilePath("/p", "a/b")).toThrow(/Invalid profile name/);
	});

	describe("session profile context", () => {
		it.each(["startup", "resume", "fork"] as const)("prefers the session entry on %s", (reason) => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const context = createSessionProfileContext({ settingsPath, profilesDirectory });

			expect(enter(context, [entry("default")], reason)).toEqual({
				profileName: "default",
				settingsPath: join(profilesDirectory, "default.json"),
				origin: "entry",
			});
		});

		it("prefers a seeded entry over the marker on new sessions", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "github" } });
			const context = createSessionProfileContext({ settingsPath, profilesDirectory });

			expect(enter(context, [entry("focused")], "new")).toEqual({
				profileName: "focused",
				settingsPath: join(profilesDirectory, "focused.json"),
				origin: "entry",
			});
		});

		it("falls back to the marker on unseeded new sessions", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "github" } });
			const context = createSessionProfileContext({ settingsPath, profilesDirectory });

			expect(enter(context, [], "new")).toEqual({
				profileName: "github",
				settingsPath: join(profilesDirectory, "github.json"),
				origin: "marker",
			});
		});

		it("uses the entry on reload even when the marker names another profile", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const context = createSessionProfileContext({ settingsPath, profilesDirectory });

			expect(enter(context, [entry("default")], "reload")).toEqual({
				profileName: "default",
				settingsPath: join(profilesDirectory, "default.json"),
				origin: "entry",
			});
		});

		it("uses the entry when the marker is absent or invalid", () => {
			for (const marker of [{}, { configProfiles: { active: "../bad" } }]) {
				const { settingsPath, profilesDirectory } = fixture(marker);
				const context = createSessionProfileContext({ settingsPath, profilesDirectory });
				expect(enter(context, [entry("default")], "startup")).toMatchObject({
					profileName: "default",
					settingsPath: join(profilesDirectory, "default.json"),
					origin: "entry",
				});
			}
		});

		it("never falls back to the marker on reload", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const context = createSessionProfileContext({ settingsPath, profilesDirectory });

			expect(enter(context, [], "reload")).toEqual({
				profileName: undefined,
				settingsPath,
				origin: "none",
			});

			const invalidEntryContext = createSessionProfileContext({ settingsPath, profilesDirectory });
			expect(enter(invalidEntryContext, [entry("../bad")], "reload")).toEqual({
				profileName: undefined,
				settingsPath,
				origin: "none",
			});
		});

		it("returns settings.json when neither source yields a valid name", () => {
			const { settingsPath, profilesDirectory } = fixture({});
			const context = createSessionProfileContext({ settingsPath, profilesDirectory });

			expect(enter(context, [], "startup")).toEqual({
				profileName: undefined,
				settingsPath,
				origin: "none",
			});
			expect(enter(context, [], "reload")).toEqual({
				profileName: undefined,
				settingsPath,
				origin: "none",
			});
		});

		it("returns an absolute path for every binding", () => {
			const { root, settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const context = createSessionProfileContext({
				settingsPath: join(root, "nested", "..", "settings.json"),
				profilesDirectory: join(root, "nested", "..", "profiles"),
			});
			const binding = enter(context, [], "startup");
			expect(binding.settingsPath).toBe(join(profilesDirectory, "focused.json"));
			expect(binding.settingsPath.startsWith("/")).toBe(true);

			const unmarked = fixture({});
			const unmarkedContext = createSessionProfileContext({
				settingsPath: join(unmarked.root, "nested", "..", "settings.json"),
				profilesDirectory: join(unmarked.root, "nested", "..", "profiles"),
			});
			expect(enter(unmarkedContext, [], "fork").settingsPath).toBe(unmarked.settingsPath);
		});

		it("uses a matching clear handoff before the marker on new sessions", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "default" } });
			const previousSessionFile = "/sessions/current.json";
			const context = createSessionProfileContext({ settingsPath, profilesDirectory });
			stageSessionProfileHandoff(previousSessionFile, "focused");
			try {
				expect(enter(context, [], "new", previousSessionFile)).toEqual({
					profileName: "focused",
					settingsPath: join(profilesDirectory, "focused.json"),
					origin: "handoff",
				});
				expect(enter(context, [], "new", "/sessions/other.json")).toEqual({
					profileName: "default",
					settingsPath: join(profilesDirectory, "default.json"),
					origin: "marker",
				});
				expect(enter(context, [], "startup", previousSessionFile)).toEqual({
					profileName: "default",
					settingsPath: join(profilesDirectory, "default.json"),
					origin: "marker",
				});
			} finally {
				clearSessionProfileHandoff(previousSessionFile);
			}
		});

		it("falls back to the marker when an entry is invalid", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const context = createSessionProfileContext({ settingsPath, profilesDirectory });

			expect(enter(context, [entry("../bad")], "startup")).toEqual({
				profileName: "focused",
				settingsPath: join(profilesDirectory, "focused.json"),
				origin: "marker",
			});
		});

		it("shares one binding object across context facades for an event and path pair", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const firstContext = createSessionProfileContext({ settingsPath, profilesDirectory });
			const secondContext = createSessionProfileContext({ settingsPath, profilesDirectory });
			const { event, ctx, getBranch } = lifecycle([], "startup");

			const first = firstContext.enter(event, ctx);
			writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "other" } }));
			const second = secondContext.enter(event, ctx);
			expect(second).toBe(first);
			expect(getBranch).toHaveBeenCalledOnce();
			expect(second.profileName).toBe("focused");

			const fresh = lifecycle([], "startup");
			expect(firstContext.enter(fresh.event, fresh.ctx).profileName).toBe("other");
		});

		it("shares slots for canonical-equivalent paths", () => {
			const { root, settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const firstContext = createSessionProfileContext({ settingsPath, profilesDirectory });
			const secondContext = createSessionProfileContext({
				settingsPath: `${root}/nested/../settings.json`,
				profilesDirectory: `${root}/nested/../profiles`,
			});
			const { event, ctx } = lifecycle([], "startup");

			expect(secondContext.enter(event, ctx)).toBe(firstContext.enter(event, ctx));
		});

		it("isolates different path pairs during one event", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const firstContext = createSessionProfileContext({ settingsPath, profilesDirectory });
			const secondContext = createSessionProfileContext({
				settingsPath,
				profilesDirectory: `${profilesDirectory}/other`,
			});
			const { event, ctx } = lifecycle([], "startup");

			const first = firstContext.enter(event, ctx);
			const second = secondContext.enter(event, ctx);
			expect(second).not.toBe(first);
			expect(second.settingsPath).not.toBe(first.settingsPath);
		});

		it("remembers a marker binding exactly once across repeated calls", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const context = createSessionProfileContext({ settingsPath, profilesDirectory });
			const { event, ctx } = lifecycle([], "startup");
			const binding = context.enter(event, ctx);
			const append = vi.fn();

			context.remember(binding, append);
			context.remember(binding, append);
			expect(append).toHaveBeenCalledOnce();
			expect(append).toHaveBeenCalledWith(CONFIG_PROFILES_ENTRY_TYPE, { active: "focused" });
		});

		it("leaves a failed remember append retryable", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const context = createSessionProfileContext({ settingsPath, profilesDirectory });
			const { event, ctx } = lifecycle([], "startup");
			const binding = context.enter(event, ctx);
			const failure = new Error("append failed");
			const append = vi.fn()
				.mockImplementationOnce(() => { throw failure; })
				.mockImplementationOnce(() => {});

			expect(() => context.remember(binding, append)).toThrow(failure);
			context.remember(binding, append);
			context.remember(binding, append);
			expect(append).toHaveBeenCalledTimes(2);
		});

		it("rejects foreign, wrong-path, and non-marker bindings", () => {
			const first = fixture({ configProfiles: { active: "focused" } });
			const firstContext = createSessionProfileContext(first);
			const firstLifecycle = lifecycle([], "startup");
			const binding = firstContext.enter(firstLifecycle.event, firstLifecycle.ctx);
			const append = vi.fn();

			expect(() => firstContext.remember({ ...binding }, append)).toThrow(/foreign/);

			const second = fixture({ configProfiles: { active: "focused" } });
			const secondContext = createSessionProfileContext(second);
			expect(() => secondContext.remember(binding, append)).toThrow(/another path pair/);

			const noMarker = fixture({});
			const noMarkerContext = createSessionProfileContext(noMarker);
			const noMarkerLifecycle = lifecycle([], "startup");
			const noMarkerBinding = noMarkerContext.enter(noMarkerLifecycle.event, noMarkerLifecycle.ctx);
			expect(() => noMarkerContext.remember(noMarkerBinding, append)).toThrow(/non-marker/);
		});
	});
});
