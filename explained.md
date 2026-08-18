codex:

Short answer: auto-compaction is not limited to the end of a user turn. It can happen mid-turn, between tool/model cycles.

  A typical sequence is:

  1. I request a tool call.
  2. The tool finishes and returns its output.
  3. Before the system asks me to continue, it evaluates the newly assembled context.
  4. If the compaction threshold has been crossed, it summarizes/compacts earlier context.
  5. I continue the same user turn using that compacted context.

  It does not normally interrupt a tool while the tool is running. Also, it generally uses a threshold below the model’s hard context-window limit, because waiting until
  the window is completely full would leave no room for the next response.

  One user “turn” can therefore contain several separate model invocations:

  model → tool → model → tool → compaction → model → final answer

  Compaction can also occur between completed user turns, whenever the next model invocation is being prepared.

  The official Responses API documentation describes an even more integrated version: once the configured rendered-token threshold is crossed, the server can emit a
  compaction item, prune the earlier context, and continue inference within the same response stream. OpenAI’s compaction documentation
  (https://developers.openai.com/api/docs/guides/compaction)

  For this Codex app specifically, the exact threshold and scheduling algorithm aren’t publicly guaranteed and may change. From my perspective, compaction happens outside
  the model: I simply receive a summarized context on a subsequent invocation and continue from it. So the closest answer to your first option is: usually after the tool
  result becomes available and before the next model continuation—not necessarily after the entire turn.

Claude:

Neither, quite. It's checked at the loop boundary — right before each request to the model, not at the end of your turn and not the instant a tool finishes.

The actual sequence

The agent loop looks roughly like:

1. Harness assembles messages → sends request
2. Model responds (maybe with tool calls)
3. Tools execute, results appended to the message list
4. ← check happens here: is projected token count over the threshold?
5. If yes: compact first, then go to 1. If no: go to 1 directly.

So a tool call finishing doesn't itself trigger anything — the tool result just lands in the message list. What triggers compaction is the harness getting ready to build the next request and noticing the context won't comfortably fit.

Practical consequences

- It can fire mid-task. If I'm ten tool calls deep into a refactor, compaction can happen between call 7 and call 8. It does not wait for me to finish and hand control back to you.
- It never interrupts an in-flight request. Once a request is sent, it runs to completion. Compaction only happens in the gap between requests.
- It's pre-emptive, not reactive. The trigger is a threshold below the true limit (there has to be headroom for the summarization call itself plus the next response), so it fires before an overflow error rather than in response to one.
- A single giant tool result can still blow past it. If one tool returns something enormous, the check catches it on the next boundary — but the result is already in the list, which is why compaction sometimes kicks in immediately after one big file read or command output.

Related mechanism worth knowing

Full auto-compact (summarize everything, restart from the summary) isn't the only thing that reclaims space. There's also incremental clearing of older tool results — stale outputs get dropped while the surrounding conversation stays intact. That's cheaper and runs more often, which is why you'll sometimes see context usage drop without a visible "compacting" step. The description in my own system prompt matches this: some or all of the context gets summarized, and the summary plus whatever remains unsummarized carries into the next window.

You can turn auto-compact off in /config, in which case you get warnings as you approach the limit and eventually a hard error instead. /compact forces it manually at a moment of your choosing — useful right after finishing a chunk of work, so the summary is written at a clean boundary rather than mid-refactor.

One caveat: I can't read Claude Code's source from this repo, so the loop structure above is from documented and observed behavior rather than from reading the implementation. The exact threshold percentage in particular I'd treat as approximate.
