# Implementation plan: deepen the child-process machinery

## Status

Ready for implementation. The source inventory and behavior taxonomy below were checked against checkout `94958a0`. The plan has no deferred verification items.

Planning baseline:

- Checkout: `94958a0` (`HEAD` during this review)
- Changed source scope: `.pi/extensions/_shared/child-process.ts` (new), `.pi/extensions/_shared/child-observation/index.ts`, `.pi/extensions/_shared/file-discovery.ts`, `.pi/extensions/_shared/process.ts` (deleted), `.pi/extensions/telemetry-cache-effort/child-runner.ts`, `.pi/extensions/tools-subagents/child-execution.ts`, `.pi/extensions/tools-subagents/child-event-ingestion.ts`, `.pi/extensions/workflows-plan/plan-sandbox.ts`, and `.pi/extensions/workflows-plan/plan-workspace.ts`
- Test and documentation scope: `.pi/extensions/_shared/child-process.test.ts` (new), the affected caller tests named below, and `CONTEXT.md`
- Baseline verified on this checkout: `pnpm --dir .pi typecheck` passes. `test:shared` passes 38 files and 383 tests. `test:cache-effort` passes 5 files and 18 tests. `test:subagents` passes 14 files and 241 tests. `test:plan` passes 13 files and 183 tests, with 1 file and 2 tests skipped behind the sandbox integration guard.
- Compatibility requirements: the `TrialRunner`, `SubagentChildExecution`, `SubagentChildEventIngestion`, `ChildObservation`, `PlanSandboxController`, and `PlanWorkspace` interfaces keep their shapes. Both existing spawn-injection seams, `ChildRunnerDependencies.spawnProcess` and `SubagentChildExecutionDependencies.spawnProcess`, stay in place. Persisted files, commands, and tool contracts are untouched.

## Objective

Move repeated child-process mechanics behind one stateless in-process module. The module owns Pi invocation resolution, incremental UTF-8 line framing, immediate process-group kill, and graceful termination escalation. Protocol parsing, event meaning, output accumulation, and caller policy remain with their current owners.

This is a real seam. Pi invocation resolution has two implementations. Incremental command-output line framing has four implementations. Termination escalation has two implementations, plus one shared immediate group-kill implementation used by two Plan runners. The new module removes those copies without trying to own process spawning or whole child lifecycles.

## Source inventory and verified behavior

### Pi invocation resolution: two implementations

1. `telemetry-cache-effort/child-runner.ts:33-50` defines `PiInvocation` and `resolvePiInvocation(argvEntry = process.argv[1])`.
   - If `argvEntry` is truthy and `realpathSync(argvEntry)` ends in `.mjs`, `.cjs`, or `.js`, case-insensitively, it returns `process.execPath`, the real path as the sole base argument, and `exact: true`.
   - A missing, unreadable, or non-JavaScript entry falls through. The code does not check that the resolved path is a regular file.
   - On fallthrough, a truthy `process.versions.bun` returns `process.execPath`, no base arguments, and `exact: true`.
   - All other fallthrough cases return `pi`, no base arguments, and `exact: false`.
   - `createChildTrialRunner` rejects the non-exact branch before spawn at `child-runner.ts:344-345`.
2. `tools-subagents/child-execution.ts:154-165` defines `resolvePiBinary()`.
   - It has the same JavaScript-entry branch.
   - It has no Bun branch and no exactness field. Every fallthrough returns `pi`.
   - `buildPiArgs` consumes the command and base arguments at `child-execution.ts:175-205`.

No test imports either resolver. `child-execution.test.ts:254-285` happens to assert `process.execPath` on this checkout because the Vitest entry resolves to JavaScript. That test does not cover either fallback.

### Incremental line framing: four implementations

1. `telemetry-cache-effort/child-runner.ts:59-79` defines a private stream adapter.
   - It uses `StringDecoder("utf8")`, splits on LF, removes one CR immediately before LF or at the tail, skips only empty strings, and flushes the tail on `end`.
   - It listens only to `data` and `end`; its returned detach removes both listeners without flushing.
