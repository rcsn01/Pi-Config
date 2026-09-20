# Own the list/detail workspace in the Dashboard client shell

## Outcome

The Dashboard client shell absorbs the one piece of list/detail behavior that is
genuinely shared — per-view selection memory — plus the three style rules and
the cost formatter that both dashboard page adapters duplicate today. Both page
adapters shrink, the drift-prone selection-restore choreography is implemented
and tested once in the shell, and every other responsibility (data rendering,
tab data, statuses, fetch paths, polling policy) stays in the page adapters
exactly as CONTEXT.md requires. Rendered behavior is byte-identical; the only
DOM deltas are one added class name on the two workspace hosts
(`dash-workspace`) and the empty-state class renamed to `dash-empty` (seven
client sites).

## What this buys

- **Locality.** The subtlest machinery on the dashboards — restore the saved
  selection if it is still offered, else fall back to the adapter's default,
  without letting an empty view erase memory — lives in one shell function and
  is tested once, instead of being hand-rolled twice with different shapes
  (a `Map` of `{sequence, part}` in Analysis, a bare id + first-row fallback in
  Usage).
- **Leverage.** One implementation, two real adapters: Analysis stores per-view
  request selections (`channel` or `subagent\0<id>` view keys) and Usage stores
  the selected session id. Adding a third dashboard inherits the behavior for
  free.
- **Deletion.** Analysis loses its `selections` Map, `saveSelection`'s map
  writes, the whole `selectRequestForCurrentView` reconcile (including a
  vestigial `typeof saved === 'number'` branch); Usage loses its stale-id
  reconcile and the defensive `|| sessions[0]` fallback. Three duplicated CSS
  rules collapse into the shell's shared styles.
- **Drift killed at the CSS level.** The selected-row treatment (the rule that
  already drifted once — `.empty` vs `.empty-state` shows the failure mode) is
  keyed on the `dash-row` class every row already carries, so pages can no
  longer disagree visually.
- **Testability where it matters.** Selection memory is pure state: the shell
  tests it directly with no DOM and no VM page harness, extending the existing
  `dashboard-client.test.ts` pattern.

## Design

Design-it-twice ran three independent designers over this seam (minimal,
maximally flexible, optimized for the hardest caller — Analysis).

- **Designer 1 (minimal)** proposed two pure-state entry points plus CSS dedup:
  right seam placement, but hard-coded cost precision at 6 digits (a
  user-visible change on Usage).
- **Designer 2 (flexible)** proposed a five-function family
  (`dashCreateSelection` with `scope`/`exchange`, `dashCreateList`,
  `dashCreateDetail`, `dashEmptyNode`, parameterized `dashFormatCost`): deepest
  after Designer 3, but `groupOf`/`groupNode`/`capture` are single-consumer
  knobs and `exchange()` adds an ordering invariant to hide four lines.
- **Designer 3 (workspace)** proposed one mega `dashCreateWorkspace` config
  bag hiding the whole Analysis spine: highest paper depth, ~18 knobs,
  several analysis-only, largest DOM churn.

**Converged hybrid:** Designer 1's selection-memory seam, Designer 2's
parameterized cost formatter, and the CSS trio all three agreed on. Cut by the
deletion test (no second consumer): `dashCreateList`, `dashCreateDetail`,
`exchange`, the workspace mega-bag, `dashEmptyNode` (`dashElement` already
builds the node). DOM assembly deliberately stays page-side: grouping,
two-part rows, and listbox roles are Analysis/Usage vocabulary, and CONTEXT.md
reserves rendering for the adapters.

### Resolved decisions (grill-style, self-answered)

1. **How much DOM assembly crosses the seam? — None.** The shared row skeleton
   is thin (~6 lines per site) while the structural differences (request
   grouping, two-part rows, listbox `aria-selected` vs button `aria-pressed`)
   are single-consumer. Forcing one `rowOf`/`groupOf` interface would put page
   vocabulary in the shell and break the parity bar. The drift risk is killed
   at the style-treatment level instead (shared rule on `.dash-row`).
