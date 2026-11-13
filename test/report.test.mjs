// test/report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Ledger } from '../src/ledger.mjs';
import { Diagnoser } from '../src/diagnose.mjs';
import { buildReport } from '../src/report.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-rep-'));
  const store = new Store({ dir });
  const ledger = new Ledger({ store });
  const diagnoser = new Diagnoser({ dir });
  return { dir, store, ledger, diagnoser, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('buildReport：空数据也能出文本', () => {
  const { dir, ledger, diagnoser, cleanup } = fresh();
  try {
    const text = buildReport({ dir, ledger, diagnoser });
    assert.ok(text.includes('万卷月报'));
    assert.ok(text.includes('请求总数：0'));
  } finally { cleanup(); }
});

test('buildReport：输出核心命中率与责任归属', () => {
  const { dir, ledger, diagnoser, cleanup } = fresh();
  try {
    diagnoser.record({ n: 1, usage: { input_tokens: 1000, cached: 800 }, overrideMissKind: 'rewrite' });
    const text = buildReport({ dir, ledger, diagnoser });
    assert.ok(text.includes('⭐ 万卷核心命中率'));
    assert.ok(text.includes('宿主违约 (Host)'));
  } finally { cleanup(); }
});

test('buildReport：块统计反映 ledger 状态', () => {
  const { dir, ledger, diagnoser, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm0', tok: 100 });
    ledger.recordMsg({ id: 'm1', tok: 100 });
    ledger.recordFold({ block: 'b1', range: ['m0', 'm0'], srcTok: 100, sumTok: 12, tier: 1, rawRef: 'r1' });
    ledger.recordFold({ block: 'b2', range: ['m1', 'm1'], srcTok: 100, sumTok: 12, tier: 1, rawRef: 'r2' });
    const text = buildReport({ dir, ledger, diagnoser });
    assert.ok(text.includes('块总数：2'));
    assert.ok(text.includes('叶子块：2'));
  } finally { cleanup(); }
});