---
name: plane-project-manager
description: Use Plane as the project-management UI for this workspace. Trigger when the user asks to sync, inspect, summarize, or manage Project-Manager-style progress in Plane, including features, project phases, progress indicators, issues, documentation, releases, operations metrics, dashboards, and project updates. Do not build a separate UI; represent progress with Plane projects, work items, states, labels, custom properties, pages, comments, views, dashboards, cycles, modules, milestones, releases, and updates. Execution/agent dispatch is intentionally out of scope for this skill version.
---

# Plane Project Manager

Use this skill to turn Project-Manager-style progress data into Plane-native project-management records. Plane is the UI and durable workspace. Pi is the sync/orchestration agent.

Bundled in the **integration-plane** Pi extension (`.pi/extensions/integration-plane/`).

## Pi commands

| Command | Purpose |
|---|---|
| `/plane` | Show help and Plane sync command list |
| `/plane on` | Enable Plane guidance for subsequent turns |
| `/plane off` | Disable Plane guidance |
| `/plane status` | Show Plane REST config and API connectivity |
| `/plane sync` | Normalize local progress and sync work items via REST |
| `/plane normalize` | Run the read-only progress normalizer (JSON) |
| `/plane plan-surfaces` | Run the read-only modules/views/pages/cycles planner (JSON) |
| `/plane doc mapping` | Print the Plane mapping reference |
| `/plane doc surfaces` | Print the Plane surfaces playbook |
| `/plane doc runbook` | Print the sync runbook |

## Scope

In scope:
- Map local project-management metadata to Plane projects, work items, states, labels, custom properties, pages, comments, views, dashboards, cycles, modules, milestones, releases, and updates.
- Read local `.project-manager/config.json` files, feature docs, test docs, project docs, and repository metadata when present.
- Use bundled `plane_*` REST tools (or `/plane sync`) for Plane reads/writes.
- Preserve the user's existing Plane data; update matching objects instead of duplicating them.

Out of scope for this version:
- Agent dispatch, kill-process, open-terminal, live stdout, run-now, PID control, cron execution, or any other local execution control.
- Building or launching a replacement dashboard app.
- Storing secrets in generated skill files or Plane content.

## First Steps

1. Confirm the working directory and locate candidate project configs:
   - Search for `.project-manager/config.json`.
   - Search for roadmap sources such as `apps/**/data/roadmap.ts`.
   - Search for project docs such as `README.md`, `docs/`, feature specs, TDD specs, test reports, deployment notes, and operation notes.
2. Confirm Plane REST access is configured (not stored in this extension):
   - `/plane status` or tool `plane_status`.
   - `plane_list_projects` to inspect available Plane projects.
   - Resolve the target Plane project by name, identifier, or explicit user instruction.
   - Config: `PLANE_API_KEY`, `PLANE_WORKSPACE_SLUG`, `PLANE_BASE_URL`, or `.pi/plane.json`.
3. For a non-trivial sync, read the relevant reference:
   - `references/sync_runbook.md` (`/plane doc runbook`)
   - `references/plane_surfaces.md` (`/plane doc surfaces`) when using cycles, modules, views, pages, intake, or releases
   - `references/plane_mapping.md` (`/plane doc mapping`)
4. For repo progress sources, prefer the bundled normalizer before writing to Plane:
   - `/plane normalize`
5. For cycles/modules/views/pages/intake planning, generate a read-only surface plan first:
   - `/plane plan-surfaces`

## Plane Modeling Rules

- A local product/software project maps to a Plane Project.
- A feature row maps to a Plane Work Item, usually type `Feature` or `Story`.
- A bug/issue maps to a Plane Work Item, usually type `Bug`.
- Project phases map to a custom property named `PM Phase`, with options:
  - `Development`
  - `E2E Testing`
  - `Deployment`
  - `Operations`
- Feature status maps to Plane Work Item States:
  - `todo` -> Todo or another Unstarted state
  - `in_progress` -> In Progress or another Started state
  - `done` -> Done or another Completed state
  - `on_hold` -> On Hold if present; otherwise create/use a blocked/paused state or label
