// test/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate } from '../src/gate.mjs';

test('正常水位，增长 < 50K 时静默', () => {
  const gate = new Gate();
  const r = gate.check({ currentEst: 100_000, lastFoldEst: 60_000, window: 200_000 });
  assert.equal(r.action, 'silent');
  assert.equal(r.grown, 40_000);
  assert.equal(r.usageRatio, 0.5);
});

test('正常水位，增长 >= 50K 时触发 nudge', () => {
  const gate = new Gate();
  const r = gate.check({ currentEst: 120_000, lastFoldEst: 60_000, window: 200_000 });
  assert.equal(r.action, 'nudge');
  assert.equal(r.grown, 60_000);
});

test('高水位（>=85%），门限降至 22.5K', () => {
  const gate = new Gate();
  // 180K / 200K = 90%
  // 增长 30K > 22.5K，应触发
  const r1 = gate.check({ currentEst: 180_000, lastFoldEst: 150_000, window: 200_000 });
  assert.equal(r1.action, 'nudge');
  assert.equal(r1.threshold, 22_500);

  // 增长 20K < 22.5K，应静默
  const r2 = gate.check({ currentEst: 180_000, lastFoldEst: 160_000, window: 200_000 });
  assert.equal(r2.action, 'silent');
});

test('紧急水位（>=95%），无视门限强制触发', () => {
  const gate = new Gate();
  // 190K / 200K = 95%
  const r = gate.check({ currentEst: 190_000, lastFoldEst: 189_000, window: 200_000 });
  assert.equal(r.action, 'emergency');
  assert.equal(r.shouldNudge, true);
  assert.equal(r.threshold, 0);
});

test('边界：刚好 85% 进高水位', () => {
  const gate = new Gate();
  const r = gate.check({ currentEst: 170_000, lastFoldEst: 140_000, window: 200_000 });
  assert.equal(r.usageRatio, 0.85);
  assert.equal(r.threshold, 22_500);
});