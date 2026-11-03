// Execute selected functions extracted at runtime from the pinned sourcemap.
// Upstream code is neither copied into this repo nor replaced with our algorithm.
// External dependencies are explicit test ports, not a live Claude Code runtime.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { SOURCE_DIR, verifySourcemap } from '../../lab/sourcemap.ts';
import { CC_SOURCE } from '../../course/syllabus.ts';

const references = verifySourcemap();
export function upstream(key, name, ports = {}) {
  const ref = references[key];
  const text = execFileSync('git', ['-C', SOURCE_DIR, 'show', `${CC_SOURCE.commit}:${ref.file}`], { encoding: 'utf8', maxBuffer: 4e6 });
  const start = text.indexOf(ref.anchor);
  const close = /\n}[ \t]*(?=\r?\n|$)/g;
  close.lastIndex = start;
  const end = close.exec(text)?.index ?? -1;
  assert(start >= 0 && end > start, `Cannot extract ${key}`);
  const code = stripTypeScriptTypes(text.slice(start, end + 2).replace(/^export /, ''), { mode: 'transform' });
  return vm.runInNewContext(`${code}\n${name}`, ports, { timeout: 1000 });
}
const plain = value => JSON.parse(JSON.stringify(value));
const cases = {
  lifecycle: async () => {
    const rows = [];
    for (const mode of ['normal', 'throw', 'return']) {
      const log = [];
      const queryLoop = async function* (_params, consumed) {
        consumed.push('command-1');
        try { yield 'started'; if (mode === 'throw') throw Error('synthetic'); return 'terminal'; }
        finally { log.push('cleanup'); }
      };
      const query = upstream('query', 'query', { queryLoop, notifyCommandLifecycle: (_, event) => log.push(event) });
      const generator = query({});
      assert.equal((await generator.next()).value, 'started');
      if (mode === 'return') await generator.return();
      else if (mode === 'throw') await assert.rejects(generator.next(), /synthetic/);
      else assert.equal((await generator.next()).value, 'terminal');
      assert.deepEqual(log, mode === 'normal' ? ['cleanup', 'completed'] : ['cleanup']);
      rows.push({ exit: mode, cleanup: true, completed: log.includes('completed') });
    }
    return { rows, ports: 'synthetic queryLoop and lifecycle recorder; original query wrapper' };
  },
  prompt: () => {
    const build = upstream('system-prompt', 'buildEffectiveSystemPrompt', {
      feature: () => false, isBuiltInAgent: () => false, asSystemPrompt: x => x,
      logEvent: () => {}, process: { env: {} },
    });
    const base = { toolUseContext: { options: {} }, defaultSystemPrompt: ['default'], appendSystemPrompt: 'append' };
    const rows = [
      ['default', {}, ['default', 'append']],
      ['custom', { customSystemPrompt: 'custom' }, ['custom', 'append']],
      ['agent', { customSystemPrompt: 'custom', mainThreadAgentDefinition: { getSystemPrompt: () => 'agent' } }, ['agent', 'append']],
      ['override', { overrideSystemPrompt: 'override' }, ['override']],
    ].map(([branch, options, expected]) => {
      const result = plain(build({ ...base, ...options })); assert.deepEqual(result, expected); return { branch, result };
    });
    return { rows, ports: 'feature gates off; prompt branding and agent identification are test ports' };
  },
  partition: () => {
    const catalogue = Object.fromEntries(['Read', 'Edit', 'Throws'].map(name => [name, {
      inputSchema: { safeParse: input => ({ success: input !== 'invalid', data: input }) },
      isConcurrencySafe: () => { if (name === 'Throws') throw Error('parse'); return name === 'Read'; },
    }]));
    const partition = upstream('tool-partition', 'partitionToolCalls', { findToolByName: (_, name) => catalogue[name] });
    const inputs = [
      ['Read', 'Read', 'Edit', 'Read', 'Read'], ['Read', 'Unknown', 'Read'], ['Read', 'Throws', 'Read'],
    ];
    const rows = inputs.map(names => ({ input: names, batches: plain(partition(names.map(name => ({ name, input: {} })), { options: { tools: [] } })).map(b => b.blocks.map(t => t.name)) }));
    assert.deepEqual(rows[0].batches, [['Read', 'Read'], ['Edit'], ['Read', 'Read']]);
    assert.equal(rows[1].batches.length, 3); assert.equal(rows[2].batches.length, 3);
    const invalid = plain(partition([{ name: 'Read', input: 'invalid' }], { options: { tools: [] } }));
    assert.equal(invalid[0].isConcurrencySafe, false);
    return { rows, invalidSchemaIsSerial: true, ports: 'synthetic tool catalogue and schema parser; original partition function' };
  },
  memory: () => {
    const files = [{ type: 'Project' }, { type: 'AutoMem' }, { type: 'TeamMem' }];
    const rows = [false, true].map(flag => {
      const filter = upstream('memory-filter', 'filterInjectedMemoryFiles', { getFeatureValue_CACHED_MAY_BE_STALE: () => flag });
      return { skipMemoryIndex: flag, injected: plain(filter(files)).map(f => f.type) };
    });
    assert.deepEqual(rows[0].injected, ['Project', 'AutoMem', 'TeamMem']);
    assert.deepEqual(rows[1].injected, ['Project']);
    return { rows, ports: 'feature flag lookup only; no memory filesystem scan' };
  },
  compact: () => {
    const rows = [undefined, '50', '100', '0', 'bad'].map(value => {
      const threshold = upstream('compact-threshold', 'getAutoCompactThreshold', {
        getEffectiveContextWindowSize: () => 100000, AUTOCOMPACT_BUFFER_TOKENS: 13000,
        process: { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: value } },
      })('synthetic-model');
      return { override: value ?? '(unset)', threshold };
    });
    assert.deepEqual(rows.map(r => r.threshold), [87000, 50000, 87000, 87000, 87000]);
    const rebuild = upstream('compact-rebuild', 'buildPostCompactMessages');
    const order = plain(rebuild({ boundaryMarker: 'boundary', summaryMessages: ['summary'], messagesToKeep: ['retained'], attachments: ['attachment'], hookResults: ['hook'] }));
    assert.deepEqual(order, ['boundary', 'summary', 'retained', 'attachment', 'hook']);
    return { rows, order, ports: 'synthetic 100000-token effective window and 13000-token buffer; not production constants' };
  },
  permissions: async () => {
    const rows = [];
    for (const test of [
      { name: 'whole-tool-deny', deny: true, expected: 'deny' },
      { name: 'whole-tool-ask', ask: true, expected: 'ask' },
      { name: 'tool-deny', toolResult: { behavior: 'deny' }, expected: 'deny' },
      { name: 'safety-check', toolResult: { behavior: 'ask', decisionReason: { type: 'safetyCheck' } }, expected: 'ask' },
      { name: 'local-allow', toolResult: { behavior: 'allow' }, expected: null },
    ]) {
      const check = upstream('permission-rules', 'checkRuleBasedPermissions', {
        getDenyRuleForTool: () => test.deny ? {} : null, getAskRuleForTool: () => test.ask ? {} : null,
        BASH_TOOL_NAME: 'Bash', SandboxManager: { isSandboxingEnabled: () => false },
        createPermissionRequestMessage: () => 'synthetic request', logError: () => {},
      });
      const decision = await check({ name: 'Read', inputSchema: { parse: x => x }, checkPermissions: async () => test.toolResult }, {}, { getAppState: () => ({ toolPermissionContext: {} }) });
      assert.equal(decision?.behavior ?? null, test.expected);
      rows.push({ case: test.name, ruleStageDecision: decision?.behavior ?? null });
    }
    return { rows, ports: 'synthetic rules and tool checker; sandbox off; final mode/approval layer not executed' };
  },
  io: async () => {
    class TestIO { constructor(input) { this.input = input; this.kind = 'local'; } }
    class RemoteTestIO { constructor(url, input) { this.input = input; this.kind = 'remote'; this.url = url; } }
    const io = upstream('structured-io', 'getStructuredIO', {
      fromArray: async function* (items) { yield* items; }, jsonStringify: JSON.stringify,
      StructuredIO: TestIO, RemoteIO: RemoteTestIO,
    });
    const rows = [];
    for (const [input, options] of [['hello', {}], ['  ', {}], ['hello', { sdkUrl: 'https://synthetic.invalid' }]]) {
      const stream = io(input, options); const messages = [];
      for await (const line of stream.input) messages.push(JSON.parse(line));
      rows.push({ input, transport: stream.kind, messages });
    }
    assert.equal(rows[0].messages[0].parent_tool_use_id, null);
    assert.equal(rows[1].messages.length, 0); assert.equal(rows[2].transport, 'remote');
    return { rows, ports: 'constructors and fromArray are test ports; no subprocess or network' };
  },
  sdk: () => {
    const query = upstream('sdk-stub', 'query');
    assert.throws(() => query(), /not implemented/i);
    return { stubThrows: true, lesson: 'a declaration entrypoint is not a functioning SDK executor', ports: 'none; original stub' };
  },
};

const names = new URL(import.meta.url).pathname === process.argv[1] ? (process.argv[2] ? [process.argv[2]] : Object.keys(cases)) : [];
for (const name of names) {
  if (!Object.hasOwn(cases, name)) throw Error(`Unknown lab: ${name}`);
  console.log(JSON.stringify({ lab: name, version: CC_SOURCE.version, commit: CC_SOURCE.commit, evidence: 'extracted upstream function + explicit isolated test ports', ...await cases[name]() }, null, 2));
}