2. `_shared/child-observation/index.ts:90-134` defines `createFrameReader`.
   - It uses `StringDecoder("utf8")`, splits on LF, and discards a line once its decoded UTF-8 byte count exceeds 8 MiB. An LF leaves discard mode and allows the next line.
   - Exactly 8 MiB is accepted. The CR and any trailing whitespace count toward the limit because `trimEnd()` runs only after framing.
   - `end()` is idempotent, ignores later pushes, flushes a nonblank bounded tail, and drops an overlong tail.
   - Before parsing, it removes all trailing whitespace with `trimEnd()`. `parseFrame` performs a second 8 MiB check and validates the event.
3. `tools-subagents/child-event-ingestion.ts:73-257` owns a string buffer directly.
   - `write()` calls `Buffer.toString()` independently for each Buffer, splits on LF, and retains the last segment.
   - `finish()` processes a nonblank tail. `processLine` ignores blank and malformed JSON.
   - A multibyte UTF-8 sequence split between Buffer chunks becomes replacement characters. This can corrupt assistant output and progress text silently.
4. `_shared/file-discovery.ts:108-158` owns another string buffer in `listWithCommand`.
   - It calls `Buffer.toString()` independently for each chunk, splits on `/\r?\n/`, trims accepted file names, flushes the tail on child close, and kills the command when the scan limit is reached.
   - It has the same split-multibyte corruption bug for file names returned by `fd` or `rg`.

Existing coverage is not empty:

- `child-observation/index.test.ts:46-77` already covers split records, a split `é`, the 8 MiB overflow case, and recovery after LF through the `ChildObservation` interface.
- `child-event-ingestion.test.ts:46-58` covers split ASCII records, blank and malformed lines, and tail flush through the ingestion interface. It does not split a multibyte character.
- `child-runner.test.ts:107-125` exercises the runner's reader through RPC and probe streams, but not decoder boundaries or detach.
- `_shared/file-discovery.test.ts` has 2 tests, both using the Node fallback. Neither exercises the `fd` or `rg` stream reader.

### Termination: three target implementations and two Plan consumers

1. `telemetry-cache-effort/child-runner.ts:243-269` implements idempotent stop with `stopPromise ??=`.
   - If its private `exited` flag is set, it detaches readers and returns.
   - Otherwise it sends pid SIGTERM immediately, schedules pid SIGKILL at 1,000 ms, and schedules give-up resolution at 2,000 ms from the initial SIGTERM. Exit clears both timers and resolves early.
   - Its child spawn is detached on non-Windows at `child-runner.ts:357-362`, so pid signals do not target descendants.
2. `tools-subagents/child-execution.ts:284-314` installs one abort listener.
   - It sends pid SIGTERM and schedules a callback at 3,000 ms.
   - The callback is `!proc.killed && proc.kill("SIGKILL")`. Node sets `ChildProcess.killed` when `kill()` successfully sends SIGTERM, not when the process exits. The normal successful-SIGTERM path therefore suppresses SIGKILL. The source does not currently provide reliable TERM-to-KILL escalation.
   - Process `close` or `error` settles the owner promise. `cancelProcessWait` removes the abort listener and clears the timer after settlement.
   - The subagent spawn is not detached, so pid signaling remains the intended policy.
3. `_shared/process.ts:3-11` implements immediate group SIGKILL.
   - A child without a pid is a no-op.
   - Windows calls `child.kill("SIGKILL")`.
   - Other platforms call `process.kill(-child.pid, "SIGKILL")` and fall back to `child.kill("SIGKILL")` if group signaling throws.
   - All signaling errors are contained.
4. `workflows-plan/plan-sandbox.ts` imports that helper and calls it in three places: command finish at line 77, abort at line 80, and timeout at line 86. The finish call deliberately catches descendants that remain after their shell exits.
5. `workflows-plan/plan-workspace.ts` imports the helper and calls it once on clone abort at line 64. Both Plan spawns are detached on non-Windows.

Relevant existing tests are narrower than the plan previously claimed:

