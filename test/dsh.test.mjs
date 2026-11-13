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

test('WanjuanPlugin：能被实例化，bind 时注册工具', async () => {
  const { plugin, cleanup } = fresh();
  try {
    let registeredTools = null;
    const mockCtx = {
      registerTools: (tools) => { registeredTools = tools; },
      dshHome: '.',
      sessionId: 'test',
    };
    await plugin.bind(mockCtx);
    
    assert.ok(plugin.wj);
    assert.ok(registeredTools);
    assert.ok(registeredTools.compress);
    assert.ok(registeredTools.decompress);
    assert.ok(registeredTools.search_context);
    assert.ok(registeredTools.decline_compress);
  } finally { cleanup(); }
});

test('WanjuanPlugin：工具 compress 与 decompress 正常', async () => {
  const { plugin, cleanup } = fresh();
  try {
    const mockCtx = { registerTools: () => {}, dshHome: '.', sessionId: 'test' };
    await plugin.bind(mockCtx);

    // 注入假数据
    plugin.wj.ledger.recordMsg({ id: 'm1', tok: 10, content: 'hello' });
    
    // 压缩
    const res = await plugin._toolCompress({ range: ['m1', 'm1'], summary: 'test-sum' });
    assert.ok(res.includes('压缩成功'));
    assert.ok(res.includes('b1'));

    // 恢复
    const decomp = await plugin._toolDecompress({ blockId: 'b1' });
    assert.ok(decomp.includes('[m1] hello'));
  } finally { cleanup(); }
});

test('WanjuanPlugin：onRequest 能注入 nudge', async () => {
  const { plugin, cleanup } = fresh();
  try {
    const mockCtx = { registerTools: () => {}, dshHome: '.', sessionId: 'test' };
    await plugin.bind(mockCtx);
    
    // 强行塞满 60K 消息，触发 nudge
    for(let i=0; i<10; i++) {
      plugin.wj.ledger.recordMsg({ id: `m${i}`, tok: 10000 });
    }
    
    const req = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: plugin.wj.ledger.getActiveMessages().map(m => ({ cls: 'text', tok: m.tok, id: m.id }))
    };
    
    let nextCalled = false;
    await plugin.onRequest(req, () => { nextCalled = true; });
    
    assert.equal(nextCalled, true);
    // 因为当前 req.messages 只有 100K，未到紧急但超过阈值，应被追加 nudge
    assert.ok(req.messages.length > 10);
    assert.ok(req.messages[req.messages.length - 1].content.includes('万卷 压缩建议'));
  } finally { cleanup(); }
});