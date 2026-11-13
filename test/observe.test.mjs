// test/observe.test.mjs
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

test('beforeRequest：返回估算结果', () => {
  const { obs } = fresh();
  const est = obs.beforeRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    messages: [{ cls: 'text', tok: 10_000 }],
  });
  assert.equal(est.estRaw, 10_000);
  assert.ok(est.estFinal > 10_000);
});

test('afterRequest：更新 k̂', () => {
  const { est, obs } = fresh();
  const e = obs.beforeRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    messages: [{ cls: 'text', tok: 10_000 }],
  });
  const before = est.getKhat('deepseek', 'deepseek-chat');
  const rec = obs.afterRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    est: e,
    usage: { input_tokens: e.estRaw * 1.1 },
  });
  assert.equal(rec.calibOk, true);
  const after = est.getKhat('deepseek', 'deepseek-chat');
  assert.notEqual(before, after);
});

test('afterRequest：无 usage 时 calibOk=false', () => {
  const { obs } = fresh();
  const e = obs.beforeRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    messages: [{ cls: 'text', tok: 10_000 }],
  });
  const rec = obs.afterRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    est: e,
    usage: null,
  });
  assert.equal(rec.calibOk, false);
  assert.equal(rec.input, 0);
});

test('requests 记录累积，n 递增', () => {
  const { obs } = fresh();
  const e = obs.beforeRequest({
    provider: 'deepseek', model: 'deepseek-chat',
    messages: [{ cls: 'text', tok: 1_000 }],
  });
  obs.afterRequest({ provider: 'deepseek', model: 'deepseek-chat', est: e, usage: { input_tokens: 1_000 } });
  obs.afterRequest({ provider: 'deepseek', model: 'deepseek-chat', est: e, usage: { input_tokens: 1_000 } });
  assert.equal(obs.size(), 2);
  assert.equal(obs.getRequests()[0].n, 1);
  assert.equal(obs.getRequests()[1].n, 2);
});