2. **Does the detail gate (fingerprint, open-pointer capture, stale-response
   guard) move? — No.** Only Analysis gates detail re-renders; Usage's detail
   is synchronous. Single consumer → page-side (`itemFingerprint` :325,
   `expandedPointers` :318–323, the guard inside `renderDetail` :505–520).
3. **`dashFormatCost` precision — parameterized, default 3, Analysis passes 6.**
   Usage's displayed `$1.234` (page.test.ts:141) is unchanged. The 3-vs-6 drift
   was real friction; the parameter is the fix, not unification.
4. **Selection-memory semantics.** `store(view, key)` ignores null keys.
   `keep(view, keys)` returns the stored key if still offered, else persists
   and returns `keys[0]` (adapters order keys so the first offer is their
   default), else returns null for empty offerings **without touching memory**.
   Fallback persistence is what makes Usage byte-identical: when a search
   filter hides the chosen session, today's code resets to the first visible
   row and "forgets"; `keep` persists the fallback into memory at the same
   moment, producing the same outcome when the filter clears. Analysis'
   guardian-tab empty view must not erase the saved subagent selection — empty
   keys preserve it. Analysis' extra fallback writes (at the tab-activate and
   subagent-click reconciles, where today's code writes nothing) are
   unobservable: `keep` is memory's only reader, both schemes hold identical
   memory at every reconcile (the old scheme's writes at clicks, refresh
   reconciles, and tab switches converge the state before the next read), and
   a vanished composite key can never reappear (sequence numbers only
   increase). Traced against every reader path.
5. **Composite row keys stay page-side.** Analysis encodes `sequence + ':' +
   part` and orders each item's keys `[defaultPart, otherPart]` so `keys[0]`
   is the default choice; the shell never learns that parts exist. View keys
   (`selectionKey()` :357–359) stay page-side. The shell stores strings only.
6. **The subagent axis stays hand-rolled.** `syncSelectedSubagent`
   (:349–355) is live state, not memory: current code forgets the subagent
   when the list empties. Routing it through `keep` would silently add memory
   across empty-refill cycles — a behavior change with no consumer asking for
   it. Three lines stay.
7. **Empty-state class converges on `.dash-empty`.** Usage renames `.empty`
   (3 client sites, zero test references); Analysis renames `.empty-state`
   (4 client sites, 2 test references updated). The unified rule drops
   `border: 0; border-radius: 0;` — empty nodes are divs and never had a
   default border; visually identical.
8. **Workspace grid dedup via a shared `.dash-workspace` class added alongside
   the existing classes.** Page rules keep only their genuine extras
   (`align-items: start`, `min-height: 440px`, the 3-column subagent-mode
   variant, media queries). Page styles compose after the shared styles by
   construction (both page-styles modules interpolate
   `DASHBOARD_CLIENT_STYLES` first), so the cascade keeps page overrides
   winning at equal specificity.
9. **`dashCreateTablist` and `dashboardRequiresLifecycle` stay as-is.** The
   tablist is the roving-tablist seam's interface with 3 call sites; the guard
   is 1:1 but belongs to page lifecycle and is already tested. Folding either
   into the workspace adds indirection without a consumer.
10. **Pure-shaping extraction (pointer decoding, week alignment) is deferred.**
    Each page's shaping logic has one consumer; the VM page tests already
    exercise it end-to-end, and a page-side `String.raw` shaping block would
    add a composition site per page with no behavior win. Recorded as
    considered-and-deferred; this plan does not touch it.
11. **Polling policy, fetch paths, statuses, and the capability-token guard
    stay page-side** (Analysis `setInterval(refresh, 1500)` :618, Usage
    `schedulePoll` :611, both `dashboardRequiresLifecycle` calls). CONTEXT.md
    invariant; no designer proposed moving them.

## Current evidence and friction

All refs verified against the working tree at plan time (HEAD `2b06a0e`).

