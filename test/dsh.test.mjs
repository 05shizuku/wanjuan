// test/dsh.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WanjuanPlugin } from '../src/dsh.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  const plugin = new WanjuanPlugin({ config: { dir } });
  return { dir, plugin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('WanjuanPlugin：连续三轮正常生长，绝不误报 host-rewrite', async () => {
  const { plugin, cleanup } = fresh();
  try {
    const mockCtx = { registerTools: () => {}, dshHome: '.', sessionId: 'test' };
    await plugin.bind(mockCtx);

    // 第一轮
    let req = { provider: 'deepseek', model: 'deepseek-chat', messages: [{ id: 'm1', tok: 1000, cls: 'text', bytes: 10 }] };
    await plugin.onRequest(req, () => {});
    let records = plugin.wj.diagnoser.readAll();
    assert.equal(records.length, 0); // 不应有记录

    // 第二轮
    req = { provider: 'deepseek', model: 'deepseek-chat', messages: [
      { id: 'm1', tok: 1000, cls: 'text', bytes: 10 },
      { id: 'm2', tok: 1000, cls: 'text', bytes: 10 }
    ]};
    await plugin.onRequest(req, () => {});
    records = plugin.wj.diagnoser.readAll();
    assert.equal(records.length, 0);

    // 第三轮
    req = { provider: 'deepseek', model: 'deepseek-chat', messages: [
      { id: 'm1', tok: 1000, cls: 'text', bytes: 10 },
      { id: 'm2', tok: 1000, cls: 'text', bytes: 10 },
      { id: 'm3', tok: 1000, cls: 'text', bytes: 10 }
    ]};
    await plugin.onRequest(req, () => {});
    records = plugin.wj.diagnoser.readAll();
    assert.equal(records.length, 0);
  } finally { cleanup(); }
});

test('WanjuanPlugin：原地改写已知消息内容，才触发 host-rewrite', async () => {
  const { plugin, cleanup } = fresh();
  try {
    const mockCtx = { registerTools: () => {}, dshHome: '.', sessionId: 'test' };
    await plugin.bind(mockCtx);

    // 第一轮：入账 m1
    let req = { provider: 'deepseek', model: 'deepseek-chat', messages: [{ id: 'm1', tok: 1000, bytes: 10, cls: 'text', content: 'old' }] };
    await plugin.onRequest(req, () => {});

    // 第二轮：原地改写 m1 的 content，同时改变 bytes 以触发 light 指纹失配
    req = { provider: 'deepseek', model: 'deepseek-chat', messages: [{ id: 'm1', tok: 1000, bytes: 11, cls: 'text', content: 'new' }] };
    await plugin.onRequest(req, () => {});
    
    const records = plugin.wj.diagnoser.readAll();
    assert.equal(records.length, 1);
    assert.equal(records[0].missKind, 'host-rewrite');
    assert.ok(req.messages.some(m => m.id.startsWith('wj-anchor-')));

  } finally { cleanup(); }
});

test('WanjuanPlugin：k̂ 不被 nudge 和锚点污染', async () => {
  const { plugin, cleanup } = fresh();
  try {
    const mockCtx = { registerTools: () => {}, dshHome: '.', sessionId: 'test' };
    await plugin.bind(mockCtx);

    // 关键修正：手动拉低 lastFoldEst，确保触发 nudge
    plugin._lastFoldEst = 50_000;

    const msgs = Array.from({ length: 10 }).map((_, i) => ({ id: `m${i}`, tok: 10000, cls: 'text', bytes: 10 }));
    const req = { provider: 'deepseek', model: 'deepseek-chat', messages: msgs };
    
    await plugin.onRequest(req, () => {});
    assert.ok(req.messages.length > 10); // 确认注入了 nudge

    // 模拟宿主返回真实 usage（假设真实 usage 是 100K）
    const realUsage = { input_tokens: 100_000, cached: 0 };
    await plugin.onResponse(req, { usage: realUsage }, () => {});

    // k̂ 应该基于 100K / estRaw(native) 计算，而不是基于 100K / estRaw(injected)
    const khat = plugin.wj.estimator.getKhat('deepseek', 'deepseek-chat');
    assert.ok(khat > 0.9 && khat < 1.1, `khat 应接近 1.0，实际 ${khat}`);

  } finally { cleanup(); }
});