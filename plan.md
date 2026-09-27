# Implementation plan: own permission-ask prose in the Permission classification module

> **Status:** Implemented. The friction section describes the pre-refactor
> source; the sequence and acceptance criteria below are the executed plan. The
> pre-refactor tree passed 189 tests across 15 files with `pnpm typecheck`
> clean; the implemented tree passes 190 tests across 15 files (the
> classification matrix guard is the new test) with `pnpm typecheck` clean.
> All line citations below reference the pre-refactor tree.

## Purpose

Give the Permission classification module sole ownership of user-ask prompt
prose — the title, the message body, and the closing question — and make the
Permission enforcement lifecycle resolve asks without composing or editing
ask prose. Every user prompt renders from classification as final text; the
lifecycle passes it verbatim across its adapter seam to `ctx.ui.confirm`.

This fixes a shipped, user-visible bug: execpolicy prompts in default mode
ask "Proceed?" twice. This is a focused in-process refactor: no type-shape
changes, no new modules, no new exports, no policy changes.

## Expected architectural gain

- **Locality.** Prompt-text changes concentrate in one module. Today a prompt
  is assembled on both sides of the classification→enforcement seam; the next
  prompt wording change has to know about both.
- **Leverage.** One ask-construction convention serves every check site. A
  new site cannot forget its closing question and cannot double it, because
  the helper owns the suffix and the lifecycle no longer has one.
- **Testability.** The interface is the test surface. Classification tests
  pin final prompt text directly (instead of suffix-less bodies that only
  become prompts after a second module mutates them); the lifecycle seam gets
  one exact-message assertion proving the verbatim pass-through that nothing
  pins today — which is why the doubling shipped unnoticed.
- **Depth.** `PermissionAsk.message` becomes genuinely render-ready — the
  interface already promises "verbatim" for the body; after this refactor
  that promise is true instead of a latent lie.

## Pre-refactor friction

The Permission classification module (`permission-policy.ts`) classifies one
tool call into ordered verdict steps, and its `PermissionAsk` type
(`policy-types.ts`) says "Prompt or review title and body, verbatim." — a
comment attached to `title` (`policy-types.ts:17`) that covers the body;
`message` itself carries no doc comment. The Permission enforcement lifecycle
(`permission-enforcement-lifecycle.ts`) then violates that contract:
`requestApproval` (defined at line 127; the append at line 140) appends
`"\n\nProceed?"` to **every** user-channel ask before calling the adapter.

One classification site also embeds its own closing question: the execpolicy
ask (`permission-policy.ts:116`) ends its message with `"…\n\nProceed?"`.
The two compositions stack, so an execpolicy prompt in default mode renders:

```
Rule matched: needs prompt

Command: curl https://example.com

Proceed?

Proceed?
```

The external-path write sites embed a second question of their own
(`"…\nAllow write?"`), so those prompts render `"…\nAllow write?\n\nProceed?"` —
two questions in one prompt.

Coverage was split by the same seam: classifier tests pin message bodies
**without** the closing question (`permission-policy.test.ts:93, 106, 120,
143, 156, 181, 194, 228`, plus the dangerous/network asks trailing inside
the execpolicy suites at `:392, :444, :476`) because the suffix arrived later,
from another module; execpolicy-ask pins (`:436, :458, :513`) pin text that
already ends in "Proceed?"; the lifecycle's only assertion on the
requestApproval seam uses `stringContaining`. No test observes the composed
prompt end to end, so the doubling shipped.

Adjacent but out of scope: classification and the Permission-mode registry
each fail closed on `hasUI` through different steps (the classifier's no-UI
execpolicy block at `permission-policy.ts:106–110` and the no-UI disposition
deny at `mode-registry.ts:50–58`, applied at
`permission-enforcement-lifecycle.ts:134`).
That is defense in depth across two layers, not prose ownership; it stays.

Relevant code:

- `.pi/extensions/policy-permissions/permission-policy.ts`: classification,
  `userAsk`/`guardianAsk` helpers, the execpolicy ask site, the external-path
  write sites.
- `.pi/extensions/policy-permissions/permission-enforcement-lifecycle.ts`:
  `requestApproval` (the append), `requestGuardianFallback` and the two
  Guardian fallback prompts (lines 193, 204) — resolution-outcome prose.
- `.pi/extensions/policy-permissions/policy-types.ts`: `PermissionAsk`
  and the `title` doc comment that covers "title and body, verbatim."
  (`message` itself is undocumented today; step 3 adds its comment).
