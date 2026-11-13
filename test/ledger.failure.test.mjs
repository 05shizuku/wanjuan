// test/ledger.failure.test.mjs
// 原则：每个失败 loud + isolated。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Ledger, InvariantError } from '../src/ledger.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-f-'));
  const store = new Store({ dir });
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('unfold：why 非法报错', () => {
  const { store, cleanup } = fresh();
  try {
    const l = new Ledger({ store });
    assert.throws(
      () => l.recordUnfold({ block: 'b1', why: 'bogus' }),
      (e) => e instanceof InvariantError && e.invariant === '原文可达'
    );
  } finally { cleanup(); }
});

test('evict 不存在消息：不抛错，幂等', () => {
  const { store, cleanup } = fresh();
  try {
    const l = new Ledger({ store });
    assert.doesNotThrow(() => l.recordEvict({ ids: ['nope'], why: 'reconcile' }));
  } finally { cleanup(); }
});

test('失败不传染：InvariantError 后其他操作正常', () => {
  const { store, cleanup } = fresh();
  try {
    const l = new Ledger({ store });
    l.recordMsg({ id: 'm1', tok: 10 });
    try {
      l.recordFold({ block: 'b1', range: ['m1', 'm1'], srcTok: 10, sumTok: 3, tier: 1 });
    } catch (e) {
      assert.ok(e instanceof InvariantError);
    }
    l.recordFold({ block: 'b1', range: ['m1', 'm1'], srcTok: 10, sumTok: 3, tier: 1, rawRef: 'r1' });
    assert.equal(l.messages.get('m1').status, 'folded');
  } finally { cleanup(); }
});

test('重复 recordMsg：幂等，不改变已有 tok', () => {
  const { store, cleanup } = fresh();
  try {
    const l = new Ledger({ store });
    l.recordMsg({ id: 'm1', tok: 10 });
    l.recordMsg({ id: 'm1', tok: 999 });
    assert.equal(l.messages.get('m1').ev.tok, 10);
  } finally { cleanup(); }
});

test('pendingCompress 指向不存在的块：assertInvariants 不抛错但记 degrade', () => {
  const { store, cleanup } = fresh();
  try {
    const l = new Ledger({ store });
    l.recordMsg({ id: 'm1', tok: 10 });
    l.setPendingCompress('b-future');
    assert.doesNotThrow(() => l.assertInvariants());
    assert.ok(l.getDegraded().includes('pending-without-block'));
  } finally { cleanup(); }
});

test('recordPromote：单子块正常晋升', () => {
  const { store, cleanup } = fresh();
  try {
    const l = new Ledger({ store });
    l.recordMsg({ id: 'm1', tok: 10 });
    l.recordFold({ block: 'b1', range: ['m1', 'm1'], srcTok: 10, sumTok: 2, tier: 1, rawRef: 'r1' });
    l.recordPromote({ parent: 'b2', children: ['b1'], srcTok: 2, sumTok: 1, tier: 2 });
    assert.deepEqual(l.blocks.get('b2').children, ['b1']);
  } finally { cleanup(); }
});