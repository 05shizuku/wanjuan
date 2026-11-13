// src/diagnose.mjs
// L0 诊断层（M1 core）。把请求的原始信息落 requests.jsonl，统计命中率与异常 miss。
// M1 阶段 missKind 只做两层粗判（new / unattributed），完整归因树留 M3。
// 命中率口径：cached / (cached + new + missTok)。异常 miss 口径：所有非 new 的 miss。

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED_MISS = new Set(['new', 'compress-repay']);

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

  record({ n, t = Date.now(), provider, model, usage, est, khat, calibrating, degraded = [], divergeAt = null }) {
    const input = usage?.input_tokens ?? 0;
    const cached = usage?.cached ?? 0;
    const missTok = Math.max(0, input - cached);
    const missKind = classifyMiss({ usage, est });
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

  summarize() {
    const rs = this.readAll();
    if (rs.length === 0) {
      return {
        total: 0, hitRate: 0,
        expectedMissTok: 0, anomalyMissTok: 0, anomalyMissRate: 0,
        unattributedRatio: 0, calibratingCount: 0, degradedRate: 0,
        byKind: {},
      };
    }
    let cached = 0, input = 0;
    let expectedMissTok = 0, anomalyMissTok = 0;
    let unattributed = 0, calibrating = 0, degradedReq = 0;
    const byKind = {};
    for (const r of rs) {
      input += r.input;
      cached += r.cached;
      if (EXPECTED_MISS.has(r.missKind)) expectedMissTok += r.missTok;
      else { anomalyMissTok += r.missTok; byKind[r.missKind] = (byKind[r.missKind] ?? 0) + r.missTok; }
      if (r.missKind === 'unattributed') unattributed++;
      if (r.calibrating) calibrating++;
      if (Array.isArray(r.degraded) && r.degraded.length > 0) degradedReq++;
    }
    const missTotal = expectedMissTok + anomalyMissTok;
    return {
      total: rs.length,
      hitRate: input === 0 ? 0 : cached / input,
      expectedMissTok,
      anomalyMissTok,
      anomalyMissRate: missTotal === 0 ? 0 : anomalyMissTok / missTotal,
      unattributedRatio: rs.length === 0 ? 0 : unattributed / rs.length,
      calibratingCount: calibrating,
      degradedRate: rs.length === 0 ? 0 : degradedReq / rs.length,
      byKind,
    };
  }
}