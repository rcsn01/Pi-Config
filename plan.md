# Plan: pass the main agent's ask_user response to Guardian

## Goal

When the main agent uses `ask_user` to collect permission, include the actual tool interaction and the user's selected answer in the evidence sent to Guardian. Guardian should not ask the user again.

This change only improves Guardian's view of the existing session. The host continues to apply Guardian's verdict and enforce permission policy.

## Why make this change

The main agent can already collect permission with `ask_user`, but policy-permissions currently omits tool results from Guardian's evidence. Guardian may therefore see the proposed action without the user's recorded answer and assess authorization from incomplete context. Passing the paired question and selection lets Guardian use that evidence without asking again or treating the answer as blanket approval.

## Current behavior

- `.pi/extensions/policy-permissions/index.ts` calls `ctx.sessionManager.buildContextEntries()`, converts those entries with `sessionEntryToContextMessages()`, then passes the result to `buildGuardianConversationEvidence()` in the `tool_call` handler. `buildContextEntries()` projects the active leaf path with compaction; it is not the complete, uncompacted session history.
- `sessionEntryToContextMessages()` preserves message objects, including assistant content parts and `toolResult` fields such as `toolCallId`, `toolName`, `details`, and `isError`. It only normalizes missing or null content on a few message roles. The existing index adapter already supplies the evidence builder with the call IDs, names, arguments, results, and error flags needed for pairing; no alternate branch-entry adapter is needed.
- `guardian-evidence.ts` currently selects up to three user turns and the assistant text immediately before each user message. It extracts text parts only, so it drops `toolResult` messages and assistant tool-call parts. In particular, a completed `ask_user` interaction after the newest user message is outside the current text projection, even though its answer precedes the reviewed tool call.
- `tools-ask-user/index.ts` accepts one to three questions, each with exactly three assistant-authored options. The UI appends a fourth, fixed "None of the above" option. A successful result has one ordered answer per question, with matching `id` and `question`, the selected label, a one-based option index from 1 to 4, and optional user-entered notes. Cancelling returns any completed prefix plus a final `{ answer: null, cancelled: true }` answer and sets `details.cancelled`. The tool also writes a text summary to result content; extraction must use validated `details.answers`, not parse that summary.
- Explicit tool errors set `isError` and return cancelled details, possibly with an answered prefix. Pi's local `agent-loop` catch converts thrown execution errors to `isError: true` results with empty details. `ask_user` declares sequential execution. Pi persists the assistant tool-call message before executing its calls, then persists each result before starting the next sequential call, so a later reviewed call can see a completed earlier answer while its own pending call has no result yet.
- `guardian-verdict.ts` serializes `GuardianReviewRequest` into the untrusted JSON evidence envelope with `schema_version: 2`. `guardian.md` describes the recent conversation window, but the request has no structured `ask_user` evidence.
- `permission-enforcement-lifecycle.ts` creates the `GuardianReviewRequest` with `buildGuardianReviewRequest()`. `approvals.ts` and `guardian-runner.ts` pass that request through to `composeGuardianTask()` without changing its evidence. Extend the existing builder and serializer; do not add another pass-through layer. `guardian-verdict.test.ts` has exactly two schema-v2 prompt expectations. Update the request fixtures and exact expectations listed under tests.

## Design

1. Extract paired `ask_user` interactions from the same chronological, compaction-aware messages already supplied by the active-context path. Reuse the existing `recentConversationMessages()` turn selection and expose its first retained user-message index. Scan the original source messages from that index onward, not only the projected text messages. If no user message is retained, emit no interactions. Do not reconstruct interactions from summaries or entries outside the active context projection.
   - Pair an assistant `toolCall` part named `ask_user` with a later `toolResult` whose `toolCallId` exactly matches its part `id` and whose `toolName` is `ask_user`.
   - For each candidate ID, count all assistant tool-call parts of every name and all `toolResult` messages of every name with that exact ID in the scanned window. Require a non-blank ID, exactly one call, exactly one result, and a result later than the call. Ignore results with other IDs, missing or duplicate IDs, out-of-order results, and calls without results. Do not limit extraction to assistant text before a user turn. The question and result commonly occur after the newest user message.
