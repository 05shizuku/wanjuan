#!/usr/bin/env node
// tools/full-audit.mjs — 万卷真实数据完整性审计（只读，不写任何文件）
// 审计维度：
//   1. 每个会话账本：重放完整性 + assertInvariants
//   2. 原文可达不变式：每个块的 raw 归档存在且可解析，行数与块 ids 对账
//   3. 块元数据一致性：ledger 块 ↔ 磁盘 block.*.json 对账
//   4. 孤儿文件：磁盘上有、账本里没有的块文件（信息项）
//   5. 水位精度：各会话最新观测的 (estBy+baseline) vs input 误差
// 用法：node tools/full-audit.mjs [数据目录]
import { createWanjuan } from '../src/index.mjs';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'E:/DSH NEXT/.dsh/profiles/desktop/.wanjuan';
const issues = [];

function auditSession(sessDir, label) {
  const problems = [];
  const infos = []; // 局部：防跨会话累积
  let wj;
  try {
    wj = createWanjuan({ dir: sessDir });
  } catch (e) {
    return { problems: [`账本创建/重放失败: ${e.message}`], infos: [] };
  }
  // 1. 不变式
  try {
    wj.ledger.assertInvariants();
  } catch (e) {
    problems.push(`不变式违反: ${e.message}`);
  }
  // 2. 原文可达 + 块对账
  const blocks = wj.ledger.listBlocks();
  for (const b of blocks) {
    const rawPath = join(sessDir, b.rawRef ?? `block.${b.id}.raw.jsonl`);
    if (!existsSync(rawPath)) {
      problems.push(`块 ${b.id}: raw 归档缺失（${b.rawRef}）——原文可达不变式破坏`);
      continue;
    }
    try {
      const lines = readFileSync(rawPath, 'utf8').split('\n').filter((l) => l.trim());
      if (Array.isArray(b.ids) && b.ids.length > 0 && lines.length !== b.ids.length) {
        problems.push(`块 ${b.id}: raw 行数 ${lines.length} ≠ ids 数 ${b.ids.length}（折叠集合与归档可能不一致）`);
      }
    } catch (e) {
      problems.push(`块 ${b.id}: raw 归档不可解析: ${e.message}`);
    }
  }
  // 3. 磁盘块文件对账（孤儿检测）
  const diskBlocks = readdirSync(sessDir).filter((f) => /^block\..+\.json$/.test(f) && !f.includes('.raw.'));
  const ledgerBlockIds = new Set(blocks.map((b) => b.id));
  for (const f of diskBlocks) {
    const id = f.replace(/^block\./, '').replace(/\.json$/, '');
    if (!ledgerBlockIds.has(id)) infos.push(`${label}: 磁盘块 ${id} 不在账本块列表（unfold 后的正常残留或漂移）`);
  }
  // 4. 活跃/折叠/驱逐计数
  const msgs = [...wj.ledger.messages.values()];
  const c = { active: 0, folded: 0, evicted: 0 };
  for (const m of msgs) c[m.status] = (c[m.status] || 0) + 1;
  return { problems, infos, stats: { active: c.active, folded: c.folded, evicted: c.evicted, blocks: blocks.length } };
}

// ---- 扫描全部会话 + root ----
const sessions = readdirSync(join(dir, 'sessions')).map((d) => ({
  label: d.replace('session-', '').slice(0, 8),
  path: join(dir, 'sessions', d),
}));
if (existsSync(join(dir, 'ledger.0001.jsonl')) || existsSync(join(dir, 'ledger.0000.jsonl'))) {
  sessions.push({ label: 'root(收编)', path: dir });
}

console.log(`== 万卷完整性审计 ==  ${sessions.length} 个账本 ==\n`);
let totalProblems = 0;
for (const s of sessions) {
  const { problems, infos, stats } = auditSession(s.path, s.label);
  totalProblems += problems.length;
  const statLine = stats ? `活跃=${stats.active} 折叠=${stats.folded} 驱逐=${stats.evicted} 块=${stats.blocks}` : '';
  console.log(`[${s.label}] ${statLine || '(无账本)'} ${problems.length === 0 ? '✅' : '✗ ' + problems.length + ' 问题'}`);
  for (const p of problems) { console.log(`   ✗ ${p}`); issues.push(`[${s.label}] ${p}`); }
  for (const i of infos) { console.log(`   ℹ ${i}`); }
}

// ---- 5. 水位精度（最新观测） ----
console.log('\n== 水位精度（各会话最新观测：estBy+baseline vs input） ==');
const reqFiles = [];
for (const d of readdirSync(join(dir, 'sessions'))) {
  const f = join(dir, 'sessions', d, 'requests.jsonl');
  if (existsSync(f)) reqFiles.push({ label: d.replace('session-', '').slice(0, 8), f });
}
for (const { label, f } of reqFiles) {
  try {
    const rs = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((x) => JSON.parse(x)).filter((r) => r.baseline !== undefined);
    if (rs.length === 0) continue;
    const last = rs[rs.length - 1];
    const book = (last.estBy || 0) + (last.baseline || 0);
    const err = last.input > 0 ? (((book - last.input) / last.input) * 100).toFixed(1) : '?';
    const flag = Math.abs(Number(err)) > 10 ? ' ⚠️' : ' ✓';
    console.log(`[${label}] input=${last.input} 账面=${book} 误差 ${err}%${flag} (k̂=${Number(last.khat).toFixed(2)})`);
  } catch (e) {
    console.log(`[${label}] 读取失败: ${e.message}`);
  }
}

console.log(`\n== 审计结论: ${totalProblems === 0 ? '✅ 全部账本健康' : '✗ ' + totalProblems + ' 个问题待处理'} ==`);
