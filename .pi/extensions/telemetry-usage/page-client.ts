export const TELEMETRY_USAGE_PAGE_CLIENT = String.raw`
(() => {
	"use strict";
	const MODES = [
		{ key: "main", label: "Main" },
		{ key: "plan", label: "Plan mode" },
		{ key: "subagent", label: "Subagent" },
		{ key: "advisor", label: "Advisor" },
		{ key: "guardian", label: "Guardian" },
	];
	const ACTIVITY_VIEWS = [
		{ key: "daily", label: "Daily" },
		{ key: "weekly", label: "Weekly" },
		{ key: "cumulative", label: "Cumulative" },
	];
	const params = new URLSearchParams(location.hash.slice(1));
	const token = params.get("token") || "";
	const fatal = document.getElementById("fatal");
	const content = document.getElementById("content");
	const status = document.getElementById("status");
	const refreshButton = document.getElementById("refresh");
	const cards = document.getElementById("cards");
	const panel = document.getElementById("panel");
	const tabs = Array.from(document.querySelectorAll("[role=tab]"));
	let activeTab = "overview";
	let activeActivityView = "daily";
	let selectedSessionId;
	let sessionQuery = "";
	let currentData;
	let requestGeneration = 0;
	let pollTimer;

	function element(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = String(text);
		return node;
	}

	function formatInteger(value) {
		return Number(value || 0).toLocaleString();
	}

	function formatCompactInteger(value) {
		const number = Number(value || 0);
		if (!Number.isFinite(number)) return "0";
		const absolute = Math.abs(number);
		const format = (divisor, suffix) => {
			const scaled = number / divisor;
			return scaled.toFixed(scaled >= 100 ? 0 : 1).replace(/\.0$/, "") + suffix;
		};
		if (absolute >= 1e9) return format(1e9, "bn");
		if (absolute >= 1e6) return format(1e6, "m");
		if (absolute >= 1e3) return format(1e3, "k");
		return formatInteger(number);
	}

	function formatPercent(value) {
		const number = Number(value || 0);
		return (Number.isFinite(number) ? number : 0).toFixed(0) + "%";
	}

	function formatCost(value) {
		return "$" + Number(value || 0).toFixed(3);
	}

	function formatDate(value) {
		const date = new Date(value);
		return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown";
	}

	function formatDay(value) {
		const date = new Date(value);
		return Number.isFinite(date.getTime())
			? date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
			: "Unknown";
	}

	function sessionTitle(session) {
		return session.name || session.firstMessage || session.id;
	}

	function metricCards(usage, includeCounts) {
		const values = [];
		if (includeCounts) {
			values.push(["Sessions", currentData.sessionCount]);
			values.push(["Models", currentData.modelCount]);
		}
		values.push(["Tokens", formatInteger(usage.tokens)]);
		values.push(["Cost", formatCost(usage.cost)]);
		values.push(["Turns", formatInteger(usage.turns)]);
		return values;
	}

	function renderCards(usage, includeCounts) {
		cards.replaceChildren();
		for (const item of metricCards(usage, includeCounts)) {
			const card = element("div", "card");
			card.append(element("span", "card-label", item[0]), element("strong", "card-value", item[1]));
			cards.append(card);
		}
	}

	function renderOverviewCards() {
		const overview = currentData.overview;
		cards.replaceChildren();
		const values = [
			["Lifetime tokens", formatCompactInteger(overview.lifetimeTokens), ""],
			["Peak day", formatCompactInteger(overview.peakDailyTokens), overview.peakDailyStart === null ? "No activity" : formatDay(overview.peakDailyStart)],
			["Longest chat", formatInteger(overview.longestChatTurns) + " assistant turns", ""],
			["Activity streak", "Current: " + formatInteger(overview.currentStreakDays) + " days · Longest: " + formatInteger(overview.longestStreakDays) + " days", ""],
			["Sessions", formatInteger(currentData.sessionCount), ""],
		];
		for (const item of values) {
			const card = element("div", "card overview-card");
			card.append(element("span", "card-label", item[0]), element("strong", "card-value", item[1]));
			if (item[2]) card.append(element("span", "card-detail", item[2]));
			cards.append(card);
		}
	}

	function usageTable(firstHeader, rows) {
		if (!rows.length) return element("div", "empty", "No usage recorded");
		const wrap = element("div", "table-wrap");
		const table = document.createElement("table");
		const head = document.createElement("thead");
		const headerRow = document.createElement("tr");
		for (const label of [firstHeader, "Input", "Cache read", "Cache write", "Output", "Total", "Cost", "Turns"]) {
			const th = element("th", "", label);
			th.scope = "col";
			headerRow.append(th);
		}
		head.append(headerRow);
		const body = document.createElement("tbody");
		for (const row of rows) {
			const tr = document.createElement("tr");
			const values = [
				row.label,
				formatInteger(row.usage.input),
				formatInteger(row.usage.cacheRead),
				formatInteger(row.usage.cacheWrite),
				formatInteger(row.usage.output),
				formatInteger(row.usage.tokens),
				formatCost(row.usage.cost),
				formatInteger(row.usage.turns),
			];
			for (const value of values) tr.append(element("td", "", value));
			body.append(tr);
		}
		table.append(head, body);
		wrap.append(table);
		return wrap;
	}

	function bucketLabel(start, hourly) {
		const options = hourly
			? { weekday: "short", hour: "numeric" }
			: { month: "short", day: "numeric" };
		return new Date(start).toLocaleString(undefined, options);
	}

	function usageChart(title, subtitle, points, hourly) {
		const figure = element("figure", "chart-card");
		const maximum = Math.max(0, ...points.map((point) => point.usage.tokens));
		const caption = document.createElement("figcaption");
		caption.append(
			element("strong", "", title),
			element("span", "", subtitle + " · peak " + formatInteger(maximum) + " tokens"),
		);
		figure.append(caption);
		const viewport = element("div", "chart-viewport");
		const plot = element("div", "chart-plot");
		plot.setAttribute("role", "img");
		plot.setAttribute("aria-label", title + ". Peak usage " + formatInteger(maximum) + " tokens.");
		plot.style.setProperty("--points", String(points.length));
		for (const point of points) {
			const bar = element("span", "chart-bar");
			const percent = maximum > 0 ? point.usage.tokens / maximum * 100 : 0;
			bar.style.height = (point.usage.tokens > 0 ? Math.max(1.5, percent) : 0) + "%";
			bar.title = bucketLabel(point.start, hourly) + ": " + formatInteger(point.usage.tokens) + " tokens, " + formatCost(point.usage.cost) + ", " + formatInteger(point.usage.turns) + " turns";
			plot.append(bar);
		}
		viewport.append(plot);
		figure.append(viewport);
		if (maximum === 0) figure.append(element("p", "chart-empty", "No usage in this period"));
		const axis = element("div", "chart-axis");
		if (points.length) {
			axis.append(
				element("span", "", bucketLabel(points[0].start, hourly)),
				element("span", "", bucketLabel(points[Math.floor(points.length / 2)].start, hourly)),
				element("span", "", bucketLabel(points[points.length - 1].start, hourly)),
			);
		}
		figure.append(axis);
		return figure;
	}

	function heatmapLevel(tokens, maximum) {
		if (!tokens || maximum <= 0) return 0;
		const ratio = tokens / maximum;
		if (ratio >= .75) return 4;
		if (ratio >= .5) return 3;
		if (ratio >= .25) return 2;
		return 1;
	}

	function fillBoxCount(value, maximum) {
		if (maximum <= 0 || value <= 0) return 0;
		return Math.min(7, Math.max(1, Math.round(value / maximum * 7)));
	}

	function shortDay(timestamp) {
		const date = new Date(timestamp);
		return date.getDate() + " " + date.toLocaleDateString(undefined, { month: "short" });
	}

	function weekStartOf(timestamp) {
		const date = new Date(timestamp);
		date.setDate(date.getDate() - (date.getDay() + 6) % 7);
		date.setHours(0, 0, 0, 0);
		return date.getTime();
	}

	function weekTokensByStart(series) {
		const tokens = new Map();
		for (const point of series) tokens.set(weekStartOf(point.start), point.usage.tokens);
		return tokens;
	}

	function weekAlignedDays(points) {
		if (!points.length) return points;
		const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, turns: 0 };
		const first = new Date(points[0].start);
		const last = new Date(points[points.length - 1].start);
		const leading = [];
		for (let offset = (first.getDay() + 6) % 7; offset > 0; offset--) {
			const date = new Date(first);
			date.setDate(date.getDate() - offset);
			leading.push({ start: date.getTime(), usage: empty });
		}
		const trailing = [];
		for (let offset = 6 - ((last.getDay() + 6) % 7); offset > 0; offset--) {
			const date = new Date(last);
			date.setDate(date.getDate() + offset);
			trailing.push({ start: date.getTime(), usage: empty });
		}
		return leading.concat(points, trailing);
	}

	let heatmapTip;

	function showTip(cell) {
		const text = cell.getAttribute("aria-label");
		if (!text) return hideTip();
		if (!heatmapTip) {
			heatmapTip = element("div", "heatmap-tip");
			heatmapTip.setAttribute("role", "tooltip");
			document.body.append(heatmapTip);
		}
		heatmapTip.textContent = text;
		let left = 0;
		let top = 0;
		const rect = typeof cell.getBoundingClientRect === "function" ? cell.getBoundingClientRect() : null;
		if (rect && Number.isFinite(rect.left)) {
			left = rect.left + rect.width / 2;
			top = rect.top;
		}
		heatmapTip.style.left = left + "px";
		heatmapTip.style.top = top + "px";
		heatmapTip.classList.add("visible");
	}

	function hideTip() {
		heatmapTip?.classList.remove("visible");
	}

	function renderActivityGrid(points, title, decorate) {
		hideTip();
		const figure = element("figure", "activity-card heatmap-card");
		figure.setAttribute("aria-label", title);

		const firstDate = new Date(points[0]?.start || Date.now());
		const leadingDays = (firstDate.getDay() + 6) % 7;
		const weeks = Math.ceil((leadingDays + points.length) / 7);
		const viewport = element("div", "heatmap-viewport");
		const months = element("div", "heatmap-months");
		months.style.setProperty("--weeks", String(weeks));
		const seenMonths = new Set();
		points.forEach((point, index) => {
			const date = new Date(point.start);
			const monthKey = date.getFullYear() + "-" + date.getMonth();
			if (seenMonths.has(monthKey) || date.getDate() > 7) return;
			seenMonths.add(monthKey);
			const label = element("span", "", date.toLocaleDateString(undefined, { month: "short" }));
			label.style.gridColumn = String(Math.floor((leadingDays + index) / 7) + 1);
			months.append(label);
		});

		const grid = element("div", "heatmap-grid");
		grid.style.setProperty("--weeks", String(weeks));
		points.forEach((point, index) => {
			const row = (leadingDays + index) % 7;
			const state = decorate(point, row);
			const cell = element("span", state.className);
			cell.style.gridColumn = String(Math.floor((leadingDays + index) / 7) + 1);
			cell.style.gridRow = String(row + 1);
			if (state.description) {
				cell.setAttribute("role", "img");
				cell.setAttribute("aria-label", state.description);
				cell.addEventListener("mouseenter", () => showTip(cell));
				cell.addEventListener("mouseleave", hideTip);
			}
			grid.append(cell);
		});
		viewport.append(months, grid);
		viewport.addEventListener("scroll", hideTip, { passive: true });
		figure.append(viewport);
		return figure;
	}

	function renderDailyActivity(points) {
		const maximum = Math.max(0, ...points.map((point) => point.usage.tokens));
		return renderActivityGrid(
			points,
			"Daily token activity",
			(point) => ({
				className: "heatmap-cell level-" + heatmapLevel(point.usage.tokens, maximum),
				description: point.usage.tokens > 0
					? formatCompactInteger(point.usage.tokens) + " tokens on " + shortDay(point.start)
					: "",
			}),
		);
	}

	function renderWeeklyActivity(points) {
		const weeks = weekTokensByStart(currentData.activity.weekly);
		const maximum = Math.max(0, ...currentData.activity.weekly.map((point) => point.usage.tokens));
		return renderActivityGrid(
			weekAlignedDays(points),
			"Weekly token activity",
			(point, row) => {
				const tokens = weeks.get(weekStartOf(point.start)) ?? 0;
				const filled = row >= 7 - fillBoxCount(tokens, maximum);
				return {
					className: "heatmap-cell" + (filled ? " fill-on" : ""),
					description: filled ? formatCompactInteger(tokens) + " tokens on the week of " + shortDay(weekStartOf(point.start)) : "",
				};
			},
		);
	}

	function renderCumulativeActivity(points) {
		const weeks = weekTokensByStart(currentData.activity.cumulative);
		const maximum = Math.max(0, ...currentData.activity.cumulative.map((point) => point.usage.tokens));
		return renderActivityGrid(
			weekAlignedDays(points),
			"Cumulative token activity",
			(point, row) => {
				const tokens = weeks.get(weekStartOf(point.start)) ?? 0;
				const filled = row >= 7 - fillBoxCount(tokens, maximum);
				return {
					className: "heatmap-cell" + (filled ? " fill-on" : ""),
					description: filled ? formatCompactInteger(tokens) + " tokens to date on the week of " + shortDay(weekStartOf(point.start)) : "",
				};
			},
		);
	}

	function selectActivityView(key, focus) {
		activeActivityView = key;
		renderOverview();
		if (focus) document.querySelector('[data-activity="' + key + '"]')?.focus();
	}

	function activityControls() {
		const controls = element("div", "activity-controls");
		controls.setAttribute("role", "tablist");
		controls.setAttribute("aria-label", "Token activity views");
		for (const view of ACTIVITY_VIEWS) {
			const button = element("button", "activity-tab", view.label);
			button.type = "button";
			button.setAttribute("role", "tab");
			button.setAttribute("data-activity", view.key);
			button.setAttribute("aria-controls", "activity-view");
			const selected = activeActivityView === view.key;
			button.setAttribute("aria-selected", String(selected));
			button.tabIndex = selected ? 0 : -1;
			button.addEventListener("click", () => selectActivityView(view.key, true));
			button.addEventListener("keydown", (event) => {
				const buttons = Array.from(controls.querySelectorAll("[role=tab]"));
				const index = buttons.indexOf(button);
				let next = index;
				if (event.key === "ArrowRight") next = (index + 1) % buttons.length;
				else if (event.key === "ArrowLeft") next = (index - 1 + buttons.length) % buttons.length;
				else if (event.key === "Home") next = 0;
				else if (event.key === "End") next = buttons.length - 1;
				else return;
				event.preventDefault();
				selectActivityView(buttons[next].getAttribute("data-activity"), true);
			});
			controls.append(button);
		}
		return controls;
	}

	function renderActivityView() {
		const points = currentData.activity.daily;
		if (activeActivityView === "daily") return renderDailyActivity(points);
		if (activeActivityView === "weekly") return renderWeeklyActivity(points);
		return renderCumulativeActivity(points);
	}

	function insightRow(list, label, value) {
		const row = element("div", "insight-row");
		row.append(element("dt", "", label), element("dd", "", value));
		list.append(row);
	}

	function renderInsights() {
		const section = element("section", "insights-section");
		section.append(element("h2", "", "Activity insights"));
		const list = element("dl", "insights-list");
		const overview = currentData.overview;
		const model = overview.mostUsedModel
			? overview.mostUsedModel.model + " · " + formatPercent(overview.mostUsedModel.share)
			: "No model data";
		insightRow(list, "Plan mode", formatPercent(overview.planModeShare));
		insightRow(list, "Most used model", model);
		insightRow(list, "Sessions", formatInteger(currentData.sessionCount));
		insightRow(list, "Recorded turns", formatInteger(currentData.total.turns));
		insightRow(list, "Tool runs", formatInteger(overview.totalToolRuns));
		section.append(list);
		return section;
	}

	function renderTools() {
		const section = element("section", "tools-section");
		section.append(element("h2", "", "Most used tools"));
		if (!currentData.tools.length) {
			section.append(element("div", "empty", "No tool runs recorded"));
			return section;
		}
		const list = element("ol", "tool-list");
		for (const row of currentData.tools) {
			const item = element("li", "tool-row");
			const badge = element("span", "tool-badge", row.tool.slice(0, 1).toUpperCase());
			badge.setAttribute("aria-hidden", "true");
			item.append(
				badge,
				element("span", "tool-name", row.tool),
				element("span", "tool-runs", formatInteger(row.runs) + " runs"),
			);
			list.append(item);
		}
		section.append(list);
		return section;
	}

	function renderLegacyOverview() {
		renderCards(currentData.total, true);
		panel.replaceChildren(element("h2", "", "Usage over time"));
		const graphs = element("div", "chart-grid");
		graphs.append(
			usageChart("Daily usage", "Last 30 days", currentData.series.daily, false),
			usageChart("Hourly usage", "Last 7 days", currentData.series.hourly, true),
		);
		panel.append(graphs, element("h2", "section-heading", "Usage by mode"));
		const rows = MODES.map((mode) => ({ label: mode.label, usage: currentData.totals[mode.key] }));
		rows.push({ label: "Total", usage: currentData.total });
		panel.append(usageTable("Mode", rows));
	}

	function renderOverview() {
		if (!currentData.overview || !currentData.activity) {
			renderLegacyOverview();
			return;
		}
		renderOverviewCards();
		panel.replaceChildren();
		const activityView = renderActivityView();
		activityView.id = "activity-view";
		panel.append(element("h2", "", "Token activity"), activityControls(), activityView);
		const lower = element("div", "overview-lower");
		lower.append(renderInsights(), renderTools());
		panel.append(lower);
	}

	function renderMode(mode) {
		const usage = currentData.totals[mode.key];
		renderCards(usage, false);
		panel.replaceChildren(element("h2", "", mode.label + " usage by model"));
		const rows = currentData.models[mode.key].map((row) => ({ label: row.model, usage: row.usage }));
		panel.append(usageTable("Model", rows));
	}

	function metadataRow(list, label, value) {
		list.append(element("dt", "", label), element("dd", "", value || "Not set"));
	}

	function renderSessionDetail(session) {
		const detail = element("section", "session-detail");
		detail.setAttribute("aria-live", "polite");
		detail.append(element("h2", "", sessionTitle(session)));
		const metadata = element("dl", "metadata");
		metadataRow(metadata, "Session ID", session.id);
		metadataRow(metadata, "Created", formatDate(session.created));
		metadataRow(metadata, "Project", session.cwd);
		metadataRow(metadata, "Session file", session.file);
		metadataRow(metadata, "Parent session", session.parentSession);
		metadataRow(metadata, "Messages", formatInteger(session.messageCount));
		metadataRow(metadata, "Chat turns", formatInteger(session.chatTurns === undefined ? session.total.turns : session.chatTurns));
		metadataRow(metadata, "Tool runs", formatInteger(session.toolRuns));
		detail.append(metadata);
		const messageSection = element("section", "detail-section");
		messageSection.append(element("h3", "", "First message"), element("p", "first-message", session.firstMessage || "No user message recorded"));
		detail.append(messageSection);
		const totalsSection = element("section", "detail-section");
		totalsSection.append(element("h3", "", "Usage by mode"));
		const totals = MODES.map((mode) => ({ label: mode.label, usage: session.totals[mode.key] }));
		totals.push({ label: "Total", usage: session.total });
		totalsSection.append(usageTable("Mode", totals));
		detail.append(totalsSection);
		for (const mode of MODES) {
			const rows = session.models[mode.key];
			if (!rows.length) continue;
			const section = element("section", "detail-section");
			section.append(element("h3", "", mode.label + " models"));
			section.append(usageTable("Model", rows.map((row) => ({ label: row.model, usage: row.usage }))));
			detail.append(section);
		}
		return detail;
	}

	function matchesSession(session, query) {
		if (!query) return true;
		const haystack = [session.name, session.firstMessage, session.cwd, session.id].filter(Boolean).join(" ").toLowerCase();
		return haystack.includes(query.toLowerCase());
	}

	function updateSessionWorkspace(workspace) {
		workspace.replaceChildren();
		const sessions = currentData.sessions.filter((session) => matchesSession(session, sessionQuery));
		if (!sessions.length) {
			workspace.append(element("div", "empty", currentData.sessions.length ? "No sessions match this search" : "No sessions recorded"));
			return;
		}
		if (!sessions.some((session) => session.id === selectedSessionId)) selectedSessionId = sessions[0].id;
		const list = element("div", "session-list");
		list.setAttribute("role", "listbox");
		list.setAttribute("aria-label", "Sessions");
		for (const session of sessions) {
			const button = element("button", "session-row");
			button.type = "button";
			button.setAttribute("role", "option");
			button.setAttribute("aria-selected", String(session.id === selectedSessionId));
			button.append(
				element("span", "session-title", sessionTitle(session)),
				element("span", "session-project", session.cwd),
				element("span", "session-metrics", formatDate(session.created) + " · " + formatInteger(session.total.tokens) + " tokens · " + formatCost(session.total.cost)),
			);
			button.addEventListener("click", () => {
				selectedSessionId = session.id;
				updateSessionWorkspace(workspace);
			});
			list.append(button);
		}
		const selected = sessions.find((session) => session.id === selectedSessionId) || sessions[0];
		workspace.append(list, renderSessionDetail(selected));
	}

	function renderSessions() {
		renderCards(currentData.total, true);
		panel.replaceChildren(element("h2", "", "Sessions"));
		const toolbar = element("div", "sessions-toolbar");
		const label = element("label", "", "Search sessions");
		label.htmlFor = "session-search";
		const input = element("input");
		input.id = "session-search";
		input.type = "search";
		input.placeholder = "Name, message, project, or ID";
		input.value = sessionQuery;
		const workspace = element("div", "sessions-layout");
		input.addEventListener("input", () => {
			sessionQuery = input.value;
			updateSessionWorkspace(workspace);
		});
		toolbar.append(label, input);
		panel.append(toolbar, workspace);
		updateSessionWorkspace(workspace);
	}

	function renderPanel() {
		if (!currentData) return;
		if (activeTab === "overview") renderOverview();
		else if (activeTab === "sessions") renderSessions();
		else renderMode(MODES.find((mode) => mode.key === activeTab));
	}

	function selectTab(name, focus) {
		activeTab = name;
		for (const tab of tabs) {
			const selected = tab.getAttribute("data-tab") === name;
			tab.setAttribute("aria-selected", String(selected));
			tab.tabIndex = selected ? 0 : -1;
			if (selected && focus) tab.focus();
		}
		renderPanel();
	}

	function renderState(next) {
		status.setAttribute("data-phase", next.phase);
		refreshButton.disabled = next.phase === "scanning";
		if (next.phase === "scanning") {
			status.textContent = next.progress
				? "Scanning sessions... " + next.progress.loaded + "/" + next.progress.total
				: "Scanning sessions...";
		} else if (next.phase === "error") {
			status.textContent = next.data
				? "Refresh failed: " + next.diagnostic + " Showing the previous scan."
				: "Global usage unavailable: " + next.diagnostic;
		} else if (next.phase === "ready") {
			status.textContent = "Updated " + formatDate(next.data.scannedAt);
		} else {
			status.textContent = "Waiting to scan sessions...";
		}
		if (next.data) {
			currentData = next.data;
			content.hidden = false;
			const sessionTab = tabs.find((tab) => tab.getAttribute("data-tab") === "sessions");
			if (sessionTab) sessionTab.textContent = "Sessions (" + currentData.sessionCount + ")";
			renderPanel();
		} else {
			content.hidden = true;
		}
	}

	async function api(path, options) {
		const response = await fetch(path, {
			...(options || {}),
			headers: { Authorization: "Bearer " + token },
		});
		if (!response.ok) throw new Error("HTTP " + response.status + " " + response.statusText);
		return response;
	}

	function schedulePoll() {
		clearTimeout(pollTimer);
		pollTimer = setTimeout(loadState, 300);
	}

	async function loadState() {
		const generation = ++requestGeneration;
		try {
			const response = await api("/api/usage");
			const next = await response.json();
			if (generation !== requestGeneration) return;
			renderState(next);
			if (next.phase === "scanning") schedulePoll();
		} catch (error) {
			if (generation !== requestGeneration) return;
			status.setAttribute("data-phase", "error");
			status.textContent = "Could not load usage: " + (error && error.message ? error.message : String(error));
			refreshButton.disabled = false;
		}
	}

	async function requestRefresh() {
		clearTimeout(pollTimer);
		requestGeneration++;
		refreshButton.disabled = true;
		status.setAttribute("data-phase", "scanning");
		status.textContent = "Starting scan...";
		try {
			await api("/api/refresh", { method: "POST" });
			await loadState();
		} catch (error) {
			status.setAttribute("data-phase", "error");
			status.textContent = "Could not refresh usage: " + (error && error.message ? error.message : String(error));
			refreshButton.disabled = false;
		}
	}

	for (const tab of tabs) {
		tab.addEventListener("click", () => selectTab(tab.getAttribute("data-tab"), false));
		tab.addEventListener("keydown", (event) => {
			const index = tabs.indexOf(tab);
			let next = index;
			if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
			else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
			else if (event.key === "Home") next = 0;
			else if (event.key === "End") next = tabs.length - 1;
			else return;
			event.preventDefault();
			selectTab(tabs[next].getAttribute("data-tab"), true);
		});
	}
	refreshButton.addEventListener("click", requestRefresh);

	if (!token) {
		fatal.hidden = false;
		fatal.textContent = "This dashboard URL is missing its capability token. Run /global-usage again and use the complete URL.";
		content.hidden = true;
		refreshButton.disabled = true;
		return;
	}
	history.replaceState(null, "", location.pathname + location.search);
	loadState();
})();
`;
