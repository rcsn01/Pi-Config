# Plane Sync Runbook

Use this runbook for repository-to-Plane progress syncs. Keep Plane as the durable UI and avoid creating a replacement dashboard.

## Source Discovery

Look for these sources first:

| Source | Adapter | External source |
|---|---|---|
| `.project-manager/config.json` | Project Manager config | `project-manager-config` |
| `apps/**/data/roadmap.ts` | Roadmap TypeScript data | choose a stable repo-specific value such as `owner-property-roadmap` |

Run the bundled normalizer when the source shape matches:

```bash
/plane normalize
```

Or:

```bash
python3 .pi/extensions/integration-plane/skills/plane-project-manager/scripts/normalize_progress_sources.py --root . --json
```

The normalizer reports source files, inferred project names, feature counts, stable IDs, progress, phase, points, category, and located section/page.

Generate a read-only Plane surface plan before enriching a project:

```bash
/plane plan-surfaces
```

Or:

```bash
python3 .pi/extensions/integration-plane/skills/plane-project-manager/scripts/plan_plane_surfaces.py --root . --json
```

For cycles, modules, views, pages, and intake behavior, read `references/plane_surfaces.md` before writing. Work item-only syncs are acceptable for a first import, but a full Project-Manager migration should enrich the Plane project with those surfaces.

## Normalized Feature Shape

Normalize each feature before writing:

| Field | Required | Notes |
|---|---:|---|
| `project_name` | yes | Local project/repo name, mapped to a Plane Project. |
| `source_path` | yes | Local file path used for traceability. |
| `external_source` | yes | Stable source namespace for idempotency. |
| `external_id` | yes | Stable per-feature ID, usually `{project}:{feature_id}`. |
| `feature_id` | yes | Source feature ID, e.g. `F01` or `001`. |
| `name` | yes | Plane work item title should include the feature ID. |
| `progress` | yes | Numeric 0-100 when available. |
| `phase` | no | `development`, `testing`, `deployment`, or `operations`. |
| `status` | no | If absent, derive from progress. |
| `points` | no | Preserve even if Plane cannot store it in `point`. |
| `category` | no | Label or custom property candidate. |
| `located` | no | Component/page/section path. |

## State Mapping

Prefer project states by group, then by name:

| Source | Plane state target |
|---|---|
| `progress == 100` or `status == done` | Completed, usually `Done` |
| `progress > 0` or `status == in_progress` | Started, usually `In Progress` |
| `progress == 0` or `status == todo` | Backlog or Todo |
| `status == on_hold` | On Hold if present; otherwise label `on-hold` |

If both source status and progress exist and disagree, keep the source status in the description and use progress for the board state unless the user directs otherwise.

## Priority And Points

Recommended priority mapping:

| Source points | Plane priority |
|---:|---|
| `>= 8` | `high` |
| `>= 5` | `medium` |
| `< 5` | `low` |

Only send Plane `point` values that the project accepts. Common accepted values are `1`, `2`, `3`, `5`, and `8`; larger values like `13` or `44` should remain in the description or a `Story Points` custom property.

## Idempotent Write Flow

1. List target Plane projects and resolve the project ID.
2. List states for that project and build state IDs for backlog/todo/in-progress/done/cancelled.
3. Enable project features needed for the requested sync scope: modules, cycles, pages, views, intake.
4. Create/update Modules from stable categories or located sections when they group multiple work items.
5. Create/update Pages from durable docs and summary reports.
6. List existing work items via `plane_find_work_item` or REST `external_source`/`external_id` query params. If self-hosted Plane ignores filters, page through list results and filter locally.
7. For each normalized feature:
   - If an item with the same `external_source` + `external_id` exists, update it.
   - Otherwise create it.
   - Attach module/page/cycle links when those surfaces exist.
8. Create saved Views **manually in the Plane UI** after work items have stable states, labels, modules, and custom properties (no public create API).
9. Create Intake records only for untriaged requests, not authoritative imported features.
10. Do not match by title unless there is no stable external ID and the user accepts possible ambiguity.
11. Do not delete existing items unless they are clearly temporary/probe records or the user explicitly asked for pruning.

## Rate Limits

Self-hosted Plane may return `429 Too Many Requests` during bulk writes.

- Do not parallelize writes.
- Use a delay of at least 0.5-1.0 seconds between write calls for large boards.
- On `429`, sleep 30 seconds and retry the same operation.
- If repeated rate limits occur, increase the delay and continue from the last confirmed external ID.

## Known Plane API Quirks

- Some list filters can be ignored by self-hosted Plane. Exact verification should filter locally after listing pages.
- Self-hosted deployments may require a custom `PLANE_BASE_URL` (see `plane.json.example`).
- Do not expose tokens from `.pi/plane.json`, env vars, shell output, or API debug logs.
- `/plane sync` and `plane_sync_workspace` upsert work items only; modules/pages/cycles need follow-up tools or agent steps.

## Verification Checklist

Before final response:

- Local source count equals synced Plane source count.
- Module, cycle, page, view, and intake counts match the requested sync scope.
- Work item relationships to modules/cycles/pages are present where created.
- No missing expected `external_id` values.
- No duplicate `external_id` values.
- Temporary/probe items are removed and verified by ID.
- Unsupported point values are reported as preserved outside Plane `point`.
- Any rate-limit or API caveat is summarized briefly.
