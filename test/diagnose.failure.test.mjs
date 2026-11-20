// test/diagnose.failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Diagnoser } from '../src/diagnose.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-diag-f-'));
  return { dir, d: new Diagnoser({ dir }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('v0.7.6：坏行跳过不再毒化——readAll 返回好行（旧 loud 语义 + 生产 catch{} 会永久毒化 provider/model 探测）', () => {
  const { dir, d, cleanup } = fresh();
  try {
    writeFileSync(join(dir, 'requests.jsonl'), '{"n":1}\nnot-json\n', 'utf8');
    const rows = d.readAll(); // 修复前：抛错 → turn/end 静默 → 窗口跌回 128K → 大窗口模型被反复误强折
    assert.equal(rows.length, 1);
    assert.equal(rows[0].n, 1);
  } finally { cleanup(); }
});

test('usage 缺 input_tokens：不崩，标 unattributed', () => {
  const { d, cleanup } = fresh();
  try {
    const r = d.record({ n: 1, provider: 'p', model: 'm', usage: { cached: 5 } });
    assert.equal(r.missKind, 'unattributed');
    assert.equal(r.input, 0);
  } finally { cleanup(); }
});

test('usage 缺 cached：不崩，标 unattributed', () => {
  const { d, cleanup } = fresh();
  try {
    const r = d.record({ n: 1, provider: 'p', model: 'm', usage: { input_tokens: 100 } });
    assert.equal(r.missKind, 'unattributed');
  } finally { cleanup(); }
});

test('失败不传染：一次坏 usage 后下一次正常记录', () => {
  const { d, cleanup } = fresh();
  try {
    d.record({ n: 1, provider: 'p', model: 'm', usage: null });
    d.record({ n: 2, provider: 'p', model: 'm', usage: { input_tokens: 100, cached: 80 } });
    assert.equal(d.readAll().length, 2);
  } finally { cleanup(); }
});