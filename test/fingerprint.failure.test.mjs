// test/fingerprint.failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Ledger } from '../src/ledger.mjs';
import { Fingerprinter } from '../src/fingerprint.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-fp-f-'));
  const store = new Store({ dir });
  const ledger = new Ledger({ store });
  return { dir, store, ledger, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('空 messages：轻指纹匹配空账本，不崩', () => {
  const { ledger, cleanup } = fresh();
  try {
    const fp = new Fingerprinter({ ledger });
    assert.equal(fp.checkLight([]), true);
  } finally { cleanup(); }
});

test('reconcile 幂等：连续两次结果一致', () => {
  const { ledger, cleanup } = fresh();
  try {
    for (let i = 0; i < 5; i++) ledger.recordMsg({ id: `m${i}`, tok: 10, bytes: 100 });
    const fp = new Fingerprinter({ ledger });
    const messages = ledger.getActiveMessages().filter((m) => m.id !== 'm2');
    const r1 = fp.reconcile(messages);
    const r2 = fp.reconcile(messages);
    assert.equal(r1.evicted, 1);
    assert.equal(r2.evicted, 0);
    assert.equal(r2.added, 0);
  } finally { cleanup(); }
});

test('sampleCheck：mid 只有 1 条时也能安全返回', () => {
  const { ledger, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm0', tok: 10, bytes: 100 });
    ledger.recordMsg({ id: 'm1', tok: 10, bytes: 100 });
    ledger.recordMsg({ id: 'm2', tok: 10, bytes: 100 });
    const fp = new Fingerprinter({ ledger });
    const s = fp.sampleCheck(ledger.getActiveMessages());
    assert.equal(s.ok, true);
    assert.equal(s.sampled, 1);
  } finally { cleanup(); }
});

test('sampleCheck：消息缺 tok 字段时 hash 仍稳定，不崩', () => {
  const { ledger, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm0', tok: 0, bytes: 0 });
    ledger.recordMsg({ id: 'm1', bytes: 0 });
    ledger.recordMsg({ id: 'm2', tok: 0, bytes: 0 });
    const fp = new Fingerprinter({ ledger });
    const s = fp.sampleCheck(ledger.getActiveMessages());
    assert.equal(s.ok, true);
  } finally { cleanup(); }
});