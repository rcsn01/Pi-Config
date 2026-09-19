# Implementation plan: deepen the per-project Pi-Config document module

## Outcome

`_shared/pi-config.ts` becomes the deep Per-project document module: one
interface that owns the `.pi/pi-config.json` path, the project-trust gate,
trust-gated document reads, trust-gated namespace mutations, atomic writes,
and sibling/unknown-key preservation. Callers (mode-store, command-policy,
profile-document, session-profile-binding) stop composing the trust gate and
path mechanics themselves and declare intent instead. The
`evaluateExecPolicy` default that silently drops the project layer is
removed. Tests concentrate at the module interface; the stale writer comment
is replaced by the real invariant.

Concretely, after this plan:

- An untrusted project can never be read from or written to by accident: the
  gate lives in one module, not in five callers' `if` branches.
- A caller cannot silently evaluate exec policy global-only; the dangerous
  default parameter is gone.
- Deleting the module would scatter path composition, the trust probe, the
  gate, and merge-preservation across at least four callers — it passes the
  deletion test and earns its keep.
- Tests target the trust-gated interface directly, including the previously
  untested untrusted no-op and the untested `readProjectProfile` read.

## Resolved design decisions

Adopted during the grilling loop (recommended answers, confirmed by the user
in advance).

### 1. Module home: deepen `_shared/pi-config.ts` in place

The file already owns the document primitives and the header comment is the
canonical schema summary. The deepening changes the interface, not the
location. A new `_shared/project-policy.ts` name would add a rename to
every importer and to `.pi/docs/pi-config.md` without adding depth.

### 2. Interface shape: trust-gated accessors

The interface owns the gate. Alternatives rejected:

- *Path-based primitives plus a separate trust wrapper*: two seams; callers
  can still compose the gate wrong — today's exact failure mode.
- *Accepting Pi `ctx` objects*: couples a `_shared/` module to a host shape
  and makes pure tests awkward. The module already takes a structural
  `{ isProjectTrusted?: () => boolean }` for the probe; that stays.
- *Document-level mutate with a trust flag*: callers would keep implementing
  namespace merge-preservation — the duplication the review flagged.

### 3. Namespace semantics stay with their domain owners

The module owns mechanics: path composition, the trust gate, atomic writes,
sibling/unknown-key preservation. The domains own semantics:

- `profile` — validation and interpretation in `_shared/profile-document.ts`.
- `permissions` — validation, hashed-store fallback, legacy migration in
  `policy-permissions/mode-store.ts`.
- `execPolicy` — rule validation, global file, layering, evaluation in
  `_shared/command-policy.ts`.

Moving schemas into `_shared/pi-config.ts` would require importing
`isApprovalMode` from `policy-permissions/mode-registry.ts`, inverting the
dependency direction (shared → extension). Rejected.

### 4. Mutation stays synchronous; the invariant is documented; no queue

The architecture review proposed routing mutations through
`withFileMutationQueue`. On inspection the finding downgrades: every mutation
today is a fully synchronous read-modify-write (mode-store
`saveModeToFile`, command-policy `saveProjectExecPolicyRules`), and a
synchronous read-modify-write cannot interleave within a process regardless
of how many writers exist — JavaScript runs each one to completion. A queue
would force an async ripple through `saveModeToFile` → the enforcement
lifecycle's best-effort `saveMode` adapter → test determinism, for a
hypothetical future async mutation. KISS and YAGNI: no queue.