- `child-runner.test.ts:127-144` checks that cancellation sends SIGTERM and removes the temporary directory. Its fake exits on the first signal, so it does not cover escalation, the 2-second give-up window, or group signaling.
- `child-execution.test.ts:446-465` checks SIGTERM for caller abort and timeout, then manually emits `close`. It does not advance 3 seconds or assert SIGKILL.
- Plan unit tests inject above `runSandboxed` or `runCloneCommand`; they do not call `killProcessGroup`. The guarded sandbox integration test indirectly exercises disposal of a long-running command.
- `_shared/process.ts` has no direct test.

### Related implementations deliberately left outside

Repository-wide searches found other process and decoding code. They stay outside for concrete reasons:

- `_shared/git.ts` incrementally decodes stdout and stderr with `StringDecoder`, but it accumulates bounded text and never frames stream records. Its timeout and abort paths use immediate pid `child.kill()` and settle the Git operation at once. It remains the Git executor.
- `_shared/file-discovery.ts` keeps command selection, result limits, trimming, and limit-triggered pid kill. Only its line framing moves.
- `tools-subagents/child-execution.ts`, `workflows-plan/plan-sandbox.ts`, and `workflows-plan/plan-workspace.ts` keep stderr accumulation. This work does not introduce a generic text accumulator.
- `_shared/browser.ts` starts a detached browser and deliberately does not terminate it.
- `skills/github-repo-explorer/scripts/github-repo-snapshot.mjs` has its own detached subprocess and Windows `taskkill` behavior. It is a standalone JavaScript CLI outside the extension TypeScript modules.
- `extensions-disabled/integration-fleet/integration-codex/index.ts` contains two disabled 3-second termination copies. Disabled extensions are not runtime consumers of the new module.

These exclusions mean the module does not claim to own every subprocess in the repository. It owns the repeated mechanics used by the active extension consumers listed above.

## Design decisions

| Decision | Final answer | Reason |
| --- | --- | --- |
| Module placement | Add `_shared/child-process.ts` with stateless functions. | Shared modules are instantiated per extension. Stateless decoder and termination objects belong to individual calls, so no global registry is needed. The loader behavior is documented in `_shared/editor-slot.ts:13-17` and `_shared/status-registry.ts:4-7`. |
| Process spawning | Keep spawning in every current owner. | RPC, JSON ingestion, observation fd 3, sandbox execution, and file discovery have different spawn arguments and lifetimes. A `runChildProcess` facade would expose nearly all of those differences and would be shallow. |
| Invocation | Export one `resolvePiInvocation` and one `PiInvocation` result. | Both Pi callers need the same resolution branches. Cache-effort consumes `exact`; subagents deliberately ignore it. |
| Line framing | Export `createLineReader`. | Four active consumers need incremental decoding and LF framing. Callers retain parsing, trimming beyond one CR, size policy, stream wiring, and command-limit behavior. |
| Stream convenience | Do not export `attachLineReader`. | Only cache-effort would use it after migration, and it merely adds two listeners. It is a one-consumer pass-through with no leverage. Cache-effort keeps its private attach/detach wiring around the shared reader. |
| Immediate group kill | Move `killProcessGroup` unchanged from `_shared/process.ts`. | Plan teardown requires synchronous SIGKILL with no grace period and no await. Folding it into an asynchronous escalation call would obscure that invariant. |
| Escalation | Export `terminateChildProcess(child, options): Promise<void>` with required timing policy. | Cache-effort awaits exit or a deadline. Subagents start the same mechanics but continue to let their existing `close` or `error` listeners settle execution. No caller uses a termination outcome value, so there is no `TerminationOutcome` type. |
| Clock injection | Use normal timers and Vitest fake timers. | There is no production clock adapter. Adding one would create a hypothetical seam. |
| Documentation | Keep the planning-time Child process module entry, then correct its consumer list and exact timing terms when implementation lands. | The current entry omits file discovery and does not define whether its termination deadline starts before or after SIGKILL. |

## Target interface and exact semantics

```ts
export interface PiInvocation {
	command: string;
	baseArgs: string[];
	exact: boolean;
}

export function resolvePiInvocation(argvEntry?: string): PiInvocation;

export interface LineReader {
	push(chunk: Buffer | string): void;
	end(): void;
}

export function createLineReader(
	onLine: (line: string) => void,
	options?: { maxLineBytes?: number },
): LineReader;

export function killProcessGroup(child: ChildProcess): void;

export function terminateChildProcess(
	child: ChildProcess,
	options: { graceMs: number; killWaitMs?: number; group?: boolean },
): Promise<void>;
```

