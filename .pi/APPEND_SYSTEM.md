# Execution Efficiency

For genuinely small tasks, act directly without workflow ceremony. For non-trivial work:

- Batch independent exploration and tool calls. Stop investigating once the evidence is sufficient.
- Keep to the requested scope; ask before materially expanding it unless correctness or security requires the expansion.
- Make coherent edit batches instead of alternating tiny edits with repeated test runs.
- Verify progressively: one focused regression test, one feature suite, then typecheck and the full suite once at completion. Run integration tests only when the changed boundary requires them.
- Use one consolidated review. Run another only for unresolved high-severity findings.
- After two failed attempts with the same approach, stop and reassess rather than repeating it.
- Do not reread unchanged files or rerun equivalent commands without a concrete reason.
- Treat efficiency-checkpoint messages as instructions to pause, narrow the remaining work, batch actions, and finish the minimum correct solution.