- `.pi/extensions/policy-permissions/mode-registry.ts`: `approvalDisposition`
  and the full-access switch confirmation — untouched prose homes.
- Tests: `permission-policy.test.ts`, `permission-enforcement-lifecycle.test.ts`
  (harness at lines 1–70; fallback pins at 248–251, 285–288; ask assertion at
  366–370; denial-record pin at 402), `index.test.ts` (fallback prose pin at 470).

## Decisions settled with the recommended defaults

1. **Ownership.** The Permission classification module owns all precomputable
   ask prose — prompt titles, message bodies, and the closing question. The
   lifecycle owns only resolution-outcome prose: the two Guardian fallback
   prompts, which depend on why a review failed and cannot be precomputed.
   They stay unchanged. (Explored alternatives: a semantic-ask taxonomy with a
   dedicated prose module called resolution-side — rejected because the new
   module would have exactly one caller, a hypothetical seam, and it moves
   final prose assembly back onto the resolution side, the very spot where
   the bug lives; lifecycle-owned prose — rejected because every per-site
   fact (rule reason, matched pattern, command text, paths) is in the
   classifier's hands, so the prose would reappear there with more
   parameters.)
2. **Question mechanism.** The private `userAsk` helper composes
   `${body}\n\n${question}` with a default question of `"Proceed?"`. Sites
   with their own question wording pass it explicitly; the external-path
   sites keep `"Allow write?"` so their phrasing survives. This keeps one
   composition convention for helper-based sites.
3. **The execpolicy site stays inline.** Its message already ends with
   exactly one "Proceed?" and is therefore already final text under the new
   ownership rule. Routing it through `userAsk` would require a
   `DeclinedReason` parameter and a denial-title override for a single site
   (its denial title is fixed `"Execpolicy Check"` while the prompt title
   varies; its declined reason is `fixed`, not `fallback`) — churn without
   gain. The invariant guard (decision 6) keeps the inline literal honest.
4. **Rendered-text policy.** Every user ask ends with exactly one closing
   question. Concretely: the execpolicy prompt loses its duplicated
   "Proceed?"; the external-path prompts render
   `"…is outside workspace.\n\nAllow write?"` (one question, phrasing
   preserved); every other user prompt renders byte-identical to today.
   Denial records, `declinedReason` texts, block reasons, check ordering, and
   all resolution policy are unchanged — they are not prompt prose.
