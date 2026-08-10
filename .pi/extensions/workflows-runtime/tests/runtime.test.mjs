import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-state-'));
process.env.PI_CONFIG_STATE_DIR = stateRoot;
test.after(async () => {
  delete process.env.PI_CONFIG_STATE_DIR;
  await rm(stateRoot, { recursive: true, force: true });
});

const definition = await import('../lib/definition.ts');
const registry = await import('../lib/registry.ts');
const approval = await import('../lib/approval.ts');
const runStore = await import('../lib/run-store.ts');
const runner = await import('../lib/runner.ts');
const subagentService = await import('../../_shared/subagent-service.ts');
const fanOutWorkflow = (await import('../bundled/fan-out-and-synthesize.ts')).default;
const verificationWorkflow = (await import('../bundled/deep-verification.ts')).default;
const gitHelper = await import('../../_shared/git.ts');

async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-test-'));
}

function registerFakeSubagents(respond) {
  const calls = [];
  const agents = ['default', 'explorer', 'researcher', 'worker'].map((name) => ({
    name,
    description: `${name} test agent`,
    tools: [],
    model: 'test-model',
    systemPrompt: '',
    filePath: `${name}.md`,
  }));
  subagentService.clearSubagentService();
  const unregister = subagentService.registerSubagentService({
    id: 'workflow-test',
    registerAgent() {},
    unregisterAgent() {},
    loadAgents: () => agents,
    async runSubagent(options) {
      const agent = typeof options.agent === 'string' ? options.agent : options.agent.name;
      const task = options.task || options.prompt || '';
      calls.push({ agent, task });
      const output = await respond({ agent, task, cwd: options.cwd, calls });
      const progress = {
        agent,
        status: 'completed',
        task,
        recentTools: [],
        toolCount: 0,
        tokens: 10,
        durationMs: 1,
        lastMessage: output,
      };
      options.onUpdate?.(progress);
      return {
        agent,
        task,
        output,
        exitCode: 0,
        progress,
        model: 'test-model',
        usage: { input: 4, output: 6, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
      };
    },
    async runSubagentsParallel() { throw new Error('not used by workflow runtime'); },
  });
  return { calls, unregister };
}

async function runBundledWorkflow(cwd, runId, workflow) {
  const entry = {
    name: workflow.name,
    trust: 'bundled',
    description: workflow.description,
    cost: workflow.budget.estimatedCost,
    canEditFiles: workflow.canEditFiles,
    source: 'bundled test source',
    sourceHash: registry.hash('bundled test source'),
  };
  const store = new runStore.RunStore(cwd, runId);
  const state = await store.initialize(entry, 'verify this subject', path.join(cwd, `${workflow.name}.ts`));
  const result = await runner.runPreparedWorkflow(
    {},
    { cwd, signal: new AbortController().signal, ui: { setStatus() {} } },
    { entry, workflow, store, state, resume: false },
  );
  return { result, store, state: await runStore.readRunState(cwd, runId) };
}

test('defineWorkflow accepts valid definitions and normalizes phases/capabilities', () => {
  const wf = definition.defineWorkflow({
    name: 'valid-workflow',
    description: 'Does useful work',
    phases: ['one', { name: 'two', description: 'second' }],
    budget: { maxAgents: 1, maxConcurrent: 1, maxTokens: 100, estimatedCost: 'quick' },
    canEditFiles: false,
    run() { return 'ok'; },
  });
  assert.equal(wf.name, 'valid-workflow');
  assert.deepEqual(wf.phases.map((p) => p.name), ['one', 'two']);
  assert.equal(wf.capabilities.canEditFiles, false);
});

test('defineWorkflow rejects invalid definitions', () => {
  const base = { name: 'valid-workflow', description: 'ok', canEditFiles: false, run() {} };
  assert.throws(() => definition.defineWorkflow({ ...base, name: 'BadName' }), /kebab-case/);
  assert.throws(() => definition.defineWorkflow({ ...base, name: 'resume' }), /reserved/);
  assert.throws(() => definition.defineWorkflow({ ...base, description: ' ' }), /non-empty description/);
  assert.throws(() => definition.defineWorkflow({ ...base, phases: [{}] }), /phase 1/);
  assert.throws(() => definition.defineWorkflow({ ...base, budget: { maxTokens: 0 } }), /maxTokens/);
  assert.throws(() => definition.defineWorkflow({ ...base, canEditFiles: undefined, capabilities: undefined }), /capabilities or canEditFiles/);
  assert.throws(() => definition.defineWorkflow({ ...base, run: undefined }), /run\(ctx\)/);
});

test('registry discovers bundled workflows and treats project workflows as metadata', async () => {
  const cwd = await tempProject();
  try {
    await mkdir(path.join(cwd, '.pi', 'workflows'), { recursive: true });
    await writeFile(path.join(cwd, '.pi', 'workflows', 'project-demo.js'), 'throw new Error("should not import during discovery");\nexport default {};\n');
    const entries = await registry.discoverWorkflows(cwd);
    for (const name of ['fan-out-and-synthesize', 'deep-verification', 'deep-research', 'generate-filter-tournament']) {
      assert.ok(entries.some((e) => e.name === name && e.trust === 'bundled'), `missing bundled workflow ${name}`);
    }
    const project = entries.find((e) => e.name === 'project-demo');
    assert.ok(project);
    assert.equal(project.trust, 'project');
    assert.equal(project.workflow, undefined);
    assert.match(project.sourceHash, /^[a-f0-9]{64}$/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('approval cache keys include project path hash, workflow name, and source hash', async () => {
  const cwdA = await tempProject();
  const cwdB = await tempProject();
  try {
    const entry = { name: 'demo', trust: 'project', description: 'demo', cost: 'medium', canEditFiles: false, source: 'a', sourceHash: registry.hash('a') };
    const keyA = approval.approvalKey(cwdA, entry);
    const keyB = approval.approvalKey(cwdB, entry);
    assert.equal(keyA.workflowName, 'demo');
    assert.equal(keyA.sourceHash, entry.sourceHash);
    assert.notEqual(keyA.projectHash, keyB.projectHash);
    assert.notEqual(approval.approvalPath(cwdA, entry), approval.approvalPath(cwdA, { ...entry, sourceHash: registry.hash('b') }));
    assert.equal(approval.approvalPath(cwdA, entry).startsWith(stateRoot), true);
  } finally {
    await rm(cwdA, { recursive: true, force: true });
    await rm(cwdB, { recursive: true, force: true });
  }
});

test('project workflow import uses approved snapshot and enforces filename-derived name', async () => {
  const cwd = await tempProject();
  try {
    const root = runStore.runPaths(cwd, 'run-1').root;
    const entry = {
      name: 'project-demo',
      trust: 'project',
      description: 'Project workflow',
      cost: 'unknown',
      canEditFiles: undefined,
      extension: '.mjs',
      filePath: path.join(cwd, '.pi', 'workflows', 'project-demo.mjs'),
      sourceHash: registry.hash('snapshot'),
      source: 'export default { name: "project-demo", description: "from snapshot", canEditFiles: false, run() { return "snapshot"; } };\n',
    };
    const snapshot = await registry.writeWorkflowSnapshot(root, entry);
    await mkdir(path.dirname(entry.filePath), { recursive: true });
    await writeFile(entry.filePath, 'export default { name: "project-demo", description: "changed", canEditFiles: false, run() { return "changed"; } };\n');
    const workflow = await registry.loadWorkflowFromEntry(entry, snapshot);
    assert.equal(workflow.description, 'from snapshot');

    const badEntry = {
      ...entry,
      sourceHash: registry.hash('bad'),
      source: 'export default { name: "wrong-name", description: "bad", canEditFiles: false, run() {} };\n',
    };
    const badSnapshot = await registry.writeWorkflowSnapshot(runStore.runPaths(cwd, 'run-2').root, badEntry);
    await assert.rejects(() => registry.loadWorkflowFromEntry(badEntry, badSnapshot), /must match filename-derived invocation name/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('run store projects progress, reuse, pause, dependencies, and agent running counts', async () => {
  const cwd = await tempProject();
  try {
    const entry = { name: 'demo', trust: 'bundled', description: 'demo', cost: 'quick', canEditFiles: false, source: 'source', sourceHash: registry.hash('source') };
    const store = new runStore.RunStore(cwd, 'run-events');
    assert.equal(store.paths.root.startsWith(stateRoot), true);
    assert.equal(store.paths.root.startsWith(path.join(cwd, '.pi')), false);
    await store.initialize(entry, 'args', path.join(cwd, 'source.txt'));
    await store.append({ type: 'run_started' });
    await store.append({ type: 'step_started', key: 's1', dependsOn: ['a1'] });
    await store.append({ type: 'step_completed', key: 's1', result: 'done' });
    await store.append({ type: 'step_reused', key: 's1' });
    await store.append({ type: 'agent_started', key: 'a1', agent: 'default', dependsOn: ['root'], prompt: 'hello' });
    await store.append({ type: 'agent_progress', key: 'a1', event: { type: 'message', message: 'hi' } });
    await store.append({ type: 'agent_tool', key: 'a1', tool: 'read', args: 'file' });
    await store.append({ type: 'agent_completed', key: 'a1', agent: 'default', result: 'ok', usage: { input: 3, output: 4, cost: 0.01, turns: 1 } });
    await store.append({ type: 'agent_reused', key: 'a1', agent: 'default' });
    await store.append({ type: 'run_pausing', mode: 'after-current' });
    await store.append({ type: 'run_paused' });
    const state = await runStore.rebuildStateFromEvents(store.paths.events);
    assert.equal(state.status, 'paused');
    assert.equal(state.steps.s1.status, 'completed');
    assert.equal(state.agents.a1.status, 'completed');
    assert.equal(state.agentsRunning, 0);
    assert.equal(state.tokens, 7);
    assert.equal(state.dependencies.a1.includes('s1'), true);
    assert.equal(state.dependencies.root.includes('a1'), true);
    assert.ok(state.agents.a1.progress.length >= 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('run store appends JSONL, rebuilds state, handles invalidation, and protects artifacts', async () => {
  const cwd = await tempProject();
  try {
    const entry = { name: 'demo', trust: 'bundled', description: 'demo', cost: 'quick', canEditFiles: false, source: 'source', sourceHash: registry.hash('source') };
    const store = new runStore.RunStore(cwd, 'run-1');
    await store.initialize(entry, 'args', path.join(cwd, 'source.txt'));
    await store.append({ type: 'step_started', key: 's1' });
    await store.append({ type: 'step_completed', key: 's1', result: 42 });
    await store.append({ type: 'invalidated', key: 's1' });
    let state = await runStore.rebuildStateFromEvents(store.paths.events);
    assert.equal(state.steps.s1.status, 'invalidated');
    await store.append({ type: 'step_completed', key: 's1', result: 43 });
    state = await runStore.rebuildStateFromEvents(store.paths.events);
    assert.equal(state.steps.s1.result, 43);
    assert.deepEqual(state.invalidatedKeys, []);
    assert.throws(() => runStore.safeArtifactPath(store.paths.artifacts, '../escape.txt'), /escapes/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('resume records replay, reuses completed keys, and restart invalidates dependents', async () => {
  const cwd = await tempProject();
  try {
    const entry = { name: 'demo', trust: 'bundled', description: 'demo', cost: 'quick', canEditFiles: false, source: 'source', sourceHash: registry.hash('source') };
    const store = new runStore.RunStore(cwd, 'run-resume');
    let executions = 0;
    const workflow = definition.defineWorkflow({
      name: 'demo',
      description: 'demo',
      canEditFiles: false,
      async run(ctx) {
        return ctx.step('first', () => ++executions);
      },
    });
    const state = await store.initialize(entry, 'args', path.join(cwd, 'source.ts'));
    const context = { cwd, signal: new AbortController().signal, ui: { setStatus() {} } };
    const prepared = { entry, workflow, store, state, resume: false };
    assert.equal(await runner.runPreparedWorkflow({}, context, prepared), 1);
    assert.equal(await runner.runPreparedWorkflow({}, context, { ...prepared, state: await runStore.readRunState(cwd, store.runId), resume: true }), 1);
    assert.equal(executions, 1);
    const events = await runStore.readEvents(store.paths.events);
    assert.equal(events.filter((event) => event.type === 'run_started').length, 1);
    assert.equal(events.filter((event) => event.type === 'run_resumed').length, 1);
    assert.equal(events.filter((event) => event.type === 'step_reused').length, 1);

    await store.append({ type: 'step_started', key: 'second', dependsOn: ['first'] });
    await store.append({ type: 'step_completed', key: 'second', result: 2 });
    const invalidated = await runner.invalidateKeyAndDependents(cwd, store.runId, 'first');
    assert.deepEqual(new Set(invalidated.invalidatedKeys), new Set(['first', 'second']));
    await assert.rejects(() => runner.invalidateKeyAndDependents(cwd, store.runId, 'missing'), /Durable key not found/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('abort marks the run stopped and preserves completed keyed results', async () => {
  const cwd = await tempProject();
  try {
    const entry = { name: 'demo', trust: 'bundled', description: 'demo', cost: 'quick', canEditFiles: false, source: 'source', sourceHash: registry.hash('source') };
    const store = new runStore.RunStore(cwd, 'run-stop');
    const controller = new AbortController();
    let enteredWaitingStep;
    const waitingStepStarted = new Promise((resolve) => { enteredWaitingStep = resolve; });
    const workflow = definition.defineWorkflow({
      name: 'demo',
      description: 'demo',
      canEditFiles: false,
      async run(ctx) {
        await ctx.step('completed', () => 'preserved');
        await ctx.step('waiting', async () => {
          enteredWaitingStep();
          await new Promise((resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason || new Error('aborted')), { once: true });
          });
        });
      },
    });
    const state = await store.initialize(entry, 'args', path.join(cwd, 'source.ts'));
    const running = runner.runPreparedWorkflow(
      {},
      { cwd, signal: controller.signal, ui: { setStatus() {} } },
      { entry, workflow, store, state, resume: false },
    );
    await waitingStepStarted;
    controller.abort(new Error('cancelled by test'));
    await assert.rejects(running, /cancelled by test/);

    const stopped = await runStore.readRunState(cwd, store.runId);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.steps.completed.status, 'completed');
    assert.equal(stopped.steps.completed.result, 'preserved');
    assert.equal(stopped.steps.waiting.status, 'failed');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('fan-out workflow plans independent work, runs workers, verifies, and synthesizes', async () => {
  const cwd = await tempProject();
  const fake = registerFakeSubagents(({ task }) => {
    if (task.includes('Split the user\'s task')) return JSON.stringify({ tasks: [
      { id: 'local-facts', title: 'Local facts', agent: 'explorer', prompt: 'Inspect local facts', verificationNeeded: true },
      { id: 'external-facts', title: 'External facts', agent: 'researcher', prompt: 'Inspect external facts' },
    ] });
    if (task.includes('Review these worker results')) return JSON.stringify({ verified: true, issues: [], confidence: 'high' });
    if (task.includes('Synthesize a final answer')) return 'Synthesized verified answer';
    if (task.includes('Subtask title: Local facts')) return 'Local evidence';
    if (task.includes('Subtask title: External facts')) return 'External evidence';
    throw new Error(`Unexpected fan-out prompt: ${task.slice(0, 80)}`);
  });
  try {
    const run = await runBundledWorkflow(cwd, 'run-fan-out', fanOutWorkflow);
    assert.equal(run.result, 'Synthesized verified answer');
    assert.equal(run.state.status, 'completed');
    assert.equal(run.state.agentsCompleted, 5);
    assert.deepEqual(Object.keys(run.state.agents).sort(), [
      'plan-work-items',
      'synthesize-final',
      'verify-worker-results',
      'worker-external-facts',
      'worker-local-facts',
    ]);
    const artifact = JSON.parse(await readFile(path.join(run.store.paths.artifacts, 'worker-results.json'), 'utf8'));
    assert.deepEqual(artifact.results, ['Local evidence', 'External evidence']);
    assert.equal(artifact.verification.confidence, 'high');
  } finally {
    fake.unregister();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('deep verification extracts a claim, verifies it, double-checks it, and reports', async () => {
  const cwd = await tempProject();
  const fake = registerFakeSubagents(({ task }) => {
    if (task.includes('Extract up to 8 concrete')) return JSON.stringify({ claims: [
      { id: 'C1', text: 'The runtime persists events.', sourceType: 'codebase', importance: 'high' },
    ] });
    if (task.includes('Double-check this verification')) return JSON.stringify({ claimId: 'C1', status: 'confirmed', confidence: 'high', additionalEvidence: [{ source: 'run-store.ts', summary: 'JSONL append' }] });
    if (task.includes('Verify this claim')) return JSON.stringify({ claimId: 'C1', claim: 'The runtime persists events.', status: 'confirmed', confidence: 'high', evidence: [{ source: 'run-store.ts', summary: 'JSONL append' }], correction: '', notes: '' });
    if (task.includes('Write a complete verification report')) return 'Verification report: one confirmed claim';
    throw new Error(`Unexpected verification prompt: ${task.slice(0, 80)}`);
  });
  try {
    const run = await runBundledWorkflow(cwd, 'run-verification', verificationWorkflow);
    assert.equal(run.result, 'Verification report: one confirmed claim');
    assert.equal(run.state.status, 'completed');
    assert.equal(run.state.agentsCompleted, 4);
    assert.equal(run.state.steps['classify-claims'].status, 'completed');
    const artifact = JSON.parse(await readFile(path.join(run.store.paths.artifacts, 'verification-results.json'), 'utf8'));
    assert.equal(artifact.claims[0].id, 'C1');
    assert.equal(artifact.verifications[0].status, 'confirmed');
    assert.equal(artifact.doubleChecks[0].confidence, 'high');
  } finally {
    fake.unregister();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('editing agents collect tracked and untracked worktree changes into an applicable patch', async () => {
  const cwd = await tempProject();
  await gitHelper.runGit(cwd, ['init', '-b', 'main']);
  await gitHelper.runGit(cwd, ['config', 'user.email', 'test@example.com']);
  await gitHelper.runGit(cwd, ['config', 'user.name', 'Test User']);
  await writeFile(path.join(cwd, 'tracked.txt'), 'base\n');
  await gitHelper.runGit(cwd, ['add', 'tracked.txt']);
  await gitHelper.runGit(cwd, ['commit', '-m', 'initial']);
  const fake = registerFakeSubagents(async ({ cwd: agentCwd }) => {
    await writeFile(path.join(agentCwd, 'tracked.txt'), 'changed\n');
    await writeFile(path.join(agentCwd, 'new file.txt'), 'created\n');
    return JSON.stringify({ filesChanged: ['tracked.txt', 'new file.txt'] });
  });
  try {
    const workflow = definition.defineWorkflow({
      name: 'editing-test',
      description: 'editing test',
      canEditFiles: true,
      async run(ctx) {
        return ctx.agent({ key: 'edit', agent: 'worker', prompt: 'edit files', output: 'json', worktree: true });
      },
    });
    const run = await runBundledWorkflow(cwd, 'run-editing', workflow);
    const patchPath = run.result.worktree.patchPath;
    assert.ok(patchPath);
    const patch = await readFile(path.join(run.store.paths.root, patchPath), 'utf8');
    assert.match(patch, /diff --git a\/tracked\.txt b\/tracked\.txt/);
    assert.match(patch, /diff --git a\/new file\.txt b\/new file\.txt/);
    assert.match(patch, /new file mode/);
    assert.deepEqual(new Set(run.result.worktree.changedFiles), new Set(['tracked.txt', 'new file.txt']));
    await gitHelper.runGit(cwd, ['apply', '--check', path.join(run.store.paths.root, patchPath)]);
  } finally {
    fake.unregister();
    await rm(cwd, { recursive: true, force: true });
  }
});