`resolvePiInvocation` preserves the cache-effort branch order exactly:

1. Use `argvEntry`, whose default value is `process.argv[1]`. Omission and an explicit `undefined` both use the process argument; an explicit empty string bypasses it.
2. A successful realpath ending in `.mjs`, `.cjs`, or `.js`, case-insensitively, wins even under Bun.
3. Otherwise Bun uses `process.execPath` with no base arguments and `exact: true`.
4. Otherwise use `pi` with no base arguments and `exact: false`.

`createLineReader` has these semantics:

- It passes Buffer chunks through `StringDecoder`. It UTF-8 encodes string chunks to Buffer first, then passes them through the same decoder. Mixed chunk types therefore cannot reorder text around a decoder-held partial sequence.
- LF terminates a line. One CR immediately before LF or at the final tail is removed. Other whitespace is retained.
- Empty strings are skipped. Whitespace-only strings are delivered because existing cache behavior distinguishes them; ingestion and observation continue to reject them in their own callbacks.
- `end()` appends `decoder.end()`, flushes one nonempty bounded tail, and is idempotent. Pushes after `end()` do nothing.
- Without `maxLineBytes`, buffering is unbounded as it is today in cache-effort, ingestion, and file discovery.
- `maxLineBytes`, when supplied, must be a positive finite integer. Invalid values throw before reader state is created.
- With `maxLineBytes`, the decoded line's UTF-8 byte count includes a trailing CR and all other whitespace. A line equal to the limit is delivered. A line over the limit is discarded through its next LF. An overlong tail is discarded. The next line after LF is read normally.
- `onLine` exceptions propagate from `push()` or `end()`. Current owners that intentionally contain parser or publication failures keep doing so in their callbacks.

`killProcessGroup` keeps every `_shared/process.ts` branch unchanged, including the no-pid no-op and pid fallback when POSIX group signaling throws.

`terminateChildProcess` has these semantics:

- `graceMs` and `killWaitMs`, when present, are finite nonnegative milliseconds. Invalid values throw synchronously before listeners or timers are installed.
- If `exitCode` or `signalCode` already indicates exit, return an already-resolved promise and send no signal.
- Register `exit` and `close` listeners before signaling so a synchronous fake or fast child cannot race settlement. Either event proves that no later escalation is needed.
- Send SIGTERM immediately. At `graceMs`, send SIGKILL unless exit has occurred. A zero grace sends TERM and then KILL in the same call turn, in that order.
- With `group: true` on non-Windows and a pid, each signal targets `-pid`; if group signaling throws, retry that signal through `child.kill`. Windows and missing-pid cases use `child.kill` for escalation. This differs from the preserved no-pid behavior of the immediate `killProcessGroup` primitive because escalation still has a live child object to signal.
- Signaling failures are contained. The function is safe to call with `void` and cannot create an unhandled rejection.
- Exit or close clears all timers and resolves early.
- If `killWaitMs` is omitted, resolution waits for exit or close. If it is supplied, the promise resolves after SIGKILL plus `killWaitMs` even if neither event arrives. `killWaitMs: 0` resolves immediately after the SIGKILL attempt.
- Resolution removes both process listeners. Timers are not `unref()`ed, matching the current process-lifetime behavior.

The explicit post-kill wait avoids the previous timing ambiguity. Cache-effort uses `graceMs: 1000, killWaitMs: 1000`, preserving its 2,000 ms total deadline. It must not pass a 2,000 ms post-kill wait, which would change shutdown to 3,000 ms.

## Consumer migration

