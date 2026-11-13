// test/store.failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';

test('replay：坏行（如断电断半行）跳过，不影响其他事件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-store-bad-'));
  try {
    const s = new Store({ dir });
    s.append({ k: 'msg', id: 'm1', tok: 10 });
    s.append({ k: 'msg', id: 'm2', tok: 10 });
    
    // 模拟断电：在文件末尾追加半行
    appendFileSync(join(dir, 'ledger.0001.jsonl'), '{"k":"msg","id":"m3",', 'utf8');

    const state = s.replay();
    assert.equal(state.messages.length, 2); // m1, m2 正常读出
    assert.equal(s.degraded.length, 1); // 记录了一条坏行
    assert.equal(s.degraded[0].reason, 'json-parse-error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});