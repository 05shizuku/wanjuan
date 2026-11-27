// test/store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs'; // v0.8.5 P2-13：canonical/snapshot 死代码已删

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'wj-store-'));
}

test('分卷后重放一致', () => {
  const dir = freshDir();
  try {
    const s = new Store({ dir, segBytes: 60 });
    for (let i = 0; i < 50; i++) s.append({ k: 'msg', id: `m${i}`, tok: 1 });
    const segs = readdirSync(dir).filter((f) => f.startsWith('ledger.'));
    assert.ok(segs.length > 1, `应触发分卷，实际 ${segs.length} 段`);
    const state = s.replay();
    assert.equal(state.messages.length, 50);
    assert.equal(state.messages[49].id, 'm49');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('块 >4MiB 断言失败且不落盘', () => {
  const dir = freshDir();
  try {
    const s = new Store({ dir, blockMaxBytes: 1024 });
    const big = { data: 'x'.repeat(2048) };
    assert.throws(() => s.writeBlock('b1', big), (err) => err.code === 'BLOCK_TOO_LARGE');
    assert.equal(existsSync(join(dir, 'block.b1.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});