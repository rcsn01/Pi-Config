# Compaction for Pi subagents

Research date: 2026-09-09

## Recommendation

Load this repository's `session-compaction` extension explicitly in every subagent child while retaining `--no-extensions`:

```text
--no-extensions
--extension /absolute/path/to/.pi/extensions/session-compaction/index.ts
```

For the current subprocess design, this is the smallest change and the best fit. It keeps child extension discovery disabled, gives children the same 80 percent threshold and overflow recovery as the main session, and does not require a second Pi configuration directory.

Implement it in [`.pi/extensions/tools-subagents/child-execution.ts`](../.pi/extensions/tools-subagents/child-execution.ts) by adding the resolved `session-compaction/index.ts` path to the initial child extension set. Keep tool-specific extensions in the same set so Pi emits one `--extension` argument per unique path.

## Why compaction is currently absent

The child launcher starts Pi with `--no-session`, `--no-skills`, and `--no-extensions`, then explicitly loads only extensions needed by the agent's tools. See [`buildPiArgs()`](../.pi/extensions/tools-subagents/child-execution.ts) and the documented child policy in [`tools-subagents/README.md`](../.pi/extensions/tools-subagents/README.md#child-pi-selection).

Both the global and project settings disable Pi's native compaction. The main session still compacts because [the project extension](../.pi/extensions/session-compaction/index.ts) calls `ctx.compact()` at 80 percent usage and on recoverable overflow. Children do not discover that extension because of `--no-extensions`, so they have neither native nor extension-owned automatic compaction.

`--no-session` is not the problem. It selects an ephemeral session rather than removing session state. Pi's SDK documents `SessionManager.inMemory()` together with `AgentSession.compact()`, and Pi's CLI describes `--no-session` as ephemeral mode. [Pi SDK](https://pi.dev/docs/latest/sdk#session-management) [Pi usage](https://pi.dev/docs/latest/usage#sessions)

## Why explicit extension loading is supported

Pi treats extension discovery and explicit extension paths separately. Its CLI help says `--no-extensions` disables discovery while explicit `-e` paths still work. The resource loader confirms this: when `noExtensions` is true, it loads `cliEnabledExtensions` and omits discovered extensions. [Pi usage](https://pi.dev/docs/latest/usage#command-line-reference) [`resource-loader.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/resource-loader.ts)

This gives the child a narrow extension set:

```text
session-compaction/index.ts
plus extensions required by declared child tools
```

It avoids loading unrelated project extensions into isolated children.

## Options considered

### Enable Pi's native compaction in settings

Pi's native automatic compaction is sound. It is enabled by default, checks the threshold during multi-turn runs, and retries once after recoverable overflow. The defaults reserve 16,384 tokens and keep 20,000 recent tokens. [Pi compaction docs](https://pi.dev/docs/latest/compaction) [Pi settings](https://pi.dev/docs/latest/settings#compaction)

It is not the best fit here because the same global and project settings feed both the main process and child processes. Pi has no per-launch `--compaction` flag. Turning native compaction on in `.pi/settings.json` would also change the main runtime, whose `session-compaction` extension deliberately disables and replaces the native policy. A separate `PI_CODING_AGENT_DIR` could isolate child settings, but it would also require separate handling for credentials, model catalogs, and other Pi configuration.

Verdict: good Pi default, poor fit for this repository's shared settings and replacement compactor.

### Explicitly load `session-compaction`

This reuses the policy already tested for the main agent:

- compaction at 80 percent of the selected model's context window;
- continuation after successful mid-task compaction;
- one recovery attempt after context overflow or recoverable truncation;
- custom cache-aware summaries with fallback to Pi's native summary generator.

Print and JSON modes support this continuation path. `runPrintMode()` awaits `session.prompt()`, while `AgentSession` continues when post-run handlers queue work. The extension uses `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`, which is the supported queue API. [`print-mode.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/print-mode.ts) [`agent-session.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts) [Pi extension API](https://pi.dev/docs/latest/extensions#pisendmessagemessage-options)

Verdict: best option for the current subprocess implementation.

### Replace subprocesses with SDK sessions

The SDK allows exact child-local settings:

```ts
const settingsManager = SettingsManager.inMemory({
  compaction: {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
  },
});

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager,
});
```

This gives the cleanest settings isolation. A `DefaultResourceLoader` can also load only selected extension paths. [Pi SDK settings](https://pi.dev/docs/latest/sdk#settings-management) [Pi SDK extensions](https://pi.dev/docs/latest/sdk#extensions)

It would replace the subagent process boundary and require work for process isolation, event ingestion, cancellation, provider setup, and failure containment. That cost is not justified merely to turn compaction on.

Verdict: strongest option if the subagent runner later moves in-process, not the right patch now.

## Risks and safeguards

### The extension can write project settings

Pi extensions have full process permissions. This extension's `session_start` handler ensures `<cwd>/.pi/settings.json` contains `compaction.enabled: false`, because it owns automatic compaction and vetoes native threshold and overflow compaction. [Pi extension security](https://pi.dev/docs/latest/extensions#extension-locations) [`session-compaction/index.ts`](../.pi/extensions/session-compaction/index.ts)

In this repository the setting is already false, so child startup does not write it. A child launched in another working directory could change that project's setting if the file exists and native compaction is enabled. If cross-project subagent execution is common, add a child-runtime mode to the compaction extension that skips settings persistence. Do not rely on `--no-approve`; explicitly loaded extensions can use Node filesystem APIs directly.

### A single huge tool result can cross the threshold

The extension checks usage at the end of a tool/model cycle. One very large `ddg_fetch` result can push context far beyond 80 percent before the check runs. The custom summarizer first tries the full branch context. If that request fails, it returns control to Pi's native manual compactor, whose serializer truncates each tool result to 2,000 characters for the summary request. [Pi compaction serialization](https://pi.dev/docs/latest/compaction#message-serialization) [`cache-aware-compaction.ts`](../.pi/extensions/_shared/cache-aware-compaction.ts)

Compaction should still be paired with a hard output limit for `ddg_fetch`. Compaction is a safety net, not a substitute for bounding tool output.

### Provider extensions remain separate

The compaction extension can summarize only if the child's selected provider is available. Built-in providers are available normally. A model supplied solely by another provider extension still requires that provider extension in the child's explicit extension set. The existing subagent README already calls out this restriction.

## Suggested patch and tests

Derive the path instead of hardcoding the checkout location:

```ts
export const CHILD_RUNTIME_EXTENSIONS = [
  path.join(EXT_BASE, "session-compaction", "index.ts"),
];

const extensionPaths = new Set<string>(CHILD_RUNTIME_EXTENSIONS);
```

Then retain the current tool-extension mapping loop.

Add focused tests in `child-execution.test.ts`:

1. Every child command contains `--no-extensions` and exactly one `session-compaction/index.ts` argument.
2. Researcher children contain the compactor plus web search and fetch extensions.
3. Explorer and worker children contain the compactor plus only their required custom tool extensions.
4. Duplicate paths remain deduplicated.

An integration test should run a child with a deliberately small-context test model or fake provider, generate enough tool output to cross the threshold, and assert that a compaction event occurs before the child completes. Command-construction tests alone prove loading, not runtime behavior.

## Decision

Use explicit child extension loading now. Do not enable native compaction globally, and do not rewrite the runner around the SDK for this change. Follow up by preventing the compaction extension from mutating settings when it runs as child infrastructure, and cap `ddg_fetch` output so one fetch cannot consume most of a context window.
