#!/usr/bin/env node
// tools/daily-snapshot.mjs — 万卷观察期每日快照（v0.6.30 观察协议）
// 只读诊断：不写任何文件、不改任何状态。数据源：
//   1. <dir>/wanjuan.log.jsonl          —— [nudge] 链路计数（注意 256KB 轮转只留尾 100 行，长窗计数为下界）
//   2. <dir>/requests.jsonl + sessions/*/requests.jsonl —— degraded 频次 + 新会话前 3 条 estBy/input
// 用法：node tools/daily-snapshot.mjs [数据目录]（默认 E:/DSH NEXT/.dsh/profiles/desktop/.wanjuan）
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'E:/DSH NEXT/.dsh/profiles/desktop/.wanjuan';
const day = process.env.SNAPSHOT_DAY ?? '(未标注)';

console.log(`== 万卷观察期快照 Day ${day} ==  数据目录: ${dir}`);

// ---- 1. nudge 链路计数（log 文件） ----
const logPath = join(dir, 'wanjuan.log.jsonl');
const counts = { 产出: 0, 已注入: 0, 接受: 0, reject: 0, 注入失败: 0, 构建: 0, 陈旧: 0 };
let logLines = 0;
if (existsSync(logPath)) {
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    logLines += 1;
    if (line.includes('nudge 已产出')) counts.产出 += 1;
    if (line.includes('[nudge] 已注入')) counts.已注入 += 1;
    if (line.includes('[nudge] 接受')) counts.接受 += 1;
    if (line.includes('reject 降频')) counts.reject += 1;
    if (line.includes('pre-step 注入失败') || line.includes('pre-step waterfall 注册失败')) counts.注入失败 += 1;
    if (line.includes('[nudge] 构建失败')) counts.构建 += 1;
    if (line.includes('pending 已陈旧')) counts.陈旧 += 1;
  }
} else {
  console.log('（未找到 wanjuan.log.jsonl）');
}
const rate = counts.已注入 > 0 ? ((counts.接受 / counts.已注入) * 100).toFixed(1) + '%' : 'N/A';
console.log(`[log ${logLines} 行，轮转截断注意] nudge 已产出=${counts.产出} 已注入=${counts.已注入} 接受=${counts.接受} reject=${counts.reject} 注入失败=${counts.注入失败} 构建失败=${counts.构建} 陈旧丢弃=${counts.陈旧}`);
console.log(`[指标] 主动压缩率（接受/已注入）= ${rate}`);

// ---- 2. degraded 频次 + 新会话前 3 条 estBy/input（requests.jsonl 们） ----
const reqFiles = [];
if (existsSync(join(dir, 'requests.jsonl'))) reqFiles.push(join(dir, 'requests.jsonl'));
const sessDir = join(dir, 'sessions');
if (existsSync(sessDir)) {
  for (const d of readdirSync(sessDir)) {
    const f = join(sessDir, d, 'requests.jsonl');
    if (existsSync(f)) reqFiles.push(f);
  }
}
let clipCount = 0, degradedTotal = 0, recTotal = 0;
const sessionHeads = [];
for (const f of reqFiles) {
  let records = [];
  try {
    records = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { continue; }
  recTotal += records.length;
  for (const r of records) {
    if (Array.isArray(r.degraded)) {
      degradedTotal += r.degraded.length;
      if (r.degraded.includes('khat-observed-clipped')) clipCount += 1;
    }
  }
  const head = records.slice(0, 3).map((r) => `input=${r.input} estBy=${r.estBy} khat=${r.khat}`);
  if (head.length > 0) sessionHeads.push(`${f.replace(dir, '.')} 前3条:\n    ${head.join('\n    ')}`);
}
console.log(`[requests ${reqFiles.length} 文件 / ${recTotal} 条记录] khat-observed-clipped 出现于 ${clipCount} 条记录（degraded 总项 ${degradedTotal}）`);
console.log('[新会话冷启动前 3 条 estBy/input —— 观察结构偏差与 clip 效果]');
for (const h of sessionHeads) console.log('  ' + h);

// ---- 3. 人工判定项（脚本无法自动判定相关性） ----
console.log('[人工] 误触率：比对 [nudge] 接受 行的折叠区间与候选相关性（accept 行见 log 尾部，可 grep「[nudge] 接受」）');
console.log('[紧急信号] ①已注入恒 0 ②单 turn 已产出 >5 ③注入失败含宿主错误 —— 任一出现立即回滚');
