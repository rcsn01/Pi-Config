import { DASHBOARD_BASE_STYLES } from "../_shared/dashboard-styles.ts";

export const ANALYSIS_PAGE_STYLES = String.raw`${DASHBOARD_BASE_STYLES}
h2 { margin: 0 0 14px; font-size: 1.1rem; font-weight: 570; }
.muted { color: var(--page-text-muted); }
.status { min-height: 0; padding: 0; border: 0; background: transparent; }
.alert { padding: 12px 0; color: var(--page-text-soft); margin: 0 0 16px; }
.alert button { margin-top: 10px; padding: 9px 14px; }
.hidden { display: none !important; }
.source-tabs { display: flex; gap: 18px; overflow-x: auto; margin-bottom: 30px; }
.source-tab { padding: 8px 0 6px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--page-text-muted); white-space: nowrap; }
.source-tab:hover:not(:disabled) { border-bottom-color: var(--page-line-strong); background: transparent; }
.source-tab[aria-selected="true"] { border-bottom-color: var(--page-accent); background: transparent; color: var(--page-text); }
.source-tab:focus-visible, .request-row:focus-visible { outline: 2px solid var(--page-accent); outline-offset: 2px; }
.empty-state { padding: 28px 12px; border: 0; border-radius: 0; color: var(--page-text-muted); text-align: center; }
.workspace { display: grid; grid-template-columns: minmax(280px, .78fr) minmax(420px, 1.22fr); gap: 12px; align-items: start; }
.request-list { overflow: auto; position: sticky; top: 12px; max-height: 68vh; background: transparent; }
.request-row { width: 100%; padding: 11px 12px; border: 0; border-bottom: 1px solid #424242; border-radius: 0; background: transparent; color: var(--page-text); font-weight: 400; text-align: left; }
.request-row:last-child { border-bottom: 0; }
.request-row:hover { background: var(--page-surface-hover); }
.request-row.selected { background: var(--page-surface-hover); box-shadow: inset 3px 0 var(--page-accent); }
.request-row strong, .request-row span { display: block; }
.request-row strong { overflow: hidden; color: var(--page-text-soft); text-overflow: ellipsis; white-space: nowrap; }
.request-row span { overflow: hidden; margin-top: 4px; color: var(--page-text-muted); font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
.detail-pane { min-width: 0; padding: 16px 0; background: transparent; }
.detail-pane:empty { display: none; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 24px; margin-bottom: 16px; }
.metric { min-width: 0; padding: 10px 0; background: transparent; }
.metric .muted { margin-bottom: 3px; font-size: .78rem; }
.metric > div:last-child { overflow-wrap: anywhere; color: var(--page-text); }
.bar { display: flex; height: 18px; margin: 10px 0; overflow: hidden; border: 1px solid var(--page-line); border-radius: 5px; background: #4A4A4A; }
.bar span { min-width: 1px; margin: 0; }
.bar span + span { border-left: 1px solid var(--page-bg); }
.request-usage-bar { height: 7px; margin: 8px -12px -11px; border-width: 1px 0 0; border-radius: 0 0 9px 9px; }
.usage-unavailable { background: #5A5A5A; }
.uncached { background: var(--page-text); }
.cache { background: var(--page-text-soft); }
.write { background: var(--page-text-muted); }
.output { background: var(--page-accent); }
.reasoning { background: #8A8A8A; }
.sections { margin: 22px 0 0; }
.sections > .muted { margin: -6px 0 12px; }
.section-controls { display: flex; gap: 8px; margin: 10px 0 16px; }
.section-controls button { padding: 6px 10px; background: var(--page-surface-raised); color: var(--page-text); border: 1px solid var(--page-line-strong); }
.section-group { margin: 20px 0 8px; color: var(--page-text-soft); font-size: .92rem; font-weight: 600; }
.analysis-section { margin: 6px 0; border-bottom: 1px solid var(--page-line); background: transparent; }
.analysis-section > summary { position: relative; min-height: 34px; padding: 7px 0; background: transparent; cursor: pointer; list-style: none; }
.analysis-section > summary::-webkit-details-marker { display: none; }
.analysis-section > summary::before { display: inline-block; width: 16px; color: var(--page-accent); content: "▸"; }
.analysis-section[open] > summary::before { content: "▾"; }
.section-bar { position: absolute; inset: 0 0 0 25px; display: flex; opacity: .42; pointer-events: none; }
.section-bar .hit { background: var(--page-accent); }
.section-bar .miss { background: #6A6A6A; }
.section-label { position: relative; }
.option-section > summary { background: transparent; }
pre { max-height: 600px; overflow: auto; padding: 12px 0; background: transparent; color: var(--page-text-soft); white-space: pre-wrap; word-break: break-word; }
.section-content { max-height: 600px; margin: 0; border-top: 1px solid var(--page-line); }
code { color: var(--page-text-soft); }
details details { margin-top: 10px; }
@media (max-width: 760px) {
	.workspace { grid-template-columns: 1fr; }
	.request-list { position: static; max-height: 300px; }
	.detail-pane { padding: 11px 0; }
}
`;