// test/philosophy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Philosophy, PHILOSOPHY_VERSION } from '../src/philosophy.mjs';

test('版本号与文本导出正确', () => {
  const p = new Philosophy();
  assert.equal(p.version, PHILOSOPHY_VERSION);
  assert.ok(p.getKeepDropRules().includes('目标 > 决策 > 工件'));
});

test('buildNudge：包含必要提醒且不含填充比例', () => {
  const p = new Philosophy();
  const text = p.buildNudge({
    candidates: [
      { range: ['m1', 'm5'], msgCount: 5, srcTok: 1000, topics: 'API 错误排查' },
    ],
  });

  assert.ok(text.includes('不是溢出警告'));
  assert.ok(text.includes('可以拒绝')); // 现在这句话在源码里有了
  assert.ok(text.includes('m1 ~ m5'));
  assert.ok(text.includes('约 1000 tokens'));
  
  // 硬规则：绝不包含填充比例（如“还有 XX%”）
  assert.ok(!text.includes('%'));
  assert.ok(!text.includes('填充'));
});

test('buildNudge：空候选列表不崩', () => {
  const p = new Philosophy();
  const text = p.buildNudge({ candidates: [] });
  assert.ok(text.includes('暂无符合条件的区间'));
});