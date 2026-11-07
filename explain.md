# Claude Code's Bash and Monitor tools

This is the full text Claude Code gives the model about its two tools for long-running commands: the tool descriptions, the parameter schemas, and other system-prompt lines that mention them. Everything in the blockquotes is verbatim.

---

## Quick reference

| Need | Tool |
|---|---|
| Run a long script and know when it's done | Bash with `run_in_background` |
| Wait for one condition (server ready, file appears) | Bash with `run_in_background` and an `until` loop |
| Get notified on every matching event (errors, CI steps) | Monitor |
| Stream events pushed by a server | Monitor with `ws` |

| | Bash (`run_in_background`) | Monitor |
|---|---|---|
| Notifications | One, when the command exits | One per stdout line (lines within 200ms are batched) |
| Default timeout | 30 min (1800000 ms) | 5 min (300000 ms) |
| Max timeout | 2 h (7200000 ms) | 30 min (1800000 ms, higher values are capped) |
| At timeout | Stopped, model re-invoked | Killed, one notice with event count; can re-arm |
| Cancel early | TaskStop | TaskStop |
| Loaded by default | Yes | No (deferred tool, loaded via ToolSearch) |

---

## Bash tool

### Description

> Executes a bash command and returns its output.
>
> - Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.
> - Command output is displayed to you, not reliably to the user.
> - `timeout` is in milliseconds: default 120000, max 600000 for a foreground command.
> - `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. With it, `timeout` is how long the command may run in the background (default 1800000, max 7200000); at that limit it is stopped and you are re-invoked. No `&` needed. Foreground `sleep` is blocked; use Monitor with an until-loop to wait on a condition.
>
> # Git
> - Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.
> - Use the `gh` CLI for GitHub operations (PRs, issues, API).
> - Commit or push only when the user asks. If on the default branch, branch first.
> - End git commit messages and PR bodies with the attribution lines given in the conversation's system-reminder, when one is present.

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | yes | The command to execute |
| `description` | string | no | Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does. Say what the command does in plain words: do not echo the command's text, its flags, or file paths - the user reads this description, often without seeing the command. For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words). For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does. |
| `timeout` | number | no | Optional timeout in milliseconds (max 600000 for a foreground command) |
| `run_in_background` | boolean | no | Set this to true to run this command in the background. With it, `timeout` limits how long the command may run in the background before it is stopped (default 1800000 ms, max 7200000 ms). |
| `dangerouslyDisableSandbox` | boolean | no | Set this to true to dangerously override sandbox mode and run commands without sandboxing. |

Examples given for `description`:

> - ls → "List files in current directory"
> - git status → "Show working tree status"
> - npm install → "Install package dependencies"
> - find . -name "*.tmp" -exec rm {} \; → "Find and delete all .tmp files recursively"
> - git reset --hard origin/main → "Discard all local changes and match remote main"
> - curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"

### Bash in the rest of the system prompt

General harness guidance:

> Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.

> If you need the user to run a shell command themselves (e.g., an interactive login like `gcloud auth login`), suggest they type `! <command>` in the prompt — the `!` prefix runs the command in this session so its output lands directly in the conversation.

When auto mode is active:

> You can do much of your work through the Bash tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated Read, Edit, or Write tools. The choice is yours: prefer Edit or Write when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.

From the ScheduleWakeup tool, about not polling background work:

> Do NOT schedule a short-interval wakeup to poll for background work you started — when harness-tracked work finishes, you are re-invoked automatically, so polling is wasted. Instead schedule a long fallback (1200s+) so the loop survives if the work hangs or never notifies. The exception is external work the harness cannot track (a CI run, a deploy, a remote queue) — there, pick a delay matched to how fast that state actually changes.

---

## Monitor tool

Monitor is a **deferred tool**. At first the model sees only its name in a list. The full description and schema below appear only after it is loaded with `ToolSearch("select:Monitor")`.

### Description

> Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.
>
> Pick by how many notifications you need:
> - **One** ("tell me when the server is ready / the build finishes") → use **Bash with `run_in_background`** and a command that exits when the condition is true, e.g. `until grep -q "Ready in" dev.log; do sleep 0.5; done`. You get a single completion notification when it exits.
> - **One per occurrence, until the monitor expires (re-arm to continue)** ("tell me every time an ERROR line appears") → Monitor with an unbounded command (`tail -f`, `inotifywait -m`, `while true`).
> - **One per occurrence, until a known end** ("emit each CI step result, stop when the run completes") → Monitor with a command that emits lines and then exits.
>
> Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.
>
> ```bash
> # Each matching log line is an event
> tail -f /var/log/app.log | grep --line-buffered "ERROR"
>
> # Each file change is an event
> inotifywait -m --format '%e %f' /watched/dir
>
> # Poll GitHub for new PR comments and emit one line per new comment
> last=$(date -u +%Y-%m-%dT%H:%M:%SZ)
> while true; do
>   now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
>   gh api "repos/owner/repo/issues/123/comments?since=$last" --jq '.[] | "\(.user.login): \(.body)"'
>   last=$now; sleep 30
> done
>
> # Node script that emits events as they arrive (e.g. WebSocket listener)
> node watch-for-events.js
>
> # Per-occurrence with a natural end: emit each CI check as it lands, exit when the run completes
> prev=""
> while true; do
>   s=$(gh pr checks 123 --json name,bucket)
>   cur=$(jq -r '.[] | select(.bucket!="pending") | "\(.name): \(.bucket)"' <<<"$s" | sort)
>   comm -13 <(echo "$prev") <(echo "$cur")
>   prev=$cur
>   jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break
>   sleep 30
> done
> ```
>
> **Don't use an unbounded command for a single notification.** `tail -f`, `inotifywait -m`, and `while true` never exit on their own, so the monitor stays armed until timeout even after the event has fired. For "tell me when X is ready," use Bash `run_in_background` with an `until` loop instead (one notification, ends in seconds). Note that `tail -f log | grep -m 1 ...` does *not* fix this: if the log goes quiet after the match, `tail` never receives SIGPIPE and the pipeline hangs anyway.
>
> **Script quality:**
> - Every pipe stage must flush per line or matches sit in its buffer unseen: `grep` needs `--line-buffered`, `awk` needs `fflush()`. `head` cannot flush at all — `| head -N` delivers nothing until N matches accumulate, then ends the stream.
> - In poll loops, handle transient failures (`curl ... || true`) — one failed request shouldn't kill the monitor.
> - Poll intervals: 30s+ for remote APIs (rate limits), 0.5-1s for local checks.
> - Write a specific `description` — it appears in every notification ("errors in deploy.log" not "watching logs").
> - Only stdout is the event stream. Stderr goes to the output file (readable via Read) but does not trigger notifications — for a command you run directly (e.g. `python train.py 2>&1 | grep --line-buffered ...`), merge stderr with `2>&1` so its failures reach your filter. (No effect on `tail -f` of an existing log — that file only contains what its writer redirected.)
>
> **Coverage — silence is not success.** When watching a job or process for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to "still running." Before arming, ask: *if this process crashed right now, would my filter emit anything?* If not, widen it.
>
> ```bash
> # Wrong — silent on crash, hang, or any non-success exit
> tail -f run.log | grep --line-buffered "elapsed_steps="
>
> # Right — one alternation covering progress + the failure signatures you'd act on
> tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"
> ```
>
> For poll loops checking job state, emit on every terminal status (`succeeded|failed|cancelled|timeout`), not just success. If you cannot confidently enumerate the failure signatures, broaden the grep alternation rather than narrow it — some extra noise is better than missing a crashloop.
>
> **Output volume**: Every stdout line is a conversation message, so the filter should be selective — but selective means "the lines you'd act on," not "only good news." Never pipe raw logs; filter to exactly the success and failure signals you care about. Monitors that produce too many events are automatically stopped; restart with a tighter filter if this happens.
>
> Stdout lines within 200ms are batched into a single notification, so multiline output from a single event groups naturally.
>
> The script runs in the same shell environment as Bash. Exit ends the watch (exit code is reported). Every monitor expires after `timeout_ms` (default 5 minutes, at most 30 minutes): it is killed and you get one notice with the event count. Re-arm it if you still need the watch; for a long watch (PR monitoring, log tails) set `timeout_ms` to the maximum and re-arm on each expiry, and widen the filter if an expiry with no events was unexpected. Use TaskStop to cancel early.
>
> **ws source** — open a WebSocket and stream each incoming text frame as an event. No shell, no polling: the server pushes, you get notified.
>
> ```js
> Monitor({
>   ws: {url: 'wss://events.example.com/stream', protocols: ['v1']},
>   description: 'deploy events',
> })
> ```
>
> Each text frame becomes one notification (multiline frames stay as one event). Binary frames are reported as `[binary frame, N bytes]` rather than passed through. Socket close ends the watch with the close code surfaced; errors are surfaced before close. Same rate limiting as bash — a firehose will be suppressed and eventually stopped, so subscribe to a filtered feed where one exists.
>
> Prefer this over `command: 'websocat wss://…'` — it avoids the extra process and line-buffering pitfalls. Use bash when you need to transform or filter frames with shell tools before they become events.

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `description` | string | yes | Short human-readable description of what you are monitoring (shown in notifications). |
| `timeout_ms` | number | yes | Kill the monitor after this deadline. Default 300000ms. Deadlines above 1800000ms are capped to 1800000ms. You are notified at expiry and can re-arm. (Schema bounds: minimum 1000, maximum 3600000.) |
| `command` | string | one of `command` / `ws` | Shell command or script. Each stdout line is an event; exit ends the watch. |
| `ws` | object | one of `command` / `ws` | WebSocket to open. Each text frame is an event; binary frames are reported as a placeholder line. Socket close ends the watch. Cannot be combined with `command`. Fields: `url` (string, required), `protocols` (array of strings, optional). |
