// test/dsh.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, WanjuanPlugin } from '../src/dsh.mjs';

function freshCtx(dir) {
  const registered = [];
  const connectionHandlers = {};
  const tokenMeterHandlers = {};
  const warns = [];
  const ctx = {
    sessionId: 'test',
    dshHome: dir,
    effect: (fn) => fn(),
    tools: { register: (def) => registered.push(def) },
    connection: { on: (evt, fn) => { connectionHandlers[evt] = fn; } },
    tokenMeter: {
      on: (evt, fn) => { tokenMeterHandlers[evt] = fn; },
      subscribe: () => {},
      observe: () => {},
    },
    logger: { info: () => {}, warn: (m) => warns.push(m) },
  };
  return { ctx, registered, connectionHandlers, tokenMeterHandlers, warns };
}

test('apply：注册 4 个工具，compress 描述含 KEEP/DROP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, registered } = freshCtx(dir);
    apply(ctx, { dir });

    assert.equal(registered.length, 4);
    const names = registered.map((d) => d.name).sort();
    assert.deepEqual(names, ['compress', 'decline_compress', 'decompress', 'search_context']);
    const compress = registered.find((d) => d.name === 'compress');
    assert.ok(compress.description.includes('必须丢弃'));
    assert.ok(compress.description.includes('当前目标 > 决策结论'));
    assert.ok(compress.parameters.properties.range);
    assert.equal(typeof compress.execute, 'function');

    // wj_status / wj_report 不该注册
    assert.ok(!registered.some((d) => d.name === 'wj_status'));
    assert.ok(!registered.some((d) => d.name === 'wj_report'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply：消息事件 → ledger 记账', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, connectionHandlers } = freshCtx(dir);
    apply(ctx, { dir });

    const handler = connectionHandlers['message'];
    assert.equal(typeof handler, 'function');

    handler({ id: 'm1', tok: 100, bytes: 200, cls: 'text', content: 'hello', sessionId: 's1' });
    handler({ id: 'm2', tok: 50, bytes: 100, cls: 'tool', content: 'world', sessionId: 's1' });

    // 通过 ctx._wj 拿到实例，检查账本
    const { wj } = ctx._wj.getOrCreate('s1');
    assert.ok(wj.ledger.messages.has('m1'));
    assert.ok(wj.ledger.messages.has('m2'));
    assert.equal(wj.ledger.messages.get('m1').ev.content, 'hello');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply：用量事件 → observer 更新 k̂ + diagnoser 落 requests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, tokenMeterHandlers } = freshCtx(dir);
    apply(ctx, { dir });

    const handler = tokenMeterHandlers['usage'];
    assert.equal(typeof handler, 'function');

    handler({
      sessionId: 's1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [{ cls: 'text', tok: 1000 }],
      usage: { input_tokens: 1000, cached: 500 },
    });

    const { wj } = ctx._wj.getOrCreate('s1');
    assert.equal(wj.diagnoser.size(), 1);
    const rec = wj.diagnoser.readAll()[0];
    assert.equal(rec.input, 1000);
    assert.equal(rec.cached, 500);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WanjuanPlugin 骨架：class 仍在，_toolCompress 能跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const p = new WanjuanPlugin({ config: { dir } });
    p.wj = (await import('../src/index.mjs')).createWanjuan({ dir });
    p.wj.ledger.recordMsg({ id: 'm1', tok: 10, content: 'x' });
    const r = await p._toolCompress({ range: ['m1', 'm1'], summary: 's' });
    assert.ok(r.includes('✅'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});