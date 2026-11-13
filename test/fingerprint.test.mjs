// test/fingerprint.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Ledger } from '../src/ledger.mjs';
import { Fingerprinter } from '../src/fingerprint.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-fp-'));
  const store = new Store({ dir });
  const ledger = new Ledger({ store });
  return { dir, store, ledger, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedLedger(ledger, n) {
  for (let i = 0; i < n; i++) {
    ledger.recordMsg({ id: `m${i}`, tok: 10, bytes: 100, cls: 'text', content: `content-${i}` });
  }
}

test('轻指纹：一致时匹配', () => {
  const { ledger, cleanup } = fresh();
  try {
    seedLedger(ledger, 5);
    const fp = new Fingerprinter({ ledger });
    assert.equal(fp.checkLight(ledger.getActiveMessages()), true);
  } finally { cleanup(); }
});

test('轻指纹：count 变化失配', () => {
  const { ledger, cleanup } = fresh();
  try {
    seedLedger(ledger, 5);
    const fp = new Fingerprinter({ ledger });
    const messages = ledger.getActiveMessages().slice(0, 4);
    assert.equal(fp.checkLight(messages), false);
  } finally { cleanup(); }
});

test('轻指纹：末条 id 变化失配', () => {
  const { ledger, cleanup } = fresh();
  try {
    seedLedger(ledger, 5);
    const fp = new Fingerprinter({ ledger });
    const messages = ledger.getActiveMessages().map((m) => ({ ...m }));
    messages[messages.length - 1].id = 'm999';
    assert.equal(fp.checkLight(messages), false);
  } finally { cleanup(); }
});

test('findDivergence：区分正常生长与宿主重写', () => {
  const { ledger, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10, bytes: 100, content: 'hello' });
    const fp = new Fingerprinter({ ledger });

    // 正常生长（尾部新增）
    let div = fp.findDivergence([...ledger.getActiveMessages(), { id: 'm2', tok: 10, bytes: 100, content: 'new' }]);
    assert.equal(div.kind, 'growth');
    assert.equal(div.msgId, 'm2');

    // 宿主重写（内容变化）
    div = fp.findDivergence([{ id: 'm1', tok: 10, bytes: 100, content: 'hacked' }]);
    assert.equal(div.kind, 'content-mismatch');
    assert.equal(div.msgId, 'm1');
  } finally { cleanup(); }
});

test('reconcile：宿主吃掉中间消息 → evict 正确', () => {
  const { ledger, cleanup } = fresh();
  try {
    seedLedger(ledger, 10);
    const fp = new Fingerprinter({ ledger });
    const messages = ledger.getActiveMessages().filter((m) => !['m3', 'm4', 'm5', 'm6', 'm7'].includes(m.id));
    const r = fp.reconcile(messages);
    assert.equal(r.evicted, 5);
    const active = ledger.getActiveMessages().map((m) => m.id);
    assert.deepEqual(active, ['m0', 'm1', 'm2', 'm8', 'm9']);
  } finally { cleanup(); }
});

test('reconcile：请求有、账本没有 → recordMsg', () => {
  const { ledger, cleanup } = fresh();
  try {
    seedLedger(ledger, 3);
    const fp = new Fingerprinter({ ledger });
    const messages = [...ledger.getActiveMessages(), { id: 'm-new', tok: 10, bytes: 100, cls: 'text' }];
    const r = fp.reconcile(messages);
    assert.equal(r.added, 1);
    assert.ok(ledger.messages.has('m-new'));
  } finally { cleanup(); }
});

test('采样对账：中间消息被改写 → 捕获', () => {
  const { ledger, cleanup } = fresh();
  try {
    seedLedger(ledger, 10);
    const fp = new Fingerprinter({ ledger });
    const messages = ledger.getActiveMessages().map((m) => ({ ...m }));
    messages[5] = { ...messages[5], content: 'hacked' };
    let i = 0;
    const seq = [0.1, 0.5, 0.9];
    const rng = () => seq[i++ % 3];
    const s = fp.sampleCheck(messages, rng);
    assert.equal(s.ok, false);
    assert.ok(s.mismatches >= 1);
  } finally { cleanup(); }
});

test('采样对账：中间消息未变 → 通过', () => {
  const { ledger, cleanup } = fresh();
  try {
    seedLedger(ledger, 10);
    const fp = new Fingerprinter({ ledger });
    let i = 0;
    const seq = [0.1, 0.5, 0.9];
    const rng = () => seq[i++ % 3];
    const s = fp.sampleCheck(ledger.getActiveMessages(), rng);
    assert.equal(s.ok, true);
  } finally { cleanup(); }
});

test('check：轻指纹通过且未到周期 → none', () => {
  const { ledger, cleanup } = fresh();
  try {
    seedLedger(ledger, 5);
    const fp = new Fingerprinter({ ledger, sampleEvery: 10 });
    const r = fp.check(ledger.getActiveMessages());
    assert.equal(r.action, 'none');
    assert.equal(r.reason, 'light-pass');
  } finally { cleanup(); }
});

test('check：轻指纹失配 → full + light-mismatch', () => {
  const { ledger, cleanup } = fresh();
  try {
    seedLedger(ledger, 5);
    const fp = new Fingerprinter({ ledger });
    const r = fp.check(ledger.getActiveMessages().slice(0, 3));
    assert.equal(r.action, 'full');
    assert.equal(r.reason, 'light-mismatch');
  } finally { cleanup(); }
});

test('check：连续到周期 → full + periodic', () => {
  const { ledger, cleanup } = fresh();
  try {
    seedLedger(ledger, 5);
    const fp = new Fingerprinter({ ledger, sampleEvery: 3 });
    const messages = ledger.getActiveMessages();
    let r;
    for (let i = 0; i < 3; i++) r = fp.check(messages);
    assert.equal(r.action, 'full');
    assert.equal(r.reason, 'periodic');
  } finally { cleanup(); }
});