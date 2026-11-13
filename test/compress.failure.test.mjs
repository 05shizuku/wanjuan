// test/compress.failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Ledger, InvariantError } from '../src/ledger.mjs';
import { BlocksManager } from '../src/blocks.mjs';
import { Compressor } from '../src/compress.mjs';
import { Restorer } from '../src/restore.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-comp-f-'));
  const store = new Store({ dir });
  const ledger = new Ledger({ store });
  const blocks = new BlocksManager({ store });
  const compressor = new Compressor({ ledger, blocks });
  const restorer = new Restorer({ ledger, blocks });
  return { dir, store, ledger, blocks, compressor, restorer, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('compress：区间越界报错', () => {
  const { ledger, compressor, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10 });
    assert.throws(
      () => compressor.compress({ range: ['m0', 'm1'], summary: 'sum' }),
      (e) => e instanceof InvariantError && e.invariant === '归属唯一'
    );
  } finally { cleanup(); }
});

test('compress：跨越已折叠消息报错', () => {
  const { ledger, compressor, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10 });
    ledger.recordMsg({ id: 'm2', tok: 10 });
    ledger.recordMsg({ id: 'm3', tok: 10 });
    
    compressor.compress({ range: ['m1', 'm1'], summary: 's1' });
    // 现在 m1 是 folded，m2,m3 是 active。尝试 fold m1 到 m3 会报错（因为 m1 不在 active 列表里）
    assert.throws(
      () => compressor.compress({ range: ['m1', 'm3'], summary: 's2' }),
      (e) => e.invariant === '归属唯一'
    );
  } finally { cleanup(); }
});

test('restore.decompress：块不存在时报错', () => {
  const { restorer, cleanup } = fresh();
  try {
    assert.throws(() => restorer.decompress('b-none'), /不存在/);
  } finally { cleanup(); }
});

test('restore.decompress：孤儿块（meta 有但 raw 无）报错', () => {
  const { ledger, compressor, restorer, blocks, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10 });
    compressor.compress({ range: ['m1', 'm1'], summary: 's1' });
    
    // 强行删掉 raw 模拟孤儿
    blocks.deleteRaw('b1');
    
    assert.throws(() => restorer.decompress('b1'), /原文缺失/);
  } finally { cleanup(); }
});

test('失败原子性：写账本失败时清理 raw', () => {
  const { dir, ledger, blocks, compressor, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10 });
    
    // 故意占位，让 ledger 报错（并发唯一）
    ledger.setPendingCompress('b-other');
    
    assert.throws(
      () => compressor.compress({ range: ['m1', 'm1'], summary: 's1' }),
      (e) => e.invariant === '并发唯一'
    );
    
    // 验证 b1 的 raw 和 meta 都被清理了（没有落盘）
    assert.equal(existsSync(join(dir, 'block.b1.raw.jsonl')), false);
    assert.equal(existsSync(join(dir, 'block.b1.json')), false);
  } finally { cleanup(); }
});