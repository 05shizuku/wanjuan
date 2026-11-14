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

test('apply：注册 5 个工具（wj_ 前缀防撞宿主），compress 描述含 KEEP/DROP 且带 output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, registered } = freshCtx(dir);
    apply(ctx, { dir });
    assert.equal(registered.length, 5);
    assert.ok(registered.some((d) => d.name === 'wj_reconcile'), '应有 wj_reconcile 补桥工具');
    const compress = registered.find((d) => d.name === 'wj_compress');
    assert.ok(compress.description.includes('必须丢弃'));
    // 宿主契约：工具必须带 output { schema, render }
    assert.ok(compress.output && compress.output.schema && typeof compress.output.render === 'function');
    assert.ok(registered.every((d) => d.output && d.output.schema && typeof d.output.render === 'function'));
    assert.ok(!registered.some((d) => d.name === 'wj_status'));
    // 真机契约：使用 parameters 字段
    assert.ok(compress.parameters && compress.parameters.type === 'object');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply：session/event 消息入账（真实宿主词汇 user/message + assistant/message）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir });
    const handler = eventHandlers['session/event'];
    assert.equal(typeof handler, 'function');

    // 宿主契约：user/message 的 data 就是 UserMessage 本体；assistant/message 的消息在 data.message
    handler({
      type: 'user/message', sessionId: 's1', seq: 1, time: 1000,
      data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }] },
    });
    handler({
      type: 'assistant/message', sessionId: 's1', seq: 2, time: 2000,
      data: {
        turn: 1, step: 1,
        message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'hello' }] },
        stream: [],
      },
    });

    const { wj } = ctx._wj.getOrCreate('s1');
    assert.equal(wj.ledger.messages.size, 2);
    // 按消息 ID 排序（a1 < u1），避免 localeCompare 的 collation 在中文上不稳定
    const entries = [...wj.ledger.messages.values()]
      .map(m => [m.ev.id, m.ev.content])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    assert.deepEqual(entries.map(e => e[1]), [
      [{ type: 'text', text: 'hello' }],
      [{ type: 'text', text: '你好' }],
    ]);
    // 时间锚来自事件的 time 字段
    const byId = new Map([...wj.ledger.messages.values()].map(m => [m.ev.id, m.ev]));
    assert.equal(byId.get('u1').at, 1000);
    assert.equal(byId.get('a1').at, 2000);
    // M3.5：seq 锚入账（供 compactRegion 做真实日志区间映射）
    assert.equal(byId.get('u1').seq, 1);
    assert.equal(byId.get('a1').seq, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply：session/event tool/result 入账', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir });
    eventHandlers['session/event']({
      type: 'tool/result', sessionId: 's1', seq: 3, time: 3000,
      data: {
        turn: 1, step: 2,
        message: { id: 't1', role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'result-a' }] },
      },
    });
    const { wj } = ctx._wj.getOrCreate('s1');
    assert.equal(wj.ledger.messages.size, 1);
    const m = wj.ledger.messages.get('t1');
    assert.equal(m.status, 'active');
    // 账本 schema 不存 role（那是 cls 的职责域），断言内容与时间锚即可
    assert.deepEqual(m.ev.content, [{ type: 'text', text: 'result-a' }]);
    assert.equal(m.ev.at, 3000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('apply：session/event assistant/message 采集 usage（真实驼峰 TokenUsage）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir });
    eventHandlers['session/event']({
      type: 'assistant/message',
      sessionId: 's1',
      seq: 2,
      time: 2000,
      data: {
        turn: 1, step: 1,
        message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'hi' }] },
        stream: [],
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 },
      },
    });
    const { wj } = ctx._wj.getOrCreate('s1');
    assert.equal(wj.diagnoser.size(), 1);
    const rec = wj.diagnoser.readAll()[0];
    assert.ok(rec);
    // 关键回归：驼峰 TokenUsage 必须映射到 input/cached，不允许再落成 0。
    // 语义对齐：inputTokens 是未命中部分，input = inputTokens + cacheReadTokens
    // = 1000 + 500 = 1500（总提示）；cached = 500；missTok = input - cached = 1000。
    assert.equal(rec.input, 1500);
    assert.equal(rec.cached, 500);
    assert.equal(rec.missTok, 1000);
    assert.equal(rec.provider, 'deepseek');
    assert.equal(rec.model, 'deepseek-chat');
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

