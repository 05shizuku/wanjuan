// test/bundle.test.mjs — DESIGN §3.7 打包产物卫生（v0.7.7 P1-10(D) 落地）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

test('打包卫生：src/ 无 .bak 备份文件', () => {
  const files = readdirSync(join(root, 'src'));
  assert.equal(files.filter((f) => f.includes('.bak')).length, 0, 'src 不应包含备份文件（git 历史即备份）');
});

test('打包卫生：src 总行数 ≤5000（DESIGN §3.7 预算）', () => {
  let total = 0;
  for (const f of readdirSync(join(root, 'src')).filter((x) => x.endsWith('.mjs'))) {
    total += readFileSync(join(root, 'src', f), 'utf8').split('\n').length;
  }
  assert.ok(total <= 5000, `src 总行数 ${total} 超预算`);
});
