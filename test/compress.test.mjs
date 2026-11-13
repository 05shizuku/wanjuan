// test/compress.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Ledger } from '../src/ledger.mjs';
import { BlocksManager } from '../src/blocks.mjs';
import { Compressor } from '../src/compress.mjs';
import { Restorer } from '../src/restore.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-comp-'));
  const store = new Store({ dir });
  const ledger = new Ledger({ store });
  const blocks = new BlocksManager({ store });
  const compressor = new Compressor({ ledger, blocks });
  const restorer = new Restorer({ ledger, blocks });
  return { dir, store, ledger, blocks, compressor, restorer, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('compress：正常折叠一段消息', () => {
  const { ledger, compressor, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10 });
    ledger.recordMsg({ id: 'm2', tok: 20 });
    ledger.recordMsg({ id: 'm3', tok: 30 });

    const bId = compressor.compress({
      range: ['m1', 'm2'],
      summary: 'This is a test summary',
      topics: ['test', 'demo'],
      sumTok: 5,
    });

    assert.equal(bId, 'b1');
    assert.equal(ledger.messages.get('m1').status, 'folded');
    assert.equal(ledger.messages.get('m2').status, 'folded');
    assert.equal(ledger.messages.get('m3').status, 'active');
    
    const b = ledger.getBlock('b1');
    assert.equal(b.srcTok, 30);
    assert.equal(b.sumTok, 5);
  } finally { cleanup(); }
});

test('restore.decompress：恢复折叠的原文', () => {
  const { ledger, compressor, restorer, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10, content: 'hello' });
    ledger.recordMsg({ id: 'm2', tok: 20, content: 'world' });
    
    compressor.compress({ range: ['m1', 'm2'], summary: 'sum' });

    const msgs = restorer.decompress('b1', 'context');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, 'hello');
    assert.equal(msgs[1].content, 'world');
  } finally { cleanup(); }
});

test('restore.search：块粒度检索命中 summary', () => {
  const { ledger, compressor, restorer, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10 });
    compressor.compress({ range: ['m1', 'm1'], summary: 'Database migration schema', topics: ['db'] });
    
    const res = restorer.search('migration');
    assert.equal(res.length, 1);
    assert.equal(res[0].id, 'b1');
  } finally { cleanup(); }
});

test('restore.search：块粒度检索命中 topics', () => {
  const { ledger, compressor, restorer, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10 });
    compressor.compress({ range: ['m1', 'm1'], summary: 'Log output', topics: ['error', 'auth'] });
    
    const res = restorer.search('auth');
    assert.equal(res.length, 1);
    assert.equal(res[0].id, 'b1');
  } finally { cleanup(); }
});

test('compress：重启后 blockId 从磁盘 max+1，不撞旧块', () => {
  const { ledger, blocks, cleanup } = fresh();
  try {
    ledger.recordMsg({ id: 'm1', tok: 10, content: 'a' });
    const c1 = new Compressor({ ledger, blocks });
    const b1 = c1.compress({ range: ['m1', 'm1'], summary: 's1' });
    assert.equal(b1, 'b1');

    // 模拟重启：新 Compressor 实例（counter 归零）
    const c2 = new Compressor({ ledger, blocks });
    ledger.recordMsg({ id: 'm2', tok: 10, content: 'b' });
    const b2 = c2.compress({ range: ['m2', 'm2'], summary: 's2' });
    assert.equal(b2, 'b2'); // 绝不能是 b1（否则旧 raw 被覆盖）

    // 旧块 raw 仍完好
    assert.equal(blocks.readRaw('b1')[0].content, 'a');
  } finally { cleanup(); }
});