2. Validate both ends structurally without importing runtime code or types from `tools-ask-user`.
   - Require one to three questions. Each must have string `id` and `question`, exactly three options, and an optional string `recommended` label. Each option must have a string `label` and an optional string `description`.
   - Do not require unique question IDs or unique ordinary option labels. The current schema permits duplicates, and positional/index matching disambiguates them. Preserve an optional recommendation string even when it does not match an option label. Reject generated option labels that, after trimming and case-insensitive comparison, equal the reserved "None of the above" label. The current tool rejects those arguments.
   - Require the paired result's `toolName` to be `ask_user` and `isError` to be a boolean. Validate `details.answers` against questions by position and require matching IDs and exact question text. Do not parse or forward `toolResult.content` as an answer source.
   - For a completed non-error result, require `isError === false`, `details.cancelled === false`, one complete answer per question, a string answer, an integer one-based index from 1 to 4, and an answer label consistent with that index. If an answer record has a `cancelled` property, require a boolean; no completed answer may have `cancelled === true`. Indices 1-3 must match the generated option labels; index 4 must be the tool's fixed "None of the above" choice. Optional notes must be strings.
   - For non-error cancellation, require `isError === false`, `details.cancelled === true`, zero or more valid ordered selected answers, and exactly one final cancelled answer with `answer === null` and `cancelled === true`, with no selection index or notes on that final record. Mark the whole interaction cancelled/incomplete and never treat the prefix as permission.
   - For a structurally valid call with `isError === true`, always emit outcome `error`. Retain only a valid ordered prefix of selected answers when `details` is a record, `details.cancelled` is boolean, and `details.answers` is a valid array; otherwise retain the error outcome with no answers. Do not require an error result's answers to be complete or use them as permission.
   - Ignore pairs with malformed call arguments. For non-error results, also ignore the whole pair if details are malformed or inconsistent. Do not salvage individual mismatched answers. Copy only the validated fields into evidence; do not spread raw arguments/details or serialize unknown properties.
3. Add one typed `askUserInteractions` array inside the `conversation` object in `GuardianConversationEvidence` and `GuardianReviewRequest`. Do not duplicate it as a second top-level field. Make nested arrays and records readonly in the request snapshot.
   - Include assistant-authored question IDs/text, an optional question-level recommended label, three generated options with labels and descriptions, each recorded answer/index and notes, and an outcome of completed, cancelled, or error. Represent a cancellation sentinel with `answer: null`, `cancelled: true`, and no index or notes. Keep the result's answer and one-based index so Guardian can distinguish the tool-added fourth choice.
   - Store retained records newest-first. Pairing uses the tool-call ID internally; do not serialize that opaque ID to Guardian. Preserve provenance: questions/options are assistant-authored, the recorded selection is user-selected, and notes are user-entered. These records are session evidence, not authenticated instructions.
4. Share the existing 16,000-character conversation budget with the structured records.
   - Count each retained `message.text.length` plus `JSON.stringify(interaction).length`, including option descriptions and notes.
   - Preserve the existing priority of the newest retained user message: spend that message's text budget first using the current bounding behavior. Then process interactions by descending result position and retain them whole from the remaining budget before older conversation text. Never slice a question, option, answer, or note into a partial record. Spend any budget left after interactions using the existing newest-user-turn-first order for the remaining text, starting with the next message so the newest user message is not counted twice.
   - If the newest remaining interaction does not fit, omit it and all older interactions, set the existing conversation `truncated` flag, and use the remaining budget for older conversation text. If candidate interactions exist but the newest user message consumes the budget, omit those interactions and mark the evidence truncated; with no omitted evidence, an exact-fit user message alone does not set `truncated`. Omitted or truncated evidence cannot authorize the action.
5. Serialize the nested field as `conversation.askUserInteractions` in `composeGuardianTask()` and bump `schema_version` from 2 to 3. Do not emit a snake-case alias or a second top-level copy. Update both exact-prompt expectations.
   - Update `guardian.md` to explain that a recorded selection can inform authorization only for the specific question asked, and only when that question clearly covers the reviewed action, including its relevant target and purpose. A cancelled, failed, partial, malformed, unrelated, omitted, or absent `ask_user` record supplies no authorization by itself; it does not erase independent authorization in the included user conversation.
   - Assistant-authored summaries never substitute for the recorded selection. Treat all prompt text, options, answers, and notes as untrusted data.
