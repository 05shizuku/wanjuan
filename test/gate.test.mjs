// test/gate.test.mjs — v0.9.0-m5.3：classifyWaterMark 边界（替代旧 Gate 增速门测试）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWaterMark } from '../src/gate.mjs';

test('classifyWaterMark：三段边界（0.80/0.95）', () => {
  assert.equal(classifyWaterMark(0.5), 'silent');
  assert.equal(classifyWaterMark(0.79), 'silent');
  assert.equal(classifyWaterMark(0.80), 'nudge');
  assert.equal(classifyWaterMark(0.94), 'nudge');
  assert.equal(classifyWaterMark(0.95), 'emergency');
  assert.equal(classifyWaterMark(1.2), 'emergency');
});

test('classifyWaterMark：阈值可配（不对齐内联值的未来留门）', () => {
  assert.equal(classifyWaterMark(0.7, { highWaterMark: 0.65 }), 'nudge');
  assert.equal(classifyWaterMark(0.9, { criticalWaterMark: 0.85 }), 'emergency');
});
