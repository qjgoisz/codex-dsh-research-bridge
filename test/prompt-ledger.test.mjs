import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Bridge } from '../src/orchestration.mjs';
import { SessionMap } from '../src/session-map.mjs';
import { contract, testWorker, until } from './fixtures.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-ledger-'));
  const store = new Store(join(root, 'state')).init().lock();
  const agentState = join(root, 'agent.json'), bridges = [], logs = [];
  const create = (broken = false) => {
    const bridge = new Bridge({ store, log: event => logs.push(event), sessions: SessionMap.fromStore(store.readSessions()),
      worker: testWorker({ FAKE_SCENARIO: 'clarify', FAKE_STATE: agentState }),
      ...(broken ? { createClient: () => { throw Object.assign(new Error('fixture did not submit'), { code: 'write_failed', submitted: false }); } } : {}),
    });
    bridges.push(bridge); return bridge;
  };
  t.after(async () => {
    for (const bridge of bridges) await bridge.shutdown();
    store.unlock(); rmSync(root, { recursive: true, force: true });
  });
  const request = contract({ id: 'ledger-task', workspace: root });
  const replied = async (bridge, answer) => {
    await bridge.reply(request.id, answer);
    await until(() => bridge.inflight.length === 0);
  };
  return { store, create, request, replied, logs, wire: () => JSON.parse(readFileSync(agentState)).promptTexts.map(p => p.text) };
}
test('unsubmitted clarification answers roll back without changing the last sent fact', async t => {
  const f = fixture(t), first = f.create();
  await first.delegate(f.request, { wait: true });
  const before = f.store.read(f.request.id).lastPromptText;
  await first.shutdown();
  const broken = f.create(true); await f.replied(broken, 'UNSENT-ANSWER');
  const record = f.store.read(f.request.id);
  assert.equal(record.status, 'needs_clarification'); assert.equal(record.clarification.answer, null);
  assert.deepEqual(record.clarifications, []); assert.equal(record.lastPromptText, before);
  assert.equal(f.wire().length, 1); assert.ok(!f.wire()[0].includes('UNSENT-ANSWER'));
});
test('a prior sent answer survives failed intent and recovery without polluting the wire prefix', async t => {
  const f = fixture(t), first = f.create();
  await first.delegate(f.request, { wait: true }); await f.replied(first, 'SENT-ANSWER');
  const before = f.store.read(f.request.id).lastPromptText;
  assert.equal(before, f.wire().at(-1)); await first.shutdown();
  const broken = f.create(true); await f.replied(broken, 'UNSENT-INTENT');
  assert.equal(f.store.read(f.request.id).lastPromptText, before); await broken.shutdown();
  const recovered = f.create(); await f.replied(recovered, 'CORRECTED-ANSWER');
  const text = f.wire().at(-1);
  assert.ok(text.startsWith(before)); assert.ok(text.includes('SENT-ANSWER'));
  assert.ok(text.includes('CORRECTED-ANSWER')); assert.ok(!text.includes('UNSENT-INTENT'));
  assert.equal(f.store.read(f.request.id).lastPromptText, text);
});

test('ledger event statistics survive restart and distinguish sources, reasons and damaged lines', t => {
  const f = fixture(t);
  const events = [
    { event: 'prefix_appended', baseSource: 'memory', persistedHistoryIncomplete: true, text: 'DO-NOT-STORE-PROMPT' },
    { event: 'prefix_diverged', baseSource: 'persisted' },
    { event: 'prefix_stability_unverified', reason: 'base_unavailable' },
    { event: 'last_prompt_text_not_recorded', persistedHistoryIncomplete: true },
  ];
  for (const event of events) f.store.appendPromptLedgerEvent(event);
  appendFileSync(f.store.promptLedgerEventsPath, '{damaged-line\n');
  const summary = f.store.inspect().promptLedger;
  assert.equal(summary.malformedLines, 1);
  assert.deepEqual(summary.counts, { prefix_appended: 1, prefix_diverged: 1,
    prefix_stability_unverified: 1, last_prompt_text_not_recorded: 1 });
  assert.equal(summary.baseSources.memory, 1); assert.equal(summary.reasons.base_unavailable, 1);
  assert.equal(summary.persistedHistoryIncomplete, 2);
  assert.ok(!readFileSync(f.store.promptLedgerEventsPath, 'utf8').includes('DO-NOT-STORE-PROMPT'));
  f.store.unlock();
  const reopened = new Store(f.store.root).init();
  assert.deepEqual(reopened.inspect().promptLedger, summary);
});
test('event persistence failure cannot change clarification submission behavior', async t => {
  const f = fixture(t), bridge = f.create();
  await bridge.delegate(f.request, { wait: true });
  f.store.appendPromptLedgerEvent = () => { throw new Error('fixture telemetry unavailable'); };
  await f.replied(bridge, 'SENT-DESPITE-TELEMETRY-FAILURE');
  assert.equal(f.store.read(f.request.id).lastPromptText, f.wire().at(-1));
  assert.equal(f.store.read(f.request.id).clarifications[0].submitted, true);
  assert.ok(f.logs.some(event => event.event === 'prompt_ledger_event_not_recorded'));
});
