// test/nudge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NudgeManager } from '../src/nudge.mjs';

test('findCandidates：按 minSize 切分', () => {
  const nudge = new NudgeManager({ minSize: 100, tailKeepTok: 0 });
  const msgs = [
    { id: 'm1', tok: 50 }, { id: 'm2', tok: 60 },
    { id: 'm3', tok: 20 }, { id: 'm4', tok: 30 },
  ];
  const cands = nudge.findCandidates(msgs);
  assert.equal(cands.length, 2);
  assert.deepEqual(cands[0].range, ['m1', 'm2']);
  assert.deepEqual(cands[1].range, ['m3', 'm4']);
});

test('findCandidates：默认排除尾部保留窗', () => {
  const nudge = new NudgeManager({ minSize: 100, tailKeepTok: 500 });
  const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `m${i + 1}`, tok: 200 }));
  const cands = nudge.findCandidates(msgs);
  for (const c of cands) {
    assert.ok(!['m8', 'm9', 'm10'].includes(c.range[1]), `候选 ${c.range} 不该含尾部`);
  }
});

test('shouldNudge：默认允许，拒绝 1-2 次允许', () => {
  const nudge = new NudgeManager();
  assert.equal(nudge.shouldNudge(['m1', 'm2'], 1), true);
  nudge.recordReject(['m1', 'm2'], 1);
  assert.equal(nudge.shouldNudge(['m1', 'm2'], 2), true);
});

test('shouldNudge：拒绝 3 次后降频，每 3 轮一次', () => {
  const nudge = new NudgeManager();
  const range = ['m1', 'm2'];
  nudge.recordReject(range, 1);
  nudge.recordReject(range, 2);
  nudge.recordReject(range, 3);
  assert.equal(nudge.shouldNudge(range, 4), false);
  assert.equal(nudge.shouldNudge(range, 6), true);
});

test('recordAccept：重置状态', () => {
  const nudge = new NudgeManager();
  const range = ['m1', 'm2'];
  nudge.recordReject(range, 1);
  nudge.recordAccept(range);
  assert.equal(nudge.shouldNudge(range, 2), true);
});

test('buildNudgeMessage：正确包装且过滤降频区间', () => {
  const nudge = new NudgeManager();
  const candidates = [{ range: ['m1', 'm2'], msgCount: 2, srcTok: 100 }];
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
  const msg = nudge.buildNudgeMessage([{ range, msgCount: 2, srcTok: 100 }], 4);
  assert.equal(msg, null);
});

test('buildNudgeMessage：中文字符 token 估算不再低估', () => {
  const nudge = new NudgeManager();
  const msg = nudge.buildNudgeMessage([
    { range: ['m1', 'm2'], msgCount: 2, srcTok: 100 }
  ], 1);
  assert.ok(msg.tok > 100, `nudge tok=${msg.tok} 对中文话术应显著 > ASCII 估算`);
});