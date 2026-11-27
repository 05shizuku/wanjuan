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
  assert.equal(typeof WJ.Diagnoser, 'function');
  assert.equal(typeof WJ.BlocksManager, 'function');
  assert.equal(typeof WJ.Compressor, 'function');
  assert.equal(typeof WJ.Restorer, 'function');
  assert.equal(typeof WJ.classifyWaterMark, 'function'); // v0.9.0-m5.3  assert.equal(typeof WJ.NudgeManager, 'function');
  assert.equal(typeof WJ.Philosophy, 'function');
  assert.equal(typeof WJ.InvariantError, 'function');
  // v0.8.5 P2-13：canonical/hashCanonical 断言随死代码删除
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
    // v0.9.0-m5.3：Observer 类退役——k̂ 校准直连 estimator（与生产路径同款）
    const est = wj.estimator.estimate({ messages: [{ cls: 'text', tok: 100 }] }, { provider: 'deepseek', model: 'deepseek-chat' });
    assert.equal(est.estRaw, 100);

    wj.estimator.observeUsage({ provider: 'deepseek', model: 'deepseek-chat', usageInputTokens: 100, estRaw: est.estRaw });
    assert.equal(wj.estimator.getCalibrationState('deepseek', 'deepseek-chat').n, 1);

    wj.diagnoser.record({
      n: 1, provider: 'deepseek', model: 'deepseek-chat',
      usage: { input_tokens: 100, cached: 100 }, est,
    });
    assert.equal(wj.diagnoser.summarize().total, 1);

    const text = WJ.buildReport({ dir, ledger: wj.ledger, diagnoser: wj.diagnoser });
    assert.ok(text.includes('万卷月报'));
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
    assert.equal(searchRes.matches.length, 1);
    assert.equal(searchRes.matches[0].id, bId);

    const msgs = wj.restorer.decompress(bId, 'context');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, 'hello');
    assert.equal(msgs[1].content, 'world');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createWanjuan：M3 自动化流水线全链路（estRaw 口径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-idx-m3-'));
  try {
    // 关键：显式传 tailKeepTok: 0，否则 180 tok 全落在默认 30k 尾部保留窗
    const wj = WJ.createWanjuan({ dir, nudgeOptions: { minSize: 100, tailKeepTok: 0 } });

    wj.ledger.recordMsg({ id: 'm1', tok: 60 });
    wj.ledger.recordMsg({ id: 'm2', tok: 60 });
    wj.ledger.recordMsg({ id: 'm3', tok: 60 });

    // v0.9.0-m5.3：Gate.check 退役——classifyWaterMark 边界
    assert.equal(WJ.classifyWaterMark(130_000 / 200_000), 'silent');
    assert.equal(WJ.classifyWaterMark(0.85), 'nudge');

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