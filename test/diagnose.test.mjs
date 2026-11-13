// test/diagnose.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Diagnoser, classifyMiss } from '../src/diagnose.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-diag-'));
  return { dir, d: new Diagnoser({ dir }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('classifyMiss：无 usage → unattributed', () => {
  assert.equal(classifyMiss({ usage: null, est: {} }), 'unattributed');
});

test('classifyMiss：有 usage 但无 cached → unattributed', () => {
  assert.equal(classifyMiss({ usage: { input_tokens: 100 }, est: {} }), 'unattributed');
});

test('classifyMiss：missTok=0 → new', () => {
  assert.equal(classifyMiss({ usage: { input_tokens: 100, cached: 100 }, est: {} }), 'new');
});

test('record：写入文件，可读回', () => {
  const { d, cleanup } = fresh();
  try {
    d.record({ n: 1, provider: 'p', model: 'm', usage: { input_tokens: 1000, cached: 800 }, est: { estFinal: 900 } });
    const rs = d.readAll();
    assert.equal(rs.length, 1);
    assert.equal(rs[0].input, 1000);
    assert.equal(rs[0].cached, 800);
  } finally { cleanup(); }
});

test('summarize：命中率正确', () => {
  const { d, cleanup } = fresh();
  try {
    d.record({ n: 1, provider: 'p', model: 'm', usage: { input_tokens: 1000, cached: 800 } });
    d.record({ n: 2, provider: 'p', model: 'm', usage: { input_tokens: 1000, cached: 900 } });
    const s = d.summarize();
    assert.equal(s.total, 2);
    assert.equal(s.hitRate, 0.85);
  } finally { cleanup(); }
});

test('summarize：正确剥离宿主违约（核心命中率高于总命中率）', () => {
  const { d, cleanup } = fresh();
  try {
    d.record({ n: 1, usage: { input_tokens: 1000, cached: 800 }, overrideMissKind: 'host-rewrite' });
    const s = d.summarize();
    assert.equal(s.hitRate, 0.8); 
    assert.ok(s.coreHitRate > 0.88);
    assert.equal(s.byOwner.host, 200); 
  } finally { cleanup(); }
});

test('summarize：空记录返回零值不崩', () => {
  const { d, cleanup } = fresh();
  try {
    const s = d.summarize();
    assert.equal(s.total, 0);
    assert.equal(s.hitRate, 0);
  } finally { cleanup(); }
});