- Feature progress maps to a custom decimal property named `Progress %`.
- Story points map to Plane Estimates where the project has estimates configured; otherwise use a decimal custom property named `Story Points`.
- Categories and located sections map to labels unless the value set needs to be tightly controlled, in which case use dropdown custom properties.
- Project documentation maps to Plane Pages and work item links.
- Reports and stakeholder summaries map to Plane Project Updates or Pages.

## Sync Behavior

When syncing from local data into Plane:

1. Read local source data.
2. Build a normalized object list in memory:
   - projects
   - features
   - modules/categories
   - cycles/timeboxes
   - views/filters
   - issues
   - docs/pages
   - releases/deployments
   - operations/incidents/metrics
3. Resolve existing Plane objects before creating new ones. Match by `external_source` + `external_id` first.
4. Prefer idempotent matching keys:
   - Plane project identifier or name for projects.
   - Local feature id plus project for features.
   - External source/id for imported or generated objects when available.
   - Stable title only as a fallback.
5. Create missing Plane setup only when needed:
   - enable project features: modules, cycles, views, pages, work item types
   - create work item types: `Feature`, `Bug`, `Incident`, `Release Task`, `Ops Metric` as needed
   - create custom properties from the reference mapping
6. Update Plane work items with status, phase, progress, estimates, labels, links, and description.
7. Put long-form generated summaries into Pages or comments, not giant work item titles.
8. Report what changed: created, updated, skipped, and any fields that could not be mapped.

## Surface Selection

Use more than work items when the source supports it:

- **Modules**: create from stable feature categories, product areas, routes, or components when they group multiple work items.
- **Views**: create from repeatable filters the user expects to revisit, such as phase tabs, status queues, priority queues, hidden/needs-review rows, and docs/testing gaps.
- **Pages**: create from durable Markdown docs, feature specs, TDD specs, architecture docs, runbooks, status summaries, and sync reports.
- **Cycles**: create only for explicit timeboxes, sprints, weekly plans, stabilization windows, or release-prep periods. Do not map lifecycle phases to cycles.
- **Intake**: use for untriaged requests, stakeholder asks, new idea rows, GitHub issues awaiting acceptance, or external submissions. Do not import authoritative source features through Intake.
- **Releases/Milestones**: use for versioned shipping targets or deployment readiness groups when the repo has version/release data.

## Operational Guardrails

- Use `plane_*` tools and `/plane sync`; never print API keys.
- Saved Views have no public create API — create them manually in the Plane UI after work items exist.
- Do not parallelize Plane writes. Throttle create/update/delete calls and back off on `429 Too Many Requests`.
- Treat deletion as sensitive. Only delete temporary/probe items or items explicitly owned by the sync source, and verify by ID afterward.
- Plane `point` accepts only the estimate values configured for the project. If a source point value is rejected or likely unsupported, omit `point` and preserve the source value in the description or a custom property.
- Some Plane list filters may be unreliable on self-hosted instances. When counts matter, list pages and filter locally by `external_source` and `external_id`.
- `delete_work_item` may report an unexpected response type even when deletion succeeds. Verify with a direct item lookup or list check before retrying.
- A sync is not complete until counts, missing IDs, duplicate IDs, and temporary/probe cleanup have been checked.

## Preferred Plane Surfaces

- Daily work queue: saved Plane Views filtered by `PM Phase`, state, labels, assignee, and priority.
- Portfolio progress: Plane Dashboards over selected projects.
- Feature detail: Plane work item detail plus linked Pages.
- Documentation: Plane project Pages.
- Weekly status: Plane Project Updates.
- Release progress: Plane Releases plus release-linked work items.
- Operations visibility: `Incident` work items, Sentry-linked work items, and custom metric properties.

## Avoid

- Do not invent a separate UI or HTML dashboard.
- Do not create duplicate work items when an existing item can be matched.
- Do not write API keys, Plane tokens, or local secrets into skill files, Plane pages, or work item comments.
- Do not change unrelated repo files while performing Plane sync work.
- Do not perform execution-related actions in this skill version; record requested execution work as normal Plane work items instead.
