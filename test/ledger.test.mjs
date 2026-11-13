// test/ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Ledger, InvariantError } from '../src/ledger.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  const store = new Store({ dir });
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('recordMsg：幂等，重复不追加', () => {
  const { store, cleanup } = fresh();
  try {
    const ledger = new Ledger({ store });
    ledger.recordMsg({ id: 'm1', tok: 10 });
    ledger.recordMsg({ id: 'm1', tok: 10 });
    assert.equal(ledger.messages.size, 1);
  } finally { cleanup(); }
});

test('recordFold：正常流程，消息变 folded', () => {
  const { store, cleanup } = fresh();
  try {
    const ledger = new Ledger({ store });
    ledger.recordMsg({ id: 'm1', tok: 10 });
    ledger.recordMsg({ id: 'm2', tok: 20 });
    ledger.recordFold({ block: 'b1', range: ['m1', 'm2'], srcTok: 30, sumTok: 5, tier: 1, rawRef: 'blocks/b1.raw.jsonl' });
    assert.equal(ledger.messages.get('m1').status, 'folded');
    assert.equal(ledger.messages.get('m2').status, 'folded');
    assert.equal(ledger.messages.get('m1').blockId, 'b1');
    assert.ok(ledger.blocks.has('b1'));
  } finally { cleanup(); }
});

test('recordFold：缺 rawRef 报错', () => {
  const { store, cleanup } = fresh();
  try {
    const ledger = new Ledger({ store });
    ledger.recordMsg({ id: 'm1', tok: 10 });
    assert.throws(
      () => ledger.recordFold({ block: 'b1', range: ['m1', 'm1'], srcTok: 10, sumTok: 3, tier: 1 }),
      (e) => e instanceof InvariantError && e.invariant === '原文可达'
    );
  } finally { cleanup(); }
});

test('recordFold：区间无消息报错', () => {
  const { store, cleanup } = fresh();
  try {
    const ledger = new Ledger({ store });
    assert.throws(
      () => ledger.recordFold({ block: 'b1', range: ['m1', 'm1'], srcTok: 10, sumTok: 3, tier: 1, rawRef: 'x' }),
      (e) => e instanceof InvariantError && e.invariant === '归属唯一'
    );
  } finally { cleanup(); }
});

test('recordFold：消息已被折过报错', () => {
  const { store, cleanup } = fresh();
  try {
    const ledger = new Ledger({ store });
    ledger.recordMsg({ id: 'm1', tok: 10 });
    ledger.recordFold({ block: 'b1', range: ['m1', 'm1'], srcTok: 10, sumTok: 3, tier: 1, rawRef: 'r1' });
    assert.throws(
      () => ledger.recordFold({ block: 'b2', range: ['m1', 'm1'], srcTok: 10, sumTok: 3, tier: 1, rawRef: 'r2' }),
      (e) => e.invariant === '归属唯一'
    );
  } finally { cleanup(); }
});

test('recordFold：并发唯一，pendingCompress 未清时报错', () => {
  const { store, cleanup } = fresh();
  try {
    const ledger = new Ledger({ store });
    ledger.recordMsg({ id: 'm1', tok: 10 });
    ledger.recordMsg({ id: 'm2', tok: 20 });
    ledger.setPendingCompress('b1');
    assert.throws(
      () => ledger.recordFold({ block: 'b2', range: ['m1', 'm2'], srcTok: 30, sumTok: 3, tier: 1, rawRef: 'r2' }),
      (e) => e.invariant === '并发唯一'
    );
    ledger.recordFold({ block: 'b1', range: ['m1', 'm2'], srcTok: 30, sumTok: 3, tier: 1, rawRef: 'r1' });
    assert.equal(ledger.pendingCompress, null);
  } finally { cleanup(); }
});

test('recordEvict：why 非法报错', () => {
  const { store, cleanup } = fresh();
  try {
    const ledger = new Ledger({ store });
    ledger.recordMsg({ id: 'm1', tok: 10 });
    assert.throws(
      () => ledger.recordEvict({ ids: ['m1'], why: 'whatever' }),
      (e) => e.invariant === '归属唯一'
    );
  } finally { cleanup(); }
});

