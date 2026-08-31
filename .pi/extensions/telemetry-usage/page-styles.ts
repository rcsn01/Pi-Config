import { DASHBOARD_BASE_STYLES, DASHBOARD_CLIENT_STYLES } from "../_shared/dashboard-styles.ts";

export const TELEMETRY_USAGE_PAGE_STYLES = String.raw`${DASHBOARD_BASE_STYLES}${DASHBOARD_CLIENT_STYLES}
.topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 30px; }
#refresh { flex: 0 0 auto; padding: 9px 14px; white-space: nowrap; }
.status { min-height: 0; padding: 0; border: 0; background: transparent; }
.status[data-phase="scanning"] { color: var(--page-accent); }
.status[data-phase="error"] { color: var(--page-text-soft); }
.fatal { padding: 18px 0; color: var(--page-text-soft); }
[hidden] { display: none !important; }
.cards { display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 28px; margin-bottom: 30px; }
.card { min-width: 0; padding: 2px 0; background: transparent; text-align: center; }
.card-label { display: block; margin-top: 5px; color: var(--page-text-muted); font-size: .9rem; }
.card-value { display: block; overflow: hidden; color: var(--page-text); font-size: 1.45rem; font-weight: 560; text-overflow: ellipsis; white-space: nowrap; }
.overview-card .card-value { font-size: clamp(1.2rem, 2.2vw, 1.65rem); }
.card-detail { display: block; margin-top: 3px; overflow: hidden; color: var(--page-text-soft); font-size: .75rem; text-overflow: ellipsis; white-space: nowrap; }
.panel { min-height: 280px; padding: 16px 0; background: transparent; }
.panel h2, .panel h3 { margin: 0; }
.panel h2 { margin-bottom: 14px; font-size: 1.1rem; font-weight: 570; }
.panel h3 { margin-bottom: 9px; font-size: .92rem; color: var(--page-text-soft); }
.section-heading { margin-top: 22px !important; }
.activity-controls { justify-content: flex-end; margin: -42px 0 16px; }
.activity-tab { padding: 3px 0; border: 0; border-radius: 0; background: transparent; color: var(--page-text-muted); }
.activity-tab:hover:not(:disabled) { background: transparent; color: var(--page-text-soft); }
.activity-tab.dash-tab-selected { color: var(--page-accent); }
.activity-card { min-width: 0; margin: 0; }
.chart-card figcaption { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.chart-card figcaption span { color: var(--page-text-muted); font-size: .8rem; }
.heatmap-viewport { width: max-content; max-width: 100%; overflow-x: auto; margin: 0 auto; padding: 2px 0 5px; }
.heatmap-months { display: grid; grid-template-columns: repeat(var(--weeks), 12px); column-gap: 3px; min-width: max-content; height: 20px; }
.heatmap-months span { color: var(--page-text-muted); font-size: .72rem; }
.heatmap-grid { display: grid; grid-template-columns: repeat(var(--weeks), 12px); grid-template-rows: repeat(7, 12px); gap: 3px; min-width: max-content; }
.heatmap-cell { display: block; width: 12px; height: 12px; border-radius: 3px; background: var(--page-line); }
.heatmap-cell:hover { outline: 1px solid var(--page-accent); outline-offset: 1px; }
.heatmap-tip { position: fixed; z-index: 20; padding: 6px 9px; border: 1px solid var(--page-line-strong); border-radius: 7px; background: var(--page-surface-deep); color: var(--page-text); font-size: .78rem; white-space: nowrap; pointer-events: none; opacity: 0; transform: translate(-50%, calc(-100% - 6px)); transition: opacity .08s linear; }
.heatmap-tip.visible { opacity: 1; }
.heatmap-cell.level-1 { background: #5A5A5A; }
.heatmap-cell.level-2 { background: var(--page-accent); }
.heatmap-cell.level-3 { background: var(--page-text-muted); }
.heatmap-cell.level-4 { background: var(--page-text); }
.fill-on { background: var(--page-accent); }
.chart-grid { display: grid; gap: 12px; }
.chart-card { min-width: 0; margin: 0; padding: 13px 0 10px; background: transparent; }
.chart-viewport { overflow-x: auto; }
.chart-plot { display: flex; align-items: flex-end; gap: 2px; min-width: max(100%, calc(var(--points) * 4px)); height: 150px; padding-top: 10px; border-bottom: 1px solid var(--page-line-strong); background: repeating-linear-gradient(to bottom, transparent 0, transparent 36px, #3C3C3C 37px); }
.chart-bar { flex: 1 0 2px; min-width: 2px; max-width: 22px; border-radius: 3px 3px 0 0; background: linear-gradient(180deg, var(--page-text), var(--page-accent)); }
.chart-bar:hover { background: var(--page-text-soft); }
.chart-axis { display: flex; justify-content: space-between; gap: 8px; margin-top: 6px; color: var(--page-text-muted); font-size: .72rem; }
.chart-empty { margin: -88px 0 69px; color: var(--page-text-muted); text-align: center; pointer-events: none; }
.overview-lower { display: grid; grid-template-columns: minmax(0, .95fr) minmax(0, 1.05fr); gap: 36px; margin-top: 36px; }
.insights-section h2, .tools-section h2 { margin-bottom: 12px; }
.insights-list { margin: 0; }
.insight-row { display: flex; justify-content: space-between; gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--page-line); }
.insight-row:last-child { border-bottom: 0; }
.insight-row dt { color: var(--page-text-muted); }
.insight-row dd { margin: 0; color: var(--page-text-soft); text-align: right; }
.tool-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.tool-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) max-content; gap: 10px; align-items: center; min-width: 0; padding: 5px 0; }
.tool-badge { display: grid; width: 30px; height: 30px; place-items: center; border: 1px solid var(--page-line-strong); border-radius: 50%; background: var(--page-surface-raised); color: var(--page-accent); font-size: .78rem; font-weight: 650; }
.tool-name { overflow: hidden; color: var(--page-text-soft); text-overflow: ellipsis; white-space: nowrap; }
.tool-runs { color: var(--page-text-muted); white-space: nowrap; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 9px 10px; border-bottom: 1px solid var(--page-surface-hover); text-align: right; white-space: nowrap; }
th { color: var(--page-text-muted); background: transparent; font-size: .75rem; text-transform: uppercase; letter-spacing: .055em; }
th:first-child, td:first-child { text-align: left; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--page-surface-raised); }
.empty { padding: 28px 12px; color: var(--page-text-muted); text-align: center; }
.sessions-toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.sessions-toolbar label { color: var(--page-text-muted); font-size: .84rem; }
.sessions-toolbar input { width: min(430px, 100%); padding: 9px 11px; border: 1px solid var(--page-line-strong); border-radius: 8px; background: var(--page-surface-deep); color: var(--page-text); }
.sessions-layout { display: grid; grid-template-columns: minmax(280px, .78fr) minmax(420px, 1.22fr); gap: 12px; min-height: 440px; }
.session-list { overflow: auto; max-height: 68vh; background: transparent; }
.session-row[aria-selected="true"] { background: var(--page-surface-hover); box-shadow: inset 3px 0 var(--page-accent); }
.session-title { color: var(--page-text-soft); font-weight: 630; }
.session-project, .session-metrics { margin-top: 4px; color: var(--page-text-muted); font-size: .78rem; }
.session-detail { min-width: 0; padding: 14px 0; background: transparent; }
.metadata { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px 12px; margin: 0 0 16px; font-size: .84rem; }
.metadata dt { color: var(--page-text-muted); }
.metadata dd { overflow-wrap: anywhere; margin: 0; }
.detail-section { margin-top: 17px; }
.first-message { margin: 0; padding: 10px 0; background: transparent; color: var(--page-text-soft); white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 980px) {
	.cards { grid-template-columns: repeat(3, minmax(120px, 1fr)); }
	.card:nth-child(3) { border-right: 0; }
	.card:nth-child(n + 4) { margin-top: 14px; }
	.overview-lower { grid-template-columns: 1fr; gap: 24px; }
}
@media (max-width: 760px) {
	.topbar { gap: 14px; }
	.cards { grid-template-columns: repeat(2, minmax(110px, 1fr)); gap: 20px; }
	.card { padding: 3px 0; }
	.card:nth-child(n + 3) { margin-top: 14px; }
	.activity-controls { justify-content: flex-start; margin: -4px 0 16px; }
	.sessions-layout { grid-template-columns: 1fr; }
	.session-list { max-height: 300px; }
	.panel { padding: 11px 0; }
}
@media (max-width: 440px) {
	.cards { grid-template-columns: 1fr; }
	.card:not(:first-child) { margin-top: 12px; padding-top: 12px; }
	.sessions-toolbar { display: block; }
	.sessions-toolbar label { display: block; margin-bottom: 6px; }
}
`;