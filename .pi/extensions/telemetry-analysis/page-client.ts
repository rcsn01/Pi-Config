export const ANALYSIS_PAGE_CLIENT = String.raw`
'use strict';

const requests = createDashboardRequestLifecycle();
const subagentList = document.getElementById('subagentList');
const requestList = document.getElementById('requestList');
const detailPane = document.getElementById('detailPane');
const sourceTabs = document.getElementById('sourceTabs');
const sourcePanel = document.getElementById('sourcePanel');
const activation = document.getElementById('activation');
const error = document.getElementById('error');

const tabs = [
	{ key: 'main', label: 'Main' },
	{ key: 'subagent', label: 'Subagents' },
	{ key: 'advisor', label: 'Advisor' },
	{ key: 'guardian', label: 'Guardian' },
	{ key: 'compaction', label: 'Compaction' },
];
let summaries = [];
let activeChannel = 'main';
let selectedSubagentId = null;
let selectedSequence = null;
let selectedPart = 'request';
const selectionMemory = dashCreateSelectionMemory();
const selectionKeyOf = (sequence, part) => sequence + ':' + part;

const element = dashElement;
const fmt = dashFormatInteger;

function metric(label, value, tokenClass = '') {
	const box = element('div', 'metric' + (tokenClass ? ' token-metric ' + tokenClass : ''));
	box.append(element('div', 'muted', label), element('div', '', value));
	return box;
}

function usageBar(usage, className = '', composition = 'all') {
	const bar = element('div', 'bar' + (className ? ' ' + className : ''));
	bar.setAttribute('role', 'img');
	if (!usage) {
		bar.classList.add('usage-unavailable');
		bar.title = 'Token usage not reported';
		bar.setAttribute('aria-label', bar.title);
		return bar;
	}
	const reasoning = usage.reasoning || 0;
	const segments = composition === 'request'
		? [
			['token-input', 'Input', usage.input],
			['token-cache-input', 'Cache input', usage.cacheRead],
			['token-cache-write', 'Cache write', usage.cacheWrite],
		]
		: composition === 'response'
			? [
				['token-output', 'Output', Math.max(0, usage.output - reasoning)],
				['token-reasoning', 'Reasoning output', reasoning],
			]
			: [
				['token-input', 'Input', usage.input],
				['token-cache-input', 'Cache input', usage.cacheRead],
				['token-cache-write', 'Cache write', usage.cacheWrite],
				['token-output', 'Output', Math.max(0, usage.output - reasoning)],
				['token-reasoning', 'Reasoning output', reasoning],
			];
	const total = segments.reduce((sum, [, , count]) => sum + count, 0);
	const labels = [];
	segments.forEach(([segmentClass, label, count]) => {
		if (!count || !total) return;
		const percent = 100 * count / total;
		const segment = document.createElement('span');
		segment.className = segmentClass;
		segment.style.width = percent + '%';
		segment.title = label + ': ' + fmt(count) + ' tokens (' + percent.toFixed(1) + '%)';
		labels.push(segment.title);
		bar.append(segment);
	});
	bar.setAttribute('aria-label', labels.length ? labels.join(', ') : 'No token usage');
	return bar;
}

const REQUEST_ACTIVITY_BADGES = {
	'user-input': { label: 'User input', className: 'activity-user-input' },
	'tool-result': { label: 'Tool result', className: 'activity-tool-result' },
};
const RESPONSE_ACTIVITY_BADGES = {
	thinking: { label: 'Thinking', className: 'activity-thinking' },
	'tool-call-request': { label: 'Tool request', className: 'activity-tool-call-request' },
	output: { label: 'Output', className: 'activity-output' },
};

function activityText(activity, badges) {
	const metadata = badges[activity?.kind];
	if (!metadata) return null;
	const labels = Array.isArray(activity.labels) ? activity.labels.filter((label) => typeof label === 'string' && label) : [];
	const count = Number.isInteger(activity.count) && activity.count > 1 ? ' ×' + activity.count : '';
	return metadata.label + (labels.length ? ': ' + labels.join(', ') : '') + count;
}

function activityBadgeList(activities, badges, className, ariaLabel) {
	const values = Array.isArray(activities)
		? activities.map((activity) => ({ activity, text: activityText(activity, badges) })).filter(({ text }) => text !== null)
		: [];
	if (!values.length) return null;
	const list = element('span', className);
	list.setAttribute('role', 'list');
	list.setAttribute('aria-label', ariaLabel + ': ' + values.map(({ text }) => text).join(', '));
	values.forEach(({ activity, text }) => {
		const metadata = badges[activity.kind];
		const badge = element('span', 'activity-badge ' + metadata.className, text);
		badge.setAttribute('role', 'listitem');
		badge.title = text;
		list.append(badge);
	});
	return list;
}

function activityGroup(activities, badges, groupClass, listClass, label) {
	const list = activityBadgeList(activities, badges, listClass, 'Provider ' + label.toLowerCase() + ' activities');
	if (!list) return null;
	const group = element('span', 'activity-group ' + groupClass);
	group.append(element('span', 'activity-group-label', label), list);
	return group;
}

function activityGroups(requestActivities, responseActivities) {
	const request = activityGroup(requestActivities, REQUEST_ACTIVITY_BADGES, 'request-activity-group', 'request-activities', 'Request');
	const response = activityGroup(responseActivities, RESPONSE_ACTIVITY_BADGES, 'response-activity-group', 'response-activities', 'Response');
	if (!request && !response) return null;
	const groups = element('span', 'activity-groups');
	if (request) groups.append(request);
	if (response) groups.append(response);
	return groups;
}

function usageView(usage) {
	const box = element('div', 'usage-summary');
	box.append(element('div', 'summary-label', 'Exact provider-reported usage'));
	const grid = element('div', 'grid usage-grid');
	grid.append(
		metric('Input', fmt(usage.input), 'token-input'),
		metric('Cache input', fmt(usage.cacheRead), 'token-cache-input'),
		metric('Cache write', fmt(usage.cacheWrite), 'token-cache-write'),
		metric('Output', fmt(usage.output), 'token-output'),
		metric('Reasoning, subset of output', usage.reasoning == null ? 'not reported' : fmt(usage.reasoning), 'token-reasoning'),
		metric('Total tokens', fmt(usage.totalTokens)),
		metric('Total cost', dashFormatCost(usage.cost.total, 6)),
	);
	box.append(grid);

	box.append(usageBar(usage));
	return box;
}

function rawDetails(title, json) {
	const details = document.createElement('details');
	const summary = document.createElement('summary');
	const content = document.createElement('pre');
	summary.textContent = title == null ? '' : String(title);
	content.textContent = json == null ? '' : String(json);
	details.append(summary, content);
	return details;
}

function pointerValue(root, pointer) {
	if (pointer === '') return root;
	return pointer.slice(1).split('/').reduce(
		(value, part) => value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')],
		root,
	);
}

function readableMessage(value, kind) {
	if (!['instruction', 'conversation', 'reasoning'].includes(kind)
		|| value === null || typeof value !== 'object' || Array.isArray(value)
		|| !Object.hasOwn(value, 'content')) return null;
	const fields = Object.entries(value)
		.filter(([key]) => key !== 'content')
		.map(([key, fieldValue]) => key + ': ' + (typeof fieldValue === 'string'
			? fieldValue
			: JSON.stringify(fieldValue, null, 2)));
	let content = value.content;
	if (Array.isArray(content)) {
		content = content.map((part, index) => {
			if (part && typeof part === 'object' && typeof part.text === 'string') {
				return '[' + (part.type || 'part ' + (index + 1)) + ']\n' + part.text;
			}
			return JSON.stringify(part, null, 2);
		}).join('\n\n');
	} else if (typeof content !== 'string') {
		content = JSON.stringify(content, null, 2);
	}
	return fields.concat('content:', content ?? '').join('\n');
}

function displayValue(value, kind) {
	if (typeof value === 'string') return value;
	const readable = readableMessage(value, kind);
	if (readable !== null) return readable;
	const json = JSON.stringify(value, null, 2);
	return json === undefined ? 'Value is missing from the captured request.' : json;
}

function sectionDetails(section, root) {
	const details = document.createElement('details');
	details.className = 'analysis-section' + (section.kind === 'option' ? ' option-section' : '');
	details.dataset.pointer = section.pointer;

	const summary = document.createElement('summary');
	if (section.kind !== 'option' && section.allocatedTokens != null) {
		const allocated = section.allocatedTokens;
		const cached = section.cachedTokens || 0;
		const bar = element('div', 'section-bar');
		const hit = element('div', 'hit');
		const miss = element('div', 'miss');
		hit.style.width = (allocated ? 100 * cached / allocated : 0) + '%';
		miss.style.width = (allocated ? 100 * (allocated - cached) / allocated : 100) + '%';
		bar.append(hit, miss);
		summary.append(bar);
	}

	const label = document.createElement('span');
	label.className = 'section-label';
	const tokenText = section.kind === 'option'
		? section.kind
		: section.allocatedTokens == null
			? section.estimatedTokens + ' locally estimated tokens'
			: section.allocatedTokens + ' estimated tokens';
	label.textContent = section.label + ' · ' + tokenText + ' · ' + (section.pointer || '/');
	summary.append(label);

	const content = document.createElement('pre');
	content.className = 'section-content';
	content.textContent = displayValue(pointerValue(root, section.pointer), section.kind);
	details.append(summary, content);
	return details;
}

function sectionView(detail, openPointers) {
	const box = element('div', 'sections');

	const controls = element('div', 'section-controls');
	const expand = document.createElement('button');
	const collapse = document.createElement('button');
	expand.type = 'button';
	collapse.type = 'button';
	expand.textContent = 'Expand all';
	collapse.textContent = 'Collapse all';
	expand.addEventListener('click', () => {
		box.querySelectorAll('details.analysis-section, details.tool-section-group').forEach((row) => {
			row.open = true;
		});
	});
	collapse.addEventListener('click', () => {
		box.querySelectorAll('details.analysis-section, details.tool-section-group').forEach((row) => {
			row.open = false;
		});
	});
	controls.append(expand, collapse);
	box.append(controls);

	try {
		const root = JSON.parse(detail.requestJson);
		const requestSections = detail.sections.filter((section) => section.kind !== 'option');
		const optionSections = detail.sections.filter((section) => section.kind === 'option');

		if (requestSections.length) {
			box.append(element('div', 'section-group', 'Prompt, tools, and conversation'));
			for (let index = 0; index < requestSections.length;) {
				const section = requestSections[index];
				if (section.kind !== 'tool') {
					const row = sectionDetails(section, root);
					if (openPointers.has(section.pointer)) row.open = true;
					box.append(row);
					index++;
					continue;
				}

				const toolSections = [];
				while (index < requestSections.length && requestSections[index].kind === 'tool') {
					toolSections.push(requestSections[index]);
					index++;
				}
				if (toolSections.length === 1) {
					const row = sectionDetails(toolSections[0], root);
					if (openPointers.has(toolSections[0].pointer)) row.open = true;
					box.append(row);
					continue;
				}
				const tools = document.createElement('details');
				tools.className = 'tool-section-group';
				tools.dataset.pointer = '__tool_schemas__' + toolSections[0].pointer;
				tools.open = openPointers.has(tools.dataset.pointer);
				const summary = document.createElement('summary');
				summary.textContent = 'Tool schemas (' + toolSections.length + ')';
				tools.append(summary);
				toolSections.forEach((toolSection) => {
					const row = sectionDetails(toolSection, root);
					if (openPointers.has(toolSection.pointer)) row.open = true;
					tools.append(row);
				});
				box.append(tools);
			}
		}
		if (optionSections.length) {
			box.append(element('div', 'section-group', 'Request options'));
			optionSections.forEach((section) => {
				const row = sectionDetails(section, root);
				if (openPointers.has(section.pointer)) row.open = true;
				box.append(row);
			});
		}
	} catch (caught) {
		box.append(element('div', 'alert', 'Could not parse the captured request JSON: ' + caught.message));
	}
	return box;
}

function expandedPointers() {
	return new Set(Array.from(
		detailPane.querySelectorAll('details.analysis-section[open], details.tool-section-group[open]'),
		(row) => row.dataset.pointer,
	));
}

function itemFingerprint(item, part) {
	return [part, item.sequence, item.state, item.bytes, item.status, item.diagnostic, JSON.stringify(item.requestActivities), JSON.stringify(item.responseActivities)].join(':');
}

function channelOf(item) {
	return item.source?.channel || 'main';
}

function subagentIdOf(item) {
	return item.source?.invocationId || 'legacy';
}

function availableSubagents() {
	const grouped = new Map();
	for (const item of summaries) {
		if (channelOf(item) !== 'subagent') continue;
		const id = subagentIdOf(item);
		const existing = grouped.get(id);
		if (existing) existing.count++;
		else grouped.set(id, { id, label: item.source?.displayLabel || id, count: 1 });
	}
	return Array.from(grouped.values());
}

function syncSelectedSubagent() {
	if (activeChannel !== 'subagent') return;
	const agents = availableSubagents();
	if (!agents.some((agent) => agent.id === selectedSubagentId)) {
		selectedSubagentId = agents[0]?.id ?? null;
	}
}

function selectionKey() {
	return activeChannel === 'subagent' ? 'subagent\u0000' + (selectedSubagentId || '') : activeChannel;
}

function visibleSummaries() {
	return summaries.filter((item) => channelOf(item) === activeChannel
		&& (activeChannel !== 'subagent' || subagentIdOf(item) === selectedSubagentId));
}

function defaultPart(item) {
	return item.state === 'complete' ? 'response' : 'request';
}

function renderEmptyDetail(message) {
	requests?.cancel('detail');
	detailPane.removeAttribute('data-selection');
	detailPane.replaceChildren(element('div', 'dash-empty', message));
}

const workspace = dashCreateListDetailWorkspace({
	memory: selectionMemory,
	scopeKey: selectionKey,
	offers: () => visibleSummaries().flatMap((item) => {
		const defaultKey = selectionKeyOf(item.sequence, defaultPart(item));
		const otherKey = selectionKeyOf(item.sequence, defaultPart(item) === 'response' ? 'request' : 'response');
		return [defaultKey, otherKey];
	}),
	select(key) {
		if (key == null) {
			selectedSequence = null;
			selectedPart = 'request';
			return;
		}
		const separator = key.indexOf(':');
		selectedSequence = Number(key.slice(0, separator));
		selectedPart = key.slice(separator + 1);
	},
	renderLists() {
		renderSubagentList();
		renderRequestList();
	},
	fingerprint: () => {
		const item = selectedItem();
		return item ? itemFingerprint(item, selectedPart) : null;
	},
	renderEmpty: () => renderEmptyDetail(emptyMessage()),
	renderDetail({ isCurrent, invalidate }) {
		const item = selectedItem();
		const part = selectedPart;
		const detailSelection = selectionKeyOf(item.sequence, part);
		const openPointers = detailPane.dataset.selection === detailSelection
			? expandedPointers()
			: new Set();
		detailPane.dataset.selection = detailSelection;
		detailPane.replaceChildren(element('div', 'status', 'Loading ' + part + ' #' + item.sequence + '...'));
		requests.read('detail', '/api/records/' + item.sequence, {
			success(detail) {
				if (!isCurrent()) return;
				const isRequest = part === 'request';
				const heading = document.createElement('h2');
				const prefix = detail.source?.channel === 'compaction' ? 'Compaction ' : '';
				heading.textContent = prefix + (isRequest ? 'Request #' : 'Response #') + item.sequence + ' · ' + detail.provider + '/' + detail.model;
				const overview = element('div', 'request-overview');
				const grid = element('div', 'grid detail-grid');
				grid.append(
					metric('Source', (detail.source?.displayLabel || 'Main agent') + ' · ' + (detail.source?.invocationId || 'legacy')),
					metric('Run / turn', detail.run + ' / ' + detail.turn),
					metric('API', detail.api),
					metric(isRequest ? 'Payload type' : 'Response type', detail.apiLabel),
					metric('Payload fidelity', detail.fidelity === 'pi-preparation' ? 'Pi-level preparation, not exact provider payload' : 'Exact provider payload'),
					metric(
						'HTTP status',
						isRequest
							? 'See response item'
							: detail.status == null ? (detail.statusEvidence?.join(', ') || 'unavailable') : detail.status,
					),
					metric('Correlation', detail.correlation),
					metric('Retained bytes', fmt(detail.bytes)),
				);
				overview.append(grid);
				if (detail.usage) overview.append(usageView(detail.usage));
				detailPane.replaceChildren(heading, overview);

				if (detail.diagnostic) detailPane.append(element('div', 'alert', detail.diagnostic));
				if (isRequest) {
					detailPane.append(
						sectionView(detail, openPointers),
						rawDetails('Complete logical request JSON', detail.requestJson),
					);
				} else if (detail.assistantJson) {
					detailPane.append(rawDetails('Complete Pi-normalized provider response JSON', detail.assistantJson));
				} else {
					detailPane.append(element('div', 'dash-empty', 'Provider response not captured yet.'));
				}
			},
			failure(caught) {
				invalidate();
				detailPane.replaceChildren(element('div', 'alert', caught.message));
			},
		});
	},
});

function selectedItem() {
	return visibleSummaries().find((item) => item.sequence === selectedSequence) ?? null;
}

function emptyMessage() {
	if (activeChannel === 'subagent') {
		const subagent = availableSubagents().find((agent) => agent.id === selectedSubagentId);
		return 'No captured requests for ' + (subagent?.label || 'Subagents') + '.';
	}
	return 'No captured requests for ' + (tabs.find((tab) => tab.key === activeChannel)?.label || activeChannel) + '.';
}

const sourceTablist = dashCreateTablist({
	host: sourceTabs,
	tabs,
	initialKey: activeChannel,
	buttonClass: 'source-tab',
	ariaLabel: 'Request sources',
	controls: 'sourcePanel',
	countOf: (channel) => ' (' + summaries.filter((item) => channelOf(item) === channel).length + ')',
	onActivate(tab, { focused }) {
		if (activeChannel === tab.key) {
			if (focused) sourceTablist.focus(tab.key);
			return;
		}
		activeChannel = tab.key;
		sourcePanel.setAttribute('aria-labelledby', 'tab-' + tab.key);
		sourcePanel.classList.toggle('subagent-mode', activeChannel === 'subagent');
		subagentList.classList.toggle('hidden', activeChannel !== 'subagent');
		syncSelectedSubagent();
		workspace.sync();
		if (focused) sourceTablist.focus(tab.key);
	},
});

function renderSubagentList() {
	subagentList.replaceChildren();
	if (activeChannel !== 'subagent') return;
	const agents = availableSubagents();
	if (!agents.length) {
		subagentList.append(element('div', 'dash-empty', 'No subagents captured in this session.'));
		return;
	}
	agents.forEach((agent) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'subagent-row dash-row' + (agent.id === selectedSubagentId ? ' selected' : '');
		button.setAttribute('aria-pressed', agent.id === selectedSubagentId ? 'true' : 'false');
		const title = document.createElement('strong');
		title.textContent = agent.label;
		const meta = document.createElement('span');
		meta.textContent = agent.id + ' · ' + agent.count + (agent.count === 1 ? ' request' : ' requests');
		button.append(title, meta);
		button.addEventListener('click', () => {
			if (agent.id === selectedSubagentId) return;
			selectedSubagentId = agent.id;
			workspace.sync();
		});
		subagentList.append(button);
	});
}

function renderRequestList() {
	requestList.replaceChildren();
	const visible = visibleSummaries();
	if (!visible.length) {
		requestList.append(element('div', 'dash-empty', 'No requests captured in this tab.'));
		return;
	}
	visible.forEach((item) => {
		const group = element('div', 'request-group');
		group.dataset.sequence = String(item.sequence);
		group.setAttribute('role', 'group');
		group.setAttribute('aria-label', item.provider + '/' + item.model);
		group.append(element('strong', 'request-group-title', item.provider + '/' + item.model));
		for (const part of ['response', 'request']) {
			const selected = item.sequence === selectedSequence && part === selectedPart;
			const button = document.createElement('button');
			button.type = 'button';
			button.dataset.part = part;
			button.dataset.sequence = String(item.sequence);
			button.className = 'request-row dash-row' + (selected ? ' selected' : '');
			button.setAttribute('aria-pressed', selected ? 'true' : 'false');

			const at = part === 'response' ? (item.completedAt ?? item.requestedAt) : item.requestedAt;
			const time = new Date(at).toLocaleTimeString();
			const meta = document.createElement('span');
			meta.textContent = time;
			const activities = part === 'request'
				? activityGroups(item.requestActivities, [])
				: activityGroups([], item.responseActivities);
			if (activities) button.append(activities);
			button.append(meta, usageBar(item.usage, 'request-usage-bar', part));
			button.addEventListener('click', () => {
				workspace.sync(selectionKeyOf(item.sequence, part));
			});
			group.append(button);
		}
		requestList.append(group);
	});
}

function refresh() {
	requests.read('summary', '/api/summary', {
		success(data) {
			error.classList.add('hidden');
			activation.classList.toggle('hidden', Boolean(data.activatedAt));
			activation.textContent = data.activatedAt ? '' : 'Capture is not active.';
			const paused = document.getElementById('paused');
			paused.classList.toggle('hidden', !data.paused);
			document.getElementById('pausedText').textContent = data.diagnostic || 'Capture paused.';

			summaries = data.records.slice().reverse();
			syncSelectedSubagent();
			sourceTablist.update();
			workspace.sync();
		},
		failure(caught) {
			activation.classList.add('hidden');
			error.classList.remove('hidden');
			error.textContent = caught.message;
		},
	});
}

document.getElementById('clear').addEventListener('click', async () => {
	await requests.mutate('clear', '/api/clear', { method: 'POST' });
	refresh();
});

if (!dashboardRequiresLifecycle(requests, {
	fatal: error,
	content: sourcePanel,
	message: 'The capability token is missing from the URL fragment.',
	disable: ['clear'],
})) {
	activation.classList.add('hidden');
} else {
	refresh();
	setInterval(refresh, 1500);
}
`;