Instead the stale comment ("a single in-process writer, so no mutation queue
is needed" — false since commit 8d006cd added a second writer) is replaced
with the real invariant: mutation is a synchronous read-modify-write, atomic
per call because it never interleaves in-process; cross-process concurrent
writes to one document remain unsupported, matching the explicit stance for
workflow run directories.

### 5. The global-only exec default is removed

`evaluateExecPolicy(command, config = loadExecPolicy())` silently evaluates
global-only when a caller omits `config` — a latent enforcement regression
for trusted projects with project rules. Both production callers
(`permission-policy.ts:57`, `commands.ts:141`) already pass `config`
explicitly. The default parameter is removed; an omission becomes a compile
error.

### 6. Trust-evaluation timing stays caller-owned

The Session profile binding freezes trust per `session_start` (one immutable
binding — deliberate, recorded in CONTEXT.md); the enforcement lifecycle
re-evaluates per event. Both lifecycles stay. The module owns gate
mechanics; callers own when they evaluate trust. Not unified.

### 7. Naming: "Per-project document"

Matches the existing phrasing in code comments and `.pi/docs/pi-config.md`
("Per-project state"). Accessor names: `readProjectDocument`,
`mutateProjectNamespace`; the gate parameter is `projectTrusted`, matching
the existing `ModePersistenceOptions.projectTrusted`. The CONTEXT.md entry
was added at decision time (see Documentation updates).

### 8. Test strategy: the interface is the test surface

Per DEEPENING.md: rewrite `pi-config.test.ts` at the new interface, add the
missing direct `readProjectProfile` tests, keep mode-store / command-policy
/ session-profile-binding tests (their interfaces do not change), and delete
the tests of the removed path-based exports. Old tests that assert internal
plumbing become waste once interface tests exist.

### 9. Non-goals (recorded, not silently dropped)

- **config-profiles awareness of the project profile layer.** `/profile`
  writes the Settings-document marker while the binding lets a trusted
  project's `profile` override it on non-reload starts. The interaction is
  Profile-domain precedence, already tested from the binding side. Out of
  scope; no behavior change here.
- **Cross-process locking for the document.** Two pi processes writing one
  repo's document remain unsupported, same policy as workflow run
  persistence. Documented, not solved.
- **Unifying trust-evaluation timing.** Decision 6.
- **Mutation queue.** Decision 4.

## Current evidence and friction

All line refs verified at HEAD (`abd6d5c`).

- `_shared/pi-config.ts:26-64` — the module is shallow: interface
  (`piConfigPath`, `isProjectTrustedContext`, `readPiConfigDocument(path)`,
  `mutatePiConfigDocument(path, mutate)`) nearly matches implementation.
  The gate is caller-side; the doc comment claims a single writer.
- `policy-permissions/mode-store.ts:39-57,70-73` — composes
  `{cwd, projectTrusted}` itself: `if (options.projectTrusted)` branches
  around `mutatePiConfigDocument`/`readPiConfigDocument`.
- `_shared/command-policy.ts:296-301,318-326,342-350` — same
  composition: `options.cwd !== undefined && options.projectTrusted === true`
  gating, plus `evaluateExecPolicy`'s global-only default (line 358).
- `_shared/profile-document.ts:75-84` — `readProjectProfileName(path)`
  takes a precomposed path; trust composition lives in the caller; no
  direct test exists in `profile-document.test.ts`.
- `_shared/session-profile-binding.ts:8,134-135,166-179,221-224` — encodes
  trust as `isProjectTrustedContext(ctx) ? piConfigPath(ctx.cwd) : undefined`
  and threads `projectPiConfigPath?: string` through slot resolution.
- `policy-permissions/index.ts:145,162,190,229` and
  `policy-permissions/commands.ts:135-141` — each event/command handler
  re-composes `{cwd: ctx.cwd, projectTrusted: isProjectTrustedContext(ctx)}`.
- `_shared/settings-document.ts:60` — `withFileMutationQueue` exists and
  wraps `mutateSettingsDocument`; `pi-config` bypasses it (see decision 4
  for why that is acceptable, and why the comment must still change).
- `_shared/pi-config.test.ts` — tests the path-based primitives; nothing
  pins the trust gate (untrusted behavior is only covered indirectly by
  `mode-store.test.ts` "untrusted projects ignore the project document").

Importer inventory of the removed exports (`readPiConfigDocument`,
`mutatePiConfigDocument`): exactly four callers — mode-store.ts,
command-policy.ts, profile-document.ts, pi-config.test.ts — all migrated by
this plan. `piConfigPath` stays exported (test fixtures in
`commands.test.ts`, `mode-store.test.ts`, `command-policy.test.ts` use it;
`session-profile-binding.ts` drops it). `isProjectTrustedContext` stays
exported (index.ts, commands.ts, session-profile-binding.ts).

## Target implementation

### Module interface: `_shared/pi-config.ts`

New header comment (replaces lines 1-22):

```ts
/**
 * Per-project Pi-Config document: `<project>/.pi/pi-config.json`.
 *
 * Extension-owned per-project state for the Pi-Config suite. Pi never parses,
 * merges, or validates this file — it is not part of the pi-native
 * `.pi/settings.json` namespace. It travels with the repo, so it is honored
 * only for trusted projects (`ctx.isProjectTrusted()`); every accessor here
 * takes an explicit `projectTrusted` flag and treats untrusted projects as
 * "nothing declared" without touching the file.
 *
 * Namespace semantics live with their domain owners — profile-document.ts
 * (`profile`), policy-permissions/mode-store.ts (`permissions`), and
 * command-policy.ts (`execPolicy`) validate and interpret their namespaces.
 * This module owns document mechanics: path composition, the trust gate,
 * atomic writes, and sibling/unknown-key preservation.
 *
 * Precedence (see .pi/docs/pi-config.md):
 *   profile       session entry > handoff > project `profile` > global marker
 *   approval mode project `permissions.mode` > hashed store > "default"
 *   exec policy   global rules > project rules > global defaultAction
 *
 * Mutation is a synchronous read-modify-write: the read, the mutation, and
 * the write never interleave within a process because none of them awaits,
 * so a mutation queue adds nothing. Atomicity across processes is out of
 * scope (two processes writing one document remain unsupported, as with
 * workflow run directories).
 *
 * Schema (namespaced, additive — readers ignore unknown keys):
 *   { "profile": "research", "permissions": { "mode": "read-only" },
 *     "execPolicy": { "rules": [ ... ] } }
 * Full schema lives in `.pi/docs/pi-config.md`.
 */
```

Public interface (four functions; `isRecord` imported from
`settings-document.ts` as today):

```ts
/** Path of `<project>/.pi/pi-config.json`. */
export function piConfigPath(cwd: string): string;                      // unchanged

/** Capability probe: true only when the pi host grants project trust. */
export function isProjectTrustedContext(
	ctx: { isProjectTrusted?: () => boolean },
): boolean;                                                              // unchanged

/**
 * Trust-gated read of the whole document. Returns undefined when the project
 * is untrusted (no filesystem access) or the document is missing, malformed,
 * or empty.
 */
export function readProjectDocument(
	cwd: string,
	projectTrusted: boolean,
): Record<string, unknown> | undefined;

/**
 * Trust-gated namespace mutation. Reads the document, applies `mutate` to the
 * namespace object (undefined when absent), and writes the document back
 * atomically, preserving sibling namespaces and unknown keys. Returning
 * undefined from `mutate` removes the namespace. Untrusted projects: no read,
 * no write, returns undefined.
 */
export function mutateProjectNamespace(
	cwd: string,
	projectTrusted: boolean,
	namespace: string,
	mutate: (namespace: Record<string, unknown> | undefined) =>
		Record<string, unknown> | undefined,
): Record<string, unknown> | undefined;
```

Implementations:

```ts
export function readProjectDocument(cwd, projectTrusted) {
	if (!projectTrusted) return undefined;
	return readDocumentAtPath(piConfigPath(cwd));
}

export function mutateProjectNamespace(cwd, projectTrusted, namespace, mutate) {
	if (!projectTrusted) return undefined;
	let applied: Record<string, unknown> | undefined;
	mutateDocumentAtPath(piConfigPath(cwd), (document) => {
		const current = isRecord(document[namespace]) ? document[namespace] : undefined;
		applied = mutate(current);
		if (applied === undefined) delete document[namespace];
		else document[namespace] = applied;
		return document;
	});
	return applied;
}
```

Private helpers (unexported, bodies moved from today's exports):

- `readDocumentAtPath(documentPath)` — the body of today's
  `readPiConfigDocument` (missing/malformed/empty → undefined).
- `mutateDocumentAtPath(documentPath, mutate)` — the body of today's
  `mutatePiConfigDocument` verbatim: `readDocumentAtPath(documentPath) ?? {}`
  → mutate → `writeSettingsDocument` with `mode: 0o644` (a missing, malformed,
  or empty document is overwritten, not raised).

Removed from the public interface: `readPiConfigDocument`,
`mutatePiConfigDocument` (path-based, gate-less primitives). Their four
callers are migrated below; `piConfigPath` and `isProjectTrustedContext`
keep their exact behavior and signatures.

### Caller migration: `policy-permissions/mode-store.ts`

Imports: `mutatePiConfigDocument, piConfigPath, readPiConfigDocument` →
`mutateProjectNamespace, readProjectDocument`.

`saveModeToFile` — the gate collapses into the module; the trusted branch
and the hashed-store branch keep their exact behavior:

```ts
export function saveModeToFile(cwd: string, mode: ModeState, options: ModePersistenceOptions = {}): void {
	const applied = mutateProjectNamespace(
		cwd,
		options.projectTrusted === true,
		"permissions",
		(namespace) => ({ ...namespace, mode: mode.mode }),
	);
	if (applied !== undefined) return;
	// ... hashed-store write unchanged (projectStatePath(cwd, MODE_FILE))
}
```

Parity notes: `{ ...undefined }` is `{}`, so the callback matches today's
`...(isRecord(document.permissions) ? document.permissions : {})`; the
trusted path still drops `setAt` (the project document carries `mode`
only); untrusted falls through to the hashed store exactly as before.

`loadModeFromFile` — same collapse:

```ts
export function loadModeFromFile(cwd: string, options: ModePersistenceOptions = {}): ModeState | null {
	const declared = options.projectTrusted === true
		? parseModeState(readProjectDocument(cwd, true)?.permissions)
		: undefined;
	if (declared) return declared;
	// ... hashed-store read + legacy migration unchanged
}
```

The private `readProjectMode(cwd)` helper is deleted (its one call site
inlines the accessor).

### Caller migration: `_shared/command-policy.ts`

Imports: `mutatePiConfigDocument, piConfigPath, readPiConfigDocument` →
`mutateProjectNamespace, readProjectDocument`.

```ts
/** Execpolicy rules declared in the trusted project document. */
function projectExecPolicyRules(cwd: string, projectTrusted: boolean): ExecPolicyRule[] {
	const namespace = readProjectDocument(cwd, projectTrusted)?.execPolicy;
	if (!isRecord(namespace) || !Array.isArray(namespace.rules)) return [];
	return namespace.rules.filter(isExecPolicyRule);
}

export function loadExecPolicyLayers(options: ExecPolicyLayerOptions = {}): ExecPolicyLayers {
	const global = loadGlobalExecPolicy();
	return {
		global,
		project: options.cwd !== undefined
			? projectExecPolicyRules(options.cwd, options.projectTrusted === true)
			: [],
	};
}

/** Write the project rule set, preserving sibling namespaces in the document. */
export function saveProjectExecPolicyRules(cwd: string, rules: ExecPolicyRule[], projectTrusted: boolean): void {
	mutateProjectNamespace(cwd, projectTrusted, "execPolicy", (namespace) => ({
		...namespace,
		rules,
	}));
}

export function evaluateExecPolicy(
	command: string,
	config: ExecPolicyConfig,
): { matched: boolean; action: ExecPolicyAction; rule?: ExecPolicyRule } {
	// body unchanged; the `config = loadExecPolicy()` default is REMOVED
}
```

`saveProjectExecPolicyRules` gains the explicit `projectTrusted` parameter
so the module gate is authoritative even for a future forgetful caller.
`loadExecPolicy` keeps its optional `ExecPolicyLayerOptions` (tests use the
bare global-only call deliberately); the hazard was the *evaluation* default,
not the loader options.

### Caller migration: `policy-permissions/commands.ts`

Two call sites pass the flag they already computed at the top of the
`/execpolicy` handler (`projectTrusted`, line 135):

- `add` (trusted branch): `saveProjectExecPolicyRules(ctx.cwd, [...layers.project, { id, pattern, action, reason }], projectTrusted);`
- `remove` (project layer): `saveProjectExecPolicyRules(ctx.cwd, layers.project, projectTrusted);`

`evaluateExecPolicy(rest, loadExecPolicy({ cwd: ctx.cwd, projectTrusted }))`
(line 141) is already explicit — unchanged. Behavior is identical because
both call sites sit inside `if (projectTrusted)` branches; passing the
variable keeps the gate honest instead of hardcoding `true`.

### Caller migration: `_shared/profile-document.ts`

`readProjectProfileName(documentPath)` is replaced by a cwd + trust
signature; the doc comment's "callers must only consult this for trusted
projects" becomes structural:

```ts
/**
 * Return the validated Profile name declared in the per-project document
 * (`<project>/.pi/pi-config.json`), or undefined for an untrusted project or
 * a missing, malformed, or invalid declaration. Untrusted projects never
 * touch the file.
 */
export function readProjectProfile(cwd: string, projectTrusted: boolean): string | undefined {
	if (!projectTrusted) return undefined;
	const profile = readProjectDocument(cwd, true)?.profile;
	if (typeof profile !== "string") return undefined;
	try {
		return validateProfileName(profile);
	} catch {
		return undefined;
	}
}
```

Imports: `readPiConfigDocument` → `readProjectDocument`. The local
`isRecord` stays (still used by the marker/entry parsers).

### Caller migration: `_shared/session-profile-binding.ts`

Imports: drop `piConfigPath`, keep `isProjectTrustedContext`; import
`readProjectProfile` instead of `readProjectProfileName`.

`resolveSessionProfileSlot` input reshapes from
`projectPiConfigPath?: string` to:

```ts
	/** Project cwd; undefined skips the project layer entirely. */
	projectCwd?: string;
	/** Honored only together with `projectCwd`; the accessor gates untrusted. */
	projectTrusted?: boolean;
```

and the project block becomes:

```ts
	// Trusted project declaration wins over the global settings marker; the
	// accessor gates untrusted projects without filesystem access.
	const fromProject = input.projectCwd === undefined
		? undefined
		: readProjectProfile(input.projectCwd, input.projectTrusted === true);
```

`enterSessionProfile` passes:

```ts
	projectCwd: ctx.cwd,
	projectTrusted: isProjectTrustedContext(ctx),
```

Parity notes: today `isProjectTrustedContext(ctx) ? piConfigPath(ctx.cwd) : undefined`
encodes trust as path-presence; the new shape encodes it as an explicit flag
and lets the accessor gate. Slot caching per `(event, pathKey)` is unchanged
(pathKey still excludes cwd — pre-existing behavior, out of scope). Tests
drive this seam through a fake `ctx` (`isProjectTrusted: vi.fn(...)`) with
real temp files, so no test reshaping is needed.

No changes: `policy-permissions/index.ts` (its
`loadExecPolicy({ cwd: ctx.cwd, projectTrusted: isProjectTrustedContext(ctx) })`
and `changeMode(..., { projectTrusted })` calls keep working as-is),
`permission-policy.ts`, `permission-enforcement-lifecycle.ts`,
`config-profiles`.

### Behavior parity checklist

- Trusted project, mode declared → mode wins over hashed store (unchanged).
- Trusted project, no/invalid mode declaration → hashed-store fallback
  (unchanged).
- Explicit `"default"` declaration honored, not treated as absent
  (unchanged).
- Untrusted project → document never read, never written; hashed store used
  (unchanged, now enforced by the module gate).
- Trusted mode save → merge-preserving namespace write, `setAt` not
  persisted to the document (unchanged).
- Exec policy layering: global rules first, project fills gaps, global
  `defaultAction` decides; untrusted → project layer empty (unchanged).
- Profile resolution: entry > handoff > project `profile` > marker; reload
  skips handoff and project layers (unchanged).
- Writes atomic (temp + rename), `0o644`, unknown keys and sibling
  namespaces preserved (unchanged).

## Test plan

### `_shared/pi-config.test.ts` — rewritten at the interface

Every case importing `readPiConfigDocument`/`mutatePiConfigDocument` is
rewritten at the new interface (the path-resolution case is unchanged
as-is). New/kept cases:

1. `piConfigPath` resolves `<cwd>/.pi/pi-config.json` (kept).
2. `readProjectDocument` returns undefined for an untrusted project even
   when a valid document exists (gate proof — new).
3. `readProjectDocument` returns undefined for missing, malformed, and
   empty documents (kept, trusted).
4. `readProjectDocument` returns the parsed document when present (kept).
5. `mutateProjectNamespace` creates the document and `.pi` directory on
   first write (kept).
6. `mutateProjectNamespace` preserves sibling namespaces and unknown keys
   (kept).
7. `mutateProjectNamespace` passes the prior namespace to the callback
   (undefined when absent) and merges within the namespace (new).
8. `mutateProjectNamespace` returns undefined for an untrusted project and
   leaves the file absent/untouched (new — pins the no-op contract).
9. A callback returning undefined removes the namespace while preserving
   siblings (new — pins the delete contract).
10. `isProjectTrustedContext`: absent probe → false, non-function → false,
    probe returning false → false, probe returning true → true (new — the
    probe had no direct test).

### `_shared/profile-document.test.ts` — closes the untested gap

New cases for `readProjectProfile`:

- trusted project with a valid declaration → the name;
- untrusted project → undefined (with a valid document present);
- missing/malformed document → undefined;
- invalid name (`"../escape"`) → undefined (validation fallback).

Existing marker/entry/path cases keep.

### `policy-permissions/mode-store.test.ts` — kept

All ten cases exercise `saveModeToFile`/`loadModeFromFile`, whose interface
is unchanged. No edits expected.

### `_shared/command-policy.test.ts` — minimal updates

- `saveProjectExecPolicyRules` call sites gain the `projectTrusted`
  argument (the "writes the namespace and preserves siblings" case and any
  others found by typecheck).
- Confirm no bare `evaluateExecPolicy(command)` calls remain (lines 76-78
  already pass `config` explicitly); update any found.

### `_shared/session-profile-binding.test.ts` — kept

The project-layer cases (prefer project over marker, ignore for untrusted,
invalid-name fallback, entries-over-project) drive the real accessor
through fake ctx + real temp files; they must pass unchanged.

### `policy-permissions/commands.test.ts` — kept

`piConfigPath` fixture imports stay valid; command-surface tests
(trusted add/remove/check/rules) cross the command interface and must pass
unchanged.

## Documentation updates

1. **CONTEXT.md** — the "Per-project document" entry was added to the
   Settings & profiles section at decision time (between "Settings
   document" and "Profile"). After implementation, re-read it and adjust
   wording if the final interface differs.
2. **`.pi/docs/pi-config.md`**:
   - Code map: `_shared/pi-config.ts` bullet becomes "path, trust probe,
     trust-gated reads (`readProjectDocument`), trust-gated namespace
     mutation (`mutateProjectNamespace`) — the per-project trust gate and
     document mechanics live here"; the `profile-document.ts`,
     `command-policy.ts`, and `mode-store.ts` bullets keep their namespace
     responsibilities with the new accessor names
     (`readProjectProfile(cwd, projectTrusted)`,
     `saveProjectExecPolicyRules(cwd, rules, projectTrusted)`).
   - Writes note: replace the merge sentence with "All access is
     trust-gated in `_shared/pi-config.ts`: untrusted projects are read as
     'nothing declared' and never touch the file. Mutation is a synchronous
     read-modify-write, atomic per call because it never interleaves
     in-process; concurrent writes from two processes remain unsupported."
3. No ADR: no documented decision is reversed; the review's queue finding
   was downgraded with its reasoning recorded in Resolved design decisions
   §4 (visible to future architecture reviews via this plan and the module
   docstring).

## Verification

Run from the repo root (`.pi/package.json` scripts):

```
pnpm -C .pi typecheck                       # tsc --noEmit; surfaces any missed importer of removed exports
pnpm -C .pi test:shared                     # vitest run extensions/_shared (pi-config, profile-document, command-policy, session-profile-binding)
pnpm -C .pi test:safety                     # vitest run extensions/policy-permissions (mode-store, commands, lifecycle)
rg -n "readPiConfigDocument|mutatePiConfigDocument" .pi/extensions   # expect no hits
rg -n "evaluateExecPolicy\([^,)]*\)" .pi/extensions --type ts        # expect no config-less calls
```

Manual smoke (optional, if a pi dev session is available): in a trusted
project, run `/permissions read-only` and `/execpolicy add "^pnpm test|allow|tests"`
and confirm `.pi/pi-config.json` retains both namespaces; run the same in an
untrusted project and confirm the file is untouched. Unit + type coverage
above is the primary gate; this smoke check is supplementary.

## Risks and mitigations

1. **Gate collapse changes `saveModeToFile`/`loadModeFromFile` structure.**
   Mitigation: parity checklist + ten existing mode-store tests must pass
   unchanged; the `applied !== undefined` return contract makes the
   trusted/untrusted split explicit.
2. **Removed exports break an unknown importer.** Inventory grepped (four
   callers, all migrated); `pnpm -C .pi typecheck` catches stragglers.
3. **`evaluateExecPolicy` default removal surfaces hidden bare callers.**
   Intended. Grep confirms only two production call sites, both explicit;
   tests updated if needed.
4. **Namespace-callback delete semantics (undefined removes the namespace).**
   New capability; no current caller returns undefined. Documented in the
   interface contract and pinned by test case 9.
5. **Slot-resolution seam reshape in session-profile-binding.** Tests drive
   the real accessor through fake ctx with real temp files; they must pass
   unchanged, proving parity.
6. **CONTEXT.md ahead of code.** The entry describes the target design; the
   documentation step re-verifies wording after implementation.