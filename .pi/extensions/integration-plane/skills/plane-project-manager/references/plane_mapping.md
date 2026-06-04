# Plane Mapping Reference

This reference maps the previous Project Manager UI concepts to Plane-native objects. Use this when syncing or designing Plane setup.

## Core Objects

| Project Manager concept | Plane target |
|---|---|
| Portfolio dashboard | Workspace-level Plane Dashboard, plus saved Views across selected projects where supported |
| Project selector / selected projects | Plane Projects |
| Project setup state | Project Page `Project Setup` plus setup work items |
| Feature row | Work Item type `Feature` or `Story` |
| GitHub issue row | Work Item type `Bug` or GitHub-synced Plane work item |
| Custom row | Work Item type `PM Row` or label `custom-row` |
| Hidden row | Custom boolean property `PM Hidden`, archived item, or saved View filter |
| Feature detail panel | Plane work item detail, description, linked Pages, links, and attachments |
| Search/filter/table views | Plane Views, filters, layouts, display options |

## Status, Phase, and Progress

| Project Manager field | Plane target |
|---|---|
| `status: todo` | State in Unstarted group, usually `Todo` |
| `status: in_progress` | State in Started group, usually `In Progress` |
| `status: done` | State in Completed group, usually `Done` |
| `status: on_hold` | State `On Hold` if available, otherwise label `on-hold` |
| Development / E2E / Deployment / Operations tab | Custom dropdown property `PM Phase` |
| Progress percent | Custom decimal property `Progress %` |
| Story points | Plane Estimates; fallback custom decimal property `Story Points` |
| Completed/In Progress/Pending summary | Dashboard widget or View grouped by state |
| Overall weighted progress | Dashboard/widget if available; otherwise generated Page or Project Update |

Recommended custom property set for Feature work items:

| Property | Type | Notes |
|---|---|---|
| `PM Phase` | OPTION | `Development`, `E2E Testing`, `Deployment`, `Operations` |
| `Progress %` | DECIMAL | 0-100 |
| `Story Points` | DECIMAL | Use only if Plane Estimates are unavailable |
| `Source Feature ID` | TEXT readonly/single-line | Stable local id, e.g. `F-001` |
| `Category` | OPTION or TEXT | Use OPTION for controlled taxonomy |
| `Located Section` | TEXT | Source section/component |
| `Acceptance Passed` | DECIMAL | Checklist rollup |
| `Acceptance Total` | DECIMAL | Checklist rollup |
| `Last Sync Source` | TEXT readonly/single-line | e.g. local repo path or tool name |
| `Last Synced At` | DATETIME | Sync timestamp |

## Documentation

| Project Manager document/link | Plane target |
|---|---|
| README | Project Page or linked Page |
| Feature spec | Project Page linked to feature work item |
| TDD spec | Project Page linked to feature work item |
| Unit/integration test docs | Project Page or work item link |
| E2E folder/scenarios | Project Page or URL property |
| TDD progress/report | Project Page or comment summary |
| Debug retro | Project Page linked to feature |
| Dev log | Project Page or work item comments |
| Full file path | Work item link or URL property; avoid exposing noisy raw paths in titles |

Use Pages for durable docs. Use comments for short sync notes and status changes.

## Planning Objects

| Project Manager concept | Plane target |
|---|---|
| Feature category / component | Module, label, or custom property |
| Large initiative | Initiative if workspace feature is enabled; otherwise Epic |
| Milestone | Milestone |
| Sprint/timebox | Cycle |
| Release/version | Release |
| Dependency | Plane dependency relation: blocked by/blocking/start/finish relations |
| Logical relation | Plane relation: relates to/implements/duplicate, or custom relation where available |

Use Modules for feature/component grouping. Use Cycles for sprint/timebox planning. Use Releases for shipped versions and deployment progress.

## Dashboards and Views

Create these saved Views when possible:

