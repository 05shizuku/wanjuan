// test/store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, canonical, hashCanonical } from '../src/store.mjs';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'wj-store-'));
}

test('canonical：键序无关', () => {
  const a = canonical({ x: 1, y: 2 }, ['x', 'y']);
  const b = canonical({ y: 2, x: 1 }, ['x', 'y']);
  assert.equal(a, b);
});

test('canonical：未知字段不参与哈希', () => {
  const h1 = hashCanonical({ x: 1, secret: 'a' }, ['x']);
  const h2 = hashCanonical({ x: 1, secret: 'b' }, ['x']);
  assert.equal(h1, h2);
});

test('canonical：过滤 __proto__/constructor/prototype', () => {
  const v = JSON.parse('{"x":1,"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad"}');
  const s = canonical(v, ['x', '__proto__', 'constructor', 'prototype']);
  assert.equal(s, JSON.stringify({ x: 1 }));
});

test('重放后最新 N 条必在 snapshot 预算内', () => {
  const dir = freshDir();
  try {
    const s = new Store({ dir, snapshotBudget: 5 });
    for (let i = 0; i < 20; i++) s.append({ k: 'msg', id: `m${i}`, tok: 1 });
    const snap = s.buildSnapshot();
    assert.equal(snap.messages.length, 5);
    assert.deepEqual(snap.messages.map((m) => m.id), ['m15', 'm16', 'm17', 'm18', 'm19']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('删 snapshot 后由 ledger 重建状态 hash 相等', () => {
  const dir = freshDir();
  try {
    const s = new Store({ dir });
    for (let i = 0; i < 10; i++) s.append({ k: 'msg', id: `m${i}`, tok: 1 });
    const first = s.buildSnapshot();
    const p = join(dir, 'snapshot.json');
    rmSync(p);
    const rebuilt = s.buildSnapshot();
    assert.deepEqual(rebuilt, first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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