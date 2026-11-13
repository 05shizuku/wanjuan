// src/store.mjs
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
         statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

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
  constructor({ dir, snapshotBudget = 1000, segBytes = 100 * 1024 * 1024, blockMaxBytes = 4 * 1024 * 1024, onWarn } = {}) {
    this.dir = dir;
    this.snapshotBudget = snapshotBudget;
    this.segBytes = segBytes;
    this.blockMaxBytes = blockMaxBytes;
    this.onWarn = onWarn ?? ((msg) => console.warn(`[wanjuan/store] ${msg}`));
    this.degraded = [];
    this._degradedWarned = false;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this._syncSegIndex();
  }

  _syncSegIndex() {
    const files = readdirSync(this.dir).filter((f) => SEG_RE.test(f)).sort();
    this.segIndex = files.length === 0 ? 1 : Number(files[files.length - 1].match(SEG_RE)[1]);
  }

  _segPath(i) { return join(this.dir, `ledger.${String(i).padStart(4, '0')}.jsonl`); }
  _currentSegPath() { return this._segPath(this.segIndex); }
  _currentSegSize() { const p = this._currentSegPath(); return existsSync(p) ? statSync(p).size : 0; }

  _rotateIfNeeded(nextBytes) {
    if (this._currentSegSize() === 0) return;
    if (this._currentSegSize() + nextBytes <= this.segBytes) return;
    this.segIndex += 1;
  }

  append(ev) {
    const line = JSON.stringify(ev) + '\n';
    this._rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(this._currentSegPath(), line, 'utf8');
    return ev;
  }

  // 坏行跳过不拖垮账本；首次发现坏行 warn 一次，让运维知道
  replay() {
    const files = readdirSync(this.dir).filter((f) => SEG_RE.test(f)).sort();
    const events = [];
    for (const f of files) {
      const text = readFileSync(join(this.dir, f), 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch (e) {
          this.degraded.push({ file: f, line: i + 1, reason: 'json-parse-error' });
        }
      }
    }
    if (this.degraded.length > 0 && !this._degradedWarned) {
      this._degradedWarned = true;
      this.onWarn(`账本有 ${this.degraded.length} 行损坏，已跳过。详情: ${JSON.stringify(this.degraded)}`);
    }
    return this._reduce(events);
  }

  _reduce(events) {
    const messages = [];
    const blocks = new Map();
    const evicted = new Set();
    const mutated = new Map();

    for (const ev of events) {
      if (ev.k === 'msg') messages.push(ev);
      else if (ev.k === 'mut') mutated.set(ev.id, ev);
      else if (ev.k === 'fold') blocks.set(ev.block, ev);
      else if (ev.k === 'evict') for (const id of ev.ids) evicted.add(id);
      else if (ev.k === 'promote') {
        for (const c of ev.children) { const b = blocks.get(c); if (b) b.promotedInto = ev.parent; }
      }
    }
    return { events, messages, blocks, evicted, mutated };
  }

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

  writeBlock(id, obj) {
    const text = JSON.stringify(obj);
    const bytes = Buffer.byteLength(text);
    if (bytes > this.blockMaxBytes) {
      const err = new Error(`块 ${id} 尺寸 ${bytes} 超过上限 ${this.blockMaxBytes}`);
      err.code = 'BLOCK_TOO_LARGE';
      throw err;
    }
    writeFileSync(join(this.dir, `block.${id}.json`), text, 'utf8');
    return bytes;
  }

  hasDegraded() { return this.degraded.length > 0; }
  getDegraded() { return [...this.degraded]; }
}