| Consumer | Migration and preserved policy |
| --- | --- |
| Cache-effort child runner | Import `resolvePiInvocation`, `createLineReader`, and `terminateChildProcess`. Delete the local resolver and decoder. Keep a private stream attach function because it owns detach. Replace only `stopOnce` signaling and waiting with `await terminateChildProcess(child, { graceMs: 1000, killWaitMs: 1000, group: true })`. Keep `stopPromise ??=`, the private `exited` fast path, reader detachment after termination settles, exact-resolution refusal, detached spawn, and both spawn and temp-directory dependencies. |
| Subagent child execution | Import `resolvePiInvocation` and `terminateChildProcess`. Delete `resolvePiBinary`, use `command` and `baseArgs`, and ignore `exact`. In the abort listener call `void terminateChildProcess(proc, { graceMs: 3000 })`. Remove `forceKillTimer` and only retain abort-listener cleanup. Keep the non-detached spawn, owner `close` and `error` settlement, child-observation attachment, and spawn dependency. |
| Subagent child event ingestion | Replace its buffer with one `createLineReader(processLine)`. `write()` delegates to `push`; `finish()` calls `end()` before cancelling the throttle and constructing the result. Keep `processLine`, JSON parsing, event meaning, progress serialization, usage, truncation, and terminal result logic unchanged. |
| Child observation module | Replace `createFrameReader` with `createLineReader(callback, { maxLineBytes: MAX_FRAME_BYTES })`. The callback must retain `line.trimEnd()` before `parseFrame`, then publish only a parsed event. Keep `parseFrame`, its defensive size check, all validation, source attribution, publication failure containment, and the existing `data`, stream `end`, stream `close`, child `close`, and child `error` fan-in to idempotent `reader.end()`. |
| File discovery | Replace only the command backend's buffer and `/\r?\n/` split with `createLineReader(acceptLine)`. Wire `data` to `push` and call `end` before `finish` on child close so the tail is accepted first. Keep trimming in `acceptLine`, scan-limit kill, abort behavior, backend fallback, and the Node walker unchanged. |
| Plan sandbox and workspace | Repoint their imports from `_shared/process.ts` to `_shared/child-process.ts`. Do not replace any call with graceful termination. Preserve all three sandbox calls and the one workspace abort call exactly. Delete `_shared/process.ts` after repository search shows no imports remain. |

There is no need to re-export `resolvePiInvocation` from `child-runner.ts`. Repository search found no test or production import of that symbol. `probe-protocol.test.ts` does not use it.

## Intentional observable changes

Exactly five changes are intended:

1. A subagent under Bun whose entry does not resolve to a JavaScript path uses the Bun runtime executable instead of PATH `pi`.
2. Subagent stdout preserves a multibyte UTF-8 character split across Buffer chunks.
3. File names emitted by `fd` or `rg` preserve a multibyte UTF-8 character split across Buffer chunks.
4. Cache-effort SIGTERM and SIGKILL target its detached process group on non-Windows, with pid fallback if group signaling fails. The grace and total give-up times remain 1,000 ms and 2,000 ms.
5. A stubborn subagent receives SIGKILL 3,000 ms after SIGTERM. The current `proc.killed` guard normally prevents that escalation after a successful SIGTERM send.

Empty-line handling is not an observable owner-level change. Cache-effort already skips empty lines, while ingestion and observation already reject them before producing events. The new reader merely makes that common framing rule explicit. The shared `exact` field is also not an observable subagent change because subagents ignore it.

## Migration sequence

