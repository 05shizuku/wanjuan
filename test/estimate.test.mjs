// test/estimate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Estimator } from '../src/estimate.mjs';

const MODELS = {
  deepseek: {
    'deepseek-chat':     { window: 200_000, output: 8_192, khatPrior: 0.97 },
    'deepseek-reasoner': { window: 200_000, output: 8_192, khatPrior: 0.95 },
  },
  anthropic: {
    'claude-3-5':        { window: 200_000, output: 8_192, khatPrior: 0.99 },
  },
};

function makeEstimator() {
  const warns = [];
  const est = new Estimator({ models: MODELS, onWarn: (m) => warns.push(m) });
  return { est, warns };
}

test('k̂ 收敛后 est_final ≥ 真值 × 1.05', () => {
  const { est } = makeEstimator();
  const T = 100_000;
  const req = { messages: [{ cls: 'text', tok: T }] };

  for (let i = 0; i < 100; i++) {
    const r = est.estimate(req, { provider: 'deepseek', model: 'deepseek-chat' });
    est.observeUsage({ provider: 'deepseek', model: 'deepseek-chat',
                       usageInputTokens: r.estRaw, estRaw: r.estRaw });
  }
  const khat = est.getKhat('deepseek', 'deepseek-chat');
  assert.ok(khat >= 0.999, `khat 应 ≥ 0.999，实际 ${khat}`);

  const r = est.estimate(req, { provider: 'deepseek', model: 'deepseek-chat' });
  assert.ok(r.estFinal >= T * 1.05);
});

test('跨模型 k̂ 互不污染', () => {
  const { est } = makeEstimator();
  const req = { messages: [{ cls: 'text', tok: 10_000 }] };
  const r0 = est.estimate(req, { provider: 'deepseek', model: 'deepseek-chat' });

  for (let i = 0; i < 10; i++) {
    est.observeUsage({ provider: 'deepseek', model: 'deepseek-chat',
                       usageInputTokens: r0.estRaw * 1.1, estRaw: r0.estRaw });
  }
  const kA = est.getKhat('deepseek', 'deepseek-chat');
  const kB = est.getKhat('anthropic', 'claude-3-5');
  const kC = est.getKhat('deepseek', 'deepseek-reasoner');

  assert.ok(kA > 1.05);
  assert.equal(kB, MODELS.anthropic['claude-3-5'].khatPrior);
  assert.equal(kC, MODELS.deepseek['deepseek-reasoner'].khatPrior);
});

test('n=0 时贝叶斯先验兜底，est_final/真值 ∈ [0.95, 1.20]', () => {
  const { est } = makeEstimator();
  const T = 50_000;
  const r = est.estimate(
    { messages: [{ cls: 'text', tok: T }] },
    { provider: 'deepseek', model: 'deepseek-chat' }
  );
  const ratio = r.estFinal / T;
  assert.ok(ratio >= 0.95 && ratio <= 1.20);
  assert.equal(r.calibrating, true);
});

test('history_sys 全会话只计一次', () => {
  const { est } = makeEstimator();
  const messages = [
    { cls: 'sys', tok: 100_000, history: true },
    { cls: 'sys', tok: 100_000, history: true },
    { cls: 'text', tok: 40_000 },
    { cls: 'text', tok: 40_000 },
    { cls: 'tool', tok: 40_000 },
    { cls: 'text', tok: 40_000 },
    { cls: 'tool', tok: 40_000 },
  ];
  const truth = 300_000;
  const r = est.estimate({ messages }, { provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(r.estRaw, truth);
});

test('CI：全库只允许一处 usage / est_raw 除法', () => {
  const path = fileURLToPath(new URL('../src/estimate.mjs', import.meta.url));
  const src = readFileSync(path, 'utf8');
  const marker = 'KAHAT-SAMPLE-DIVISION';
  const markers = src.split(marker).length - 1;
  assert.equal(markers, 1);
  const divisions = (src.match(/usageInputTokens\s*\/\s*estRaw/g) ?? []).length;
  assert.equal(divisions, 1);
});

test('fits 显式扣 output 与 nudgeReserve', () => {
  const { est } = makeEstimator();
  assert.equal(est.fits({ messages: [{ cls: 'text', tok: 100_000 }] },
    { provider: 'deepseek', model: 'deepseek-chat', nudgeReserve: 2_000 }), true);
  assert.equal(est.fits({ messages: [{ cls: 'text', tok: 195_000 }] },
    { provider: 'deepseek', model: 'deepseek-chat', nudgeReserve: 2_000 }), false);
});

// P1 修复守护：同一批 messages 两次调用 estRaw 一致
test('estimate：同一批 messages 两次调用 estRaw 一致（不因 Set 跨调用丢 history）', () => {
  const { est } = makeEstimator();
  const req = {
    messages: [
      { cls: 'sys', tok: 1000, history: true },
      { cls: 'sys', tok: 1000, history: true },
      { cls: 'text', tok: 100 },
    ],
  };
  const r1 = est.estimate(req, { provider: 'deepseek', model: 'deepseek-chat' });
  const r2 = est.estimate(req, { provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(r1.estRaw, r2.estRaw);
  assert.equal(r1.estRaw, 1100);
});