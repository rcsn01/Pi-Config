# Per-project state: `.pi/pi-config.json`

Each project tracks its own Pi-Config settings in a committed
`.pi/pi-config.json` at the project root. This file is **owned by the
Pi-Config extensions** — pi never parses, merges, or validates it (that is
`.pi/settings.json`'s job). Because it travels with the repo, it is only
honored for **trusted projects** (`ctx.isProjectTrusted()`); untrusted
projects ignore it. The `profile` key is the exception: it is read and written
regardless of trust.

## Schema

Namespaced and additive; readers ignore unknown keys.

```jsonc
{
  // Active Profile for this project. Written by `/profile`; honored regardless
  // of project trust (used when no session entry or handoff applies).
  "profile": "research",

  // Approval mode for this project. Written by `/permissions <mode>`.
  "permissions": {
    "mode": "read-only" // "read-only" | "default" | "auto-review" | "full-access"
  },

  // Execpolicy rules for this project. Written by `/execpolicy add` in trusted
  // projects. Rules require id, pattern, action, and reason. Optional — omit
  // the whole namespace when the global rules suffice.
  "execPolicy": {
    "rules": [
      { "id": "1", "pattern": "^pnpm test", "action": "allow", "reason": "project test runner" }
    ]
  }
}
```

## Precedence

| Concern | Winner first |
| --- | --- |
| Profile | session entry → handoff → project `profile` → none |
| Approval mode | project `permissions.mode` → `"default"` |
| Exec policy | global rules → project `execPolicy.rules` → global `defaultAction` (global always wins) |

Notes:

- The mode declaration is the source of truth for trusted projects: running
  `/permissions` writes it, so it shows up in `git status` and syncs with the
  repo. `full-access` in a committed file is visible in review — that is
  intentional; pi's project-trust gate is what keeps hostile repos from
  declaring it.
- The project document is the only mode store. Nothing is written into the
  repo when merely loading; the first `/permissions` change creates it.
- Untrusted projects ignore `.pi/pi-config.json` entirely. Their mode starts
  at `"default"` and a `/permissions` change lasts for the session only.
- The project `profile` is the only persisted Profile marker. `/profile`
  writes it; `compaction.keepRecentTokens` is still projected into
  `.pi/settings.json` because pi reads it from there. The profile is not
  trust-gated: the Profile documents themselves live in the repo's
  `.pi/profiles/`, so a repo choosing among them grants nothing new.
- Exec policy: global rules are authoritative — a project rule only fires when
  no global rule matches, so a repo file can add coverage but never neutralize
  a global rule. The project layer is rules-only; `defaultAction` stays global.
  `/execpolicy add` writes the project layer in trusted projects and the
  global file otherwise; `rules` lists both layers with `p<n>`/`g<n>` ids;
  `remove` accepts the same ids (a bare numeric id means global).
- Writes are trust-gated in `_shared/pi-config.ts`: untrusted projects are
  read as "nothing declared" and never touch the file (the `profile` owner
  always passes `projectTrusted: true`). Mutation is a
  synchronous read-modify-write, atomic per call (temp file + rename) because
  it never interleaves in-process; concurrent writes from two processes
  remain unsupported. Sibling namespaces survive (e.g. saving the mode
  preserves `profile`).

## Code map

- `_shared/pi-config.ts` — path, trust probe, trust-gated reads
  (`readProjectDocument`), trust-gated mutation (`mutateProjectNamespace`,
  `mutateProjectDocument`) — the per-project trust gate and document
  mechanics live here.
- `_shared/profile-document.ts` → `readProjectProfile(cwd)` /
  `writeProjectProfile(cwd, name)` — validated `profile`.
- `config-profiles/profile-store.ts` — `/profile` switch/create/delete write
  the project `profile`.
- `_shared/command-policy.ts` — `loadExecPolicyLayers` / `loadExecPolicy` merge,
  `saveProjectExecPolicyRules(cwd, rules, projectTrusted)` write.
- `policy-permissions/mode-store.ts` — `permissions.mode` read/write
  (`ModePersistenceOptions.projectTrusted`).
- `_shared/session-profile-binding.ts` — resolves the project `profile`
  (any trust level).