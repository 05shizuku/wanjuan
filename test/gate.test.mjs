// test/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate } from '../src/gate.mjs';

test('正常水位，est_raw 增长 < 50K 时静默', () => {
  const gate = new Gate();
  const r = gate.check({ currentEstRaw: 100_000, lastFoldEstRaw: 60_000, estFinal: 100_000, window: 200_000 });
  assert.equal(r.action, 'silent');
});

test('紧急水位（>=95%），无视门限强制触发', () => {
  const gate = new Gate();
  const r = gate.check({ currentEstRaw: 190_000, lastFoldEstRaw: 189_000, estFinal: 195_000, window: 200_000 });
  assert.equal(r.action, 'emergency');
});

// 补充其他用例...