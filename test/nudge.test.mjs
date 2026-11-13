// test/nudge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NudgeManager } from '../src/nudge.mjs';

test('findCandidates：按 minSize 切分', () => {
  const nudge = new NudgeManager({ minSize: 100 });
  const msgs = [
    { id: 'm1', tok: 50 },
    { id: 'm2', tok: 60 }, // 累积 110 -> 切分
    { id: 'm3', tok: 20 },
    { id: 'm4', tok: 30 }, // 累积 50 -> 尾部
  ];
  const cands = nudge.findCandidates(msgs);
  assert.equal(cands.length, 2);
  assert.deepEqual(cands[0].range, ['m1', 'm2']);
  assert.equal(cands[0].srcTok, 110);
  assert.deepEqual(cands[1].range, ['m3', 'm4']);
  assert.equal(cands[1].srcTok, 50);
});

test('shouldNudge：默认允许，拒绝 1-2 次允许', () => {
  const nudge = new NudgeManager();
  assert.equal(nudge.shouldNudge(['m1', 'm2'], 1), true);
  nudge.recordReject(['m1', 'm2'], 1);
  assert.equal(nudge.shouldNudge(['m1', 'm2'], 2), true);
  nudge.recordReject(['m1', 'm2'], 2);
  assert.equal(nudge.shouldNudge(['m1', 'm2'], 3), true);
});

test('shouldNudge：拒绝 3 次后降频，每 3 轮一次', () => {
  const nudge = new NudgeManager();
  const range = ['m1', 'm2'];
  nudge.recordReject(range, 1);
  nudge.recordReject(range, 2);
  nudge.recordReject(range, 3); // 第 3 次拒绝

  // 当前是第 4 轮，距离上次拒绝才 1 轮，应静默
  assert.equal(nudge.shouldNudge(range, 4), false);
  // 当前是第 6 轮，距离 3 轮，应放行
  assert.equal(nudge.shouldNudge(range, 6), true);
});

test('recordAccept：重置状态', () => {
  const nudge = new NudgeManager();
  const range = ['m1', 'm2'];
  nudge.recordReject(range, 1);
  nudge.recordAccept(range);
  assert.equal(nudge.shouldNudge(range, 2), true); // 重新算作 0 次拒绝
});

test('buildNudgeMessage：正确包装且过滤降频区间', () => {
  const nudge = new NudgeManager();
  const candidates = [
    { range: ['m1', 'm2'], msgCount: 2, srcTok: 100 },
  ];
  const msg = nudge.buildNudgeMessage(candidates, 1);
  assert.ok(msg.id.includes('wj-nudge-1'));
  assert.equal(msg.cls, 'sys');
  assert.ok(msg.content.includes('m1 ~ m2'));
});

test('buildNudgeMessage：全部被降频时返回 null', () => {
  const nudge = new NudgeManager();
  const range = ['m1', 'm2'];
  nudge.recordReject(range, 1);
  nudge.recordReject(range, 2);
  nudge.recordReject(range, 3);

  const candidates = [{ range, msgCount: 2, srcTok: 100 }];
  const msg = nudge.buildNudgeMessage(candidates, 4); // 第 4 轮
  assert.equal(msg, null);
});