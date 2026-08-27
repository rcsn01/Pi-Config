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
		<header>
			<div>
				<h1>Global usage</h1>
				<p class="subtitle">Token usage and cost across persisted Pi sessions.</p>
				<p class="secret">This page can reveal prompts and local paths. Treat its URL as a secret.</p>
			</div>
			<div class="header-actions">
				<button id="refresh" type="button">Refresh</button>
			</div>
		</header>
		<div id="status" class="status" data-phase="idle" role="status" aria-live="polite">Connecting...</div>
		<div id="fatal" class="fatal" role="alert" hidden></div>
		<main id="content" hidden>
			<section id="cards" class="cards" aria-label="Usage summary"></section>
			<nav class="tabs" role="tablist" aria-label="Usage views">
				<button class="tab" type="button" role="tab" data-tab="overview" aria-selected="true" aria-controls="panel" tabindex="0">Overview</button>
				<button class="tab" type="button" role="tab" data-tab="main" aria-selected="false" aria-controls="panel" tabindex="-1">Main</button>
				<button class="tab" type="button" role="tab" data-tab="plan" aria-selected="false" aria-controls="panel" tabindex="-1">Plan mode</button>
				<button class="tab" type="button" role="tab" data-tab="subagent" aria-selected="false" aria-controls="panel" tabindex="-1">Subagent</button>
				<button class="tab" type="button" role="tab" data-tab="advisor" aria-selected="false" aria-controls="panel" tabindex="-1">Advisor</button>
				<button class="tab" type="button" role="tab" data-tab="guardian" aria-selected="false" aria-controls="panel" tabindex="-1">Guardian</button>
				<button class="tab" type="button" role="tab" data-tab="sessions" aria-selected="false" aria-controls="panel" tabindex="-1">Sessions</button>
			</nav>
			<section id="panel" class="panel" role="tabpanel" aria-live="polite"></section>
		</main>
	</div>
	<script>${TELEMETRY_USAGE_PAGE_CLIENT}</script>
</body>
</html>`;
