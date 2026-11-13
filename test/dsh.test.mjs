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

test('工具注册：6 个工具全带 description/parameters/handler，compress 描述含 KEEP/DROP', async () => {
  const { plugin, cleanup } = fresh();
  try {
    let tools = null;
    const mockCtx = { registerTools: (t) => { tools = t; }, dshHome: '.', sessionId: 'test' };
    await plugin.bind(mockCtx);

    const names = ['compress', 'decline_compress', 'decompress', 'search_context', 'wj_status', 'wj_report'];
    for (const name of names) {
      assert.ok(tools[name], `工具 ${name} 未注册`);
      assert.ok(tools[name].description && tools[name].description.length > 0, `${name} 缺 description`);
      assert.ok(tools[name].parameters && typeof tools[name].parameters === 'object', `${name} 缺 parameters`);
      assert.equal(typeof tools[name].handler, 'function', `${name} 缺 handler`);
    }

    // 关键守护：KEEP/DROP 必须嵌在 compress 描述里
    assert.ok(tools.compress.description.includes('必须丢弃'), 'compress 描述缺 KEEP/DROP 规则');
    assert.ok(tools.compress.description.includes('当前目标 > 决策结论'), 'compress 描述缺优先级');
  } finally { cleanup(); }
});

test('bind：相对路径 dir 锚到 dshHome，并按 sessionId 隔离', async () => {
  const { plugin, cleanup } = fresh();
  try {
    plugin.config.dir = '.wanjuan';
    const mockCtx = { registerTools: () => {}, dshHome: '/fake-home', sessionId: 'sess-abc' };
    await plugin.bind(mockCtx);
    assert.ok(plugin.wj.dir.includes('fake-home'), `dir 未锚到 dshHome: ${plugin.wj.dir}`);
    assert.ok(plugin.wj.dir.includes('sess-abc'), `dir 未含 sessionId: ${plugin.wj.dir}`);
  } finally { cleanup(); }
});

test('WanjuanPlugin：连续三轮正常生长，绝不误报 host-rewrite', async () => {
  const { plugin, cleanup } = fresh();
  try {
    const mockCtx = { registerTools: () => {}, dshHome: '.', sessionId: 'test' };
    await plugin.bind(mockCtx);

    let req = { provider: 'deepseek', model: 'deepseek-chat', messages: [{ id: 'm1', tok: 1000, cls: 'text', bytes: 10 }] };
    await plugin.onRequest(req, () => {});
    assert.equal(plugin.wj.diagnoser.readAll().length, 0);

    req = { provider: 'deepseek', model: 'deepseek-chat', messages: [
      { id: 'm1', tok: 1000, cls: 'text', bytes: 10 },
      { id: 'm2', tok: 1000, cls: 'text', bytes: 10 }
    ]};
    await plugin.onRequest(req, () => {});
    assert.equal(plugin.wj.diagnoser.readAll().length, 0);

    req = { provider: 'deepseek', model: 'deepseek-chat', messages: [
      { id: 'm1', tok: 1000, cls: 'text', bytes: 10 },
      { id: 'm2', tok: 1000, cls: 'text', bytes: 10 },
      { id: 'm3', tok: 1000, cls: 'text', bytes: 10 }
    ]};
    await plugin.onRequest(req, () => {});
    assert.equal(plugin.wj.diagnoser.readAll().length, 0);
  } finally { cleanup(); }
});

test('WanjuanPlugin：原地改写已知消息内容，才触发 host-rewrite', async () => {
  const { plugin, cleanup } = fresh();
  try {
    const mockCtx = { registerTools: () => {}, dshHome: '.', sessionId: 'test' };
    await plugin.bind(mockCtx);

    let req = { provider: 'deepseek', model: 'deepseek-chat', messages: [{ id: 'm1', tok: 1000, bytes: 10, cls: 'text', content: 'old' }] };
    await plugin.onRequest(req, () => {});

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

    plugin._lastFoldEst = 50_000;

    const msgs = Array.from({ length: 10 }).map((_, i) => ({ id: `m${i}`, tok: 10000, cls: 'text', bytes: 10 }));
    const req = { provider: 'deepseek', model: 'deepseek-chat', messages: msgs };

    await plugin.onRequest(req, () => {});
    assert.ok(req.messages.length > 10);

    const realUsage = { input_tokens: 100_000, cached: 0 };
    await plugin.onResponse(req, { usage: realUsage }, () => {});

    const khat = plugin.wj.estimator.getKhat('deepseek', 'deepseek-chat');
    assert.ok(khat > 0.9 && khat < 1.1, `khat 应接近 1.0，实际 ${khat}`);
  } finally { cleanup(); }
});