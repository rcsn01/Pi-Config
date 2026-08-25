export const ANALYSIS_PAGE_STYLES = String.raw`
:root {
	color-scheme: dark;
	--bg: #101316;
	--panel: #181d22;
	--line: #303840;
	--muted: #9ca8b3;
	--text: #edf2f6;
	--accent: #62b5ff;
	--hit: #245942;
	--miss: #6a4931;
	--bad: #ff8c82;
}

* {
	box-sizing: border-box;
}

body {
	margin: 0;
	background: var(--bg);
	color: var(--text);
	font: 14px/1.45 system-ui, sans-serif;
}

header,
main {
	max-width: 1600px;
	margin: auto;
	padding: 20px;
}

h1 {
	font-size: 22px;
	margin: 0 0 6px;
}

h2 {
	font-size: 17px;
}

.muted {
	color: var(--muted);
}

.alert {
	border: 1px solid var(--bad);
	padding: 12px;
	color: var(--bad);
	margin: 12px 0;
}

.hidden {
	display: none;
}

button {
	background: var(--accent);
	border: 0;
	border-radius: 4px;
	padding: 8px 12px;
	color: #08121b;
	font-weight: 700;
	cursor: pointer;
}

.workspace {
	display: grid;
	grid-template-columns: minmax(240px, 340px) minmax(0, 1fr);
	gap: 16px;
	align-items: start;
}

.request-list {
	display: flex;
	flex-direction: column;
	gap: 6px;
	position: sticky;
	top: 12px;
	max-height: calc(100vh - 24px);
	overflow: auto;
}

.request-row {
	width: 100%;
	background: var(--panel);
	border: 1px solid var(--line);
	border-radius: 6px;
	padding: 10px;
	color: var(--text);
	font-weight: 400;
	text-align: left;
}

.request-row:hover,
.request-row.selected {
	border-color: var(--accent);
	background: #202a33;
}

.request-row strong,
.request-row span {
	display: block;
}

.request-row span {
	color: var(--muted);
	font-size: 12px;
	margin-top: 3px;
}

.detail-pane {
	min-width: 0;
	background: var(--panel);
	border: 1px solid var(--line);
	padding: 16px;
	border-radius: 6px;
}

.detail-pane:empty {
	display: none;
}

.grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
	gap: 8px;
}

.metric {
	background: #11161a;
	padding: 8px;
}

.bar {
	display: flex;
	height: 18px;
	margin: 10px 0;
	background: #252b31;
}

.bar span {
	min-width: 1px;
}

.uncached {
	background: #d8894d;
}

.cache {
	background: #55a979;
}

.write {
	background: #9873c8;
}

.output {
	background: #5799d1;
}

.reasoning {
	background: #c66abd;
}

.sections {
	margin: 8px 0;
}

.section-controls {
	display: flex;
	gap: 8px;
	margin: 10px 0;
}

.section-controls button {
	background: #26313a;
	color: var(--text);
	border: 1px solid var(--line);
	padding: 5px 9px;
}

.section-group {
	margin: 16px 0 6px;
	font-size: 14px;
}

.analysis-section {
	border: 1px solid var(--line);
	margin: 5px 0;
	background: #11161a;
}

.analysis-section[open] {
	border-color: #53616d;
}

.analysis-section > summary {
	cursor: pointer;
	list-style: none;
	position: relative;
	min-height: 30px;
	padding: 5px 8px;
}

.analysis-section > summary::-webkit-details-marker {
	display: none;
}

.analysis-section > summary::before {
	content: "▸";
	display: inline-block;
	width: 16px;
	color: var(--accent);
}

.analysis-section[open] > summary::before {
	content: "▾";
}

.section-bar {
	position: absolute;
	inset: 0 0 0 24px;
	display: flex;
	opacity: 0.45;
	pointer-events: none;
}

.section-bar .hit {
	background: var(--hit);
}

.section-bar .miss {
	background: var(--miss);
}

.section-label {
	position: relative;
}

.section-content {
	margin: 0;
	border-width: 1px 0 0;
	max-height: 600px;
}

.option-section > summary {
	background: #171d22;
}

pre {
	white-space: pre-wrap;
	word-break: break-word;
	background: #0c0f12;
	border: 1px solid var(--line);
	padding: 12px;
	max-height: 600px;
	overflow: auto;
}

code {
	color: #bcdcff;
}

details details {
	margin-top: 10px;
}

.status {
	color: var(--accent);
}

@media (max-width: 760px) {
	.workspace {
		grid-template-columns: 1fr;
	}

	.request-list {
		position: static;
		max-height: 35vh;
	}
}
`;
