// test/dsh.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, WanjuanPlugin } from '../src/dsh.mjs';

function freshCtx(dir) {
  const registered = [];
  const eventHandlers = {};
  const waterHandlers = {};
  const infos = [];
  const warns = [];
  const ctx = {
    dshHome: dir,
    effect: (fn) => fn(),
    on: (evt, fn) => { eventHandlers[evt] = fn; },
    waterfall: (evt, fn) => { waterHandlers[evt] = fn; },
    tools: { register: (def) => registered.push(def) },
    connection: { on: () => {} },
    tokenMeter: {
      measure: () => ({}),
      estimateMessage: () => 0,
    },
    logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
  };
  return { ctx, registered, eventHandlers, waterHandlers, infos, warns };
}

test('apply：注册 4 个工具，compress 描述含 KEEP/DROP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, registered } = freshCtx(dir);
    apply(ctx, { dir });
    assert.equal(registered.length, 4);
    const compress = registered.find((d) => d.name === 'compress');
    assert.ok(compress.description.includes('必须丢弃'));
    assert.ok(!registered.some((d) => d.name === 'wj_status'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply：session/event 消息入账', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir });
    const handler = eventHandlers['session/event'];
    assert.equal(typeof handler, 'function');

    handler({ type: 'message', sessionId: 's1', message: { role: 'user', content: '你好' } });
    handler({ type: 'message', sessionId: 's1', message: { role: 'assistant', content: 'hello' } });

    const { wj } = ctx._wj.getOrCreate('s1');
    assert.equal(wj.ledger.messages.size, 2);
    const contents = [...wj.ledger.messages.values()].map(m => m.ev.content).sort();
    assert.deepEqual(contents, ['hello', '你好']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply：session/event step 批量入账', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir });
    eventHandlers['session/event']({
      type: 'step', sessionId: 's1',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ]
    });
    const { wj } = ctx._wj.getOrCreate('s1');
    assert.equal(wj.ledger.messages.size, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply：llm/stream waterfall 包流拿 usage（async iterable 尾部）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, waterHandlers } = freshCtx(dir);
    apply(ctx, { dir });
    const handler = waterHandlers['llm/stream'];
    assert.equal(typeof handler, 'function');

    // 模拟 async iterable stream，最后 chunk 带 usage
    const fakeStream = (async function* () {
      yield { delta: 'hi' };
      yield { delta: ' there' };
      yield { delta: '', usage: { input_tokens: 1000, cached: 500 } };
    })();

    const request = {
      sessionId: 's1', provider: 'deepseek', model: 'deepseek-chat',
      messages: [{ cls: 'text', tok: 1000 }],
    };
    const result = await handler(request, async () => fakeStream);

    // 消费流
    const chunks = [];
    for await (const c of result) chunks.push(c);
    assert.equal(chunks.length, 3);

    // 检查 diagnoser
    const { wj } = ctx._wj.getOrCreate('s1');
    assert.equal(wj.diagnoser.size(), 1);
    const rec = wj.diagnoser.readAll()[0];
    assert.equal(rec.input, 1000);
    assert.equal(rec.cached, 500);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply：llm/stream 直接返回带 usage 的对象', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, waterHandlers } = freshCtx(dir);
    apply(ctx, { dir });
    const handler = waterHandlers['llm/stream'];

    const request = { sessionId: 's1', provider: 'deepseek', model: 'deepseek-chat', messages: [] };
    const result = await handler(request, async () => ({ usage: { input_tokens: 200, cached: 100 } }));
    assert.ok(result.usage);

    const { wj } = ctx._wj.getOrCreate('s1');
    assert.equal(wj.diagnoser.size(), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WanjuanPlugin：影子模式 compress 被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const p = new WanjuanPlugin({ config: { dir, shadowMode: true } });
    p.wj = (await import('../src/index.mjs')).createWanjuan({ dir });
    p.wj.ledger.recordMsg({ id: 'm1', tok: 10, content: 'x' });
    const r = await p._toolCompress({ range: ['m1', 'm1'], summary: 's' });
    assert.ok(r.includes('影子模式'));
    // 账本里消息仍是 active（未真的 fold）
    assert.equal(p.wj.ledger.messages.get('m1').status, 'active');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WanjuanPlugin：shadowMode=false 时 compress 真执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const p = new WanjuanPlugin({ config: { dir, shadowMode: false } });
    p.wj = (await import('../src/index.mjs')).createWanjuan({ dir });
    p.wj.ledger.recordMsg({ id: 'm1', tok: 10, content: 'x' });
    const r = await p._toolCompress({ range: ['m1', 'm1'], summary: 's' });
    assert.ok(r.includes('✅'));
    assert.equal(p.wj.ledger.messages.get('m1').status, 'folded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});