1. Add `_shared/child-process.ts` and `_shared/child-process.test.ts`. Implement all four functions and the exact semantics above. Run `pnpm --dir .pi test:shared`.
2. Migrate `child-event-ingestion.ts`. Extend its existing framing test with a multibyte character split between Buffer chunks so the consumer wiring, not only the shared reader, proves the regression fixed. Run `pnpm --dir .pi test:subagents`.
3. Migrate `_shared/child-observation/index.ts`. Keep its current split-Unicode, exact-limit overflow, recovery, and fan-in coverage. Run `pnpm --dir .pi test:shared`.
4. Migrate `_shared/file-discovery.ts`. Keep its 2 Node fallback tests unchanged. Do not add a spawn dependency or export a private command helper solely to duplicate the shared reader's decoder-boundary test. Run `pnpm --dir .pi test:shared` and `pnpm --dir .pi test:subagents`, because `repo-query` also consumes file discovery.
5. Migrate `telemetry-cache-effort/child-runner.ts`. Update its cancellation test to mock POSIX `process.kill`, assert group SIGTERM with the fake child's negative pid, and restore the mock. On Windows, assert pid SIGTERM through `child.kill`. Keep escalation timing and fallback branches in the shared test. Run `pnpm --dir .pi test:cache-effort`.
6. Migrate `tools-subagents/child-execution.ts`. Extend the abort/timeout test to use fake timers and prove SIGKILL occurs at 3,000 ms when no exit occurs, then prove close prevents a later kill. Run `pnpm --dir .pi test:subagents`.
7. Move `killProcessGroup`, repoint both Plan imports, and delete `_shared/process.ts`. Run `pnpm --dir .pi test:plan`.
8. Update `CONTEXT.md`. The Child process module entry must name file discovery as a line-reader consumer, distinguish the 1,000 ms grace plus 1,000 ms post-kill cache wait from the 3,000 ms subagent grace, and retain the explicit Git exclusion. Update the Subagent child execution and Child observation entries to say which mechanics they delegate. Run `pnpm --dir .pi typecheck`, then `pnpm --dir .pi test`.

## Test plan

Create `_shared/child-process.test.ts` and test through exported interfaces. Use temporary files for invocation paths, `PassThrough` only where stream behavior is under a caller test, EventEmitter-based fake children with `exitCode`, `signalCode`, `pid`, and `kill`, `vi.spyOn(process, "kill")` for POSIX group tests, and Vitest fake timers. No test may send a real process-group signal.

### Invocation cases

Cover the complete branch taxonomy:

- Existing lowercase and uppercase `.js`, `.mjs`, and `.cjs` entries resolve through realpath and win over Bun fallback.
- A symlink is classified by its real target path, not its link name.
- A directory whose real path ends in a supported JavaScript suffix is classified as exact, preserving the current lack of a regular-file check.
- Existing non-JavaScript, missing, and explicit empty entries reach the fallback branches.
- For omitted and explicit-`undefined` arguments, mock `process.argv[1]` with JavaScript, non-JavaScript, missing, and empty values and assert the same branch rules.
- Each fallthrough case under Bun returns `process.execPath`, no base arguments, and `exact: true`.
- Each fallthrough case without Bun returns `pi`, no base arguments, and `exact: false`.
- A defined explicit `argvEntry`, including an empty string, takes precedence over `process.argv[1]`.

Restore any mocked `process.versions.bun`, `process.argv`, and filesystem state after each test.

### Line-reader cases

Cover delimiters, decoding, bounds, and lifecycle:

- Multiple lines in one chunk and one line split across chunks.
- A CJK or emoji code point split at every interior byte boundary between Buffer chunks.
- Pure string chunks, plus a Buffer-to-string-to-Buffer transition while the decoder holds an incomplete code point. The output must remain ordered and use replacement characters for invalid byte sequences.
- LF, CRLF, a final tail ending in CR, and retained non-CR whitespace.
- Consecutive empty lines are skipped; whitespace-only lines are delivered.
- A tail without LF is delivered once. Repeated `end()` and pushes after `end()` do not deliver again.
- Invalid zero, negative, nonfinite, and fractional byte limits throw before accepting input.
- With a small byte limit, lines below and exactly at the limit are delivered, while limit plus one is discarded.
- Multibyte byte accounting, including the fact that a trailing CR counts before removal.
- Overlong lines split across chunks, overlong tails, recovery after LF in the same chunk, and recovery when LF arrives later.
- `onLine` exceptions propagate.

The existing Child observation test remains valuable because it checks framing, parsing, source attribution, and publication together. The existing ingestion framing test remains valuable because it checks malformed-line handling and result construction. They are not replaced by shared tests.

### Termination cases

Cover immediate state, signal targets, timers, and cleanup:

