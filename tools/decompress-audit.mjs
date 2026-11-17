// tools/decompress-audit.mjs
// 只读诊断：统计 wj_decompress 调用轨迹。不写入，不改 src/。
// 用法：node tools/decompress-audit.mjs "E:\DSH NEXT\.dsh\profiles\desktop\.wanjuan"
import { Store } from '../src/store.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('用法：node tools/decompress-audit.mjs <wanjuan数据目录>');
  process.exit(1);
}

function listSessionDirs(base) {
  const out = [];
  const sessionsDir = join(base, 'sessions');
  if (existsSync(sessionsDir)) {
    for (const sid of readdirSync(sessionsDir)) {
      const p = join(sessionsDir, sid);
      if (existsSync(p)) out.push(p);
    }
  }
  if (existsSync(join(base, 'ledger.0001.jsonl'))) out.push(base);
  return out;
}

function analyzeSession(sdir) {
  let events = [];
  try {
    const store = new Store({ dir: sdir });
    events = store.replay().events;
  } catch (e) {
    return { sdir, error: e.message, unfolds: [], bigRequests: [] };
  }

  const unfolds = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].k !== 'unfold') continue;
    let prevAt = null, nextAt = null;
    for (let j = i - 1; j >= 0; j--) if (events[j].k === 'msg') { prevAt = events[j].at; break; }
    for (let j = i + 1; j < events.length; j++) if (events[j].k === 'msg') { nextAt = events[j].at; break; }
    unfolds.push({ block: events[i].block, why: events[i].why, approxAt: nextAt ?? prevAt });
  }

  const reqPath = join(sdir, 'requests.jsonl');
  const bigRequests = [];
  if (existsSync(reqPath)) {
    for (const line of readFileSync(reqPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.input > 50000) bigRequests.push({ t: r.t, input: r.input, estBy: r.estBy, missKind: r.missKind });
      } catch {}
    }
  }

  return { sdir, unfolds, bigRequests };
}

console.log('=== wanjuan decompress 审计 ===');
console.log('根目录：', root, '\n');

const sessions = listSessionDirs(root);
if (sessions.length === 0) {
  console.log('未找到任何会话。');
  process.exit(0);
}
console.log(`发现 ${sessions.length} 个会话目录\n`);

let totalUnfolds = 0, totalBig = 0;
for (const sdir of sessions) {
  const r = analyzeSession(sdir);
  if (r.error) { console.log(`[FAIL] ${sdir}\n   读取失败：${r.error}\n`); continue; }
  if (r.unfolds.length === 0 && r.bigRequests.length === 0) continue;

  console.log(`[SESSION] ${sdir}`);
  console.log(`   unfold 次数（= decompress context 调用次数）：${r.unfolds.length}`);
  for (const u of r.unfolds) {
    console.log(`     - 块 ${u.block}，why=${u.why}，近似时间 ${u.approxAt ? new Date(u.approxAt).toISOString() : '未知'}`);
  }
  console.log(`   input>50K 的请求数：${r.bigRequests.length}`);
  for (const b of r.bigRequests.slice(0, 20)) {
    console.log(`     - ${new Date(b.t).toISOString()} input=${b.input} estBy=${b.estBy} miss=${b.missKind}`);
  }
  if (r.bigRequests.length > 20) console.log(`     ... 还有 ${r.bigRequests.length - 20} 条`);
  console.log();
  totalUnfolds += r.unfolds.length;
  totalBig += r.bigRequests.length;
}
console.log(`\n合计：unfold ${totalUnfolds} 次，大请求 ${totalBig} 条`);
