#!/usr/bin/env node
// tools/daily-snapshot.mjs — 万卷周度哨兵（v0.8.0 护栏观测；原 v0.6.30 观察协议换代）
// 只读诊断：不写任何文件、不改任何状态。运行环境：PATH 里有系统 node 即可（本脚本无硬编码路径）。
// 数据源：
//   1. <dir>/wanjuan.log.jsonl          —— nudge 链路计数 + 7 天异常扫描（256KB 轮转只留尾 100 行，长窗计数为下界）
//   2. <dir>/requests.jsonl + sessions/*/requests.jsonl —— degraded 频次 / 极端会话 k̂ 尾部
//   3. <dir>/models-calib.json + wanjuan.lock + calib.json（根目录与 sessions/ 两处形态都扫）
// 用法：node tools/daily-snapshot.mjs <数据目录>（目录必填：argv 或环境变量 WANJUAN_DATA_DIR）
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? process.env.WANJUAN_DATA_DIR;
if (!dir) {
  console.error('用法: node tools/daily-snapshot.mjs <数据目录>（或设环境变量 WANJUAN_DATA_DIR）');
  process.exit(1);
}
if (!existsSync(dir)) {
  console.error(`数据目录不存在: ${dir}`);
  process.exit(1);
}
const day = process.env.SNAPSHOT_DAY ?? '(未标注)';
const WEEK_MS = 7 * 24 * 3600 * 1000;

console.log(`== 万卷周度哨兵（Day ${day}）==  数据目录: ${dir}`);

// ---- 1. nudge 链路计数 + 压缩率趋势（log 按时间窗切分：近 7 天 vs 前 7 天） ----
const logPath = join(dir, 'wanjuan.log.jsonl');
const mkCounts = () => ({ 产出: 0, 已注入: 0, 接受: 0, reject: 0, 注入失败: 0, 构建: 0, 陈旧: 0 });
const counts = mkCounts();
const countsPrev = mkCounts();
let logLines = 0;
const scanLine = (line, bucket) => {
  bucket.产出 += line.includes('nudge 已产出') ? 1 : 0;
  bucket.已注入 += line.includes('[nudge] 已注入') ? 1 : 0;
  bucket.接受 += line.includes('[nudge] 接受') ? 1 : 0;
  bucket.reject += line.includes('reject 降频') ? 1 : 0;
  bucket.注入失败 += (line.includes('pre-step 注入失败') || line.includes('pre-step waterfall 注册失败')) ? 1 : 0;
  bucket.构建 += line.includes('[nudge] 构建失败') ? 1 : 0;
  bucket.陈旧 += line.includes('pending 已陈旧') ? 1 : 0;
};
let recentLines = [];
if (existsSync(logPath)) {
  const now = Date.now();
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    logLines += 1;
    let t = 0;
    try { t = JSON.parse(line).t ?? 0; } catch {}
    scanLine(line, counts);
    if (t > now - WEEK_MS) {
      recentLines.push(line);
      scanLine(line, countsPrev); // 近 7 天（趋势的「当前」侧）
    } else if (t > now - 2 * WEEK_MS) {
      scanLine(line, countsPrev); // 前 7 天（趋势的「上一」侧）——下方单独统计
    }
  }
} else {
  console.log('（未找到 wanjuan.log.jsonl）');
}
const rate = (c) => (c.已注入 > 0 ? ((c.接受 / c.已注入) * 100).toFixed(1) + '%' : 'N/A');
console.log(`[log ${logLines} 行，轮转截断注意] nudge 已产出=${counts.产出} 已注入=${counts.已注入} 接受=${counts.接受} reject=${counts.reject} 注入失败=${counts.注入失败} 构建失败=${counts.构建} 陈旧丢弃=${counts.陈旧}`);
console.log(`[指标] 主动压缩率（接受/已注入）= ${rate(counts)}`);

// ---- 1b. 近 7 天窗口趋势（周度哨兵专用：当前 7 天窗 vs 上一 7 天窗，全部来自 log 时间戳） ----
const recent7Counts = mkCounts();
const prev7Counts = mkCounts();
{
  const now = Date.now();
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let t = 0;
    try { t = JSON.parse(line).t ?? 0; } catch {}
    if (t > now - WEEK_MS) scanLine(line, recent7Counts);
    else if (t > now - 2 * WEEK_MS) scanLine(line, prev7Counts);
  }
}
console.log(`[趋势·近7天] 注入=${recent7Counts.已注入} 接受=${recent7Counts.接受} 率=${rate(recent7Counts)} | [前7天] 注入=${prev7Counts.已注入} 接受=${prev7Counts.接受} 率=${rate(prev7Counts)}`);