5. **Scope.** Guardian-channel asks are untouched (their message is embedded
   as untrusted evidence; that seam belongs to the "one Guardian review
   request" candidate). The mode registry's full-access switch confirmation
   is untouched. `PermissionAsk` keeps its exact shape — only its
   documentation sharpens.
6. **Tests.** Guard the invariant from both sides: (a) a classification
   matrix test asserting that every user-channel ask message across the
   ask-producing scenarios ends with `"?"` and contains `"Proceed?"` at most
   once; (b) a lifecycle seam test asserting `requestUserConfirmation`
   receives a classifier message verbatim — an exact-message pin, not
   `stringContaining`.
7. **Domain language.** Sharpen `CONTEXT.md`'s Permission classification
   module and Permission enforcement lifecycle entries as part of
   implementation (sequence step 6), matching the house pattern.

## Target module responsibilities

### Permission classification module (`permission-policy.ts`)

Owns, unchanged: check ordering, block decisions, denial records,
`declinedReason` policy, Guardian ask composition (out of scope here).

Newly explicit: **final user-prompt prose.** Every user-channel ask carries a
message that is ready to render — body plus exactly one closing question. The
`userAsk` helper owns the default question; the execpolicy site owns its own
literal. The lifecycle never sees a message it may edit.

### Permission enforcement lifecycle (`permission-enforcement-lifecycle.ts`)

Owns, unchanged: approval disposition (with the mode registry), no-UI
fail-closed resolution, prompted denials, one-shot retry approvals,
transient-approval state, Guardian fallback, verdict persistence.

Removed: prompt-prose composition. `requestApproval` resolves the
disposition and, on the prompt path, passes `message` through unchanged.

### `policy-types.ts`

`PermissionAsk` shape unchanged. `message` gains the doc comment it lacks
today (the "verbatim" wording sits on `title` and covers both fields): an
explicit invariant that user-channel messages are final prompt text ending
in exactly one closing question, which resolvers pass unedited. The `title`
comment narrows to document only the title.

## Proposed interface change

No exported type changes and no new exports. One private helper gains an
optional parameter; one template literal is deleted.

```ts
// permission-policy.ts — userAsk composes the final prompt text.
function userAsk(
	title: string,
	body: string,
	denialMessage: string,
	fallback: string,
	question = "Proceed?",
): PermissionAsk {
	return {
		kind: "ask",
		channel: "user",
		title,
		message: `${body}\n\n${question}`,
		denial: { title, message: denialMessage },
		declinedReason: { kind: "fallback", reason: fallback },
	};
}
```

The external-path sites pass their own question and stop embedding it in the
body:

```ts
userAsk(
	"External Path",
	`Default mode: path "${inputPath}" is outside workspace.`,
	inputPath,
	"Write to external path blocked.",
	"Allow write?",
);
// Resolved-path variant: body becomes
// `Default mode: path "${inputPath}" (resolved: ${resolved}) is outside workspace.`
```

The execpolicy ask site's message is untouched — it already ends with exactly
one `"Proceed?"` and is final text.

The lifecycle stops composing:

```ts
// permission-enforcement-lifecycle.ts — requestApproval, prompt path.
return adapter.requestUserConfirmation(
	environment.hostContext,
	title,
	message, // was: `${message}\n\nProceed?`
).then((allowed) => { /* unchanged */ });
```

Rendered prompts, before → after:

| Ask site | Before | After |
|---|---|---|
| Execpolicy (default, UI) | `…Proceed?\n\nProceed?` | `…Proceed?` (bug fixed) |
| External path (both variants) | `…\nAllow write?\n\nProceed?` | `…\n\nAllow write?` |
| Sensitive path, dangerous, network command, snapshot removal, network tool | body + `Proceed?` (composed by the lifecycle) | identical bytes (composed by the helper) |
| Guardian asks, Guardian fallback prompts | untouched | untouched |

## Implementation sequence

### 1. Give the helper the closing question

Edit `.pi/extensions/policy-permissions/permission-policy.ts`:

- Rename `userAsk`'s `message` parameter to `body`; add the optional
  `question = "Proceed?"` parameter; compose
  `message: \`${body}\n\n${question}\``. Keep the helper's doc comment and
  extend it to say the helper composes the final prompt text.
- Update the two external-path sites: drop `\nAllow write?` from the body
  and pass `"Allow write?"` as the question.
- Leave the execpolicy site, `guardianAsk`, all denial records, and all
  block reasons byte-identical.

### 2. Make the lifecycle a verbatim resolver

Edit `.pi/extensions/policy-permissions/permission-enforcement-lifecycle.ts`:

- In `requestApproval`, replace `` `${message}\n\nProceed?` `` with `message`.
- Leave `requestGuardianFallback` and the two Guardian fallback prompts
  untouched — they are resolution-outcome prose with their own inline
  questions.
- Add a file-header comment (the file has none today) stating the ownership
  rule: classification composes final ask prose; this module resolves asks
  without editing them. Keep the literal `"Proceed?"` out of it — the
  acceptance criterion greps this file for that string.

### 3. Sharpen the interface documentation

Edit `.pi/extensions/policy-permissions/policy-types.ts`:

- `PermissionAsk.message` (no doc comment today; add one): user-channel
  messages are final prompt text, ending in exactly one closing question, and
  resolvers pass them verbatim without appending.
- Re-word the `title` comment ("Prompt or review title and body, verbatim.",
  `policy-types.ts:17`) so it documents only the title.

### 4. Move the classifier pins with the composition

Edit `.pi/extensions/policy-permissions/permission-policy.test.ts`:

- User-ask message pins gain the composed closing question: the bodies at
  lines 93, 106, 120, 143, 156, 181, 194, 228 (external-path pins become
  `…is outside workspace.\n\nAllow write?`) and the three trailing asks
  inside the execpolicy suites — the dangerous-command pin at 392 (the
  multi-mode test) and the network-access pins at 444 (matched-rule test)
  and 476 (no-UI test). Those three are dangerous/network pins that happen
  to live in execpolicy tests, not execpolicy-ask pins; they move with the
  helper.
- Denial-record and `declinedReason` pins stay unchanged — including 144 and
  159, where the pre-change body text doubles as the denial message at the
  network-tool and sensitive-path sites: only the `message` field gains the
  suffix.
- Execpolicy-ask pins (436, 458, 513) and Guardian pins (249, 253, 331, 343,
  354, 403, 407) stay unchanged — assert this in review, since those pins
  are now load-bearing proof that nothing else moved.

### 5. Add the two invariant guards

- In `permission-policy.test.ts`, add a matrix test: run `classifyToolCall`
  across the ask-producing scenarios (execpolicy matched and default-prompt,
  sensitive path, dangerous command, network command, snapshot removal,
  network tool, external path plain and resolved) and assert every
  user-channel ask message ends with `"?"` and contains `"Proceed?"` at most
  once. This kills the bug class for future sites, including hand-rolled
  `PermissionAsk` literals.
- In `permission-enforcement-lifecycle.test.ts`, tighten the existing
  dangerous-command ask assertion (lines 366–370) to the exact final message
  (for `sudo rm -rf /workspace/x`:
  `Default mode detected: recursive forced deletion\n\nCommand: sudo rm -rf /workspace/x\n\nProceed?`)
  so the seam test proves verbatim pass-through. Fallback-prompt pins
  (248–251, 285–288) and the denial-record pin (402) stay unchanged.

### 6. Keep the domain glossary current

Edit `CONTEXT.md`:

- **Permission classification module**: state that user-ask messages are
  final prompt text including the closing question (default "Proceed?",
  site questions like "Allow write?" where the site wording is preserved),
  composed once by the module, and that resolvers pass them verbatim.
- **Permission enforcement lifecycle**: state that it resolves asks without
  composing or editing ask prose and owns only resolution-outcome prose
  (the Guardian fallback prompts).

## Verification plan

Run from `.pi/`:

1. The focused suite for the changed extension (pre-refactor baseline:
   189 tests across 15 files, green):

   ```sh
   pnpm exec vitest run extensions/policy-permissions
   ```

2. Typecheck the extension workspace (pre-refactor baseline: clean):

   ```sh
   pnpm typecheck
   ```

3. Manual prompt check (prompts are user-visible; no unit test renders the
   TUI): start `pi` in this repo, add a prompt rule
   (`/execpolicy add ^curl|prompt|test`), remain in default mode, and issue
   a `curl` call through the bash tool; confirm the execpolicy prompt shows
   exactly one "Proceed?". Then trigger an external-path write (e.g. `write`
   to a path outside the workspace) and confirm the prompt ends with a
   single "Allow write?".

4. Review the diff and confirm the implementation changes only
   `permission-policy.ts`, `permission-enforcement-lifecycle.ts`,
   `policy-types.ts`, the two test files, and `CONTEXT.md`. This root
   `plan.md` is the plan record. No behavior beyond the two prompt fixes
   changes.

## Acceptance criteria

- Execpolicy prompts in default mode render exactly one "Proceed?".
- External-path prompts render exactly one closing question: "Allow write?".
- Every other user prompt renders byte-identical to the pre-refactor tree.
- `requestApproval` composes no prose; `"Proceed?"` appears in
  `permission-enforcement-lifecycle.ts` only inside the two Guardian fallback
  prompts.
- Denial records, `declinedReason` texts, block reasons, check ordering,
  disposition policy, one-shot approvals, and Guardian behavior are
  unchanged.
- The classification matrix guard and the lifecycle verbatim guard exist and
  pass, alongside the moved classifier pins.
- The focused suite and typecheck pass.

## Risks and safeguards

- **Prompt-text drift while moving composition.** The rendered-text table
  above is the source of truth; the moved pins and the two guards make any
  drift fail loudly rather than silently, which is what the `stringContaining`
  gap allowed.
- **A future site hand-rolls a `PermissionAsk` literal** (the original
  execpolicy mistake) and doubles or omits the question. The matrix guard
  asserts every user-ask message ends with a question and contains
  "Proceed?" at most once.
- **The lifecycle re-learns prose.** The exact-message seam pin fails if any
  append or rewrite returns. If prompt prose legitimately changes later, move
  the pin with it — that coupling is the pin's job.
- **Scope creep.** The Guardian request seam (serialized envelope, triggers
  drift), the unused `_shared/policy-service.ts` module and the lifecycle's
  dead re-exports, and the dual no-UI fail-closed rules are all separate
  candidates with their own evidence; none ride along here.

## Explicitly out of scope

- The "one Guardian review request" candidate: the serialized evidence
  envelope, the double-embedded title, and the `triggers` signature drift.
- Deleting `_shared/policy-service.ts` (zero production importers) and the
  dead re-exports at `permission-enforcement-lifecycle.ts:12`.
- Unifying the two no-UI fail-closed rules (classification block vs
  disposition deny) — deliberate defense in depth.
- The mode registry's full-access switch confirmation ("Are you sure?").
- `ModeState.setAt` persistence inconsistency.
- Any change to `PermissionStep` ordering, block reasons, approval
  disposition, one-shot retry approvals, or Guardian verdict persistence.