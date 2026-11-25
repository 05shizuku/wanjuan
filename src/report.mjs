// src/report.mjs
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
  lines.push('== 万卷月报 ==');
  // v0.8.0 根锁：常驻锁状态行（复审建议项；周度哨兵观察点⑤）
  try {
    const lk = JSON.parse(readFileSync(join(dir, 'wanjuan.lock'), 'utf8'));
    const ageMin = Math.round((Date.now() - (lk.at || 0)) / 60000);
    lines.push(`根锁：pid=${lk.pid}（${ageMin} 分钟前获取，第二实例将只读）`);
  } catch {
    lines.push('根锁：无（无实例持锁）');
  }
  lines.push('');
  lines.push(`请求总数：${summary.total}`);
  lines.push(`总命中率：${pct(summary.hitRate)}`);
  lines.push(`⭐ 万卷核心命中率：${pct(summary.coreHitRate)} （已剥离宿主与上游责任）`);
  lines.push('');
  lines.push('异常 miss 责任归属：');
  lines.push(`  宿主违约 (Host)：${tok(summary.byOwner.host)} tokens`);
  lines.push(`  上游盲区 (Upstream)：${tok(summary.byOwner.upstream)} tokens`);
  lines.push(`  万卷自身 (Wanjuan)：${tok(summary.byOwner.wanjuan)} tokens`);
  lines.push(`  未归因 (Unattributed)：${tok(summary.byOwner.unattributed)} tokens`);
  lines.push('');
  lines.push(`活跃消息：${active.length} 条，共 ${tok(activeTok)} tok`);
  lines.push(`块总数：${blocks.length}（tier-1=${tiers[1]} tier-2=${tiers[2]} tier-3=${tiers[3]}）`);
  lines.push(`叶子块：${leaves.length}，srcTok=${tok(leafSrcTok)}，sumTok=${tok(leafSumTok)}`);
  // v0.6.25：说明残留块文件的性质（原文可达兜底，非垃圾）
  if (blocks.length > leaves.length) lines.push(`（另有 ${blocks.length - leaves.length} 个历史块元数据留存磁盘，原文归档可 wj_search/wj_decompress 取回，不计入活跃统计）`);
  // v0.6.21：折叠节省估算（观察期核心数据）——原文本应发送的 token 减去摘要实际占用
  if (leafSrcTok > 0) {
    const saved = Math.max(0, leafSrcTok - leafSumTok);
    const pctTxt = `压缩率 ${((saved / leafSrcTok) * 100).toFixed(1)}%`;
    lines.push(`折叠节省：≈${tok(saved)} tok（${tok(leafSrcTok)} → ${tok(leafSumTok)}，${pctTxt}）`);
  }
  return lines.join('\n');
}

// 补回被误删的函数
export function reportFromDisk({ dir }) {
  const reqPath = join(dir, 'requests.jsonl');
  if (!existsSync(reqPath)) return '== 万卷月报 ==\n\n无请求记录。';
  const text = readFileSync(reqPath, 'utf8');
  const out = [];
  for (const line of text.split('\n')) { if (line.trim()) out.push(JSON.parse(line)); }
  return '== 万卷月报（仅请求侧）==\n请求总数：' + out.length;
}