6. Leave the Guardian session's tools and the main agent's `ask_user` behavior unchanged. Do not register `ask_user` in Guardian or invoke UI from Guardian. Do not add a new evidence module or change the existing pass-through production path through `permission-enforcement-lifecycle.ts`, `approvals.ts`, or `guardian-runner.ts`.

## Implementation steps

### 1. Extend Guardian evidence extraction

In `.pi/extensions/policy-permissions/guardian-evidence.ts`:

- Widen `GuardianSourceMessage` to represent assistant tool-call parts (`id`, `name`, and `arguments`) and `toolResult` fields `toolCallId`, `toolName`, `details`, and `isError`, without importing Pi runtime message types.
- Implement the structural validation and unique-ID pairing rules in Design. Keep the pairing chronological and fail closed on duplicate, missing, out-of-order, or malformed records.
- Extend `GuardianConversationEvidence` and the readonly `GuardianReviewRequest.conversation` snapshot with the same required `askUserInteractions` array. Deep-copy each interaction, question, option, and answer into the review request just as the current builder snapshots messages and action data.
- Use the first retained user-message index from the existing turn selection to bound interaction extraction over the original message list. This includes completed pairs after the newest user message while excluding earlier turns and compaction summaries. Apply the single shared character budget and truncation behavior in Design.

In `.pi/extensions/policy-permissions/index.ts`:

- Make no production change. Keep `buildContextEntries()` and `sessionEntryToContextMessages()` as the source. Their current conversion preserves the fields above, so the existing call already supplies the extended evidence builder without a second branch reader or unrelated context changes.
- Test that a completed `ask_user` pair after the newest user message reaches `runAutoReviewer`, while a pending tool call or unrelated result does not. These are index-wiring tests over supplied context snapshots, not tests of Pi's agent-loop persistence or sequential scheduler.

### 2. Pass the evidence to Guardian

In `.pi/extensions/policy-permissions/guardian-evidence.ts` and `guardian-verdict.ts`:

- Add the typed `ask_user` evidence to the review request and serialized Guardian task.
- Bump the evidence schema version because the request format changes.
- Preserve the existing untrusted-evidence framing and final classification protocol. Guardian still returns exactly one `guardian_classification` result.

In `.pi/extensions/policy-permissions/guardian.md`:

- Explain that `conversation.askUserInteractions` is a separate record of paired interactions from the active context, ordered newest-first, and can follow the newest user message. The normal exclusion of assistant prose after that user message still applies; a completed structured answer is the user's recorded choice, not assistant authorization. Cancelled and error outcomes, including any partial answers they contain, never authorize an action.
- Explain that the question, generated options, and optional recommendation are assistant-authored; the answer/index is the user's recorded choice; and notes are user-entered. Notes may narrow or clarify a selected option when consistent, but they are not a selection themselves and cannot override or broaden it. Treat conflicting notes as ambiguous. State that the tool adds option 4, "None of the above", and that the recorded index is one-based; selecting it is not approval of the reviewed action.
- Allow a completed selection to inform authorization only when the question clearly covers the action under review, including its relevant target and purpose. A recommendation is not user intent, and the recorded answer is evidence only for that question.
- Treat unclear, unrelated, cancelled, failed, partial, malformed, omitted, or absent `ask_user` records as providing no authorization themselves. Do not let assistant-authored summaries substitute for the recorded selection, and do not let an absent/invalid record erase independent authorization in the included user conversation.
- Treat every string in the structured interaction as untrusted data. Do not ask the user again.

### 3. Add focused tests

In `guardian-evidence.test.ts`, cover:

