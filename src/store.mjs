// src/store.mjs
// L-1 存储层。职责：ledger 只追加、snapshot 派生缓存、canonical 白名单序列化、块分片尺寸断言。
// 硬规则（§3.1）：
//   - ledger 永不裁剪、永不重写、永不删除；裁剪只作用 snapshot。
//   - snapshot 可由 ledger 全量重放重建，删掉零损失。
//   - 分卷只切不裁。
//   - canonical 按字段白名单+固定顺序，过滤 __proto__/constructor/prototype。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
         statSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

// 字段白名单序列化：按 schema 顺序取值，未知字段忽略，禁用三键。
export function canonical(v, fields) {
  const out = {};
  for (const f of fields) {
    if (FORBIDDEN.has(f)) continue;
    if (v && Object.prototype.hasOwnProperty.call(v, f)) out[f] = v[f];
  }
  return JSON.stringify(out);
}

export function hashCanonical(v, fields) {
  return createHash('sha256').update(canonical(v, fields)).digest('hex');
}

const SEG_RE = /^ledger\.(\d{4})\.jsonl$/;

export class Store {
  constructor({ dir, snapshotBudget = 1000, segBytes = 100 * 1024 * 1024, blockMaxBytes = 4 * 1024 * 1024 }) {
    this.dir = dir;
    this.snapshotBudget = snapshotBudget;
    this.segBytes = segBytes;
    this.blockMaxBytes = blockMaxBytes;
    this.segIndex = 1;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this._syncSegIndex();
  }

  _syncSegIndex() {
    const files = readdirSync(this.dir).filter((f) => SEG_RE.test(f)).sort();
    this.segIndex = files.length === 0 ? 1 : Number(files[files.length - 1].match(SEG_RE)[1]);
  }

  _segPath(i) {
    return join(this.dir, `ledger.${String(i).padStart(4, '0')}.jsonl`);
  }

  _currentSegPath() {
    return this._segPath(this.segIndex);
  }

  _currentSegSize() {
    const p = this._currentSegPath();
    return existsSync(p) ? statSync(p).size : 0;
  }

  _rotateIfNeeded(nextBytes) {
    if (this._currentSegSize() === 0) return;
    if (this._currentSegSize() + nextBytes <= this.segBytes) return;
    this.segIndex += 1;
  }

  // 追加一条事件。分卷只切不裁。
  append(ev) {
    const line = JSON.stringify(ev) + '\n';
    this._rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(this._currentSegPath(), line, 'utf8');
    return ev;
  }

  // 全量重放。返回 { events, messages, blocks }。
  replay() {
    const files = readdirSync(this.dir).filter((f) => SEG_RE.test(f)).sort();
    const events = [];
    for (const f of files) {
      const text = readFileSync(join(this.dir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        events.push(JSON.parse(line));
      }
    }
    return this._reduce(events);
  }

  _reduce(events) {
    const messages = [];
    const blocks = new Map();
    const evicted = new Set();
    for (const ev of events) {
      if (ev.k === 'msg') messages.push(ev);
      else if (ev.k === 'fold') blocks.set(ev.block, ev);
      else if (ev.k === 'evict') for (const id of ev.ids) evicted.add(id);
      else if (ev.k === 'promote') { for (const c of ev.children) { const b = blocks.get(c); if (b) b.promotedInto = ev.parent; } }
    }
    return { events, messages, blocks, evicted };
  }

  // snapshot 构建：从全量重放结果按新近度裁剪，永远从最旧丢。
  buildSnapshot() {
    const state = this.replay();
    const kept = state.messages.slice(-this.snapshotBudget);
    const snap = { snapshotVersion: 1, messages: kept, blockIds: [...state.blocks.keys()], evicted: [...state.evicted] };
    writeFileSync(join(this.dir, 'snapshot.json'), JSON.stringify(snap), 'utf8');
    return snap;
  }

  loadSnapshot() {
    const p = join(this.dir, 'snapshot.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  }

  // 块写入：尺寸断言，超限抛错且不落盘。
  writeBlock(id, obj) {
    const text = JSON.stringify(obj);
    const bytes = Buffer.byteLength(text);
    if (bytes > this.blockMaxBytes) {
      const err = new Error(`块 ${id} 尺寸 ${bytes} 超过上限 ${this.blockMaxBytes}，拒绝落盘`);
      err.code = 'BLOCK_TOO_LARGE';
      throw err;
    }
    writeFileSync(join(this.dir, `block.${id}.json`), text, 'utf8');
    return bytes;
  }
}