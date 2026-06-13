# Plane Surface Playbook

Use this reference when a sync should go beyond plain work items.

## Decision Rules

| Plane surface | Use when | Do not use when |
|---|---|---|
| Modules | Work items naturally group by product area, feature category, route, subsystem, or objective. | The group has only one item and no expected future tracking value. |
| Views | Users need repeatable filtered/ordered perspectives. | The filter is one-off or can be answered in the current report. |
| Pages | Source has durable docs, specs, runbooks, architecture decisions, status summaries, or generated reports. | Content is tiny enough to stay in a work item description/comment. |
| Cycles | There is a real timebox: sprint, week, stabilization window, release-prep window. | The source only has lifecycle phases such as development/testing/deployment/operations. |
| Intake | A work item is proposed but not accepted/triaged yet. | The item is already part of the authoritative project plan. |

## Project-Manager Analogues

| Project-Manager concept | Plane surface |
|---|---|
| `category` | Module or label; prefer Module when category has multiple work items. |
| `locatedSection` / route / component path | Module, label, or custom property depending on granularity. |
| Dashboard sheet tabs: Projects, Issues, Development, E2E Testing, Deployment, Operations | Saved Views. |
| Search, category filter, hidden rows, table presets | Saved Views and view display props where supported; custom properties/labels as fallback. |
| `.project-manager/features/<ID>/README.md` | Project Page linked to the matching work item. |
| Feature spec / TDD spec / debug retro / test scenarios / dev log | Project Pages or work item page links. |
| `docs/architecture`, `docs/engineering`, `docs/product`, `docs/guides` | Project Pages; workspace Pages for cross-project standards. |
| `AddRowModal` custom rows | Intake when untriaged; Work Item when accepted. |
| GitHub issue sync tab | Intake for newly imported/untriaged issues; Work Items for accepted bugs/tasks. |
| `docs/project-process/YYYY-MM-DD-*.md` | Project Updates or Pages; Cycles only if the doc represents a timebox. |

## Modules

Create Modules before assigning work items when the source has stable groupings.

Recommended module candidates for Project-Manager-style repos:

- Feature categories: `Frontend/UI`, `Core/AI`, `Core/Platform`, `Core/Security`, `Core/Integration`, `Execution`, `Documentation`.
- Located sections with repeated work: `/plugins`, `/xmux`, `/keys`, `/project-progress-dashboard`, `/chat`, `/ai_assistants`.
- Major subsystems: `GitHub Sync`, `Documentation Site`, `Agent Workflow DAG`, `Runtime Bridge`, `Storage`.

Module status mapping:

| Rollup condition | Module status |
|---|---|
| All children completed | `completed` |
| Any child started | `in-progress` |
| All children unstarted | `planned` or `backlog` |
| Explicitly paused/on-hold | `paused` |
| Explicitly cancelled | `cancelled` |

Do not create too many modules from one-off paths. Prefer categories first, then promoted located sections with several items.

## Views

**REST limitation:** Plane has no public API to create saved Views. Define filter recipes here, then create matching Views manually in the Plane UI (or document them for the user).

Create saved Views for repeated operating modes.

Recommended baseline views:

- `PM - Development`
- `PM - E2E Testing`
- `PM - Deployment`
- `PM - Operations`
- `PM - In Progress`
- `PM - Done`
- `PM - Backlog`
- `PM - High Priority`
- `PM - Needs Docs`
- `PM - Needs Test Evidence`
- `PM - Recently Updated`

View filters should prefer Plane-native fields first: state group, priority, assignee, labels, modules, cycles, target date. Use custom properties for `PM Phase`, `Progress %`, `Source Feature ID`, `Located Section`, and evidence gaps when available.

## Pages

Use Pages for durable content and link them to work items when possible.

Recommended page structure:

- `Project Setup`
- `Progress Sync Runbook`
- `Architecture Overview`
- `Documentation Index`
- `Weekly Status / YYYY-MM-DD`
- `Feature / <ID> / Overview`
- `Feature / <ID> / Spec`
- `Feature / <ID> / TDD`
- `Feature / <ID> / Debug Retro`
- `Feature / <ID> / Test Scenarios`

Keep work item descriptions concise. Put long Markdown, Mermaid diagrams, logs, and acceptance evidence into Pages.

## Cycles

Cycles are for time, not phase. Use them only when the source or user names a time window.

Good cycle names:

- `2026-W22 Stabilization`
- `2026-W22 Development`
- `Release Prep 0.4`
- `Docs & Verification Sprint`

Cycle assignment rules:

- Assign only work items that are planned for the cycle window.
- If no dates exist, ask for the timebox or create a draft plan in a Page instead of inventing dates.
- Do not map `development`, `e2e_testing`, `deployment`, or `operations` directly to cycles; those are lifecycle phases and should be Views/custom properties.

## Intake

Use Intake as triage.

Good intake candidates:

- New rows from `AddRowModal` before acceptance.
- GitHub issues imported for review.
- Stakeholder requests or ideas without approved scope.
- Bugs reported externally.
- Duplicate/unclear requests that need review.

Intake status policy:

| Situation | Intake status |
|---|---|
| Needs triage | Pending |
| Not in scope | Rejected |
| Accepted into plan | Accepted and convert/link to Work Item |
| Duplicate of existing work | Duplicate |
| Valid but deferred | Snoozed |

Do not send already-approved local source features to Intake. They are Work Items.

## Enrichment Order

When building a full Plane project-management surface:

1. Enable project features needed by the sync: modules, cycles, pages, views, intake.
2. Create/update custom properties and labels.
3. Create/update Modules.
4. Create/update Pages.
5. Create/update Work Items.
6. Link Work Items to Modules, Cycles, Pages, and external docs.
7. Create/update Views.
8. Create Intake entries only for untriaged requests.
9. Verify object counts and relationships.
