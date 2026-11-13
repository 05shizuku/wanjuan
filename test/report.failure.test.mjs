// test/report.failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFromDisk } from '../src/report.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-rep-f-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('reportFromDisk：requests.jsonl 不存在 → 提示无记录，不崩', () => {
  const { dir, cleanup } = fresh();
  try {
    const text = reportFromDisk({ dir });
    assert.ok(text.includes('无请求记录'));
  } finally { cleanup(); }
});

test('reportFromDisk：坏行 loud 报错', () => {
  const { dir, cleanup } = fresh();
  try {
    writeFileSync(join(dir, 'requests.jsonl'), 'not-json\n', 'utf8');
    assert.throws(() => reportFromDisk({ dir }));
  } finally { cleanup(); }
});