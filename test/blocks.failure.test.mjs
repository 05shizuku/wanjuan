// test/blocks.failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { BlocksManager } from '../src/blocks.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-blocks-f-'));
  const store = new Store({ dir });
  const bm = new BlocksManager({ store });
  return { dir, bm, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('writeRaw：空数组也能正常写入和读取', () => {
  const { bm, cleanup } = fresh();
  try {
    bm.writeRaw('b1', []);
    const read = bm.readRaw('b1');
    assert.deepEqual(read, []);
  } finally { cleanup(); }
});

test('readRaw：文件包含坏行时报错 loud', () => {
  const { dir, bm, cleanup } = fresh();
  try {
    // 手动造一个坏文件
    writeFileSync(join(dir, 'block.b1.raw.jsonl'), '{"id":"m1"}\nnot-json\n', 'utf8');
    assert.throws(() => bm.readRaw('b1'));
  } finally { cleanup(); }
});

test('失败不传染：删除不存在的块不报错，幂等', () => {
  const { bm, cleanup } = fresh();
  try {
    assert.doesNotThrow(() => bm.deleteRaw('b-none'));
  } finally { cleanup(); }
});