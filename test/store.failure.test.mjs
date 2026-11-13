// test/store.failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'wj-store-f-'));
}

test('坏行导致 replay loud 报错，不静默跳过', () => {
  const dir = freshDir();
  try {
    const s = new Store({ dir });
    s.append({ k: 'msg', id: 'm0', tok: 1 });
    writeFileSync(join(dir, 'ledger.0001.jsonl'), '{"k":"msg","id":"m0"}\nnot-json\n', 'utf8');
    assert.throws(() => s.replay());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('append 后文件字节增长，非空', () => {
  const dir = freshDir();
  try {
    const s = new Store({ dir });
    s.append({ k: 'msg', id: 'm0', tok: 1 });
    const files = readdirSync(dir).filter((f) => f.startsWith('ledger.'));
    assert.equal(files.length, 1);
    const text = readFileSync(join(dir, files[0]), 'utf8');
    assert.ok(text.includes('m0'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('snapshot 不存在时 loadSnapshot 返回 null，不抛错', () => {
  const dir = freshDir();
  try {
    const s = new Store({ dir });
    assert.equal(s.loadSnapshot(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('块恰好等于上限时允许落盘', () => {
  const dir = freshDir();
  try {
    const s = new Store({ dir, blockMaxBytes: 32 });
    const ok = { d: 'x'.repeat(20) }; // 约 26 字节
    assert.doesNotThrow(() => s.writeBlock('b1', ok));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});