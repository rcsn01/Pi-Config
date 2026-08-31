/**
 * Shared base stylesheet for the telemetry dashboards. Both page-styles modules
 * compose this first, then append dashboard-specific rules after it so their
 * class selectors keep overriding the element-level base rules.
 */
export const DASHBOARD_BASE_STYLES = String.raw`
:root {
	color-scheme: dark;
	font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	background: var(--page-bg);
	color: var(--page-text);
	font-synthesis: none;
	--page-bg: #282828;
	--page-surface: #303030;
	--page-surface-raised: #383838;
	--page-surface-hover: #424242;
	--page-surface-deep: #242424;
	--page-line: #4A4A4A;
	--page-line-strong: #606060;
	--page-text: #F9F8F6;
	--page-text-soft: #EFE9E3;
	--page-text-muted: #D9CFC7;
	--page-accent: #C9B59C;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: var(--page-bg); color: var(--page-text); }
button, input { font: inherit; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--page-accent); outline-offset: 2px; }
.shell { width: min(1480px, 100%); margin: 0 auto; padding: 24px; }
header { display: flex; gap: 24px; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; }
h1 { margin: 0 0 6px; font-size: clamp(1.45rem, 3vw, 2.1rem); letter-spacing: -0.035em; }
button { border: 1px solid var(--page-line); border-radius: 8px; color: var(--page-text); background: var(--page-surface-raised); cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--page-line-strong); background: var(--page-surface-hover); }
button:disabled { cursor: wait; opacity: .58; }
.status { min-height: 42px; display: flex; align-items: center; padding: 10px 13px; margin-bottom: 16px; border: 1px solid var(--page-line); border-radius: 9px; background: var(--page-surface); color: var(--page-text-soft); }
@media (max-width: 760px) {
	.shell { padding: 14px; }
	header { display: block; }
}
`;

/** Shared browser styles for dashboard tabs and list/detail rows. */
export const DASHBOARD_CLIENT_STYLES = String.raw`
[role="tablist"] { display: flex; gap: 18px; overflow-x: auto; }
[role="tab"] { padding: 8px 0 6px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--page-text-muted); white-space: nowrap; }
[role="tab"]:hover:not(:disabled) { border-bottom-color: var(--page-line-strong); background: transparent; }
[role="tab"][aria-selected="true"] { border-bottom-color: var(--page-accent); background: transparent; color: var(--page-text); }
.dash-row { width: 100%; padding: 11px 12px; border: 0; border-bottom: 1px solid var(--page-surface-hover); border-radius: 0; background: transparent; color: var(--page-text); font-weight: 400; text-align: left; }
.dash-row:last-child { border-bottom: 0; }
.dash-row:hover:not(:disabled) { background: var(--page-surface-hover); }
.dash-row > strong, .dash-row > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