- Already exited by `exitCode` and already signaled by `signalCode` resolve without signaling.
- SIGTERM is immediate. SIGKILL does not occur before grace and occurs exactly at 1,000 ms and 3,000 ms policies.
- `graceMs: 0` sends TERM then KILL in order.
- Exit or close before grace clears the kill timer and resolves. Either event after KILL but before the post-kill deadline resolves early.
- `graceMs: 1000, killWaitMs: 1000` resolves at a 2,000 ms total deadline for a stubborn child.
- Omitting `killWaitMs` does not resolve a stubborn child's promise merely because SIGKILL was attempted.
- `killWaitMs: 0` resolves immediately after the KILL attempt.
- Pid mode calls `child.kill`. POSIX group mode calls `process.kill(-pid, signal)` for both TERM and KILL. A thrown group signal falls back to `child.kill` for the same signal. Windows behavior calls `child.kill`; test it by temporarily overriding `process.platform` using the pattern already used in `_shared/browser.test.ts`.
- Escalation with `group: true` and no pid falls back to `child.kill`. The separate `killProcessGroup` no-pid case remains a no-op.
- `killProcessGroup` preserves POSIX group SIGKILL, Windows pid SIGKILL, thrown-group fallback, no-pid no-op, and error containment.
- Invalid negative, nonfinite, and fractional timing values throw before signaling.
- Signal failures do not reject or leak an unhandled rejection. Promise resolution still follows exit or `killWaitMs`.
- Resolution removes listeners and leaves no pending fake timers.

Caller tests retain ownership assertions:

- `child-runner.test.ts` keeps exact launch flags, RPC and probe integration, cancellation cleanup, and first TERM behavior.
- `child-execution.test.ts` keeps argument ordering, observation wiring, injected spawn, abort and timeout ownership, close and error result construction, and cleanup.
- `child-event-ingestion.test.ts` keeps JSON event meaning, progress ordering, output selection, and terminal status.
- `child-observation/index.test.ts` and `child-extension.test.ts` keep best-effort observation behavior.
- `file-discovery.test.ts` keeps backend-independent result policy and Node fallback behavior.
- Plan unit and guarded integration tests keep immediate teardown and disposable-workspace behavior.

## Risks controlled by the checklist

- Group signaling in tests can hit an unrelated operating-system process if `process.kill` is not mocked. Shared tests must mock it before using fake negative pids.
- The cache-effort deadline can accidentally become 3 seconds if the post-kill wait is confused with the existing absolute give-up deadline. The interface uses `killWaitMs: 1000`, and the test pins total settlement at 2 seconds.
- Listening after signaling can miss a synchronous fake exit or close. The helper installs both listeners first.
- `ChildProcess.killed` does not mean exited. The new escalation never uses it as an exit test.
- Child observation trims all trailing whitespace before parsing. The migration retains that adapter callback rather than broadening the shared reader's CR rule.
- Child observation's byte cap includes whitespace before trimming and allows exactly 8 MiB. Shared boundary tests pin both facts.
- File discovery must flush its reader before settling the close handler or it will lose a final unterminated file name.
- A fire-and-forget termination promise must not reject. Signal failures are contained inside the helper.
- Per-extension module copies cannot fork shared state because the module has no module-level mutable state. Each reader and termination operation owns only call-local state.

## Definition of done

- Repository search finds one active Pi invocation resolver, one incremental UTF-8 line-reader implementation for the four migrated consumers, one immediate group-kill implementation, and one graceful escalation implementation.
- `_shared/process.ts`, the local cache resolver and decoder, the subagent resolver and stdout buffer, the Child observation frame reader, and the file-discovery command buffer are gone.
- Cache-effort still refuses a non-exact PATH guess, settles a stubborn stop after 2 seconds total, detaches its readers, removes its temporary directory, and now targets its detached process group.
- Subagents retain their public and injection interfaces, preserve split UTF-8 output, and actually escalate a stubborn process after 3 seconds.
- Child observation retains exact 8 MiB behavior, trailing-whitespace parsing, end/close/error fan-in, and best-effort failure containment.
- Plan sandbox and workspace retain synchronous immediate group SIGKILL at all four existing call sites.
- No `attachLineReader`, `TerminationOutcome`, injectable clock, process runner facade, or generic text accumulator is added.
- `CONTEXT.md` matches the implemented consumer list and timing semantics.
- `pnpm --dir .pi typecheck` and the full `pnpm --dir .pi test` pass.
