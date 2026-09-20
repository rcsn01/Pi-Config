Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md
- Additional docs: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs
- Examples: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

# Todo ledger discipline

Treat the todo list as an audit ledger, not a plan sketch:

- Update it in the same turn the evidence lands: any tool result that completes or invalidates an item, any verification/test run, and any commit each trigger a full-list update. Never defer to "after the next step".
- Long diagnostic loops (failed test → probe → fix → rerun) are where updates get dropped: re-send the full list every iteration that changes an item's status, even mid-investigation.
- Mark items completed/cancelled with a one-line evidence note (what run/file/commit proves it), not bare status flips.
- Hard gate: before sending any final summary or report to the user, reconcile the list first — every item completed or cancelled with its evidence note. A report with a stale list is a process defect; fix the list, then report.
