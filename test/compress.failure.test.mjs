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
    blocks.deleteRaw('b1');
    assert.throws(() => restorer.decompress('b1'), /原文缺失/);
  } finally { cleanup(); }
});

test('失败原子性：写账本失败时清理 raw', () => {
  const { dir, ledger, blocks, compressor, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10 });
    ledger.setPendingCompress('b-other');
    assert.throws(
      () => compressor.compress({ range: ['m1', 'm1'], summary: 's1' }),
      (e) => e.invariant === '并发唯一'
    );
    assert.equal(existsSync(join(dir, 'block.b1.raw.jsonl')), false);
    assert.equal(existsSync(join(dir, 'block.b1.json')), false);
  } finally { cleanup(); }
});

// P1 修复守护：decompress(context) 后账本 unfold，块消失
test('decompress(context)：成功后账本 unfold，块消失', () => {
  const { ledger, compressor, restorer, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10, content: 'x' });
    const b1 = compressor.compress({ range: ['m1', 'm1'], summary: 's1' });
    assert.equal(ledger.messages.get('m1').status, 'folded');

    restorer.decompress(b1, 'context');

    assert.equal(ledger.messages.get('m1').status, 'active');
    assert.equal(ledger.getBlock(b1), undefined);
  } finally { cleanup(); }
});