| View name | Filter/grouping |
|---|---|
| `PM - Development` | `PM Phase = Development` |
| `PM - E2E Testing` | `PM Phase = E2E Testing` |
| `PM - Deployment` | `PM Phase = Deployment` |
| `PM - Operations` | `PM Phase = Operations` |
| `PM - Blocked / On Hold` | state `On Hold` or label `blocked`/`on-hold` |
| `PM - Done This Week` | completed state and updated/completed date in current week |
| `PM - Needs Docs` | missing doc links or label `needs-docs` |
| `PM - Needs Test Evidence` | test status missing/failing/pending |

Recommended dashboard widgets:

| Metric | Data source |
|---|---|
| Total features | Feature work items |
| Completed features | Feature work items in Completed states |
| In-progress features | Feature work items in Started states |
| On-hold features | On Hold state or label |
| Weighted progress | `Progress %` and `Story Points` |
| Phase counts | `PM Phase` grouped counts |
| E2E pass/fail/pending | Test custom properties or `Test Evidence` work items |
| Deployment status | Release-linked work items and deployment properties |
| Operations incidents | Incident work items by state/severity |

## Issues and Integrations

| Project Manager issue feature | Plane target |
|---|---|
| Open/closed issue counts | Dashboard over Bug/GitHub-synced work items |
| Repository sync status | Project Page `Integrations` or custom properties on project setup work item |
| GitHub issue create/edit/comment/close/reopen | Plane work items/comments/states, with GitHub integration when configured |
| Labels | Plane labels |
| Issue timeline/comments | Work item activity and comments |
| Link to GitHub | Work item URL link |
| GitHub repo URL | Custom URL property or Project Page |
| Sentry errors | Sentry integration creates/syncs work items where configured |

## Testing, Deployment, and Operations

Recommended custom properties for testing:

| Property | Type |
|---|---|
| `Test Status` | OPTION: `Pending`, `Passed`, `Failed`, `Blocked` |
| `Coverage %` | DECIMAL |
| `Passed Count` | DECIMAL |
| `Failed Count` | DECIMAL |
| `Test Evidence URL` | URL |

Recommended custom properties for deployment:

| Property | Type |
|---|---|
| `Deploy Status` | OPTION: `Not Deployed`, `Staging`, `Production`, `Failed`, `Rolled Back` |
| `Environment` | OPTION or TEXT |
| `Deploy Date` | DATETIME |
| `Release URL` | URL |

Recommended custom properties for operations:

| Property | Type |
|---|---|
| `Uptime %` | DECIMAL |
| `Error Rate %` | DECIMAL |
| `Response Time ms` | DECIMAL |
| `Last Incident At` | DATETIME |
| `Severity` | OPTION |

Use `Incident` work items for real operational incidents. Use Pages or comments for metric snapshots when Plane dashboards cannot compute the exact metric natively.

## Reports and Updates

| Project Manager report | Plane target |
|---|---|
| Weekly report | Project Update with `On Track`, `At Risk`, or `Off Track` status |
| Progress export JSON | Local Codex-generated export from Plane data |
| Stakeholder summary | Project Page or Project Update |
| Setup/preflight warning | Project Update, setup work item, or comment tagged `preflight` |

Use Project Updates for time-based status snapshots. Use Pages for living reports that should be revised over time.

## Intentionally Excluded in This Version

Do not implement these as active behavior yet:

| Excluded feature | Interim Plane representation |
|---|---|
| Agent dispatch | Normal work item or comment saying dispatch requested |
| Planner/Worker/Evaluator execution state | Future `Agent Run`/workflow model, not active now |
| PID/command/live stdout | Out of scope |
| Kill/open terminal buttons | Out of scope |
| Cron run-now or scheduled local execution | Out of scope |
| Live log streaming | Out of scope |
| Workflow DAG execution | Out of scope |
| Token/session transcript tracking | Out of scope |
