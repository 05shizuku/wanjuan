import { readFileSync } from 'node:fs';

const f = 'E:\\DSH NEXT\\.dsh\\profiles\\desktop\\.wanjuan\\sessions\\session-9b8147b5-263d-48f3-85e9-526a369f4b1c\\requests.jsonl';
const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
console.log('总记录数:', lines.length);

const fmt = (i, r) => `[${i}] t=${new Date(r.t).toISOString()} input=${r.input} estBy=${r.estBy} khat=${r.khat}`;

console.log('--- 前 5 条 ---');
lines.slice(0, 5).forEach((l, i) => console.log(fmt(i, JSON.parse(l))));

console.log('--- 后 5 条 ---');
const n = lines.length;
lines.slice(-5).forEach((l, i) => console.log(fmt(n - 5 + i, JSON.parse(l))));

// 中间抽样：每 10% 一条
console.log('--- 中间抽样（每 ~10%）---');
const step = Math.max(1, Math.floor(lines.length / 10));
for (let i = 0; i < lines.length; i += step) {
  console.log(fmt(i, JSON.parse(lines[i])));
}
