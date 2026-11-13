// test/blocks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { BlocksManager, BlockError } from '../src/blocks.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-blocks-'));
  const store = new Store({ dir });
  const bm = new BlocksManager({ store });
  return { dir, bm, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('writeRaw 与 readRaw：内容一致，往返成功', () => {
  const { bm, cleanup } = fresh();
  try {
    const msgs = [
      { id: 'm1', cls: 'text', content: 'hello', tok: 10 },
      { id: 'm2', cls: 'tool', content: 'world', tok: 20 },
    ];
    bm.writeRaw('b1', msgs);
    const read = bm.readRaw('b1');
    assert.deepEqual(read, msgs);
  } finally { cleanup(); }
});

test('writeRaw：重复写入同一个块会覆盖旧内容，不留残余', () => {
  const { bm, cleanup } = fresh();
  try {
    bm.writeRaw('b1', [{ id: 'm1', content: 'old' }]);
    bm.writeRaw('b1', [{ id: 'm1', content: 'new' }]);
    const read = bm.readRaw('b1');
    assert.equal(read.length, 1);
    assert.equal(read[0].content, 'new');
  } finally { cleanup(); }
});

test('readRaw：缺失报错 loud', () => {
  const { bm, cleanup } = fresh();
  try {
    assert.throws(
      () => bm.readRaw('b-missing'),
      (e) => e instanceof BlockError && e.code === 'RAW_MISSING'
    );
  } finally { cleanup(); }
});

test('deleteRaw：删除后读取报错', () => {
  const { bm, cleanup } = fresh();
  try {
    bm.writeRaw('b1', [{ id: 'm1' }]);
    bm.deleteRaw('b1');
    assert.throws(() => bm.readRaw('b1'), /原文缺失/);
  } finally { cleanup(); }
});

test('writeBlockMeta 与 readBlockMeta：往返一致', () => {
  const { bm, cleanup } = fresh();
  try {
    const meta = { id: 'b1', tier: 1, summary: 'test', sumTok: 10 };
    bm.writeBlockMeta('b1', meta);
    const read = bm.readBlockMeta('b1');
    assert.deepEqual(read, meta);
  } finally { cleanup(); }
});

test('readBlockMeta：缺失报错 loud', () => {
  const { bm, cleanup } = fresh();
  try {
    assert.throws(
      () => bm.readBlockMeta('b-none'),
      (e) => e instanceof BlockError && e.code === 'BLOCK_NOT_FOUND'
    );
  } finally { cleanup(); }
});