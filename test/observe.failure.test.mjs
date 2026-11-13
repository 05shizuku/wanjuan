// test/observe.failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Estimator } from '../src/estimate.mjs';
import { Observer } from '../src/observe.mjs';

const MODELS = {
  deepseek: {
    'deepseek-chat': { window: 200_000, output: 8_192, khatPrior: 0.97 },
  },
};

function fresh() {
  const est = new Estimator({ models: MODELS });
  const obs = new Observer({ estimator: est });
  return { est, obs };
}

test('usage 为负：calibOk=false，不污染 k̂', () => {
  const { est, obs } = fresh();
  const e = obs.beforeRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    messages: [{ cls: 'text', tok: 1_000 }],
  });
  const before = est.getKhat('deepseek', 'deepseek-chat');
  const rec = obs.afterRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    est: e,
    usage: { input_tokens: -5 },
  });
  assert.equal(rec.calibOk, false);
  assert.equal(est.getKhat('deepseek', 'deepseek-chat'), before);
});

test('usage 为 undefined 字段：不崩，calibOk=false', () => {
  const { obs } = fresh();
  const e = obs.beforeRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    messages: [{ cls: 'text', tok: 1_000 }],
  });
  const rec = obs.afterRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    est: e,
    usage: {},
  });
  assert.equal(rec.calibOk, false);
  assert.equal(rec.input, 0);
});

test('失败不传染：连续失败后成功样本仍更新 k̂', () => {
  const { est, obs } = fresh();
  const e = obs.beforeRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    messages: [{ cls: 'text', tok: 1_000 }],
  });
  obs.afterRequest({ provider: 'deepseek', model: 'deepseek-chat', est: e, usage: null });
  obs.afterRequest({ provider: 'deepseek', model: 'deepseek-chat', est: e, usage: { input_tokens: 0 } });
  const before = est.getKhat('deepseek', 'deepseek-chat');
  const rec = obs.afterRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    est: e,
    usage: { input_tokens: e.estRaw * 1.2 },
  });
  assert.equal(rec.calibOk, true);
  assert.notEqual(est.getKhat('deepseek', 'deepseek-chat'), before);
});