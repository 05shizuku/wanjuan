// test/dsh.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/dsh.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('apply：注册 4 个工具，compress 含 KEEP/DROP 规则', () => {
  const { dir, cleanup } = fresh();
  try {
    const registered = {};
    const mockCtx = {
      sessionId: 'test',
      dshHome: dir,
      registerTool: (name, tool) => { registered[name] = tool; }
    };
    
    apply(mockCtx, { dir });

    assert.ok(registered.compress);
    assert.ok(registered.compress.description.includes('必须丢弃'));
    assert.ok(registered.compress.description.includes('当前目标 > 决策结论'));
    assert.ok(registered.decline_compress);
    assert.ok(registered.decompress);
    assert.ok(registered.search_context);
    assert.equal(registered.wj_status, undefined);
  } finally { cleanup(); }
});

test('apply：onRequest 折叠渲染与瞬态 Nudge，onResponse 清理', async () => {
  const { dir, cleanup } = fresh();
  try {
    const mockCtx = {
      sessionId: 'test',
      dshHome: dir,
      registerTool: () => {}
    };
    
    const { wj, onRequest, onResponse } = apply(mockCtx, { dir });
    
    // 准备一个折叠块
    wj.ledger.recordMsg({ id: 'm1', tok: 100, cls: 'text', content: 'old' });
    wj.compressor.compress({ range: ['m1', 'm1'], summary: 'my_summary', topics: [] });

    // 模拟请求，带着旧的 m1
    const req = { provider: 'deepseek', model: 'deepseek-chat', messages: [{ id: 'm1', tok: 100, cls: 'text' }] };
    await onRequest(req);

    // 1. 验证折叠渲染生效 (m1 被替换为 block-b1)
    assert.equal(req.messages.length, 1);
    assert.ok(req.messages[0].id.startsWith('block-b1'));
    assert.ok(req.messages[0].content.includes('my_summary'));

    // 2. 验证响应清理
    const res = { usage: { input_tokens: 100, cached: 50 } };
    await onResponse(req, res);
    // nudge 如果被注入过，会被清掉；这里 m1 已经被折叠，messages 长度不变
    assert.equal(req.messages.length, 1);
  } finally { cleanup(); }
});

test('apply：正常生长绝不误报 host-rewrite', async () => {
  const { dir, cleanup } = fresh();
  try {
    const mockCtx = { sessionId: 'test', dshHome: dir, registerTool: () => {} };
    const { wj, onRequest } = apply(mockCtx, { dir });

    let req = { provider: 'deepseek', model: 'deepseek-chat', messages: [{ id: 'm1', tok: 1000, cls: 'text', bytes: 10 }] };
    await onRequest(req);
    assert.equal(wj.diagnoser.readAll().length, 0);

    req = { provider: 'deepseek', model: 'deepseek-chat', messages: [
      { id: 'm1', tok: 1000, cls: 'text', bytes: 10 },
      { id: 'm2', tok: 1000, cls: 'text', bytes: 10 }
    ]};
    await onRequest(req);
    assert.equal(wj.diagnoser.readAll().length, 0);
  } finally { cleanup(); }
});