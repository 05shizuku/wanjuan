// src/fingerprint.mjs
// L1 轻指纹 + 采样对账。防宿主原生压缩导致 stale blocks。
// 每轮轻指纹（条数+首末id+总字节）→ 失配即全量 reconcile。
// 每 sampleEvery 轮 / sawRewrite / hostVersionChanged → 采样对账（中间抽 3 条比 hash）。
// 采样失配或周期到 → 全量 reconcile。
// reconcile 双向：账本有请求无 → evict；请求有账本无 → recordMsg。

import { createHash } from 'node:crypto';

function hashMsg(m) {
  return createHash('sha256')
    .update(JSON.stringify({ id: m.id, tok: m.tok, cls: m.cls }))
    .digest('hex');
}

export class Fingerprinter {
  constructor({ ledger, sampleEvery = 10 }) {
    this.ledger = ledger;
    this.sampleEvery = sampleEvery;
    this.turnsSinceFull = 0;
  }

  lightFingerprint(messages) {
    if (messages.length === 0) return { count: 0, first: null, last: null, bytes: 0 };
    const bytes = messages.reduce((s, m) => s + (m.bytes ?? 0), 0);
    return {
      count: messages.length,
      first: messages[0].id,
      last: messages[messages.length - 1].id,
      bytes,
    };
  }

  checkLight(messages) {
    const active = this.ledger.getActiveMessages();
    const a = this.lightFingerprint(messages);
    const b = this.lightFingerprint(active);
    return a.count === b.count && a.first === b.first && a.last === b.last && a.bytes === b.bytes;
  }

  sampleCheck(messages, rng = Math.random) {
    const active = this.ledger.getActiveMessages();
    const activeMap = new Map(active.map((m) => [m.id, m]));
    const mid = messages.slice(1, -1);
    if (mid.length === 0) return { ok: true, sampled: 0, mismatches: 0 };
    const want = Math.min(3, mid.length);
    const picks = [];
    const used = new Set();
    let attempts = 0;
    while (picks.length < want && attempts < mid.length * 4) {
      attempts++;
      const i = Math.floor(rng() * mid.length);
      if (used.has(i)) continue;
      used.add(i);
      picks.push(mid[i]);
    }
    let mismatches = 0;
    for (const m of picks) {
      const a = activeMap.get(m.id);
      if (!a) { mismatches++; continue; }
      if (hashMsg(a) !== hashMsg(m)) mismatches++;
    }
    return { ok: mismatches === 0, sampled: picks.length, mismatches };
  }

  reconcile(messages, why = 'reconcile') {
    const present = new Set(messages.map((m) => m.id));
    const ledgerActive = this.ledger.getActiveMessages();
    const ledgerMap = new Map(ledgerActive.map((m) => [m.id, m]));

    const toEvict = [];
    for (const m of ledgerActive) {
      if (!present.has(m.id)) toEvict.push(m.id);
    }
    if (toEvict.length > 0) this.ledger.recordEvict({ ids: toEvict, why });

    let added = 0;
    for (const m of messages) {
      if (!ledgerMap.has(m.id)) {
        this.ledger.recordMsg({ id: m.id, tok: m.tok, cls: m.cls, bytes: m.bytes });
        added++;
      }
    }

    this.turnsSinceFull = 0;
    return { evicted: toEvict.length, added };
  }

  check(messages, { hostVersionChanged = false, sawRewrite = false, forceFull = false } = {}) {
    this.turnsSinceFull += 1;

    if (!this.checkLight(messages)) {
      const r = this.reconcile(messages);
      return { action: 'full', reason: 'light-mismatch', ...r };
    }

    const needSample = this.turnsSinceFull >= this.sampleEvery || sawRewrite || hostVersionChanged || forceFull;
    if (needSample) {
      const s = this.sampleCheck(messages);
      if (!s.ok) {
        const r = this.reconcile(messages);
        return { action: 'full', reason: 'sample-mismatch', ...r };
      }
      if (this.turnsSinceFull >= this.sampleEvery || forceFull) {
        const r = this.reconcile(messages);
        return { action: 'full', reason: 'periodic', ...r };
      }
      return { action: 'sample', reason: 'sample-pass', ...s };
    }

    return { action: 'none', reason: 'light-pass' };
  }
}