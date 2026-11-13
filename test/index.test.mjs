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
  assert.equal(typeof WJ.BlocksManager, 'function');
  assert.equal(typeof WJ.Compressor, 'function');
  assert.equal(typeof WJ.Restorer, 'function');
  assert.equal(typeof WJ.Gate, 'function');
  assert.equal(typeof WJ.NudgeManager, 'function');
  assert.equal(typeof WJ.Philosophy, 'function');
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

test('createWanjuan：M2 折叠与恢复全流程', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-idx-m2-'));
  try {
    const wj = WJ.createWanjuan({ dir });
    wj.ledger.recordMsg({ id: 'm1', tok: 10, content: 'hello' });
    wj.ledger.recordMsg({ id: 'm2', tok: 20, content: 'world' });

    const bId = wj.compressor.compress({ range: ['m1', 'm2'], summary: 'greeting' });
    assert.equal(wj.ledger.getActiveMessages().length, 0);

    const searchRes = wj.restorer.search('greeting');
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].id, bId);

    const msgs = wj.restorer.decompress(bId, 'context');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, 'hello');
    assert.equal(msgs[1].content, 'world');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createWanjuan：M3 自动化流水线全链路（estRaw 口径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-idx-m3-'));
  try {
    const wj = WJ.createWanjuan({ dir, nudgeOptions: { minSize: 100 } });

    wj.ledger.recordMsg({ id: 'm1', tok: 60 });
    wj.ledger.recordMsg({ id: 'm2', tok: 60 });
    wj.ledger.recordMsg({ id: 'm3', tok: 60 });

    // A5 修复后，gate 用 estRaw 口径
    const gateRes = wj.gate.check({
      currentEstRaw: 130_000,
      lastFoldEstRaw: 50_000,
      estFinal: 130_000,
      window: 200_000
    });
    assert.equal(gateRes.action, 'nudge');

    const candidates = wj.nudge.findCandidates(wj.ledger.getActiveMessages());
    assert.equal(candidates.length, 2);

    const nudgeMsg = wj.nudge.buildNudgeMessage(candidates, 1);
    assert.ok(nudgeMsg);
    assert.ok(nudgeMsg.content.includes('m1 ~ m2'));

    wj.nudge.recordReject(candidates[0].range, 1);
    wj.nudge.recordReject(candidates[0].range, 2);
    const nudgeMsg2 = wj.nudge.buildNudgeMessage([candidates[0]], 3);
    assert.ok(nudgeMsg2);

    wj.nudge.recordReject(candidates[0].range, 3);
    const nudgeMsg3 = wj.nudge.buildNudgeMessage([candidates[0]], 4);
    assert.equal(nudgeMsg3, null);

    const nudgeMsg4 = wj.nudge.buildNudgeMessage([candidates[0]], 6);
    assert.ok(nudgeMsg4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});