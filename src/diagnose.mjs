// M1 局限（P2-5）：classifyMiss 只会产 new/unattributed。
//   ttl/seam/restart/abort/provider-miss 归因检测待 M3 的 seam 探针 + 供应商反馈接线。
//   summarize 的 byOwner 在 M1 阶段会大量落在 unattributed（尤其首次真机跑），
//   这是预期的半成品状态——月报的招牌功能要 M3 才算完整。
//   责任隔离机制本身已在：overrideMissKind 可注入 host-rewrite，写月报时能分离。
// src/diagnose.mjs
import { appendFileSync, existsSync, readFileSync, mkdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED_MISS = new Set(['new', 'compress-repay']);
// 责任方映射
const HOST_MISS = new Set(['rewrite', 'host-compact', 'host-rewrite', 'host-bootstrap']);
const UPSTREAM_MISS = new Set(['ttl', 'provider-miss', 'switch-model']);
const WANJUAN_MISS = new Set(['seam', 'abort']);

export function classifyMiss({ usage, est, divergeAt = null, baseline = 0 }) {
  if (!usage) return 'unattributed';
  if (typeof usage.input_tokens !== 'number') return 'unattributed';
  if (typeof usage.cached !== 'number') return 'unattributed';
  const missTok = Math.max(0, usage.input_tokens - usage.cached);
  if (missTok === 0) return 'new';
  // v0.7.3：挂载前固定开销单列——账本消息可忽略（estRaw < baseline/10）且全量击穿，
  // miss 几乎全部来自 system/tools/挂载前历史（结构性），单列 host-bootstrap 归 host 桶
  if (usage.cached === 0 && !divergeAt && baseline > 0 && est && est.estRaw < baseline * 0.1) return 'host-bootstrap';
  // v0.6.27：门槛 10K → 1K（真机数据：6 个 ~9K 的新击穿全掉进了 unattributed）——
  // 全量击穿（cached=0）且无分歧点，基本就是上游的锅
  if (usage.cached === 0 && !divergeAt && missTok > 1000) return 'provider-miss';
  return 'unattributed';
}

export class Diagnoser {
  constructor({ dir, readOnly = false }) {
    this.dir = dir;
    this.readOnly = readOnly; // v0.8.0 根锁
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'requests.jsonl');
  }

  record({ n, t = Date.now(), provider, model, usage, est, khat, calibrating, degraded = [], divergeAt = null, overrideMissKind = null, baseline = 0 }) {
    if (this.readOnly) return null; // v0.8.0 根锁：只读实例不写共享遥测（requests.jsonl 为 append 型，双进程交错会撕裂半行）
    const input = usage?.input_tokens ?? 0;
    const cached = usage?.cached ?? 0;
    const missTok = Math.max(0, input - cached);
    const missKind = overrideMissKind || classifyMiss({ usage, est, divergeAt, baseline });
    
    const rec = {
      ...(n !== undefined ? { n } : {}), // v0.7.7 P2-17(D)：dsh 不传 n，落盘 undefined 键无意义
      t, provider, model,
      input, cached,
      new: missTok,
      estBy: est?.estFinal ?? 0,
      khat: khat ?? 1,
      calibrating: !!calibrating,
      missKind,
      missTok,
      degraded: Array.isArray(degraded) ? [...degraded] : [],
      divergeAt,
      baseline,
    };
    // v0.6.5：遥测非 durability 数据——超 5MB 轮转保留尾 2000 行，防止无限增长
    try {
      if (statSync(this.path).size > 5 * 1024 * 1024) {
        const tail = readFileSync(this.path, 'utf8').trim().split('\n').slice(-2000);
        // v0.7.6 P1(C2)：轮转改原子写——裸截断重写的崩溃窗口正是坏行来源
        const rtmp = this.path + '.tmp';
        writeFileSync(rtmp, tail.join('\n') + '\n', 'utf8');
        renameSync(rtmp, this.path);
      }
    } catch {}
    appendFileSync(this.path, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  }

  readAll() {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const out = [];
    let bad = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // v0.7.6 P1(C1/C2)：坏行跳过而非抛错——旧语义下一条坏行永久毒化 provider/model 探测。
      try { out.push(JSON.parse(line)); } catch { bad++; }
    }
    if (bad > 0) console.warn(`[wanjuan/diagnose] requests.jsonl 有 ${bad} 行损坏，已跳过`);
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
