import { DASHBOARD_CLIENT_HELPERS } from "../_shared/dashboard-client.ts";
import { DASHBOARD_REQUEST_LIFECYCLE_CLIENT } from "../_shared/dashboard-request-lifecycle.ts";
import { TELEMETRY_USAGE_PAGE_CLIENT } from "./page-client.ts";
import { TELEMETRY_USAGE_PAGE_STYLES } from "./page-styles.ts";

export const TELEMETRY_USAGE_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Pi global usage</title>
	<style>${TELEMETRY_USAGE_PAGE_STYLES}</style>
</head>
<body>
	<div class="shell">
		<div id="status" class="status" data-phase="idle" role="status" aria-live="polite">Connecting...</div>
		<div id="fatal" class="fatal" role="alert" hidden></div>
		<main id="content" hidden>
			<div class="topbar">
				<nav class="tabs" role="tablist" aria-label="Usage views"></nav>
				<button id="refresh" type="button">Refresh</button>
			</div>
			<section id="cards" class="cards" aria-label="Usage summary"></section>
			<section id="panel" class="panel" role="tabpanel" aria-live="polite"></section>
		</main>
	</div>
	<script>${DASHBOARD_REQUEST_LIFECYCLE_CLIENT}${DASHBOARD_CLIENT_HELPERS}${TELEMETRY_USAGE_PAGE_CLIENT}</script>
</body>
</html>`;
