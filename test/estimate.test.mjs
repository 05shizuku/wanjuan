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

// ① k̂ 收敛后 est_final ≥ 真值 × 1.05（偏置未被抵消）
test('k̂ 收敛后 est_final ≥ 真值 × 1.05', () => {
  const { est } = makeEstimator();
  const T = 100_000;
  const req = { messages: [{ cls: 'text', tok: T }] };

  for (let i = 0; i < 100; i++) {
    const r = est.estimate(req, { provider: 'deepseek', model: 'deepseek-chat' });
    assert.equal(
      est.observeUsage({ provider: 'deepseek', model: 'deepseek-chat',
                         usageInputTokens: r.estRaw, estRaw: r.estRaw }),
      true
    );
  }
  const khat = est.getKhat('deepseek', 'deepseek-chat');
  assert.ok(khat >= 0.999, `khat 应 ≥ 0.999，实际 ${khat}`);

  const r = est.estimate(req, { provider: 'deepseek', model: 'deepseek-chat' });
  assert.ok(
    r.estFinal >= T * 1.05,
    `estFinal=${r.estFinal} 应 ≥ 真值×1.05=${T * 1.05}`
  );
});

// ② 跨模型 k̂ 互不污染
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

  assert.ok(kA > 1.05, `chat khat 应 >1.05，实际 ${kA}`);
  assert.equal(kB, MODELS.anthropic['claude-3-5'].khatPrior);
  assert.equal(kC, MODELS.deepseek['deepseek-reasoner'].khatPrior);
});

// ③ n=0 时 est_final/真值 ∈ [0.95, 1.20]
test('n=0 时贝叶斯先验兜底，est_final/真值 ∈ [0.95, 1.20]', () => {
  const { est } = makeEstimator();
  const T = 50_000;
  const r = est.estimate(
    { messages: [{ cls: 'text', tok: T }] },
    { provider: 'deepseek', model: 'deepseek-chat' }
  );
  const ratio = r.estFinal / T;
  assert.ok(ratio >= 0.95 && ratio <= 1.20, `ratio=${ratio} 超出 [0.95, 1.20]`);
  assert.equal(r.calibrating, true);
});

// ④ history_sys 只计一次：3MB 历史偏差 <15%
test('history_sys 全会话只计一次，3MB 历史偏差 <15%', () => {
  const { est } = makeEstimator();
  const messages = [
    { cls: 'sys', tok: 100_000, history: true }, // 计
    { cls: 'sys', tok: 100_000, history: true }, // 跳过
    { cls: 'sys', tok: 100_000, history: true }, // 跳过
    { cls: 'sys', tok: 100_000, history: true }, // 跳过
    { cls: 'sys', tok: 100_000, history: true }, // 跳过
    { cls: 'text', tok: 40_000 },
    { cls: 'text', tok: 40_000 },
    { cls: 'tool', tok: 40_000 },
    { cls: 'text', tok: 40_000 },
    { cls: 'tool', tok: 40_000 },
  ];
  const truth = 300_000; // 100K + 120K(text) + 80K(tool)
  const r = est.estimate({ messages }, { provider: 'deepseek', model: 'deepseek-chat' });

  assert.equal(r.estRaw, truth, 'estRaw 应只计一次 history_sys');
  const repeatCharged = 5 * 100_000 + 200_000; // 若重复计费 = 700K
  assert.ok(
    Math.abs(r.estFinal - truth) / truth < 0.15,
    `estFinal=${r.estFinal} 与真值 ${truth} 偏差应 <15%（重复计费版 ${repeatCharged}）`
  );
});

// ⑤ CI：全库只允许一处 usage / est_raw 除法
test('CI：全库只允许一处 usage / est_raw 除法', () => {
  const path = fileURLToPath(new URL('../src/estimate.mjs', import.meta.url));
  const src = readFileSync(path, 'utf8');
  const marker = 'KAHAT-SAMPLE-DIVISION';
  const markers = src.split(marker).length - 1;
  assert.equal(markers, 1, `标记应恰出现 1 次，实际 ${markers}`);
  const divisions = (src.match(/usageInputTokens\s*\/\s*estRaw/g) ?? []).length;
  assert.equal(divisions, 1, `usageInputTokens / estRaw 应恰出现 1 次，实际 ${divisions}`);
});

// fits 显式扣 output 与 nudgeReserve
test('fits 显式扣 output 与 nudgeReserve', () => {
  const { est } = makeEstimator();
  const fitsOk = est.fits(
    { messages: [{ cls: 'text', tok: 100_000 }] },
    { provider: 'deepseek', model: 'deepseek-chat', nudgeReserve: 2_000 }
  );
  assert.equal(fitsOk, true);

  const fitsBad = est.fits(
    { messages: [{ cls: 'text', tok: 195_000 }] },
    { provider: 'deepseek', model: 'deepseek-chat', nudgeReserve: 2_000 }
  );
  assert.equal(fitsBad, false);
});