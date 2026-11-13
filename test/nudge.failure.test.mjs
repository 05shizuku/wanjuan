// test/nudge.failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NudgeManager } from '../src/nudge.mjs';

test('findCandidates：空消息数组安全处理', () => {
  const nudge = new NudgeManager();
  assert.deepEqual(nudge.findCandidates([]), []);
});

test('buildNudgeMessage：空候选返回 null', () => {
  const nudge = new NudgeManager();
  assert.equal(nudge.buildNudgeMessage([], 1), null);
});