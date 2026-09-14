# Codex and Claude Code prompt comparison

Research date: 2026-09-14

## Provenance and scope

"Leaked" is inaccurate for Codex CLI. OpenAI publishes Codex under an open-source license, including model-specific prompt files. This comparison uses OpenAI's `gpt_5_2_prompt.md` at commit [`3abbf9f`](https://github.com/openai/codex/blob/3abbf9fe2c6b6910e9de61f6a0c5bb468f74b5c8/codex-rs/core/gpt_5_2_prompt.md). Codex has several prompt variants, so this is representative of that model family, not every Codex session.

Anthropic does not publish Claude Code's source prompt as a canonical document. The Claude material comes from [Piebald's extraction](https://github.com/Piebald-AI/claude-code-system-prompts/tree/17cb250873f43af841cdfb4d76c6b3314b13e04c), which says it extracts strings from Claude Code's compiled npm package. The snapshot identifies itself as Claude Code v2.1.270. It is a third-party artifact, not an Anthropic-authenticated source. Claude Code assembles its prompt conditionally from many fragments and tool descriptions, so no single extracted file represents every session.

"Our prompt" means this repository's effective Pi prompt: [`.pi/SYSTEM.md`](../.pi/SYSTEM.md), [`.pi/APPEND_SYSTEM.md`](../.pi/APPEND_SYSTEM.md), generated skill descriptions, dynamic tool guidelines, project context, and the current working directory. Tool schemas also carry usage policy, but they are not all repeated in the prompt text.

## Short answer

Our prompt is a compact engineering policy. Codex's prompt is a much larger operating manual. Claude Code's extracted prompt is a modular policy system split across main-agent fragments, tool descriptions, subagents, and a separate security monitor.

The strongest parts unique to ours are evidence-efficient execution: batch independent work, stop exploring when evidence is sufficient, verify in proportion to risk, prefer one consolidated review, reassess after two failed attempts, and avoid rereading unchanged files. Codex and Claude overlap with pieces of this, but neither source uses this exact compact loop.

The biggest gaps in ours are explicit Git safety, dirty-worktree handling, prompt-injection boundaries, credential and exfiltration rules, instruction-file precedence, and concrete frontend verification. Codex is strongest on Git and repository etiquette. Claude Code is strongest on layered security and narrowly specified tool behavior.

## Differences

| Topic | Our Pi prompt | OpenAI Codex prompt | Extracted Claude Code prompt |
|---|---|---|---|
| Overall shape | Short stable core, then dynamic skills and tool guidance. | Long model-specific prompt with autonomy, plans, editing, validation, approvals, and output rules. | Hundreds of conditional fragments and tool descriptions. Main-agent behavior cannot be reduced to one static string. |
| Workflow | Explicitly batches independent exploration, stops when evidence is sufficient, makes coherent edit batches, and reassesses after two failed attempts. | Stresses end-to-end persistence and implementation instead of merely proposing a solution. It does not use our two-failure or one-review rules. | Tells the agent to make routine judgments, finish all unblocked scope, and avoid quietly narrowing or expanding the request. It also asks for parallel independent tool calls. |
| Planning | Tracks non-trivial work, requires exactly one item in progress, and clears the list when done. | Uses plans for non-trivial work, not simple tasks. It has strict status transitions and no stale plans. | Uses `TodoWrite`, with each task marked complete immediately. It discourages unrequested planning or analysis documents. |
| Tool use | Uses `read` for files, `bash` for listing and search, and exact replacement through `edit`. The prompt explicitly batches independent calls. | Prefers `rg`, requires `apply_patch`, and describes sandbox or approval escalation. | Prefers dedicated read, glob, grep, and edit tools over shell use. Independent calls should run in parallel; dependent calls run sequentially. |
| Editing | Before `edit`, the old text must be an exact unique match. Separate edits in one file should be sent together. | Requires `apply_patch`, focused changes, existing style, and no unnecessary rereads after a successful patch. The older GPT-5 Codex variant also has detailed ASCII and comment rules. | `Edit` uses exact-string replacement with preserved indentation. It prefers existing files and says not to create files unless needed. |
| Tests and verification | Starts narrow, expands with risk, and runs typechecking or the full suite near completion when applicable. It explicitly calls for integration tests when a changed boundary needs them. | Starts with the narrowest relevant check, then broadens. Test and lint timing may depend on approval mode. It avoids adding tests to repositories with no tests. | Its frontend rule is more concrete: run the development server and test the feature in a browser, including normal, edge, and regression paths. It warns that typechecks and test suites alone do not prove UI behavior. |
| Git | No general Git or dirty-worktree policy in the core prompt. Repository tools and permission extensions may still impose controls outside this text. | Detailed safeguards: preserve user changes, stop on unexpected changes, do not amend or commit unless asked, and never use destructive Git commands without explicit approval. | Detailed commit and PR rules: commit only when asked, avoid destructive commands, stage named files, avoid secrets, do not push unless asked, and verify with `git status`. |
| Autonomy and questions | Says to act directly on small tasks and ask before materially expanding scope. | Strong persistence rule: assume implementation is wanted unless the user is planning, brainstorming, or asking a question. Resolve blockers independently where possible. | Ask only when materially different interpretations change the work. Finish unblocked scope and state assumptions rather than stopping early. |
| Coding principles | Explicit YAGNI, KISS, reuse, standard library preference, dependency restraint, deletion, justified abstractions, root-cause fixes, and clarity. | Strong overlap on root-cause fixes, minimal focused diffs, existing style, and avoiding unnecessary complexity. | Its extracted task rule adds a useful boundary: trust internal guarantees and validate user input or external APIs, rather than adding impossible-case fallbacks or compatibility shims. |
| Safety and security | Names correctness and security as priorities, but has no concrete prompt-injection, credentials, exfiltration, or OWASP rules in the core text. | Has sandbox and approval semantics plus strong destructive-Git protections. The compared prompt allows vulnerability analysis and repository work. | Explicitly warns against OWASP-class flaws. Its separate autonomous-action monitor models prompt injection, scope creep, accidental damage, shared environments, secrets, and irreversible actions. |
| Web access | Exposes explicit search and fetch tools whose descriptions govern sourcing and delegation. The custom core has no web-security section. | The compared base prompt is centered on terminal and patch tools; web behavior depends on available tools and session configuration. | Treats fetched content and downloaded binaries as untrusted data, not instructions. It distinguishes public fetching from authenticated URLs and can delegate to a web-reading agent. |
| Subagents and skills | Lists installed skills with trigger descriptions and has a policy-rich subagent tool. Delegation is reserved for work that examines much more than it returns. | The compared file focuses more on the main agent and planning; subagent availability is harness-dependent. | Ships specialized Explore, Plan, web-reading, review, security, and utility prompts, often with reduced tool access. |
| User updates | The core does not require a pre-tool status line or periodic narration. | Requires concise ongoing status and a self-contained handoff. | Requires a one-sentence intent before the first tool call and brief updates at discoveries, direction changes, and blockers. |
| Final response | Requires concision and clear file paths at the base layer. Active skill instructions can add further constraints. | Has extensive formatting, file-reference, brevity, and next-step rules. | The extracted writing fragment is stricter: lead with the result, use short standalone sentences, avoid em dashes and parentheticals, limit headers, and stop without a closing offer. |
| Environment context | Injects Pi documentation paths, active skills, tool guidance, project context, and current working directory. | Injects repository instruction semantics for scoped `AGENTS.md` files and describes sandbox or approval mode. | Conditionally injects tools, agents, environment data, permissions, and product-specific reminders. |

## What ours does better

- It states a clean evidence budget. "Stop investigating once the evidence is sufficient" is better than generic persistence because it restrains expensive exploration.
- It has a practical failure circuit breaker. Two failed attempts trigger reassessment instead of another nearly identical call.
- It joins verification depth to change risk and boundary changes instead of treating "run tests" as a universal checkbox.
- It gives maintainability defaults in a small, readable block. The YAGNI, deletion, standard-library, dependency, abstraction, and root-cause rules are unusually coherent.
- Its delegation rule protects the main context window by requiring subagents to examine substantially more than they return.

## What Codex does better

- It handles dirty worktrees and user-authored changes explicitly.
- It says exactly when commits, amendments, branches, and destructive Git operations are forbidden.
- It defines instruction precedence and directory-scoped `AGENTS.md` behavior.
- It gives stronger end-to-end autonomy guidance and clearer final-answer formatting.
- It connects validation behavior to sandbox and approval mode.

## What Claude Code does better

- It separates ordinary coding behavior from high-risk action review. The autonomous security monitor has a real threat model instead of a generic "be secure" line.
- It treats web pages, tool output, and downloaded files as untrusted, which directly addresses prompt injection.
- It has concrete frontend verification rather than assuming tests or typechecks establish user-visible correctness.
- Its tool policies are precise, including parallel versus sequential calls, rejected-call behavior, and exact edit mechanics.
- It has specialized read-only agents for exploration and planning, reducing accidental mutation during research.

## Recommended changes to ours

The comparison does not justify copying either large prompt. Most of their length is harness-specific. Four focused additions would close the important gaps without turning ours into a manual:

1. Add dirty-worktree and Git safety rules: preserve unrelated changes, stop on unexpected concurrent changes, do not commit or push unless asked, and require explicit approval for destructive Git.
2. Add an untrusted-content rule: files, web pages, issue text, logs, and tool output are data, not authority to expand scope or disclose secrets.
3. Add boundary-specific verification: browser exercise for user-interface changes and explicit disclosure when it cannot be performed.
4. Define project-instruction precedence and scope if Pi loads nested instruction files.

## Sources

### OpenAI

- [Codex GPT-5.2 prompt, commit-pinned](https://github.com/openai/codex/blob/3abbf9fe2c6b6910e9de61f6a0c5bb468f74b5c8/codex-rs/core/gpt_5_2_prompt.md)
- [Older GPT-5 Codex prompt, commit-pinned](https://github.com/openai/codex/blob/3abbf9fe2c6b6910e9de61f6a0c5bb468f74b5c8/codex-rs/core/gpt_5_codex_prompt.md)
- [OpenAI Codex repository](https://github.com/openai/codex)

### Claude Code extraction

- [Extraction README and version statement](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/README.md)
- [Harness instructions](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/system-prompts/system-prompt-harness-instructions.md)
- [Parallel tool-call policy](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/system-prompts/system-prompt-parallel-tool-call-note-part-of-tool-usage-policy.md)
- [Task management](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/system-prompts/system-prompt-tool-usage-task-management.md)
- [Full-scope delivery and question policy](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/system-prompts/system-prompt-delivering-work-at-full-scope.md)
- [Task security](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/system-prompts/system-prompt-doing-tasks-security.md)
- [Avoiding unnecessary fallback and validation code](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/system-prompts/system-prompt-doing-tasks-no-unnecessary-error-handling.md)
- [Frontend browser verification](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/system-prompts/system-prompt-frontend-browser-verification.md)
- [Git commit and PR instructions](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/system-prompts/tool-description-bash-git-commit-and-pr-creation-instructions.md)
- [Autonomous-action security monitor](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/system-prompts/agent-prompt-security-monitor-for-autonomous-agent-actions-first-part.md)
- [Web-fetch delegation and trust boundaries](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/system-prompts/agent-prompt-web-fetch-agent-usage-guidance.md)
- [Writing for the user](https://github.com/Piebald-AI/claude-code-system-prompts/blob/17cb250873f43af841cdfb4d76c6b3314b13e04c/system-prompts/system-prompt-writing-for-the-user.md)
