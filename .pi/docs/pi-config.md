# Per-project state: `.pi/pi-config.json`

Each project tracks its own Pi-Config settings in a committed
`.pi/pi-config.json` at the project root. This file is **owned by the
Pi-Config extensions** — pi never parses, merges, or validates it (that is
`.pi/settings.json`'s job). Because it travels with the repo, it is only
honored for **trusted projects** (`ctx.isProjectTrusted()`); for untrusted
projects everything falls back to machine-local state.

## Schema

Namespaced and additive; readers ignore unknown keys.

```jsonc
{
  // Profile declared for this project (used when no session entry or handoff applies).
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
| Profile | session entry → handoff → project `profile` → global `configProfiles.active` marker |
| Approval mode | project `permissions.mode` → legacy hashed store (`~/.pi/state/pi-config/<hash>/approval-mode.json`) → `"default"` |
| Exec policy | global rules → project `execPolicy.rules` → global `defaultAction` (global always wins) |

Notes:

- The mode declaration is the source of truth for trusted projects: running
  `/permissions` writes it, so it shows up in `git status` and syncs with the
  repo. `full-access` in a committed file is visible in review — that is
  intentional; pi's project-trust gate is what keeps hostile repos from
  declaring it.
- The hashed store fallback is **read-only**. A trusted project adopts the
  pi-config document on its first mode change; nothing is written into the
  repo when merely loading.
- Untrusted projects ignore `.pi/pi-config.json` entirely and behave exactly
  as before (hashed store, legacy `.pi/approval-mode.json` migration).
- Exec policy: global rules are authoritative — a project rule only fires when
  no global rule matches, so a repo file can add coverage but never neutralize
  a global rule. The project layer is rules-only; `defaultAction` stays global.
  `/execpolicy add` writes the project layer in trusted projects and the
  global file otherwise; `rules` lists both layers with `p<n>`/`g<n>` ids;
  `remove` accepts the same ids (a bare numeric id means global).
- Writes are atomic (temp file + rename) and merge — sibling namespaces
  survive (e.g. saving the mode preserves `profile`).

## Code map

- `_shared/pi-config.ts` — path, read, merge-write (document primitives), trust probe.
- `_shared/profile-document.ts` → `readProjectProfileName` — validated `profile`.
- `_shared/command-policy.ts` — `loadExecPolicyLayers` / `loadExecPolicy` merge,
  `saveProjectExecPolicyRules` write.
- `policy-permissions/mode-store.ts` — `permissions.mode` read/write
  (`ModePersistenceOptions.projectTrusted`).
- `_shared/session-profile-binding.ts` — project layer in Profile resolution
  (trusted sessions only).