test('recordEvict：正常将消息标 evicted', () => {
  const { store, cleanup } = fresh();
  try {
    const ledger = new Ledger({ store });
    ledger.recordMsg({ id: 'm1', tok: 10 });
    ledger.recordEvict({ ids: ['m1'], why: 'host-compact' });
    assert.equal(ledger.messages.get('m1').status, 'evicted');
  } finally { cleanup(); }
});

test('recordUnfold：恢复消息为 active 并删块', () => {
  const { store, cleanup } = fresh();
  try {
    const ledger = new Ledger({ store });
    ledger.recordMsg({ id: 'm1', tok: 10 });
    ledger.recordFold({ block: 'b1', range: ['m1', 'm1'], srcTok: 10, sumTok: 3, tier: 1, rawRef: 'r1' });
    ledger.recordUnfold({ block: 'b1', why: 'context' });
    assert.equal(ledger.messages.get('m1').status, 'active');
    assert.equal(ledger.blocks.has('b1'), false);
  } finally { cleanup(); }
});

test('recordPromote：父子关系正确', () => {
  const { store, cleanup } = fresh();
  try {
    const ledger = new Ledger({ store });
    ledger.recordMsg({ id: 'm1', tok: 10 });
    ledger.recordMsg({ id: 'm2', tok: 10 });
    ledger.recordFold({ block: 'b1', range: ['m1', 'm1'], srcTok: 10, sumTok: 2, tier: 1, rawRef: 'r1' });
    ledger.recordFold({ block: 'b2', range: ['m2', 'm2'], srcTok: 10, sumTok: 2, tier: 1, rawRef: 'r2' });
    ledger.recordPromote({ parent: 'b3', children: ['b1', 'b2'], srcTok: 4, sumTok: 1, tier: 2 });
    assert.equal(ledger.blocks.get('b1').promotedInto, 'b3');
    assert.equal(ledger.blocks.get('b2').promotedInto, 'b3');
    assert.deepEqual(ledger.blocks.get('b3').children, ['b1', 'b2']);
  } finally { cleanup(); }
});

test('assertInvariants：正常流程通过', () => {
  const { store, cleanup } = fresh();
  try {
    const ledger = new Ledger({ store });
    ledger.recordMsg({ id: 'm1', tok: 10 });
    ledger.recordMsg({ id: 'm2', tok: 20 });
    ledger.recordFold({ block: 'b1', range: ['m1', 'm2'], srcTok: 30, sumTok: 5, tier: 1, rawRef: 'r1' });
    const r = ledger.assertInvariants();
    assert.equal(r.totalTok, 30);
    assert.equal(r.blocks, 1);
  } finally { cleanup(); }
});

test('重放：新 Ledger 从同一 store 重建状态一致', () => {
  const { store, cleanup } = fresh();
  try {
    const l1 = new Ledger({ store });
    l1.recordMsg({ id: 'm1', tok: 10 });
    l1.recordMsg({ id: 'm2', tok: 20 });
    l1.recordFold({ block: 'b1', range: ['m1', 'm2'], srcTok: 30, sumTok: 5, tier: 1, rawRef: 'r1' });
    const l2 = new Ledger({ store });
    assert.equal(l2.messages.size, 2);
    assert.equal(l2.blocks.size, 1);
    assert.equal(l2.messages.get('m1').status, 'folded');
    assert.deepEqual(l2.assertInvariants(), l1.assertInvariants());
  } finally { cleanup(); }
});

test('recordPromote：父块 atRange = children 并集', () => {
  const { store, cleanup } = fresh();
  try {
    const l = new Ledger({ store });
    l.recordMsg({ id: 'm1', tok: 10 });
    l.recordMsg({ id: 'm2', tok: 10 });
    l.recordFold({ block: 'b1', range: ['m1', 'm1'], srcTok: 10, sumTok: 2, tier: 1, rawRef: 'r1', atRange: [100, 200] });
    l.recordFold({ block: 'b2', range: ['m2', 'm2'], srcTok: 10, sumTok: 2, tier: 1, rawRef: 'r2', atRange: [150, 300] });
    l.recordPromote({ parent: 'b3', children: ['b1', 'b2'], srcTok: 4, sumTok: 1, tier: 2 });
    assert.deepEqual(l.blocks.get('b3').atRange, [100, 300]);
  } finally { cleanup(); }
});