// src/report.mjs
// 中文月报生成。读 requests.jsonl + ledger + blocks，输出给人看的文本。
// 两个健康指标：命中率（含 new 的正常口径）与异常 miss 率（真正的健康度）。
// 用户可见文案，按 §14.5 未来走 locale；M1 先内嵌中文并标 TODO-locale。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function pct(x) { return (x * 100).toFixed(2) + '%'; }
function tok(n) { return n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n); }

export function buildReport({ dir, ledger, diagnoser }) {
  const summary = diagnoser.summarize();
  const active = ledger ? ledger.getActiveMessages() : [];
  const blocks = ledger ? ledger.listBlocks() : [];
  const leaves = ledger ? ledger.getLeafBlocks() : [];
  const activeTok = active.reduce((s, m) => s + m.tok, 0);
  const leafSrcTok = leaves.reduce((s, b) => s + b.srcTok, 0);
  const leafSumTok = leaves.reduce((s, b) => s + b.sumTok, 0);
  const tiers = { 1: 0, 2: 0, 3: 0 };
  for (const b of blocks) tiers[b.tier] = (tiers[b.tier] ?? 0) + 1;

  const lines = [];
  lines.push('== 万卷月报（M1 观测模式）==');
  lines.push('');
  lines.push(`请求总数：${summary.total}`);
  lines.push(`命中率（含 new 的正常口径）：${pct(summary.hitRate)}`);
  lines.push(`异常 miss 率：${pct(summary.anomalyMissRate)}（异常 token ${tok(summary.anomalyMissTok)}）`);
  lines.push(`低置信未归因占比：${pct(summary.unattributedRatio)}（阈值 10%）`);
  lines.push(`校准期请求数：${summary.calibratingCount}`);
  lines.push(`降级率：${pct(summary.degradedRate)}`);
  lines.push('');
  lines.push('异常 miss 分类：');
  const kinds = Object.entries(summary.byKind).sort((a, b) => b[1] - a[1]);
  if (kinds.length === 0) lines.push('  （无）');
  else for (const [k, v] of kinds) lines.push(`  ${k}: ${tok(v)}`);
  lines.push('');
  lines.push(`活跃消息：${active.length} 条，共 ${tok(activeTok)} tok`);
  lines.push(`块总数：${blocks.length}（tier-1=${tiers[1]} tier-2=${tiers[2]} tier-3=${tiers[3]}）`);
  lines.push(`叶子块：${leaves.length}，srcTok=${tok(leafSrcTok)}，sumTok=${tok(leafSumTok)}`);
  return lines.join('\n');
}

export function reportFromDisk({ dir }) {
  const reqPath = join(dir, 'requests.jsonl');
  if (!existsSync(reqPath)) return '== 万卷月报 ==\n\n无请求记录。';
  const diagnoser = { readAll: () => {
    const text = readFileSync(reqPath, 'utf8');
    const out = [];
    for (const line of text.split('\n')) { if (line.trim()) out.push(JSON.parse(line)); }
    return out;
  } };
  // 占位：无 ledger 时只出请求侧统计
  const summary = (function () {
    const rs = diagnoser.readAll();
    const expected = new Set(['new', 'compress-repay']);
    let cached = 0, input = 0, exp = 0, ano = 0, un = 0, cal = 0, deg = 0;
    const byKind = {};
    for (const r of rs) {
      input += r.input; cached += r.cached;
      if (expected.has(r.missKind)) exp += r.missTok;
      else { ano += r.missTok; byKind[r.missKind] = (byKind[r.missKind] ?? 0) + r.missTok; }
      if (r.missKind === 'unattributed') un++;
      if (r.calibrating) cal++;
      if (Array.isArray(r.degraded) && r.degraded.length > 0) deg++;
    }
    const total = exp + ano;
    return { total: rs.length, hitRate: input ? cached / input : 0,
      anomalyMissRate: total ? ano / total : 0, anomalyMissTok: ano,
      unattributedRatio: rs.length ? un / rs.length : 0,
      calibratingCount: cal, degradedRate: rs.length ? deg / rs.length : 0, byKind };
  })();
  const lines = [];
  lines.push('== 万卷月报（仅请求侧，无 ledger）==');
  lines.push(`请求总数：${summary.total}`);
  lines.push(`命中率：${pct(summary.hitRate)}`);
  lines.push(`异常 miss 率：${pct(summary.anomalyMissRate)}`);
  lines.push(`低置信未归因占比：${pct(summary.unattributedRatio)}`);
  return lines.join('\n');
}