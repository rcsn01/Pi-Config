import { DASHBOARD_REQUEST_LIFECYCLE_CLIENT } from "../_shared/dashboard-request-lifecycle.ts";
import { ANALYSIS_PAGE_CLIENT } from "./page-client.ts";
import { ANALYSIS_PAGE_STYLES } from "./page-styles.ts";

export const ANALYSIS_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Pi request analysis</title>
	<style>${ANALYSIS_PAGE_STYLES}</style>
</head>
<body>
	<div class="shell">
		<main>
			<div id="sourceTabs" class="source-tabs" role="tablist" aria-label="Request sources"></div>
			<div id="activation" class="status" data-phase="idle" role="status" aria-live="polite">Connecting...</div>
			<div id="error" class="alert hidden"></div>
			<div id="paused" class="alert hidden">
				<div id="pausedText"></div>
				<button id="clear">Clear and resume</button>
			</div>
			<div id="sourcePanel" class="workspace" role="tabpanel" aria-labelledby="tab-main">
				<nav id="requestList" class="request-list" aria-label="Captured requests"></nav>
				<section id="detailPane" class="detail-pane" aria-live="polite"></section>
			</div>
		</main>
	</div>
	<script>${DASHBOARD_REQUEST_LIFECYCLE_CLIENT}${ANALYSIS_PAGE_CLIENT}</script>
</body>
</html>`;
