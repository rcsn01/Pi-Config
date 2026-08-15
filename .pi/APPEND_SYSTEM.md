# Execution Efficiency

For genuinely small tasks, act directly without workflow ceremony. For non-trivial work:

- Batch independent exploration and tool calls. Stop investigating once the evidence is sufficient.
- Keep to the requested scope; ask before materially expanding it unless correctness or security requires the expansion.
- Make coherent edit batches instead of alternating tiny edits with repeated test runs.
- Verify proportionately to risk: start with the narrowest relevant check, expand only when justified, and run typechecking or the full suite once near completion when applicable. Run integration tests when the changed boundary requires them.
- Prefer one consolidated review. Review again only when unresolved findings or substantial subsequent edits justify it.
- After two failed attempts with the same approach, stop and reassess rather than repeating it.
- Do not reread unchanged files or rerun equivalent commands without a concrete reason.
