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
    const warns = [];
    const s = new Store({ dir, onWarn: (m) => warns.push(m) });
    s.append({ k: 'msg', id: 'm1', tok: 10 });
    s.append({ k: 'msg', id: 'm2', tok: 10 });
    appendFileSync(join(dir, 'ledger.0001.jsonl'), '{"k":"msg","id":"m3",', 'utf8');

    const state = s.replay();
    assert.equal(state.messages.length, 2);
    assert.equal(s.degraded.length, 1);
    assert.equal(s.degraded[0].reason, 'json-parse-error');

    // 守护：坏行必须喊一嗓子
    assert.ok(warns.length > 0, '坏行未触发 warn');
    assert.ok(warns[0].includes('损坏'), `warn 内容不符: ${warns[0]}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replay：连续 replay 不重复 warn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-store-bad2-'));
  try {
    const warns = [];
    const s = new Store({ dir, onWarn: (m) => warns.push(m) });
    s.append({ k: 'msg', id: 'm1', tok: 10 });
    appendFileSync(join(dir, 'ledger.0001.jsonl'), 'bad-line\n', 'utf8');

    s.replay();
    s.replay();
    s.replay();

    assert.equal(warns.length, 1, '只应 warn 一次');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});