| Evidence | Location |
| --- | --- |
| Shell today: one `String.raw` block, 5 functions (`dashboardRequiresLifecycle` :2, `dashElement` :20, `dashFormatInteger` :27, `dashFormatCompact` :31, `dashCreateTablist` :45) | `_shared/dashboard-client.ts` (102 lines) |
| Composition into one `<script>` tag | `telemetry-analysis/page.ts:31`, `telemetry-usage/page.ts:27` |
| Analysis selection state: `selections` Map | `telemetry-analysis/page-client.ts:25` |
| Analysis reconcile: `saveSelection` / `selectRequestForCurrentView` (incl. vestigial `typeof saved === 'number'` branch) | `telemetry-analysis/page-client.ts:366–368`, `:374–386` |
| Analysis view vocabulary (stays page-side): `selectionKey` :357–359, `defaultPart` :370–372, `visibleSummaries` :361–363, `syncSelectedSubagent` :349–355 | `telemetry-analysis/page-client.ts` |
| Usage reconcile + defensive fallback | `telemetry-usage/page-client.ts:531`, `:551` |
| Usage local formatters (cost drift vs Analysis inline 6-digit) | `telemetry-usage/page-client.ts:59–61`, `telemetry-analysis/page-client.ts:146` |
| Selected-row CSS duplicated verbatim (declarations; selectors differ — Analysis uses `.selected` + `aria-pressed`, Usage uses `[aria-selected="true"]`) | `telemetry-analysis/page-styles.ts:22`, `telemetry-usage/page-styles.ts:77` |
| Workspace grid template duplicated | `telemetry-analysis/page-styles.ts:19`, `telemetry-usage/page-styles.ts:75` |
| Empty-state divergence (same declarations except Analysis's extra `border: 0; border-radius: 0;`, which decision 7 drops) | `telemetry-analysis/page-styles.ts:18`, `telemetry-usage/page-styles.ts:71` |
| Empty-state client sites (Analysis 4, Usage 3) | `telemetry-analysis/page-client.ts:392, 431, 464, 553`; `telemetry-usage/page-client.ts:119, 422, 528` |
| Shared row class the CSS keys on | `_shared/dashboard-styles.ts:43–51` (`DASHBOARD_CLIENT_STYLES`, `.dash-row` rules at :48–51) |
| Workspace host markup / construction | `telemetry-analysis/page.ts:24` (`class="workspace"`), `telemetry-usage/page-client.ts:566` |
| Shell test pattern (evaluate block alone in vm+linkedom) | `_shared/dashboard-client.test.ts:8–17` |
| Test refs needing the rename | `telemetry-analysis/page.test.ts:160–161` |
| Stays page-side: polling, guard | `telemetry-analysis/page-client.ts:618`, `:609`; `telemetry-usage/page-client.ts:611`, `:650` |

Baselines: dashboard client/page test files contain 19 tests
(`dashboard-client.test.ts` 4, `telemetry-analysis/page.test.ts` 3,
`telemetry-usage/page.test.ts` 5, `dashboard-request-lifecycle.test.ts` 7);
`test:shared` suite baseline 492 tests; typecheck clean. Shell consumers:
exactly the two page composers, the two page tests, and
`dashboard-client.test.ts`.

## Target implementation

### 1. Shell: `_shared/dashboard-client.ts`

Add after `dashFormatCompact` (before `dashCreateTablist`), inside
`DASHBOARD_CLIENT_HELPERS`:

```js
function dashFormatCost(value, digits = 3) {
	return '$' + Number(value || 0).toFixed(digits);
}

function dashCreateSelectionMemory() {
	const memory = new Map();
	return {
		store(view, key) {
			if (key != null) memory.set(view, key);
		},
		keep(view, keys) {
			const stored = memory.get(view);
			if (stored != null && keys.includes(stored)) return stored;
			const fallback = keys[0] ?? null;
			if (fallback != null) memory.set(view, fallback);
			return fallback;
		},
	};
}
```

The shell grows from 5 to 7 functions. No DOM, no fetch, no timers — pure
state plus a formatter, so the guard/tablist/lifecycle responsibilities are
untouched.

### 2. Shared styles: `_shared/dashboard-styles.ts`

`DASHBOARD_CLIENT_STYLES` gains three rules after the `.dash-row` block:

```css
.dash-row.selected, .dash-row[aria-selected="true"] { background: var(--page-surface-hover); box-shadow: inset 3px 0 var(--page-accent); }
.dash-empty { padding: 28px 12px; color: var(--page-text-muted); text-align: center; }
.dash-workspace { display: grid; grid-template-columns: minmax(280px, .78fr) minmax(420px, 1.22fr); gap: 12px; }
```

### 3. Analysis page adapter: `telemetry-analysis/page-client.ts`

State (:25–28 region):

```js
let selectedSequence = null;
let selectedPart = 'request';
const selectionMemory = dashCreateSelectionMemory();          // replaces: const selections = new Map();
const selectionKeyOf = (sequence, part) => sequence + ':' + part;
```

`saveSelection` → `rememberSelection` (:366–368):

```js
function rememberSelection() {
	if (selectedSequence != null) selectionMemory.store(selectionKey(), selectionKeyOf(selectedSequence, selectedPart));
}
```

`selectRequestForCurrentView` (:374–386) collapses to one `keep` call. Keys are
ordered per item so the first offer is `defaultPart`'s choice — that is how the
shell learns the default without learning about parts:

```js
function selectRequestForCurrentView() {
	const picked = selectionMemory.keep(selectionKey(), visibleSummaries().flatMap((item) => {
		const defaultKey = selectionKeyOf(item.sequence, defaultPart(item));
		const otherKey = selectionKeyOf(item.sequence, defaultPart(item) === 'response' ? 'request' : 'response');
		return [defaultKey, otherKey];
	}));
	if (picked == null) {
		selectedSequence = null;
		selectedPart = 'request';
		return;
	}
	const separator = picked.indexOf(':');
	selectedSequence = Number(picked.slice(0, separator));
	selectedPart = picked.slice(separator + 1);
}
```

Call-site renames `saveSelection()` → `rememberSelection()` at :408 (tab
activate), :446 (subagent click), :494 (request-row click), :580
(refresh reconcile). The refresh block keeps its exact shape:

```js
if (!visible.some((item) => item.sequence === selectedSequence)) {
	selectRequestForCurrentView();
	visible = visibleSummaries();
}
rememberSelection();
```

Cost formatting (:146): `metric('Total cost', dashFormatCost(usage.cost.total, 6))`.

Empty-state renames (:392, :431, :464, :553): `'empty-state'` → `'dash-empty'`.

Unchanged: `syncSelectedSubagent` (:349–355), `selectionKey` (:357–359),
`visibleSummaries`, `defaultPart`, `itemFingerprint`, `expandedPointers`,
`renderDetail`'s gate and stale-response guard, `renderEmptyDetail`'s
`requests?.cancel('detail')`, tab data, `usageBar`/activity/section rendering,
fetch paths, `setInterval(refresh, 1500)` (:618), the capability-token guard
(:609).

### 4. Usage page adapter: `telemetry-usage/page-client.ts`

State (near :30): add `const sessionMemory = dashCreateSelectionMemory();`
Formatter (:37–38 alias block): add `const formatCost = dashFormatCost;` and
delete the `formatCost` body (:59–61). Empty-state renames (:119, :422, :528):
`"empty"` → `"dash-empty"`.

`updateSessionWorkspace` (:524–553) — the reconcile and fallback collapse:

```js
	if (!sessions.length) {
		workspace.append(element("div", "dash-empty", currentData.sessions.length ? "No sessions match this search" : "No sessions recorded"));
		return;
	}
	selectedSessionId = sessionMemory.keep("sessions", sessions.map((session) => session.id));
	// … row loop unchanged except the click handler:
	button.addEventListener("click", () => {
		selectedSessionId = session.id;
		sessionMemory.store("sessions", session.id);
		updateSessionWorkspace(workspace);
	});
	// … detail mount:
	const selected = sessions.find((session) => session.id === selectedSessionId)!;
	workspace.append(list, renderSessionDetail(selected));
```

(The `!` is illustrative; plain JS — `selectedSessionId` is guaranteed to be a
member of `sessions` after `keep`, which is why `|| sessions[0]` at :551 is
deleted.)

Workspace host (:566): `element("div", "sessions-layout dash-workspace")`.

Unchanged: tablists (:39, :374), search filter (`matchesSession` :518),
`renderSessionDetail`, cards/charts/heatmap rendering, statuses,
`schedulePoll`/`loadState`/`requestRefresh` (:611–648), the capability-token
guard (:650).

### 5. Page composition and page styles

- `telemetry-analysis/page.ts:24`: `class="workspace"` →
  `class="workspace dash-workspace"`.
- `telemetry-analysis/page-styles.ts`: delete :18 (`.empty-state`), reduce
  :19 to `.workspace { align-items: start; }`, delete :22 (selected-row rule).
  Keep :20 (`.workspace.subagent-mode` 3-column variant) and both media-query
  blocks (:85–88, :89–94) verbatim.
- `telemetry-usage/page-styles.ts`: delete :71 (`.empty`), reduce :75 to
  `.sessions-layout { min-height: 440px; }`, delete :77 (selected-row rule).
  Media-query overrides (:100) stay.

### 6. Tests

`_shared/dashboard-client.test.ts`: extend `dashboardTestHelpers` with
`selectionMemory: dashCreateSelectionMemory()` and
`formatCost: dashFormatCost`, and add two tests:

```js
it("remembers selections per view and falls back without erasing memory", () => {
	const { helpers } = browserContext();
	const memory = helpers.selectionMemory;
	// empty offering returns null and does not touch memory
	expect(memory.keep("guardian", [])).toBeNull();
	memory.store("main", "2:response");
	expect(memory.keep("main", ["2:response", "2:request"])).toBe("2:response");
	// stored choice vanished -> first offered key wins and is persisted
	expect(memory.keep("main", ["5:request", "5:response"])).toBe("5:request");
	// keys[0] wins on a fresh view too: the first offer is the adapter's default
	expect(memory.keep("other", ["5:response", "5:request"])).toBe("5:response");
	// null never erases
	memory.store("main", null);
	expect(memory.keep("main", ["5:request"])).toBe("5:request");
	// views are isolated
	memory.store("sessions", "session-1");
	expect(memory.keep("main", ["5:request"])).toBe("5:request");
	expect(memory.keep("sessions", ["session-9"])).toBe("session-9");
});

it("formats cost with per-adapter precision", () => {
	const { helpers } = browserContext();
	expect(helpers.formatCost(1.2345)).toBe("$1.234");
	expect(helpers.formatCost(1.2345, 6)).toBe("$1.234500");
	expect(helpers.formatCost(undefined)).toBe("$0.000");
});
```

`telemetry-analysis/page.test.ts:160–161`: `.empty-state` → `.dash-empty`.
No other test changes. The 12 existing client/page tests are the integration
net: they run the composed page in vm+linkedom and assert selection restore
across refresh/tab/subagent switches (analysis) and search/selection (usage),
so they exercise the new seam through the adapters without any new page-level
assertions duplicating the shell cases (replace-don't-layer).

## Behavior parity checklist

- [ ] Tab counts, tablist wiring, keyboard navigation (delegated to the shell) — analysis test :19+ assertions pass unchanged.
- [ ] Selection restore across refresh, tab switches, and subagent switches — analysis tests pass unchanged (saved sequence **and** part restored; first-visible + `defaultPart` fallback; empty views yield null without erasing memory).
- [ ] Usage search filter, session selection, detail rendering — usage tests pass unchanged, including `"$1.234"` at :141 (default digits = 3).
- [ ] Analysis cost keeps 6 digits (:146 via `dashFormatCost(..., 6)`); Usage keeps 3.
- [ ] Empty-state: Analysis `.empty-state` → `.dash-empty` (4 client sites, 2 test refs); Usage `.empty` → `.dash-empty` (3 client sites). Dropped `border: 0; border-radius: 0;` — divs never had a default border; computed styles identical.
- [ ] `.dash-workspace` added to both workspace hosts; grid template identical; page extras preserved (`align-items: start`, `min-height: 440px`, subagent-mode 3-column, media queries) and still win the cascade (page rules compose after `DASHBOARD_CLIENT_STYLES`).
- [ ] Selected-row treatment identical: same declarations, now keyed on `.dash-row.selected` / `.dash-row[aria-selected="true"]`; Analysis rows keep `.selected` + `aria-pressed`, Usage keeps `aria-selected`.
- [ ] Polling (`setInterval(refresh, 1500)` / `schedulePoll`), fetch paths (`/api/summary`, `/api/records/:seq`, `/api/usage`, `/api/refresh`, `/api/clear`), statuses, and the capability-token guard untouched.
- [ ] XSS posture untouched: `dashFormatCost`/`dashCreateSelectionMemory` touch no DOM; all insertion stays `textContent`-based.
- [ ] `renderDetail`'s fingerprint gate, open-pointer preservation, and stale-response guard untouched (Analysis-only machinery, stays page-side).

## Documentation updates

- CONTEXT.md: done at decision time (this commit) — new **Dashboard selection
  memory** entry; **Dashboard client shell** entry extended with the memory,
  the shared workspace/selected-row/empty-state styles, and
  `dashFormatCost` precision.
- No ADR directory exists; the resolved-decisions section above is the record.

## Verification

1. `npx vitest run .pi/extensions/_shared/dashboard-client.test.ts .pi/extensions/telemetry-analysis/page.test.ts .pi/extensions/telemetry-usage/page.test.ts .pi/extensions/_shared/dashboard-request-lifecycle.test.ts` → 4 files, 21 tests pass (19 existing + 2 new).
2. `npm run test:shared`, run from `.pi/` (the package root) → full shared
   suite green (492 baseline + 2 new shell tests = 494).
3. `npm run typecheck`, also from `.pi/` → clean.
4. Manual smoke (browser): open both dashboards, confirm tab switching, Analysis selection restore after a refresh and a subagent switch, Usage session selection surviving a search detour, empty states on the Guardian tab and an unmatched search, and cost display ($X.123456 on Analysis usage view, $X.234 on Usage).

Dry-run result: the target edits above were applied literally to a scratch
checkout of `2b06a0e` and steps 1–3 verified — 4 files, 21 tests pass;
test:shared 494 pass; typecheck clean. The numbers above are verified, not
estimates.

## Risks and mitigations

- **CSS cascade regressions.** The shared rules must lose to page rules where
  pages override (media queries, subagent mode). Mitigated by construction:
  both page-styles interpolate `DASHBOARD_CLIENT_STYLES` first; verified by
  the manual smoke and by the existing responsive CSS assertions.
- **`keep` fallback persistence misunderstood as "erasing".** The null-store /
  empty-keys / fallback-persist semantics are exactly what the new shell test
  pins. If a future adapter needs forget-on-empty, that is a new interface
  member requiring a second consumer — not an option bolted on now.
- **Composite-key parsing.** `sequence` is numeric (`analysis-capture.ts:32`
  declares `sequence: number`; `:282` assigns it via `++sequence`) and `part`
  is a fixed two-word vocabulary, so `indexOf(':')` parsing is safe. The
  shell treats keys as opaque strings — parsing lives entirely in the adapter
  that built the key (decision 5), so a future adapter may choose any string
  shape, colons included.
- **Scope creep.** Explicitly out of scope: DOM/list/detail assembly, the
  detail gate, shaping extraction, polling, statuses. Each was cut by the
  deletion test in the design section; re-litigating them belongs to a future
  review with new evidence.