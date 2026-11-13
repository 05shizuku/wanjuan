// test/index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as WJ from '../src/index.mjs';

test('聚合导出：所有模块的类与函数都在', () => {
  assert.equal(typeof WJ.Estimator, 'function');
  assert.equal(typeof WJ.Store, 'function');
  assert.equal(typeof WJ.Ledger, 'function');
  assert.equal(typeof WJ.Observer, 'function');
  assert.equal(typeof WJ.Fingerprinter, 'function');
  assert.equal(typeof WJ.Diagnoser, 'function');
  assert.equal(typeof WJ.InvariantError, 'function');
  assert.equal(typeof WJ.canonical, 'function');
  assert.equal(typeof WJ.hashCanonical, 'function');
  assert.equal(typeof WJ.classifyMiss, 'function');
  assert.equal(typeof WJ.buildReport, 'function');
  assert.equal(typeof WJ.reportFromDisk, 'function');
});

test('DEFAULT_MODELS：含 deepseek-chat 且窗口 200000', () => {
  assert.ok(WJ.DEFAULT_MODELS.deepseek['deepseek-chat']);
  assert.equal(WJ.DEFAULT_MODELS.deepseek['deepseek-chat'].window, 200_000);
});

test('createWanjuan：缺 dir 报错', () => {
  assert.throws(() => WJ.createWanjuan({}), /dir 必填/);
});

test('createWanjuan：串起所有模块，状态可互通', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-idx-'));
  try {
    const wj = WJ.createWanjuan({ dir });
    wj.ledger.recordMsg({ id: 'm1', tok: 100 });
    const est = wj.observer.beforeRequest({
      provider: 'deepseek', model: 'deepseek-chat',
      messages: [{ cls: 'text', tok: 100 }],
    });
    assert.equal(est.estRaw, 100);

    const rec = wj.observer.afterRequest({
      provider: 'deepseek', model: 'deepseek-chat',
      est, usage: { input_tokens: 100, cached: 100 },
    });
    assert.equal(rec.calibOk, true);

    wj.diagnoser.record({
      n: 1, provider: 'deepseek', model: 'deepseek-chat',
      usage: { input_tokens: 100, cached: 100 }, est,
    });
    assert.equal(wj.diagnoser.summarize().total, 1);

    const text = WJ.buildReport({ dir, ledger: wj.ledger, diagnoser: wj.diagnoser });
    assert.ok(text.includes('万卷月报'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createWanjuan：fp 与 ledger 共享同一实例', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-idx-'));
  try {
    const wj = WJ.createWanjuan({ dir });
    wj.ledger.recordMsg({ id: 'm1', tok: 10, bytes: 100 });
    assert.equal(wj.fingerprinter.ledger, wj.ledger);
    assert.equal(wj.fingerprinter.checkLight(wj.ledger.getActiveMessages()), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});