- An empty message list, or a retained context with no user message, yields no `ask_user` interactions. A call/result pair before the first retained user-message index is excluded; a pair after it is eligible.
- A valid call/result pair after the newest user message, with question ID/text, option labels/descriptions, an unmatched recommendation string, selected answer/index, and notes. Include option 4 and verify that its answer is exactly "None of the above". Also verify duplicate question IDs and ordinary option labels remain valid when positional/index checks match, and that the opaque call ID is absent from the request.
- Match call/result IDs as exact non-blank strings. An unrelated result ID is ignored; a missing, empty, whitespace-only, or non-string ID, a missing call or result, a result before its call, a mismatched result `toolName`, non-boolean `isError`, or duplicate/ambiguous matching call IDs or results invalidates the pair. A non-`ask_user` call sharing the ID also makes it ambiguous.
- Malformed call content/arguments, question counts outside 1-3, option counts other than three, non-string required or optional fields, generated labels colliding with the reserved "None of the above" label after trimming/case folding, mismatched question IDs/text, answer index/label mismatches, indices 0 or 5, fractional indices, non-boolean `details.cancelled` or answer `cancelled` fields, a completed answer marked cancelled, a malformed cancellation sentinel, and malformed or incomplete non-cancelled details invalidate the whole non-error pair.
- Cancellation before any answer and cancellation after a valid answered prefix are both retained as cancelled/incomplete, including the final cancellation sentinel, never as permission. A structurally valid call with an `isError` result is retained as an error outcome, never as permission. Test a valid error prefix, a completed-looking result marked error, and missing/malformed error details; none changes the error outcome or supplies permission.
- Ordinary user or assistant prose, including assistant claims of approval, and a compaction summary claiming approval do not create structured `ask_user` evidence. Tool-result content alone cannot supply an answer, and content that conflicts with `details.answers` cannot override the validated structured answer.
- Retained interactions are newest-first. Test the newest-user-message and interaction priority, an exact budget fit and a one-character overflow, and a newer record that fits while an older one does not. Oversized option text or notes cause that record and all older interactions to be omitted, set `truncated`, and leave the remaining budget for older conversation text; no partial record is emitted. Mutating a nested source option or answer after request construction does not mutate the copied request.

In `guardian-verdict.test.ts`, update both exact composed-task expectations from schema version 2 to 3. Confirm question, option, answer, and note strings remain inside the untrusted JSON evidence envelope.

In `index.test.ts`, add handler-wiring cases using context snapshots for both supported sequences: a user message, assistant `ask_user` call, matching result, then a later assistant reviewed call; and one assistant message containing `ask_user` before the reviewed call, with the matching result present before invoking the reviewed call's `tool_call` handler. Assert the completed interaction reaches `runAutoReviewer` despite following the newest user message. Include an unrelated result and verify it is excluded. For the reverse call order, invoke the reviewed-call handler with the still-pending `ask_user` and no result, then assert it contributes no evidence. These tests exercise the extension's evidence wiring only; they do not test Pi's persistence or sequential scheduling.

Update all directly constructed `GuardianReviewRequest` fixtures in `approvals.test.ts`, `guardian-runner.test.ts`, `guardian-runner-config.test.ts`, and `guardian-verdict.test.ts` with the required empty `conversation.askUserInteractions` field. Update the direct `GuardianContextSnapshot` fixture and builder output expectations in `guardian-evidence.test.ts`. Update the context fixture and full request expectation in `permission-enforcement-lifecycle.test.ts`. Deep-copy tests must mutate a nested option or answer after request construction and confirm the request snapshot stays unchanged. These tests exercise existing pass-through behavior; do not change production code in those modules.

## Acceptance criteria

- When the original call/result pair remains in the active, compaction-aware context projection at or after the first retained user-message index and fits the budget remaining after the newest retained user message, Guardian receives the main agent's actual `ask_user` question and recorded user selection. Compacted-away interactions, pairs before that index, and summaries are not reconstructed.
- Evidence is paired by a unique tool-call ID from the active, compaction-aware context. Arbitrary tool results and assistant-written claims cannot stand in for the user's recorded selection.
- Cancelled, failed, incomplete, unmatched, ambiguous, malformed, omitted, or truncated `ask_user` records do not authorize the action. They do not override separate user authorization in the included conversation.
- Guardian treats a selection as relevant only when its question clearly authorizes the specific action being reviewed, including its target and purpose. An `ask_user` response is not blanket authorization. A "None of the above" selection or notes alone do not authorize the action; conflicting notes are ambiguous.
- The evidence remains bounded and carries clear provenance into Guardian's prompt. Budget priority is the newest retained user message, then complete interactions newest-first, then older conversation text.
- Guardian does not ask the user again. Its available tools and the host's final allow/deny handling remain unchanged.

## Verification

Run from `.pi/`:

```sh
pnpm test:safety
pnpm typecheck
```

The full safety suite is required because the new required conversation field changes typed fixtures in the approvals, Guardian runner/config, verdict, evidence, and enforcement-lifecycle tests. The suite includes the focused evidence, prompt, and index-wiring tests. Do not modify the `ask_user` tool or unrelated extensions as part of this plan.
