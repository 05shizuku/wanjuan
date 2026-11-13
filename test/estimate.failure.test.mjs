// test/estimate.failure.test.mjs
// 原则：每个失败 loud + isolated（§13 原则 3）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Estimator } from '../src/estimate.mjs';

const MODELS = {
  deepseek: {
    'deepseek-chat': { window: 200_000, output: 8_192, khatPrior: 0.97 },
  },
};

// 未知模型：明着降级 + warn + degraded
test('未知模型：明着降级 128K + warn + degraded', () => {
  const warns = [];
  const est = new Estimator({ models: MODELS, onWarn: (m) => warns.push(m) });
  const r = est.estimate(
    { messages: [{ cls: 'text', tok: 10_000 }] },
    { provider: 'nope', model: 'nope' }
  );
  assert.equal(r.window, 128_000);
  assert.equal(r.output, 8_192);
  assert.ok(warns.some((w) => w.includes('128K')), '应有 128K warn');
  assert.ok(est.getDegraded().includes('unknown-model'));
});

// usage=0：拒绝更新 k̂
test('usage=0：拒绝更新 + degraded，不污染 k̂', () => {
  const warns = [];
  const est = new Estimator({ models: MODELS, onWarn: (m) => warns.push(m) });
  const ok = est.observeUsage({
    provider: 'deepseek', model: 'deepseek-chat',
    usageInputTokens: 0, estRaw: 1_000,
  });
  assert.equal(ok, false);
  assert.ok(warns.length > 0);
  assert.ok(est.getDegraded().includes('bad-usage'));
});

// estRaw=0：拒绝更新 k̂
test('estRaw=0：拒绝更新 + degraded', () => {
  const est = new Estimator({ models: MODELS });
  const ok = est.observeUsage({
    provider: 'deepseek', model: 'deepseek-chat',
    usageInputTokens: 1_000, estRaw: 0,
  });
  assert.equal(ok, false);
  assert.ok(est.getDegraded().includes('bad-est-raw'));
});

// 未知消息分类：warn + 按 text 计 + degraded
test('未知消息分类：warn + 按 text 计 + degraded', () => {
  const warns = [];
  const est = new Estimator({ models: MODELS, onWarn: (m) => warns.push(m) });
  const r = est.estimate(
    { messages: [{ cls: 'bogus', tok: 5_000 }] },
    { provider: 'deepseek', model: 'deepseek-chat' }
  );
  assert.equal(r.counts.text, 5_000);
  assert.ok(warns.some((w) => w.includes('bogus')));
  assert.ok(est.getDegraded().includes('unknown-cls'));
});

// 失败不传染：未知模型降级后，正常模型 estimate 仍工作
test('失败不传染：未知模型降级不影响正常模型', () => {
  const est = new Estimator({ models: MODELS });
  est.estimate(
    { messages: [{ cls: 'text', tok: 1_000 }] },
    { provider: 'unknown', model: 'unknown' }
  );
  const r = est.estimate(
    { messages: [{ cls: 'text', tok: 1_000 }] },
    { provider: 'deepseek', model: 'deepseek-chat' }
  );
  assert.equal(r.window, 200_000);
  assert.equal(r.calibrating, true);
});

// 失败不传染：坏样本不改变已有 k̂
test('失败不传染：坏 usage 不污染已有 k̂', () => {
  const est = new Estimator({ models: MODELS });
  const req = { messages: [{ cls: 'text', tok: 10_000 }] };
  const r0 = est.estimate(req, { provider: 'deepseek', model: 'deepseek-chat' });
  for (let i = 0; i < 10; i++) {
    est.observeUsage({
      provider: 'deepseek', model: 'deepseek-chat',
      usageInputTokens: r0.estRaw, estRaw: r0.estRaw,
    });
  }
  const before = est.getKhat('deepseek', 'deepseek-chat');
  est.observeUsage({
    provider: 'deepseek', model: 'deepseek-chat',
    usageInputTokens: 0, estRaw: r0.estRaw,
  });
  est.observeUsage({
    provider: 'deepseek', model: 'deepseek-chat',
    usageInputTokens: r0.estRaw, estRaw: 0,
  });
  const after = est.getKhat('deepseek', 'deepseek-chat');
  assert.equal(before, after, '坏样本不得改变 khat');
});

// 负 nudgeReserve：loud，按 0 处理
test('负 nudgeReserve：loud 并按 0 处理，不静默', () => {
  const warns = [];
  const est = new Estimator({ models: MODELS, onWarn: (m) => warns.push(m) });
  const fits = est.fits(
    { messages: [{ cls: 'text', tok: 1_000 }] },
    { provider: 'deepseek', model: 'deepseek-chat', nudgeReserve: -100 }
  );
  assert.equal(fits, true);
  assert.ok(warns.some((w) => w.includes('nudgeReserve')));
  assert.ok(est.getDegraded().includes('bad-nudge-reserve'));
});

// degraded 可观测且可清空
test('degraded 可观测且可清空', () => {
  const est = new Estimator({ models: MODELS });
  est.estimate(
    { messages: [{ cls: 'text', tok: 1 }] },
    { provider: 'x', model: 'y' }
  );
  assert.ok(est.getDegraded().length > 0);
  est.clearDegraded();
  assert.equal(est.getDegraded().length, 0);
});