// ---- 2. degraded 频次 + 极端会话 k̂ 尾部（按记录数取前 3 大会话） ----
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
const perSession = [];
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
  if (records.length > 0) {
    const last = records[records.length - 1];
    perSession.push({ f, n: records.length, last });
  }
}
console.log(`[requests ${reqFiles.length} 文件 / ${recTotal} 条记录] khat-observed-clipped 出现于 ${clipCount} 条记录（degraded 总项 ${degradedTotal}）`);
const top3 = perSession.sort((a, b) => b.n - a.n).slice(0, 3);
console.log('[极端会话 k̂ 尾部（按记录数前 3）]');
for (const s of top3) {
  const l = s.last;
  console.log(`  ${s.f.replace(dir + '/', '').replace(dir, '.')} 共${s.n}条 | 最新: ${new Date(l.t).toISOString().slice(5, 16)} input=${l.input} khat=${Number(l.khat).toFixed(3)}`);
}

// ---- 3. 新机制在岗证据：k̂ calib + 根锁 + 会话 baseline（两种目录形态都扫） ----
console.log('[在岗证据]');
try {
  const c = JSON.parse(readFileSync(join(dir, 'models-calib.json'), 'utf8'));
  const keys = Object.keys(c);
  const sum = keys.reduce((s2, k) => s2 + (c[k].n ?? 0), 0);
  console.log(`  models-calib.json: ✓ ${keys.length} 个模型 / 共 ${sum} 样本（k̂ 持久化在岗）`);
} catch { console.log('  models-calib.json: ✗ 不存在或不可读（k̂ 持久化未生效？）'); }
try {
  const lk = JSON.parse(readFileSync(join(dir, 'wanjuan.lock'), 'utf8'));
  const ageMin = Math.round((Date.now() - (lk.at || 0)) / 60000);
  console.log(`  wanjuan.lock: ✓ 持锁 pid=${lk.pid} boot=${lk.boot}（${ageMin} 分钟前获取）——根锁在岗，第二实例将只读`);
} catch { console.log('  wanjuan.lock: ✗ 无（无实例持锁，或 v0.8.0-phase1 未部署到运行实例）'); }
let calibSessions = 0;
if (existsSync(join(dir, 'calib.json'))) calibSessions += 1; // owner 收编形态：根目录即会话目录
if (existsSync(sessDir)) {
  for (const d of readdirSync(sessDir)) {
    if (existsSync(join(sessDir, d, 'calib.json'))) calibSessions += 1;
  }
}
console.log(`  sessions calib.json: ${calibSessions} 处（含根目录收编形态；baseline 持久化覆盖面）`);

// ---- 4. 7 天异常扫描（周度哨兵五观察点） ----
const scanPats = {
  '①根锁只读误触发': /降级只读|根锁竞争|根锁创建失败|根锁存在但无法读取/,
  '②时龄护栏拦截': /可能是仍在摘要的孤儿|拒绝补偿以防双 end/,
  '③砖化征兆': /自压缩失败|malformed-event|malformed-line/,
  '④错位拒绝（P3 候选）': /is after end/,
  '注入失败': /注入失败|构建失败/,
};
let anomalyTotal = 0;
console.log('[7 天异常扫描]');
for (const [name, re] of Object.entries(scanPats)) {
  const n = recentLines.filter((l) => re.test(l)).length;
  anomalyTotal += n;
  if (n > 0) {
    const sample = (recentLines.find((l) => re.test(l)) ?? '').replace(/^\{[^,]+,/, '').slice(0, 110);
    console.log(`  ${name}: ${n} 次 | 例: ${sample}`);
  } else {
    console.log(`  ${name}: 0`);
  }
}
console.log(`  合计: ${anomalyTotal} 次`);

// ---- 5. 人工判定项（脚本无法自动判定相关性） ----
console.log('[人工] 误触率：比对 [nudge] 接受 行的折叠区间与候选相关性（accept 行见 log 尾部，可 grep「[nudge] 接受」）');
console.log('[紧急信号] ①已注入恒 0 ②单 turn 已产出 >5 ③注入失败含宿主错误 —— 任一出现立即回滚');
