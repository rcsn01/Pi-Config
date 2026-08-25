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
	<header>
		<h1>Pi provider request analysis</h1>
		<div id="activation" class="muted">Connecting...</div>
	</header>
	<main>
		<div id="error" class="alert hidden"></div>
		<div id="paused" class="alert hidden">
			<div id="pausedText"></div>
			<button id="clear">Clear and resume</button>
		</div>
		<p class="muted">
			Requests shown here are logical payloads exposed by Pi before transport-specific transformations.
			Captured prompts and tool data may contain secrets.
		</p>
		<div id="sourceTabs" class="source-tabs" role="tablist" aria-label="Request sources"></div>
		<div id="sourcePanel" class="workspace" role="tabpanel" aria-labelledby="tab-main">
			<nav id="requestList" class="request-list" aria-label="Captured requests"></nav>
			<section id="detailPane" class="detail-pane" aria-live="polite"></section>
		</div>
	</main>
	<script>${ANALYSIS_PAGE_CLIENT}</script>
</body>
</html>`;