test('apply：折叠渲染带内容时间（atRange 保留）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const { wj } = ctx._wj.getOrCreate('s1');

    const t1 = Date.parse('2026-11-10T10:00:00Z');
    const t2 = Date.parse('2026-11-12T10:00:00Z');
    wj.ledger.recordMsg({ id: 'm1', at: t1, tok: 100, content: 'a' });
    wj.ledger.recordMsg({ id: 'm2', at: t2, tok: 100, content: 'b' });
    wj.compressor.compress({ range: ['m1', 'm2'], summary: 'test-summary' });

    const block = wj.ledger.getBlock('b1');
    assert.deepEqual(block.atRange, [t1, t2]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compress：ids 精确折叠不受 UUID 字典序影响', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const { wj } = ctx._wj.getOrCreate('s1');
    // 人造 id：字典序与时间序刻意错开（模拟宿主 UUID id）
    wj.ledger.recordMsg({ id: 'uuid-ccc', at: 1000, tok: 10, content: 'oldest' });
    wj.ledger.recordMsg({ id: 'uuid-aaa', at: 2000, tok: 10, content: 'middle' });
    wj.ledger.recordMsg({ id: 'uuid-bbb', at: 3000, tok: 10, content: 'newest' });

    // 时间序最老两条 = uuid-ccc, uuid-aaa。若走 range 端点 (ccc→aaa)，
    // 在字典序列 [aaa,bbb,ccc] 上会 startIndex>endIndex 直接抛错。
    const blockId = wj.compressor.compress({ ids: ['uuid-ccc', 'uuid-aaa'], summary: 's' });
    assert.equal(wj.ledger.messages.get('uuid-ccc').status, 'folded');
    assert.equal(wj.ledger.messages.get('uuid-aaa').status, 'folded');
    assert.equal(wj.ledger.messages.get('uuid-bbb').status, 'active');
    const block = wj.ledger.getBlock(blockId);
    // ids 数组按账本活跃序（id 字典序）存储，集合正确即可
    assert.deepEqual(block.ids, ['uuid-aaa', 'uuid-ccc']);
    assert.deepEqual(block.atRange, [1000, 2000]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M3 水位：超过 95% 自动折叠最老消息并保尾 20 条', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const { wj } = ctx._wj.getOrCreate('s1');

    // 25 条消息：最老 5 条各 30000 tok（合计 150000），其余 20 条各 10 tok
    // estRaw = 150200；未知模型 → window 128000、khat=1 → estFinal = ceil(150200*1.05)=157710
    // 水位 ≈ 123% ≥ 95% → 折叠最老 5 条，保尾 20 条
    for (let i = 1; i <= 25; i++) {
      const id = `u${String(i).padStart(2, '0')}`;
      wj.ledger.recordMsg({ id, at: 1000 + i, tok: i <= 5 ? 30000 : 10, content: `m${i}` });
    }
    assert.equal(wj.ledger.messages.size, 25);

    eventHandlers['session/event']({
      type: 'turn/end', sessionId: 's1', seq: 99, time: 9999,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    assert.equal(wj.ledger.blocks.size, 1);
    const folded = [...wj.ledger.messages.values()].filter(m => m.status === 'folded');
    const active = [...wj.ledger.messages.values()].filter(m => m.status === 'active');
    assert.equal(folded.length, 5);
    assert.equal(active.length, 20);
    assert.deepEqual(folded.map(m => m.ev.id).sort(), ['u01', 'u02', 'u03', 'u04', 'u05']);
    assert.ok(active.every(m => m.ev.id > 'u05'), '保尾的必须是最新 20 条');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M3 水位：低于 80% 不折叠', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const { wj } = ctx._wj.getOrCreate('s1');

    for (let i = 1; i <= 25; i++) {
      wj.ledger.recordMsg({ id: `u${String(i).padStart(2, '0')}`, at: 1000 + i, tok: 10, content: `m${i}` });
    }
    eventHandlers['session/event']({
      type: 'turn/end', sessionId: 's1', seq: 99, time: 9999,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    assert.equal(wj.ledger.blocks.size, 0);
    assert.equal([...wj.ledger.messages.values()].every(m => m.status === 'active'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M3.5：折叠后桥接宿主 compaction（compactRegion 以 seq 区间调用）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    const compactionCalls = [];
    ctx.compaction = {
      compactRegion: async (start, end, agent) => {
        compactionCalls.push([start, end, agent]);
        return { ok: true };
      },
    };
    apply(ctx, { dir, shadowMode: false });

    // 25 条消息：最老 5 条各 30000 tok，其余 20 条各 10 tok；seq 随事件递增
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({
        type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: i <= 5 ? 30000 : 10 },
      });
    }
    eventHandlers['session/event']({
      type: 'turn/end', sessionId: 's1', seq: 99, time: 9999,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    // 账本折叠立即发生：最老 5 条折叠、保尾 20 条
    const { wj } = ctx._wj.getOrCreate('s1');
    assert.equal(wj.ledger.blocks.size, 1);
    const folded = [...wj.ledger.messages.values()].filter(m => m.status === 'folded');
    assert.equal(folded.length, 5);

    // 桥接是 fire-and-forget，等微任务清空后再断言
    await new Promise((r) => setImmediate(r));
    assert.equal(compactionCalls.length, 1);
    // 区间 = 被折 5 条消息的 seq 跨度（u01..u05 → seq 1..5）
    assert.deepEqual(compactionCalls[0].slice(0, 2), [1, 5]);
    // 宿主契约：第三参必须是 agent 包装 { session, options }（裸 Session 会抛 reading 'surface'）
    assert.ok(compactionCalls[0][2]?.session, 'agent 包装应含 session');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M3.5：宿主 compaction 缺失时折叠照常、不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir); // freshCtx 没有 compaction
    apply(ctx, { dir, shadowMode: false });

    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({
        type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: i <= 5 ? 30000 : 10 },
      });
    }
    assert.doesNotThrow(() => eventHandlers['session/event']({
      type: 'turn/end', sessionId: 's1', seq: 99, time: 9999,
      data: { turn: 1, reason: { kind: 'completed' } },
    }));

    const { wj } = ctx._wj.getOrCreate('s1');
    assert.equal(wj.ledger.blocks.size, 1, '账本折叠不依赖宿主服务');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('日志环：pushLog 截断 30 条，wj_report 附最近日志（含自动折叠记录）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers, registered } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => ({ ok: true }) };
    apply(ctx, { dir, shadowMode: false });
    const plugin = ctx._wj;

    // 环形截断：塞 35 条，留最后 30 条
    for (let i = 1; i <= 35; i++) plugin.pushLog('log', `测试日志 ${i}`);
    assert.equal(plugin.logs.length, 30);
    assert.equal(plugin.logs[0].msg, '测试日志 6');
    assert.equal(plugin.logs[29].msg, '测试日志 35');

    // 走一遍真实的折叠流程，让日志环里出现「自动折叠完成」
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({
        type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: i <= 5 ? 30000 : 10 },
      });
    }
    eventHandlers['session/event']({
      type: 'turn/end', sessionId: 's1', seq: 99, time: 9999,
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    await new Promise((r) => setImmediate(r)); // 等 M3.5 桥接的 fire-and-forget 落日志

    const report = registered.find((d) => d.name === 'wj_report');
    const out = await report.handler({});
    const text = out.content[0].text;
    assert.ok(text.includes('最近日志'), '报告应附日志环');
    assert.ok(text.includes('🚨 水位达到'), '应包含水位告警');
    assert.ok(text.includes('✅ 自动折叠完成'), '应包含折叠成功记录');
    assert.ok(text.includes('M3.5：宿主原生压缩完成'), '应包含桥接成功记录');
    assert.ok(!text.includes('测试日志 6'), '更早的日志应已被挤出/不显示');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M3.6：窗口跟随宿主注册表——小窗口触发折叠，缓存命中只解析一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    let resolveCalls = 0;
    ctx.llm = {
      resolveModelInfo: async () => {
        resolveCalls += 1;
        return { context: { contextWindow: 100000 } }; // 故意给小窗口，验证覆盖生效
      },
    };
    apply(ctx, { dir, shadowMode: false });

    // 25 条重消息（estFinal≈157710），窗口被宿主覆盖为 100000 → 水位 157% → 折叠
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({
        type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 6300 },
      });
    }
    // 一条带 usage 的 assistant 消息：写诊断记录（供水位取 provider/model）+ 触发窗口预热
    eventHandlers['session/event']({
      type: 'assistant/message', sessionId: 's1', seq: 26, time: 2000,
      data: {
        message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'nvmine', model: 'glm' }, content: [] },
        usage: { inputTokens: 1000, cacheReadTokens: 500 },
      },
    });
    await new Promise((r) => setImmediate(r)); // 等窗口预热落缓存
    assert.equal(resolveCalls, 1);

    eventHandlers['session/event']({
      type: 'turn/end', sessionId: 's1', seq: 99, time: 9999,
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    const plugin = ctx._wj;
    const wj = plugin.getOrCreate('s1').wj;
    assert.equal(wj.ledger.blocks.size, 1, '小窗口下应触发折叠');
    assert.ok(plugin.logs.some((l) => l.msg.includes('窗口 100000')), '水位日志应标注覆盖后的窗口');

    // 再来一轮：缓存命中，不重复解析
    eventHandlers['session/event']({
      type: 'user/message', sessionId: 's1', seq: 100, time: 10000,
      data: { id: 'u100', role: 'user', content: 'x', tok: 100 },
    });
    eventHandlers['session/event']({
      type: 'turn/end', sessionId: 's1', seq: 101, time: 10001,
      data: { turn: 2, reason: { kind: 'completed' } },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(resolveCalls, 1, '同模型第二次不应重复解析');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M3.6b：解析成功的窗口自学习落盘，下次加载合并进 estimator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { readFileSync: rf } = await import('node:fs');
    // 第一阶段：llm 服务解析窗口 888888 → 应落盘 models.learned.json
    const { ctx, eventHandlers } = freshCtx(dir);
    ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 888888 }, defaultMaxTokens: 4096 }) };
    apply(ctx, { dir, shadowMode: false });
    eventHandlers['session/event']({
      type: 'assistant/message', sessionId: 's1', seq: 1, time: 1000,
      data: {
        message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'nvmine', model: 'glm' }, content: [] },
        usage: { inputTokens: 1000, cacheReadTokens: 0 },
      },
    });
    await new Promise((r) => setImmediate(r));
    const learned = JSON.parse(rf(join(dir, 'models.learned.json'), 'utf8'));
    assert.equal(learned.nvmine.glm.window, 888888);
    assert.equal(learned.nvmine.glm.output, 4096);

    // 第二阶段：全新加载（无 llm 服务）→ 已学习窗口应合并进 estimator
    const { ctx: ctx2, eventHandlers: eh2 } = freshCtx(dir); // freshCtx 没有 llm
    apply(ctx2, { dir, shadowMode: false });
    const wj2 = ctx2._wj.getOrCreate('s2').wj;
    assert.equal(wj2.estimator.models.nvmine.glm.window, 888888, '启动时应合并已学习窗口');
    const est = wj2.estimator.estimate(
      { messages: [{ tok: 10, cls: 'text' }] },
      { provider: 'nvmine', model: 'glm' },
    );
    assert.equal(est.window, 888888, 'estimate 应使用已学习窗口');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M3.5：手动 wj_compress 同样桥接宿主 compaction（seq 区间）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers, registered } = freshCtx(dir);
    const compactionCalls = [];
    ctx.compaction = {
      compactRegion: async (start, end, agent) => {
        compactionCalls.push([start, end, agent]);
        return { ok: true };
      },
    };
    apply(ctx, { dir, shadowMode: false });

    // 8 条消息带 seq；事件流顺手记录宿主 session 引用（a0 即事件对象）
    for (let i = 1; i <= 8; i++) {
      eventHandlers['session/event']({
        type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 10 },
      });
    }

    const compress = registered.find((d) => d.name === 'wj_compress');
    const out = await compress.handler({ range: ['u01', 'u05'], summary: '手动折叠测试摘要' });
    assert.ok(!out.isError, out.content?.[0]?.text);

    const { wj } = ctx._wj.getOrCreate('s1');
    assert.equal(wj.ledger.blocks.size, 1, '手动折叠应产生一个块');

    await new Promise((r) => setImmediate(r)); // 桥接 fire-and-forget
    assert.equal(compactionCalls.length, 1, '手动折叠应触发一次桥接');
    assert.deepEqual(compactionCalls[0].slice(0, 2), [1, 5], '区间 = 被折消息的 seq 跨度');
    assert.ok(compactionCalls[0][2]?.session, 'agent 包装应含 session');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.2 补桥：wj_reconcile 对未打通的历史块补发 compactRegion 并落状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers, registered } = freshCtx(dir);
    const compactionCalls = [];
    ctx.compaction = { compactRegion: async (a, b, c) => { compactionCalls.push([a, b]); return { ok: true }; } };
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 6; i++) {
      eventHandlers['session/event']({
        type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 10 },
      });
    }
    const { wj } = ctx._wj.getOrCreate('s1');
    wj.compressor.compress({ ids: ['u01', 'u02', 'u03'], summary: '块一摘要' });
    wj.compressor.compress({ ids: ['u04', 'u05', 'u06'], summary: '块二摘要' });
    const reconcile = registered.find((d) => d.name === 'wj_reconcile');
    const out1 = await reconcile.handler({});
    assert.ok(!out1.isError, out1.content?.[0]?.text);
    assert.equal(compactionCalls.length, 2, '两个未打通块都应补发');
    assert.deepEqual(compactionCalls[0], [1, 3]);
    assert.deepEqual(compactionCalls[1], [4, 6]);
    const { readFileSync: rf } = await import('node:fs');
    const bridge = JSON.parse(rf(join(dir, 'host-bridge.json'), 'utf8'));
    assert.equal(bridge[Object.keys(bridge)[0]].status, 'ok', '桥接状态应落盘');
    const out2 = await reconcile.handler({});
    assert.equal(compactionCalls.length, 2, '已打通的块第二次应跳过');
    assert.ok(out2.content[0].text.includes('已打通'), '报告应标注已打通');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.2 Nudge：80% 告警点名可折区间（seq 跨度 + 条数）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    // estFinal ≈ (4×25000 + 21×10) × 1.05 ≈ 105331 / 128000 ≈ 82.3%（80~95% 区间）
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({
        type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: i <= 4 ? 25000 : 10 },
      });
    }
    eventHandlers['session/event']({
      type: 'turn/end', sessionId: 's1', seq: 99, time: 9999,
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    const warn = ctx._wj.logs.find((l) => l.msg.includes('建议主动调用 wj_compress'));
    assert.ok(warn, '应产生 Nudge 告警');
    assert.ok(warn.msg.includes('seq 1→'), '应点名起始 seq');
    assert.ok(warn.msg.includes('共 5 条'), '应点名可折条数');
    assert.ok(!wjFolds(ctx, 's1'), '80% 只提醒不折叠');
    function wjFolds(c, sid) { return c._wj.getOrCreate(sid).wj.ledger.blocks.size; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});