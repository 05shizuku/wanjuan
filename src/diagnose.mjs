// M1 局限（P2-5）：classifyMiss 只会产 new/unattributed。
//   ttl/seam/restart/abort/provider-miss 归因检测待 M3 的 seam 探针 + 供应商反馈接线。
//   summarize 的 byOwner 在 M1 阶段会大量落在 unattributed（尤其首次真机跑），
//   这是预期的半成品状态——月报的招牌功能要 M3 才算完整。
//   责任隔离机制本身已在：overrideMissKind 可注入 host-rewrite，写月报时能分离。
// src/diagnose.mjs
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED_MISS = new Set(['new', 'compress-repay']);
// 责任方映射
const HOST_MISS = new Set(['rewrite', 'host-compact', 'host-rewrite']);
const UPSTREAM_MISS = new Set(['ttl', 'provider-miss', 'switch-model']);
const WANJUAN_MISS = new Set(['seam', 'abort']);

export function classifyMiss({ usage, est }) {
  if (!usage) return 'unattributed';
  if (typeof usage.input_tokens !== 'number') return 'unattributed';
  if (typeof usage.cached !== 'number') return 'unattributed';
  const missTok = Math.max(0, usage.input_tokens - usage.cached);
  if (missTok === 0) return 'new';
  return 'unattributed';
}

export class Diagnoser {
  constructor({ dir }) {
    this.dir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'requests.jsonl');
  }

  record({ n, t = Date.now(), provider, model, usage, est, khat, calibrating, degraded = [], divergeAt = null, overrideMissKind = null }) {
    const input = usage?.input_tokens ?? 0;
    const cached = usage?.cached ?? 0;
    const missTok = Math.max(0, input - cached);
    const missKind = overrideMissKind || classifyMiss({ usage, est });
    
    const rec = {
      n, t, provider, model,
      input, cached,
      new: missTok,
      estBy: est?.estFinal ?? 0,
      khat: khat ?? 1,
      calibrating: !!calibrating,
      missKind,
      missTok,
      degraded: Array.isArray(degraded) ? [...degraded] : [],
      divergeAt,
    };
    appendFileSync(this.path, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  }

  readAll() {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line));
    }
    return out;
  }

  size() { return this.readAll().length; }

  summarize() {
    const rs = this.readAll();
    if (rs.length === 0) {
      return { total: 0, hitRate: 0, coreHitRate: 0, expectedMissTok: 0, anomalyMissTok: 0, byOwner: { host: 0, upstream: 0, wanjuan: 0, unattributed: 0 } };
    }

    let input = 0, cached = 0;
    let expectedMissTok = 0, anomalyMissTok = 0;
    let hostMissTok = 0, upstreamMissTok = 0;
    const byOwner = { host: 0, upstream: 0, wanjuan: 0, unattributed: 0 };

    for (const r of rs) {
      input += r.input; cached += r.cached;
      const isExpected = EXPECTED_MISS.has(r.missKind);
      
      if (isExpected) {
        expectedMissTok += r.missTok;
      } else {
        anomalyMissTok += r.missTok;
        if (HOST_MISS.has(r.missKind)) { hostMissTok += r.missTok; byOwner.host += r.missTok; }
        else if (UPSTREAM_MISS.has(r.missKind)) { upstreamMissTok += r.missTok; byOwner.upstream += r.missTok; }
        else if (WANJUAN_MISS.has(r.missKind)) { byOwner.wanjuan += r.missTok; }
        else { byOwner.unattributed += r.missTok; }
      }
    }

    const hitRate = input === 0 ? 0 : cached / input;
    const coreInput = input - hostMissTok - upstreamMissTok;
    const coreHitRate = coreInput <= 0 ? hitRate : cached / coreInput;

    return {
      total: rs.length,
      hitRate,
      coreHitRate,
      expectedMissTok,
      anomalyMissTok,
      byOwner,
    };
  }
}
