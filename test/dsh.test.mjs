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

test('apply：注册 6 个工具（wj_ 前缀防撞宿主），compress 描述含 KEEP/DROP 且带 output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, registered } = freshCtx(dir);
    apply(ctx, { dir });
    assert.equal(registered.length, 6);
    assert.ok(registered.some((d) => d.name === 'wj_unfold'), '应有 wj_unfold 纯记账修复工具（v0.6.33）');
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
    const wj = p._currentWj(); // default 会话（收编根目录），与 _toolCompress 同源
    wj.ledger.recordMsg({ id: 'm1', tok: 10, content: 'x' });
    const r = await p._toolCompress({ range: ['m1', 'm1'], summary: 's' });
    assert.ok(r.includes('✅'));
    assert.equal(wj.ledger.messages.get('m1').status, 'folded');
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
    // ids 集合正确即可（v0.6.34 起账本活跃序为时间序，ids 数组随之按时间序）
    assert.deepEqual([...block.ids].sort(), ['uuid-aaa', 'uuid-ccc']);
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
    assert.equal(plugin.logs[0].msg, '[root] 测试日志 6');
    assert.equal(plugin.logs[29].msg, '[root] 测试日志 35');

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
        usage: { inputTokens: 100000, cacheReadTokens: 500 }, // 真实 input 与小窗口自洽（v0.6.31 observe>predict：水位以真实 input 为准）
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
    const warn = ctx._wj.logs.find((l) => l.msg.includes('nudge 已产出'));
    assert.ok(warn, '应产出结构化 nudge（M5.2）');
    assert.ok(warn.msg.includes('seq 1→'), '应点名起始 seq');
    assert.ok(warn.msg.includes('共 5 条'), '应点名可折条数');
    assert.ok(ctx._wj._pendingNudge.has('s1'), 'nudge 应入 pending 待注入');
    assert.ok(!wjFolds(ctx, 's1'), '80% 只提醒不折叠');
    function wjFolds(c, sid) { return c._wj.getOrCreate(sid).wj.ledger.blocks.size; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.3：usage 入档带 est（estBy>0、归因不再 unattributed）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    eventHandlers['session/event']({
      type: 'user/message', sessionId: 's1', seq: 1, time: 1000,
      data: { id: 'u1', role: 'user', content: '你好', tok: 100 },
    });
    eventHandlers['session/event']({
      type: 'assistant/message', sessionId: 's1', seq: 2, time: 1001,
      data: {
        message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'nvmine', model: 'glm' }, content: [] },
        usage: { inputTokens: 500, cacheReadTokens: 200 },
      },
    });
    const recs = ctx._wj.getOrCreate('s1').wj.diagnoser.readAll();
    assert.equal(recs.length, 1);
    assert.ok(recs[0].estBy > 0, 'estBy 应为估算值而非 0');
    assert.ok(recs[0].khat > 0, 'khat 应入档');
    // M1 设计如此：classifyMiss 只产 new/unattributed（P2-5，完整归因属后续里程碑）
    assert.ok(['new', 'unattributed'].includes(recs[0].missKind), 'missKind 应为合法词汇');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.3：起点拆散 pair 时自动回退到 user 消息重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers, registered } = freshCtx(dir);
    const calls = [];
    ctx.compaction = {
      compactRegion: async (start, end) => {
        if (start === 3) throw new Error("compactRegion: start seq 3 is not a balanced boundary (would split a step's tool-call/result pair)");
        calls.push([start, end]);
        return { ok: true };
      },
    };
    apply(ctx, { dir, shadowMode: false });
    // 模拟宿主 session：surface 节点 1..5，node 1 是 user 消息
    ctx._wj._lastHostSession = {
      surface: { nodes: [1, 2, 3, 4, 5] },
      eventAt: (seq) => ({ type: seq === 1 ? 'user/message' : 'assistant/message' }),
    };
    ctx._wj.tryHostCompaction(ctx._wj._lastHostSession, 3, 5, 'bx');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [[1, 5]], '应回退到 user 消息起点重试');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('回退 3→1')), '应记录回退日志');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.4：日志落盘 wanjuan.log.jsonl（超 256KB 轮转保留尾 100 行）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const plugin = ctx._wj;
    plugin.pushLog('warn', '落盘测试α');
    const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
    const logPath = join(dir, 'wanjuan.log.jsonl');
    let text = rf(logPath, 'utf8');
    assert.ok(text.includes('落盘测试α'), '日志应落盘');
    // 制造超限文件（300 行 × 1KB ≈ 300KB > 256KB）
    const big = Array.from({ length: 300 }, (_, i) => JSON.stringify({ t: i, level: 'log', msg: 'x'.repeat(1000) })).join('\n');
    wf(logPath, big, 'utf8');
    plugin.pushLog('log', '轮转后新行β');
    text = rf(logPath, 'utf8');
    const lines = text.trim().split('\n');
    assert.ok(lines.length <= 101, `轮转后应 ≤101 行，实际 ${lines.length}`);
    assert.ok(text.includes('轮转后新行β'), '新行应在轮转后的文件里');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.4：turn/end 自动补桥——不与折叠桥接重复、限流、终态跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    let calls = 0;
    ctx.compaction = { compactRegion: async () => { calls += 1; return { ok: true }; } };
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: i <= 5 ? 30000 : 10 } });
    }
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 1, reason: { kind: 'completed' } } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1, '折叠桥接 + 链式补桥只应产生一次宿主调用');
    assert.equal(ctx._wj._bridgeStatus.b1.status, 'ok', '补桥应把块标记为 ok');
    // 限流：立刻再触发 turn/end（补一条消息让水位分支运行）不应再调宿主
    eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: 100, time: 10000,
      data: { id: 'u100', role: 'user', content: 'x', tok: 10 } });
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 101, time: 10001, data: { turn: 2, reason: { kind: 'completed' } } });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1, '10 分钟限流内不应重复补桥');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4：宿主突变吸收——同 id 内容变化走 mut 事件（幂等 + tok 更新 + 重放一致）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const emit = (content) => eventHandlers['session/event']({
      type: 'user/message', sessionId: 's1', seq: 1, time: 1000,
      data: { id: 'u1', role: 'user', content, tok: 10 },
    });
    emit('你好');
    const wj = ctx._wj.getOrCreate('s1').wj;
    assert.equal(wj.ledger.messages.size, 1);
    emit('你好（已被宿主改写）');
    const m = wj.ledger.messages.get('u1');
    assert.ok(JSON.stringify(m.ev.content).includes('改写'), '账本应吸收突变后的内容');
    assert.ok(m.ev.mutatedAt, '应记录 mutatedAt');
    assert.equal(m.ev.tok, 12, '突变后 tok 应按 CJK 口径重估（v0.7.7 P1-6：全角标点升权 1.2 → 10 字×1.2 = 12；旧口径标点 0.25 系系统性低估）');
    // 幂等：相同内容重复投递不再追加 mut
    const before = wj.store.replay().events.length;
    emit('你好（已被宿主改写）');
    assert.equal(wj.store.replay().events.length, before, '相同内容不应追加事件');
    // 重放一致：全新 Ledger 实例重放后内容一致
    const { createWanjuan } = await import('../src/index.mjs');
    const wj2 = createWanjuan({ dir });
    assert.ok(JSON.stringify(wj2.ledger.messages.get('u1').ev.content).includes('改写'), '重放后突变保持');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4：重启恢复——首个会话事件即触发补扫（限流兜底）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    assert.equal(ctx._wj.getOrCreate('s1')._recoveryKicked, undefined, 'apply 时尚未触发');
    eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: 1, time: 1000,
      data: { id: 'u1', role: 'user', content: 'hi', tok: 1 } });
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx._wj.getOrCreate('s1')._recoveryKicked, true, '首个会话事件应踢脚恢复扫描（按会话记录）');
    // 第二个会话独立踢脚：A 的踢脚不遮蔽 B 的遗留锁清理
    eventHandlers['session/event']({ type: 'user/message', sessionId: 's2', seq: 2, time: 1001,
      data: { id: 'u2', role: 'user', content: 'hi2', tok: 1 } });
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx._wj.getOrCreate('s2')._recoveryKicked, true, 'B 的首次事件应独立踢脚');
    assert.equal(ctx._wj.getOrCreate('s1')._recoveryKicked, true, 'A 的踢脚状态不受影响');
    // v0.7.9 P2-10：限流改按会话 Map
    assert.ok([...(ctx._wj._lastAutoReconcileMap?.values() ?? [])].some((v) => v > 0), '自动补桥限流时间戳应更新');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4.1：账本对数压缩——等价极简流 + 旧卷归档 + 重放一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const store = new Store({ dir });
    const ledger = new Ledger({ store });
    for (let i = 1; i <= 8; i++) ledger.recordMsg({ id: `m${i}`, at: i, tok: 10, seq: i });
    ledger.recordFold({ block: 'b1', ids: ['m1', 'm2', 'm3', 'm4'], range: ['m1', 'm4'], srcTok: 40, sumTok: 10, tier: 1, rawRef: 'block.b1.raw.jsonl' });
    ledger.recordEvict({ ids: ['m5'], why: 'reconcile' });
    const before = ledger._lastReplayEventCount;
    const r = ledger.compactNow();
    // v0.7.9 N-1：保留元数据 msg 事件后事件数持平——真缩减在 content 剥离
    assert.ok(r.before >= before && r.after <= r.before, `压缩不膨胀 ${r.before} → ${r.after}`);
    for (const ev of ledger.store.replay().events) {
      if (ev.k === 'msg' && ['m1', 'm2', 'm3', 'm4', 'm5'].includes(ev.id)) {
        assert.equal(ev.content, undefined, `折叠/驱逐消息 ${ev.id} 的 content 应剥离`);
      }
    }
    assert.deepEqual(ledger.getActiveMessages().map((m) => m.id), ['m6', 'm7', 'm8'], '活跃集不变');
    assert.equal(ledger.getBlock('b1').rawRef, 'block.b1.raw.jsonl', '块元数据保留');
    const { existsSync: ex, readdirSync: rd } = await import('node:fs');
    assert.ok(ex(join(dir, 'ledger.0000.jsonl')), '压缩流应写为 0000 卷');
    assert.ok(ex(join(dir, 'archive')), '旧卷应归档');
    const arcDirs = rd(join(dir, 'archive'));
    assert.ok(arcDirs.length >= 1, 'archive 应有按时间戳的归档子目录');
    assert.ok(rd(join(dir, 'archive', arcDirs[0])).some((f) => f.startsWith('ledger.')), '归档子目录内应有旧账本卷');
    const ledger2 = new Ledger({ store: new Store({ dir }) });
    assert.deepEqual(ledger2.getActiveMessages().map((m) => m.id), ['m6', 'm7', 'm8'], '重放后活跃集一致');
    assert.equal(ledger2.getBlock('b1').id, 'b1', '重放后块一致');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4.1：wj_report logTail 深读落盘日志', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, registered } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    ctx._wj.pushLog('warn', '深读审计线索γ');
    const report = registered.find((d) => d.name === 'wj_report');
    const deep = await report.handler({ logTail: 20 });
    assert.ok(deep.content[0].text.includes('落盘日志尾部'), '应附落盘日志段');
    assert.ok(deep.content[0].text.includes('深读审计线索γ'), '应读到落盘的历史行');
    const shallow = await report.handler({});
    assert.ok(!shallow.content[0].text.includes('落盘日志尾部'), '缺省不深读');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4.3：运行期摊销压缩——turn/end 跨阈值即归并，计数复位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false, compactionThreshold: 3 });
    for (let i = 1; i <= 5; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 10 } });
    }
    const wj = ctx._wj.getOrCreate('s1').wj;
    assert.ok(wj.ledger._appendsSinceCompact >= 5, `追加计数应累计（实际 ${wj.ledger._appendsSinceCompact}）`);
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 1, reason: { kind: 'completed' } } });
    assert.equal(wj.ledger._appendsSinceCompact, 0, '跨阈值压缩后计数应复位');
    const { existsSync: ex } = await import('node:fs');
    assert.ok(ex(join(dir, 'ledger.0000.jsonl')), '运行期应写出 0000 检查点卷');
    assert.deepEqual(wj.ledger.getActiveMessages().map((m) => m.id), ['u01', 'u02', 'u03', 'u04', 'u05'], '运行期压缩后活跃集不变');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('账本自压缩')), '应记录自压缩日志');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P0-2：pending 超 3 分钟即僵尸——reconcile 按 failed 重试而非永久跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers, registered } = freshCtx(dir);
    let calls = 0;
    ctx.compaction = { compactRegion: async () => { calls += 1; return { ok: true }; } };
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 3; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 10 } });
    }
    // 伪造崩溃遗留：真实块 b1（先折叠）+ pending 状态且 at 是 10 分钟前
    const wj = ctx._wj.getOrCreate('s1').wj;
    wj.compressor.compress({ ids: ['u01', 'u02'], summary: '块摘要' });
    ctx._wj.getOrCreate('s1').bridgeStatus = { b1: { status: 'pending', at: Date.now() - 10 * 60 * 1000 } };
    ctx._wj._currentSessionId = 's1';
    ctx._wj._bridgeStatus = ctx._wj.getOrCreate('s1').bridgeStatus;
    ctx._wj._lastHostSession = { id: 's1' };
    const reconcile = registered.find((d) => d.name === 'wj_reconcile');
    await reconcile.handler({});
    assert.equal(calls, 1, '僵尸 pending 应被重试（修复前永久跳过）');
    assert.equal(ctx._wj.getOrCreate('s1').bridgeStatus.b1.status, 'ok', '重试成功应转 ok');
    // 新鲜 pending（in-flight）仍受保护：重置为 pending + 当前时间，reconcile 再跑不新增调用
    ctx._wj.getOrCreate('s1').bridgeStatus.b1 = { status: 'pending', at: Date.now() };
    await reconcile.handler({});
    assert.equal(calls, 1, '新鲜 pending 不应被重试');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P1-2：超 24h 的 ok 记录被清理（防 host-bridge.json 膨胀）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers, registered } = freshCtx(dir);
    let calls = 0;
    ctx.compaction = { compactRegion: async () => { calls += 1; return { ok: true }; } };
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 3; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 10 } });
    }
    // 旧 ok（25h 前）+ 新 ok（刚刚）：旧 ok 应被清理并重试，新 ok 保留
    ctx._wj._currentSessionId = 's1';
    ctx._wj.getOrCreate('s1').bridgeStatus = {
      bold: { status: 'ok', at: Date.now() - 25 * 60 * 60 * 1000 },
      bnew: { status: 'ok', at: Date.now() },
    };
    ctx._wj._bridgeStatus = ctx._wj.getOrCreate('s1').bridgeStatus;
    ctx._wj._lastHostSession = { id: 's1' };
    const reconcile = registered.find((d) => d.name === 'wj_reconcile');
    await reconcile.handler({});
    const st = ctx._wj.getOrCreate('s1').bridgeStatus;
    assert.ok(!('bold' in st) || (st.bold.at ?? Date.now()) > Date.now() - 24 * 60 * 60 * 1000, '旧 ok 应被清理');
    assert.equal(st.bnew.status, 'ok', '新 ok 应保留');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4.4：冷启动探针——首个事件即主动清理崩溃遗留锁（无需等桥接撞锁）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    const appends = [];
    // 模拟宿主 session：日志尾部有未匹配 compaction/start（上次崩溃遗留）
    const fakeSession = {
      seq: 5,
      eventAt: (q) => (q === 4 ? { type: 'compaction/start', seq: 4, data: { compactionId: 'c9' } } : { type: 'user/message', seq: q }),
      append: (type, data) => appends.push([type, data]),
      id: 's1',
    };
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._repairWaitMs = 10; // v0.6.32：等待重扫注入短时长（测试加速）
    // 首个事件以 (session, event) 双参投递——踢脚探针应直接对账解锁
    eventHandlers['session/event'](fakeSession, { type: 'user/message', sessionId: 's1', seq: 5, time: 1000,
      data: { id: 'u1', role: 'user', content: 'hi', tok: 1 } });
    for (let i = 0; i < 60 && appends.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(appends.length, 1, '冷启动探针应补写补偿 end（等待重扫后仍无 end）');
    assert.equal(appends[0][0], 'compaction/end');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('崩溃遗留压缩锁')), '应记录解锁日志');
    // 第二次事件不再重复探针（_recoveryKicked 已置位）
    eventHandlers['session/event'](fakeSession, { type: 'user/message', sessionId: 's1', seq: 6, time: 1001,
      data: { id: 'u2', role: 'user', content: 'hi2', tok: 1 } });
    await new Promise((r) => setImmediate(r));
    assert.equal(appends.length, 1, '探针只跑一次');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.20：桥接竞态——完成回调写入发起时会话，不受会话切换污染', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => ({ ok: true }) };
    apply(ctx, { dir, shadowMode: false });
    // 模拟：A 发起桥接后，用户切到 B（_currentSessionId 已变）
    const fakeSessionA = { id: 'session-A', seq: 5, eventAt: () => undefined };
    ctx._wj._currentSessionId = 'session-B'; // 竞态现场：完成时当前会话已是 B
    ctx._wj.tryHostCompaction(fakeSessionA, 1, 5, 'bx', 'session-A'); // 发起时锁定 sid=A
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const statusA = ctx._wj.getOrCreate('session-A').bridgeStatus;
    const statusB = ctx._wj.getOrCreate('session-B').bridgeStatus ?? {};
    assert.equal(statusA.bx.status, 'ok', 'A 的块状态应写进 A 的会话记录');
    assert.ok(!('bx' in statusB), 'B 的会话记录不应被 A 的状态污染');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.24：failed 桥接冷却 30 分钟——冷却内跳过，超时后允许重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers, registered } = freshCtx(dir);
    let calls = 0;
    ctx.compaction = { compactRegion: async () => { calls += 1; return { ok: true }; } };
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 3; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 10 } });
    }
    const wj = ctx._wj.getOrCreate('s1').wj;
    wj.compressor.compress({ ids: ['u01', 'u02'], summary: '块摘要' });
    ctx._wj._currentSessionId = 's1';
    ctx._wj._lastHostSession = { id: 's1' };
    const reconcile = registered.find((d) => d.name === 'wj_reconcile');
    // 冷却内（5 分钟前失败）：跳过，不重试
    ctx._wj.getOrCreate('s1').bridgeStatus = { b1: { status: 'failed', at: Date.now() - 5 * 60 * 1000, error: 'context length exceeded' } };
    await reconcile.handler({});
    assert.equal(calls, 0, '冷却内不应重试（防超窗口死循环）');
    // 冷却结束（31 分钟前失败）：允许重试一次，成功转 ok
    ctx._wj.getOrCreate('s1').bridgeStatus.b1.at = Date.now() - 31 * 60 * 1000;
    await reconcile.handler({});
    assert.equal(calls, 1, '冷却结束应重试');
    assert.equal(ctx._wj.getOrCreate('s1').bridgeStatus.b1.status, 'ok', '重试成功应转 ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4.4：崩溃遗留锁——busy 错误触发补偿 end 解锁并重试成功（signal 透传）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir);
    const sigs = []; const appends = [];
    ctx.compaction = { compactRegion: async (start, end, agent, signal) => {
      sigs.push(signal);
      if (sigs.length === 1) throw new Error('compaction: compaction already in progress; the session compaction lock is already active');
      return { ok: true };
    } };
    apply(ctx, { dir, shadowMode: false });
    // 模拟宿主 session：日志尾部有未匹配的 compaction/start（崩溃遗留锁）
    ctx._wj._lastHostSession = {
      seq: 5,
      eventAt: (q) => (q === 4 ? { type: 'compaction/start', seq: 4, data: { compactionId: 'c1' } } : { type: 'user/message', seq: q }),
      append: (type, data) => appends.push([type, data]),
    };
    ctx._wj._repairWaitMs = 10; // v0.6.32：等待重扫注入短时长
    ctx._wj.tryHostCompaction(ctx._wj._lastHostSession, 1, 5, 'bl');
    for (let i = 0; i < 80 && sigs.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(sigs.length, 2, '解锁后应重试一次');
    assert.ok(sigs.every((x) => x && typeof x.aborted === 'boolean'), 'signal 应透传给 compactRegion 第 4 参');
    assert.equal(appends.length, 1, '应补写恰好一个补偿事件');
    assert.equal(appends[0][0], 'compaction/end', '补偿事件类型应为 compaction/end');
    assert.equal(ctx._wj.getOrCreate('default').bridgeStatus.bl.status, 'ok', '重试成功应标记 ok');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('崩溃遗留压缩锁')), '应记录解锁日志');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P1-A：水位分母减 output reserve——与 estimator.fits 语义对齐', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    // deepseek-chat：window 200000 / output 8192 / khatPrior 0.97 → usable 191808，95% 线 = 182218
    // 30 × 6100 tok → estRaw 183000，estFinal = ceil(183000×0.97×1.05) = 186386：
    // usage 180000 → k̂ ≈ 0.974 → estFinal ≈ 187116：旧口径 93.6%（不折），新口径 97.6%（折叠）
    for (let i = 1; i <= 30; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 6100 } });
    }
    eventHandlers['session/event']({ type: 'assistant/message', sessionId: 's1', seq: 31, time: 2000,
      data: { message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] }, usage: { inputTokens: 185000, cacheReadTokens: 0 } } }); // v0.6.31 observe>predict：真实 185000/(200000-8192)=96.4%≥95 折叠；无 reserve 则 92.5% 不折——保留 reserve 判别力
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 1, reason: { kind: 'completed' } } });
    const wj = ctx._wj.getOrCreate('s1').wj;
    assert.equal(wj.ledger.blocks.size, 1, 'output reserve 计入后应在 95% 线正确折叠');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4.5：启动环境探针——压缩服务缺失时大字报警', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir); // 无 compaction
    apply(ctx, { dir, shadowMode: false });
    const hit = ctx._wj.logs.find((l) => l.msg.includes('未检测到宿主 compaction 服务'));
    assert.ok(hit, '应有大字报警');
    assert.ok(hit.msg.includes('真实上下文接管'), '报警应说明影响范围');
    // 有 compaction 服务时不报警
    const dir2 = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
    try {
      const { ctx: ctx2 } = freshCtx(dir2);
      ctx2.compaction = { compactRegion: async () => ({ ok: true }) };
      apply(ctx2, { dir: dir2, shadowMode: false });
      assert.ok(!ctx2._wj.logs.some((l) => l.msg.includes('未检测到宿主 compaction 服务')), '服务齐备不应报警');
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4.5：bundle patch 纪律——纯 ASCII + 自带 compaction-basic 启用', async () => {
  const { readFileSync: rf } = await import('node:fs');
  const y = rf('dsh.bundle.patch.yml', 'utf8');
  assert.ok(!/[^ -]/.test(y), 'patch 文件必须纯 ASCII（防 PowerShell GBK 乱码）');
  assert.ok(y.includes('id: compaction-basic'), '应自带 compaction-basic 启用');
  assert.ok(y.includes('disabled: false'), '应显式 disabled: false');
  assert.ok(y.includes('id: wanjuan-native'), '应挂载 wanjuan 本体');
});

test('v0.6.19：wj_report 接线 buildReport——月报段真实产出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers, registered } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: 1, time: 1000,
      data: { id: 'u1', role: 'user', content: 'x', tok: 10 } });
    const report = registered.find((d) => d.name === 'wj_report');
    const out = await report.handler({});
    const text = out.content[0].text;
    assert.ok(text.includes('万卷月报'), '应包含 buildReport 产出的月报段');
    assert.ok(text.includes('总命中率'), '应包含命中率段（归因 M5，数值如实）');
    assert.ok(text.includes('责任归属'), '应包含责任归属段');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.19：store.replay 的 degraded 不再跨次累积', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const store = new Store({ dir });
    const { writeFileSync: wf } = await import('node:fs');
    wf(join(dir, 'ledger.0001.jsonl'), '{"k":"msg","id":"a"}\n{bad-line\n', 'utf8');
    store.replay();
    const first = store.degraded.length;
    store.replay();
    store.replay();
    assert.equal(first, 1, '首次应记录 1 条坏行');
    assert.equal(store.degraded.length, 1, `重放多次不应累积（实际 ${store.degraded.length}）`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.1：指纹对账——重建不完整时（seq ≥ 表面最小值）保留观察，不误驱逐', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 3; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 10 } });
    }
    // 模拟宿主表面：只有 seq 1 可见（u02/u03 被宿主侧压缩掉了）
    const fakeSession = {
      seq: 3,
      surface: { nodes: [1] },
      eventAt: (q) => (q === 1 ? { type: 'user/message', data: { id: 'u01' } } : undefined),
      id: 's1',
    };
    eventHandlers['session/event'](fakeSession, { type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 1, reason: { kind: 'completed' } } });
    const hit = ctx._wj.logs.find((l) => l.msg.includes('指纹观察'));
    assert.ok(hit, '应产生指纹观察告警');
    assert.ok(hit.msg.includes('另有 2 条不在表面'), '应指出保留观察的数量（seq ≥ 表面最小值，重建存疑）');
    assert.equal(ctx._wj.getOrCreate('s1').wj.ledger.getActiveMessages().length, 3, '重建存疑时不驱逐，活跃集不变');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.21：月报折叠节省——精确压缩率与历史块全额两种形态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const { buildReport } = await import('../src/report.mjs');
    const ledger = new Ledger({ store: new Store({ dir }) });
    for (let i = 1; i <= 3; i++) ledger.recordMsg({ id: `m${i}`, at: i, tok: 10, seq: i });
    ledger.recordFold({ block: 'b1', ids: ['m1', 'm2'], range: ['m1', 'm2'], srcTok: 100, sumTok: 8, tier: 1, rawRef: 'block.b1.raw.jsonl' });
    const r1 = buildReport({ dir, ledger, diagnoser: { summarize: () => ({ total: 0, hitRate: 0, coreHitRate: 0, byOwner: { host: 0, upstream: 0, wanjuan: 0, unattributed: 0 } }) } });
    assert.ok(r1.includes('折叠节省：≈92 tok（100 → 8，压缩率 92.0%）'), '精确压缩率形态');
    // 历史块 sumTok=0：按全额计并如实标注
    ledger.recordFold({ block: 'b2', ids: ['m3'], range: ['m3', 'm3'], srcTok: 50, sumTok: 0, tier: 1, rawRef: 'block.b2.raw.jsonl' });
    const r2 = buildReport({ dir, ledger, diagnoser: { summarize: () => ({ total: 0, hitRate: 0, coreHitRate: 0, byOwner: { host: 0, upstream: 0, wanjuan: 0, unattributed: 0 } }) } });
    assert.ok(r2.includes('≈142 tok（150 → 8，压缩率 94.7%）'), '聚合节省应如实计算（150 → 8）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.22：estimateTok 数组分支 CJK 口径——中文 ContentBlock 不再低估', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    // 宿主消息的真实形态：ContentBlock 数组。中文 2 字 → 2×1.2=2.4 → 3（修复前 n/2=1）
    eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: 1, time: 1000,
      data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }] } });
    const wj = ctx._wj.getOrCreate('s1').wj;
    assert.equal(wj.ledger.messages.get('u1').ev.tok, 3, '数组分支应按 CJK 口径估算（2 字 → 3）');
    // 工具调用块：name+arguments 按 other 0.25 计
    eventHandlers['session/event']({ type: 'assistant/message', sessionId: 's1', seq: 2, time: 1001,
      data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', name: 'readfile', arguments: '{"p":1}' }] } } });
    const a1 = wj.ledger.messages.get('a1').ev;
    assert.ok(a1.tok >= 1, 'tool-call 块应计入 tok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.25：decompress 按 seq 升序返回——raw 写入顺序乱也不乱时间线', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  try {
    const { createWanjuan } = await import('../src/index.mjs');
    const wj = createWanjuan({ dir });
    for (let i = 1; i <= 3; i++) wj.ledger.recordMsg({ id: `m${i}`, at: i, tok: 10, seq: i });
    wj.compressor.compress({ ids: ['m1', 'm2', 'm3'], summary: '测试块' });
    const block = wj.ledger.listBlocks().find((b) => !b.promotedInto);
    // 模拟 raw 写入顺序 ≠ seq 顺序（倒转行序）
    const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
    const rawPath = join(dir, `block.${block.id}.raw.jsonl`);
    const lines = rf(rawPath, 'utf8').trim().split('\n');
    wf(rawPath, lines.reverse().join('\n') + '\n', 'utf8');
    const msgs = wj.restorer.decompress(block.id, 'context');
    const seqs = msgs.map((m) => m.seq ?? 0);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '返回必须按 seq 升序');
    assert.equal(msgs.length, 3, '原文三条都应返回');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.26：classifyMiss 全量击穿无分歧点 → provider-miss（上游桶）', async () => {
  const { classifyMiss } = await import('../src/diagnose.mjs');
  // 全量击穿（cached=0）+ 无分歧点 + missTok>10K → provider-miss
  assert.equal(classifyMiss({ usage: { input_tokens: 50000, cached: 0 } }), 'provider-miss');
  // v0.6.27：门槛 1K——5K 全量击穿应判 provider-miss（此前 9K 击穿漏报的教训）
  assert.equal(classifyMiss({ usage: { input_tokens: 5000, cached: 0 } }), 'provider-miss');
  // 1K 以下小请求 → 不误判
  assert.equal(classifyMiss({ usage: { input_tokens: 800, cached: 0 } }), 'unattributed');
  // 有分歧点（正常追加导致的 miss）→ 不误判
  assert.equal(classifyMiss({ usage: { input_tokens: 50000, cached: 0 }, divergeAt: 123 }), 'unattributed');
  // 部分 cached（缓存仍在，只是没全中）→ 不误判
  assert.equal(classifyMiss({ usage: { input_tokens: 50000, cached: 20000 } }), 'unattributed');
  // 全命中 → new
  assert.equal(classifyMiss({ usage: { input_tokens: 5000, cached: 5000 } }), 'new');
});

test('v0.6.28：tokenizer 统一口径——三形态单一来源（M5.4）', async () => {
  const { estimateTok } = await import('../src/tokenizer.mjs');
  assert.equal(estimateTok('你好'), 3, '字符串 CJK 1.2 口径');
  assert.equal(estimateTok([{ type: 'text', text: '你好' }]), 3, '数组与字符串同口径');
  assert.equal(estimateTok([{ type: 'tool-call', name: 'ab', arguments: 'cd' }]), 1, 'tool-call 计入');
  assert.equal(estimateTok('abc'), 1, '纯 ASCII 0.25/字符');
  assert.equal(estimateTok(null), 1, '空值最小非零');
});

test('M5.2：turn/end 80% 产出 nudge（结构正确 + 存入 pending）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    // 25 条消息，4 条大消息构造 80~95% 水位（复用 v0.6.2 Nudge case 的构造）
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({
        type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: i <= 4 ? 25000 : 10 },
      });
    }
    eventHandlers['session/event']({
      type: 'turn/end', sessionId: 's1', seq: 99, time: 9999,
      data: { turn: 5, reason: { kind: 'completed' } },
    });
    const pending = ctx._wj._pendingNudge.get('s1');
    assert.ok(pending, '80% 水位应产出 pending nudge');
    assert.equal(pending.turn, 5, 'pending 应记宿主 turn 号');
    assert.ok(pending.message.tok > 0, 'nudge 消息应带 tok');
    assert.ok(pending.message.content.includes('压缩建议'), 'nudge 内容应为 philosophy 文本');
    assert.ok(Array.isArray(pending.candidateIds) && pending.candidateIds.length > 0, '候选区间应记录');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M5.2：pre-step 注入 nudge（形状 + source.kind + 一次性消费）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    // 直接塞一个 pending（不跑完整 turn/end 流程）
    ctx._wj._pendingNudge.set('s1', {
      message: { id: 'wj-nudge-5', cls: 'sys', tok: 42, content: '【测试 nudge】' },
      turn: 5,
      candidateIds: ['u01', 'u02'],
    });
    // 手动触发 waterfall（payload 用宿主真实形状：agent.id）
    const decision = { messages: [{ id: 'existing' }] };
    const result = await ctx._wj._preStepHandler({ agent: { id: 's1' }, turn: 5 }, async () => decision);
    assert.equal(result.messages.length, 2, '应注入 1 条消息');
    const injected = result.messages[1];
    assert.equal(injected.role, 'user');
    assert.equal(injected.source.kind, 'wanjuan-nudge');
    assert.equal(injected.source.form, 'nudge');
    assert.equal(injected.content[0].text, '【测试 nudge】');
    assert.equal(ctx._wj._pendingNudge.get('s1').injectedAt, 5, '注入后 pending 保留并标记 injectedAt（消费归 accept）');
    // 二次触发：不应再注入
    const result2 = await ctx._wj._preStepHandler({ agent: { id: 's1' }, turn: 6 }, async () => ({ messages: [] }));
    assert.equal(result2.messages.length, 0, '无 pending 不应注入');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M5.2：accept 链路——注入后 wj_compress 命中候选 → recordAccept + 清 pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => ({ ok: true }) };
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: i <= 4 ? 25000 : 10 } });
    }
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 99, time: 9999,
      data: { turn: 5, reason: { kind: 'completed' } } });
    const pending = ctx._wj._pendingNudge.get('s1');
    assert.ok(pending, '前置：pending 已产出');
    // v0.7.7 P0-1(D)：按候选逐个预置 reject（并集 key 时代已死——accept/reject 都按单候选记账）
    for (const c of pending.candidates) ctx._wj.getOrCreate('s1').wj.nudge.recordReject(c.range, 4);
    // 注入
    await ctx._wj._preStepHandler({ agent: { id: 's1' }, turn: 5 }, async () => ({ messages: [{ id: 'm' }] }));
    assert.equal(ctx._wj._pendingNudge.get('s1').injectedAt, 5, '注入后保留 pending');
    // 模型照做：wj_compress 折叠候选端点 u01
    const out = await ctx._wj._toolCompress({ ids: ['u01'], summary: '接受 nudge 的折叠' });
    assert.ok(out.includes('✅'), '折叠应成功');
    assert.equal(ctx._wj._pendingNudge.has('s1'), false, 'accept 应清 pending（修订后 accept 不再是死代码）');
    assert.equal(ctx._wj.getOrCreate('s1').wj.nudge.rangeStates.size, 0, 'recordAccept 应清 rangeStates');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('[nudge] 接受')), '应记 accept 日志');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.30：k̂ 冷启动保护——observed 钳到 [0.5, 5.0] 并记 degraded', async () => {
  const { Estimator } = await import('../src/estimate.mjs');
  const est = new Estimator({ models: { t: { m: { window: 1000000 } } } });
  // 冷启动极端：input 541565 / estRaw 1814 → rawObserved ≈ 298 → 钳到 5.0
  est.observeUsage({ provider: 't', model: 'm', usageInputTokens: 541565, estRaw: 1814 });
  let rec = est.calib.get('["t","m"]');
  assert.equal(rec.khatObserved, 5.0, `极端 observed 应钳到 5.0（实际 ${rec.khatObserved}）`);
  assert.equal(rec.n, 1);
  assert.ok(est.getDegraded().includes('khat-observed-clipped'), '应记 clipped degrade');
  // 低侧：estRaw 远大于 input → rawObserved 0.1 → 钳到 0.5
  est.clearDegraded();
  est.observeUsage({ provider: 't', model: 'm', usageInputTokens: 100, estRaw: 1000 });
  rec = est.calib.get('["t","m"]');
  assert.ok(rec.khatObserved >= 0.5 && rec.khatObserved <= 5.0, `k̂ 应始终在钳制区间内（实际 ${rec.khatObserved}）`);
  assert.ok(est.getDegraded().includes('khat-observed-clipped'), '低侧超限同样记 degrade');
  // 正常值（1.05）不钳、不记 degrade
  est.clearDegraded();
  est.observeUsage({ provider: 't', model: 'm', usageInputTokens: 1050, estRaw: 1000 });
  rec = est.calib.get('["t","m"]');
  assert.ok(rec.khatObserved > 0.5 && rec.khatObserved < 5.0);
  assert.equal(est.getDegraded().includes('khat-observed-clipped'), false, '正常值不应记 clipped');
  // 连续钳制输入：EMA 稳定在 5.0 上限，不再飞百倍
  for (let i = 0; i < 5; i++) est.observeUsage({ provider: 't', model: 'm', usageInputTokens: 500000, estRaw: 1800 });
  rec = est.calib.get('["t","m"]');
  assert.ok(rec.khatObserved <= 5.0, `连续极端输入下 k̂ 不得突破 5.0（实际 ${rec.khatObserved}）`);
});

test('v0.6.31：水位止血——clipped-k̂ 虚高被真实 input 纠偏，不再误触发强制折叠', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => ({ ok: true }) };
    // 预置学习窗口 1M（复现 30e39a74 的 Day-1 形态：1M 窗口 + 挂载前历史不在账本）
    const { writeFileSync: wf } = await import('node:fs');
    wf(join(dir, 'models.learned.json'), JSON.stringify({ t: { m: { window: 1000000, output: 8192 } } }), 'utf8');
    apply(ctx, { dir, shadowMode: false });
    // ① 小账本 + 大 input → observed 巨大 → k̂ 钳到 5.0（Day-1 同款）
    eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: 1, time: 1001,
      data: { id: 'u01', role: 'user', content: 'x', tok: 20 } });
    eventHandlers['session/event']({ type: 'assistant/message', sessionId: 's1', seq: 2, time: 1002,
      data: { message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 't', model: 'm' }, content: [] }, usage: { inputTokens: 616400 } } });
    const calib = ctx._wj.getOrCreate('s1').wj.estimator.calib.get('["t","m"]');
    assert.equal(calib.khatObserved, 1.0, 'v0.7 baseline 吸收结构缺口后 k̂ 回归 1.0（不再钳 5.0）');
    assert.equal(ctx._wj._sessionBaseline.get('s1').baseline, 616379, 'baseline = input − estRaw（含 a1 的 1 tok，结构性开销 616379）');
    // ② 账本涨到 ~200K（真实 input 仍 616K ≈ 62%，无新观测）
    for (let i = 2; i <= 43; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i + 1, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 4750 } });
    }
    // ③ turn/end：v0.7 水位 = (estFinal + baseline)/usable ≈ (210K + 616K)/992K ≈ 83%——
    // 强折线（95%）不触发；nudge 线（80%）触发但二次确认（真实 62% < 80%）拦截
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 9, reason: { kind: 'completed' } } });
    assert.equal(ctx._wj.getOrCreate('s1').wj.ledger.blocks.size, 0, '真实 62% 不应被假水位骗折（Day-1 回归）');
    assert.equal(ctx._wj._pendingNudge.size, 0, '真实 62% < 80%：nudge 应被二次确认拦截');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.32 刀一：真 end 等待期内落盘 → 跳过补偿（防一个 start 两条 end）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._repairWaitMs = 30; // 快速重扫
    // 可控 fake session：等待期内「真 end 落盘」（eventAt 动态翻面）
    const sess = {
      endLanded: false,
      appended: [],
      get seq() { return this.endLanded ? 7 : 6; }, // 真 end 落盘会推进 seq（忠实模拟宿主追加）
      append(type, data) { this.appended.push([type, data]); },
      eventAt(q) {
        if (q === 5) return { type: 'compaction/start', seq: 5, data: { compactionId: 'c9' } };
        if (q === 6 && this.endLanded) return { type: 'compaction/end', seq: 6, data: {} };
        return undefined;
      },
    };
    setTimeout(() => { sess.endLanded = true; }, 10); // 真 end 在等待期内（10ms）落盘，重扫（30ms）时可见
    const repaired = await ctx._wj.busyLockRepair(sess);
    assert.equal(repaired, false, '真 end 已落盘，不应补偿');
    assert.equal(sess.appended.length, 0, '不得双写补偿 end');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('重扫后发现 end 已自行落盘')), '应记录跳过原因');
    // 对照：end 未落盘 → 正常补偿
    const sess2 = { seq: 6, appended: [], endLanded: false,
      append(type, data) { this.appended.push([type, data]); },
      eventAt(q) { return q === 5 ? { type: 'compaction/start', seq: 5, data: {} } : undefined; } };
    const repaired2 = await ctx._wj.busyLockRepair(sess2);
    assert.equal(repaired2, true, '仍无 end 应正常补偿');
    assert.equal(sess2.appended.length, 1, '补偿 end 已写');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.32 刀二：no open turn 判 pending 挂起重试，不再终态停摆', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => { throw new Error('no open turn'); } };
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 3; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 10 } });
    }
    const wj = ctx._wj.getOrCreate('s1').wj;
    wj.compressor.compress({ ids: ['u01', 'u02'], summary: '块摘要' });
    ctx._wj._currentSessionId = 's1';
    ctx._wj._lastHostSession = { id: 's1' };
    await ctx._wj.tryHostCompaction(ctx._wj._lastHostSession, 1, 3, 'b1', 's1');
    const st = ctx._wj.getOrCreate('s1').bridgeStatus.b1;
    assert.equal(st.status, 'pending', '前置拒绝应挂起（deferred）而非终态 failed');
    assert.ok((st.error ?? '').includes('deferred'), '应注明挂起原因');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.33：wj_unfold 纯记账修复——折叠消息恢复活跃，原文不投递', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers, registered } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 3; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `细节${i}`, tok: 10 } });
    }
    const wj = ctx._wj.getOrCreate('s1').wj;
    wj.compressor.compress({ ids: ['u01', 'u02'], summary: '误折叠的块' });
    assert.equal(wj.ledger.getActiveMessages().length, 1, '前置：折叠后只剩 1 条活跃');
    const unfold = registered.find((d) => d.name === 'wj_unfold');
    const out = await unfold.handler({ blockId: 'b1' });
    const text = out.content[0].text; // wrappedHandler 返回结构化对象
    assert.ok(text.includes('已恢复 2 条'), '应报告恢复条数');
    assert.equal(wj.ledger.getActiveMessages().length, 3, '折叠消息应回到活跃');
    assert.ok(!text.includes('细节'), '原文不得投递进工具结果（纯记账）');
    // 幂等：再次调用应提示无折叠消息
    const out2 = await unfold.handler({ blockId: 'b1' });
    assert.ok(out2.content[0].text.includes('没有折叠中的消息'), '重复恢复应幂等提示');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.34：UUID 乱序——getActiveMessages 时间序，nudge 区间可正确压缩（外部报告回归）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers, registered } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    // 模拟宿主 UUID：时间序 1..6，但 id 是随机十六进制（字典序 ≠ 时间序）
    const uuids = ['f13c1c60', '4bd8d65c', 'efcbd24c', '721a955a', '52db0961', 'a9d3e7f2'];
    for (let i = 1; i <= 6; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: uuids[i - 1], role: 'user', content: `消息${i}`, tok: 10 } });
    }
    const wj = ctx._wj.getOrCreate('s1').wj;
    const order = wj.ledger.getActiveMessages().map((m) => m.id);
    assert.deepEqual(order, uuids, '活跃集必须按时间序（at）返回，而非 id 字典序');
    // nudge 语义的候选：时间序里第 2~4 条（端点 4bd8d65c ~ 721a955a）
    const compress = registered.find((d) => d.name === 'wj_compress');
    const out = await compress.handler({ range: ['4bd8d65c', '721a955a'], summary: '时间序区间折叠' });
    const text = out.content?.[0]?.text ?? String(out);
    assert.ok(text.includes('✅'), `时间序区间应折叠成功（实际：${text.slice(0, 80)}）`);
    const folded = [...wj.ledger.messages.entries()].filter(([id, m]) => m.status === 'folded').map(([id]) => id); // id 是 Map 的键
    assert.deepEqual(folded.sort(), ['4bd8d65c', '721a955a', 'efcbd24c'].sort(), '折叠的应是时间序区间的三条');
    assert.equal(wj.ledger.getActiveMessages().length, 3, '剩余 3 条活跃');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.35：Day-3 回归——真实 26% 时不得产出 nudge（观测>预测 + 二次确认）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    // 预置学习窗口 1M（复现 bb00f425 形态）
    const { writeFileSync: wf } = await import('node:fs');
    wf(join(dir, 'models.learned.json'), JSON.stringify({ t: { m: { window: 1000000, output: 8192 } } }), 'utf8');
    apply(ctx, { dir, shadowMode: false });
    // ① 小账本 + 大 input → k̂ 钳到 5
    eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: 1, time: 1001,
      data: { id: 'u01', role: 'user', content: 'x', tok: 20 } });
    eventHandlers['session/event']({ type: 'assistant/message', sessionId: 's1', seq: 2, time: 1002,
      data: { message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 't', model: 'm' }, content: [] }, usage: { inputTokens: 616400 } } });
    // ② 账本涨到 ~180K（真实 input 仍 26 万 ≈ 26%）
    for (let i = 2; i <= 39; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i + 1, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 4750 } });
    }
    // ③ turn/end：账面 ~81%（k̂4.3 × estRaw 180K），真实 26% → 观测>预测 + 二次确认双重拦截
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 9, reason: { kind: 'completed' } } });
    assert.equal(ctx._wj._pendingNudge.size, 0, '真实 26% 不得产出 nudge（Day-3 bb00f425 回归）');
    assert.ok(!ctx._wj.logs.some((l) => l.msg.includes('nudge 已产出')), '不得有产出日志');
    // v0.7 baseline 后：estFinal+baseline 与真实差距收敛（<20% 阈值），背离日志不再触发属正确行为
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.35：无新鲜观测诊断日志——nudge 按账面产出的路径可见', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: i <= 4 ? 25000 : 10 } });
    }
    // 清空真实观测（模拟无观测 turn）→ 按账面产出 + 诊断日志可见
    ctx._wj._lastRealInput.clear();
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 1, reason: { kind: 'completed' } } });
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('无新鲜真实观测')), '应记诊断日志（定位失效路径）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.1 M5.1：指纹精确驱逐——seq < 表面最小值的零误驱逐对账', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 3; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 10 } });
    }
    // 一条无 seq 的账本消息（无法定位，必须保留）
    ctx._wj.getOrCreate('s1').wj.ledger.recordMsg({ id: 'x1', tok: 5, content: '无seq' });
    // 宿主表面：只有 seq 3 可见（u01/u02 被宿主压缩，u03 仍在表面）
    const fakeSession = {
      seq: 3,
      surface: { nodes: [3] },
      eventAt: (q) => (q === 3 ? { type: 'user/message', data: { id: 'u03' } } : undefined),
      id: 's1',
    };
    eventHandlers['session/event'](fakeSession, { type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 1, reason: { kind: 'completed' } } });
    const wj = ctx._wj.getOrCreate('s1').wj;
    assert.deepEqual(wj.ledger.getActiveMessages().map((m) => m.id).sort(), ['u03', 'x1'], 'seq < 3 的 u01/u02 被驱逐，u03 与无 seq 的 x1 保留');
    assert.equal(wj.ledger.messages.get('u01').status, 'evicted', 'u01 应标记 evicted');
    assert.equal(wj.ledger.messages.get('u02').status, 'evicted', 'u02 应标记 evicted');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('指纹对账（M5.1）') && l.msg.includes('2 条已被宿主压缩')), '应记录驱逐对账');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.2：启动回溯入账——从宿主表面重建挂载前历史（幂等）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    // 宿主会话：表面有 3 条挂载前消息（UUID id，时间序）
    const fakeSession = {
      seq: 3,
      surface: { nodes: [1, 2, 3] },
      eventAt: (q) => ({
        1: { type: 'user/message', time: 100, data: { id: 'pre-aaa', role: 'user', content: '挂载前1' } },
        2: { type: 'assistant/message', time: 200, data: { message: { id: 'pre-bbb', role: 'assistant', content: [{ type: 'text', text: '挂载前2' }] } } },
        3: { type: 'user/message', time: 300, data: { id: 'pre-ccc', role: 'user', content: '挂载前3' } },
      })[q],
      append: () => {},
      id: 's1',
    };
    eventHandlers['session/event'](fakeSession, { type: 'user/message', sessionId: 's1', seq: 4, time: 400,
      data: { id: 'u01', role: 'user', content: '挂载后', tok: 10 } });
    for (let i = 0; i < 40 && !ctx._wj.logs.some((l) => l.msg.includes('启动回溯')); i++) await new Promise((r) => setTimeout(r, 10));
    const wj = ctx._wj.getOrCreate('s1').wj;
    assert.deepEqual(wj.ledger.getActiveMessages().map((m) => m.id).sort(), ['pre-aaa', 'pre-bbb', 'pre-ccc', 'u01'].sort(), '挂载前历史应被回填');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('回填 3 条')), '应记录回填数量');
    // 幂等：kick 只跑一次 + recordMsg 去重——新事件不重复回填
    eventHandlers['session/event'](fakeSession, { type: 'user/message', sessionId: 's1', seq: 5, time: 500,
      data: { id: 'u02', role: 'user', content: '挂载后2', tok: 10 } });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(wj.ledger.getActiveMessages().length, 5, '幂等：4 条回填 + 1 条新消息');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.3：host-bootstrap 归因——账本可忽略时全量击穿单列 host 桶', async () => {
  const { classifyMiss } = await import('../src/diagnose.mjs');
  // 账本消息可忽略（estRaw 500 < baseline 50000 的 10%）且全量击穿 → host-bootstrap
  assert.equal(classifyMiss({ usage: { input_tokens: 500000, cached: 0 }, est: { estRaw: 500 }, baseline: 50000 }), 'host-bootstrap');
  // 账本消息占比显著（estRaw ≥ baseline/10）→ 不误判（走 provider-miss/unattributed 链）
  assert.equal(classifyMiss({ usage: { input_tokens: 500000, cached: 0 }, est: { estRaw: 300000 }, baseline: 50000 }), 'provider-miss');
  // 有分歧点 → 不误判
  assert.equal(classifyMiss({ usage: { input_tokens: 500000, cached: 0 }, est: { estRaw: 500 }, baseline: 50000, divergeAt: 7 }), 'unattributed');
  // 部分 cached → 不误判
  assert.equal(classifyMiss({ usage: { input_tokens: 500000, cached: 200000 }, est: { estRaw: 500 }, baseline: 50000 }), 'unattributed');
});

test('v0.7.3：超窗口桥接降级——context length 判 skip 而非 failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => { throw new Error('context length exceeded: 950000 tokens > 8192 maximum context'); } };
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 3; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 10 } });
    }
    const wj = ctx._wj.getOrCreate('s1').wj;
    wj.compressor.compress({ ids: ['u01', 'u02'], summary: '块摘要' });
    ctx._wj._currentSessionId = 's1';
    ctx._wj._lastHostSession = { id: 's1' };
    await ctx._wj.tryHostCompaction(ctx._wj._lastHostSession, 1, 3, 'b1', 's1');
    const st = ctx._wj.getOrCreate('s1').bridgeStatus.b1;
    assert.equal(st.status, 'skip', '超窗口应降级 skip（账本保持折叠，宿主侧原生压缩接管）');
    assert.ok((st.error ?? '').includes('超窗口'), '应注明超窗口原因');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.4 M5.1b：中部空洞型压缩——seq < 表面最大值即驱逐（bb00f425 85.6% 误差根治）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    // 时间序 1..5 共 5 条消息；宿主在中部压缩了 2~4（表面只剩 1 和 5）
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
    for (let i = 1; i <= 5; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: ids[i - 1], role: 'user', content: `m${i}`, tok: 10 } });
    }
    const fakeSession = {
      seq: 5,
      surface: { nodes: [1, 5] }, // 中部空洞：2~4 被宿主压缩
      eventAt: (q) => (q === 1 ? { type: 'user/message', data: { id: 'm1' } } : q === 5 ? { type: 'user/message', data: { id: 'm5' } } : undefined),
      id: 's1',
    };
    eventHandlers['session/event'](fakeSession, { type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 1, reason: { kind: 'completed' } } });
    const wj = ctx._wj.getOrCreate('s1').wj;
    // 旧判据（seq < min=1）：零驱逐 → estRaw 多算 400K（bb00f425 的 85.6% 误差根源）
    // 新判据（不在表面 且 seq < max=5）：m2/m3/m4 驱逐，m1/m5 保留
    assert.deepEqual(wj.ledger.getActiveMessages().map((m) => m.id).sort(), ['m1', 'm5'], '中部空洞的三条应被驱逐，两端保留');
    for (const id of ['m2', 'm3', 'm4']) assert.equal(wj.ledger.messages.get(id).status, 'evicted', `${id} 应 evicted`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.5 P0-1：重扫命中不同 start（新桥接在途）→ 放弃补偿，不对在途压缩补 end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._repairWaitMs = 30;
    // 可控 fake：首扫只看到旧 start@4；等待期内新桥接追加新 start@7（seq 推进到 8）
    const sess = {
      appended: [],
      newStartLanded: false,
      get seq() { return this.newStartLanded ? 8 : 5; },
      append(type, data) { this.appended.push([type, data]); },
      eventAt(q) {
        if (q === 4) return { type: 'compaction/start', seq: 4, data: { compactionId: 'old' } };
        if (q === 7 && this.newStartLanded) return { type: 'compaction/start', seq: 7, data: { compactionId: 'new' } };
        return undefined;
      },
    };
    setTimeout(() => { sess.newStartLanded = true; }, 10); // 新 start 在等待期内落盘
    const repaired = await ctx._wj.busyLockRepair(sess);
    assert.equal(repaired, false, '重扫命中不同 start（在途压缩）应放弃补偿');
    assert.equal(sess.appended.length, 0, '不得对在途压缩补写 end（双 end = 会话消失）');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('重扫命中不同 start')), '应记录放弃原因');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.5 P1-2：tokenizer 宿主真实形态——tool-result 嵌套 content 与 reasoning 计入', async () => {
  const { estimateTok } = await import('../src/tokenizer.mjs');
  // 宿主真实形态：tool-result 载荷在嵌套 content 数组
  const toolResultMsg = [{ type: 'tool-result', content: [{ type: 'text', text: '这是一段很长的工具输出'.repeat(10) }] }];
  const tok = estimateTok(toolResultMsg);
  assert.ok(tok > 50, `tool-result 嵌套内容应计入（实际 ${tok}，修复前 ≈1）`);
  // reasoning 块的 thinking 字段计入
  const reasoningMsg = [{ type: 'reasoning', thinking: '这是一段很长的思考过程'.repeat(10) }];
  assert.ok(estimateTok(reasoningMsg) > 50, 'reasoning/thinking 应计入');
  // 对照：空块仍 ≈1
  assert.equal(estimateTok([{ type: 'tool-result', content: [] }]), 1, '空载荷仍最小非零');
});

test('v0.7.5 P2-2：收编归属持久化——owner.json 防根账本孤儿', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    // 第一轮：会话 A 收编根目录
    const ctxA = { tools: { register: () => {} }, on: () => {}, logger: { info: () => {}, warn: () => {}, error: () => {} } };
    apply(ctxA, { dir, shadowMode: false });
    ctxA._wj.getOrCreate('session-aaaaaaaa');
    const { existsSync: ex, readFileSync: rf } = await import('node:fs');
    assert.ok(ex(join(dir, 'owner.json')), '收编后应写 owner.json');
    assert.equal(JSON.parse(rf(join(dir, 'owner.json'))).sid, 'session-aaaaaaaa', 'owner 应记录收编者');
    // 第二会话 B：独立目录
    ctxA._wj.getOrCreate('session-bbbbbbbb');
    assert.ok(ex(join(dir, 'sessions', 'session-bbbbbbbb')), 'B 应有独立目录');
    // 模拟重启：全新 plugin 实例，A 仍映射根目录（owner.json 持久化）
    const ctxB = { tools: { register: () => {} }, on: () => {}, logger: { info: () => {}, warn: () => {}, error: () => {} } };
    apply(ctxB, { dir, shadowMode: false });
    const recA = ctxB._wj.getOrCreate('session-aaaaaaaa');
    assert.equal(recA.sid, dir, '重启后 A 仍映射根目录（owner.json）');
    const recB = ctxB._wj.getOrCreate('session-bbbbbbbb');
    assert.ok(recB.sid.includes('sessions'), 'B 仍映射独立目录');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.6 P0(C1)：promote 虚拟父块 × 对数压缩——重放存活不砖化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-brick-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const wj = ctx._wj.getOrCreate('s1').wj;
    wj.ledger.recordMsg({ id: 'm1', at: 1, tok: 10, content: 'a' });
    wj.ledger.recordMsg({ id: 'm2', at: 2, tok: 10, content: 'b' });
    wj.ledger.recordFold({ block: 'b1', ids: ['m1'], range: ['m1', 'm1'], srcTok: 10, sumTok: 3, tier: 0, rawRef: 'block.b1.raw.jsonl' });
    wj.ledger.recordPromote({ parent: 'bP', children: ['b1'], srcTok: 10, sumTok: 3, tier: 1 });
    wj.ledger.compactNow(); // 修复前：产生 range:null 的 fold → 重放抛 TypeError → 0000 卷砖化
    // 重启模拟：全新实例读同一目录（修复前构造函数直接崩）
    const { ctx: ctx2 } = freshCtx(dir);
    apply(ctx2, { dir, shadowMode: false });
    const wj2 = ctx2._wj.getOrCreate('s1').wj;
    assert.ok(wj2.ledger.listBlocks().some((b) => b.id === 'bP'), '父块应由 promote 事件重建');
    const b1b = wj2.ledger.getBlock('b1');
    assert.ok(b1b, '子块 b1 重放重建');
    assert.ok(Array.isArray(b1b.ids) && b1b.ids.includes('m1'), '折叠归属保留在块 ids 中（压缩后折叠消息不留 msg 记录）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.6 P1(C1)：合法 JSON 形状非法账本行——构造存活 + degraded，不再砖化全会话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-brick2-'));
  try {
    const { writeFileSync: wf } = await import('node:fs');
    wf(join(dir, 'ledger.0000.jsonl'),
      '{"k":"msg","id":"m1","at":1,"tok":5}\n' +
      'null\n' +
      '{"k":"fold","block":"b1","rawRef":"x"}\n' +
      '{"k":"evict"}\n', 'utf8');
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false }); // 修复前：构造函数 TypeError → apply 崩 → 全部 wj_* 离线
    const wj = ctx._wj.getOrCreate('default').wj;
    assert.equal(wj.ledger.messages.get('m1')?.status, 'active', '合法消息存活');
    assert.ok(wj.ledger.getDegraded().some((d) => String(d).includes('malformed-event')), '形状非法事件记 degraded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.6 P0-2(C2)：孤儿压缩宽限窗——窗内拒绝补偿防双 end，窗后照常', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-limbo-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._repairWaitMs = 1;
    const sess = {
      appended: [],
      get seq() { return 5; },
      append(type, data) { this.appended.push([type, data]); },
      eventAt(q) { if (q === 4) return { type: 'compaction/start', seq: 4, data: { compactionId: 'old' } }; return undefined; },
    };
    ctx._wj._bridgeLimbo = new Map([['s1', Date.now() + 60000]]);
    assert.equal(await ctx._wj.busyLockRepair(sess, 's1'), false, '窗内拒绝补偿');
    assert.equal(sess.appended.length, 0, '不得补 end（双 end = 会话消失）');
    ctx._wj._bridgeLimbo.set('s1', Date.now() - 1);
    assert.equal(await ctx._wj.busyLockRepair(sess, 's1'), true, '窗后照常补偿');
    assert.equal(sess.appended.length, 1, '补偿 end 已写');
    ctx._wj._bridgeLimbo.set('other', Date.now() + 60000);
    assert.equal(await ctx._wj.busyLockRepair(sess, 'another-session'), true, '宽限窗按会话隔离');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.6 P1(C2)：重复 apply 幂等——复用实例防双监听双账本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-apply2-'));
  try {
    const { ctx } = freshCtx(dir);
    const first = apply(ctx, { dir, shadowMode: false });
    const again = apply(ctx, { dir, shadowMode: false });
    assert.equal(again, ctx._wj);
    assert.equal(again, first, '二次 apply 必须复用同一实例');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.6 P2(C1)：负 tok 钳 0——estRaw 不再为负、fits 不再恒真', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-negtok-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const wj = ctx._wj.getOrCreate('s1').wj;
    const r = wj.estimator.estimate({ messages: [{ tok: -500, cls: 'text' }, { tok: 100, cls: 'text' }] }, { provider: 'p', model: 'm' });
    assert.equal(r.estRaw, 100, '负 tok 被钳 0');
    const deg = (wj.estimator.getDegraded?.() ?? wj.estimator.degraded ?? []);
    assert.ok(deg.includes('negative-tok'), '应记 degrade');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.6 P2(C1)：tokenizer string 型 content 与 object 型 arguments 计入', async () => {
  const { estimateTok } = await import('../src/tokenizer.mjs');
  assert.ok(estimateTok([{ type: 'tool-result', content: '这是一段很长的工具输出'.repeat(10) }]) > 50, 'string content 计入');
  assert.ok(estimateTok([{ type: 'tool-call', name: 'f', arguments: { big: 'x'.repeat(500) } }]) > 50, 'object arguments 计入');
});

test('v0.7.7 P0-1(D)：nudge 候选级记账——3 次 reject 后过滤，accept 清账（旧并集 key 恒不过滤）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-d7-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const wj = ctx._wj.getOrCreate('s1').wj;
    const cands = [{ range: ['a', 'b'] }, { range: ['c', 'd'] }];
    assert.ok(wj.nudge.buildNudgeMessage(cands, 5) !== null, '前置：无 reject 应产出');
    wj.nudge.recordRejectCandidates(cands, 5);
    wj.nudge.recordRejectCandidates(cands, 6);
    wj.nudge.recordRejectCandidates(cands, 7);
    assert.equal(wj.nudge.buildNudgeMessage(cands, 8), null, '3 次 reject 后应过滤（旧并集 key 记账永远到不了这里）');
    assert.ok(wj.nudge.buildNudgeMessage(cands, 12) !== null, 'turn 前进 ≥3 后恢复');
    wj.nudge.recordAcceptCandidates(cands);
    assert.ok(wj.nudge.buildNudgeMessage(cands, 12) !== null, 'accept 清账后状态归零');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.7 P0-2(D)：自压缩后锚回退 block.seqSpan——长会话补桥不失锚', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-d7-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 1; i <= 3; i++) wj.ledger.recordMsg({ id: 'm' + i, at: i, tok: 5, content: 'x', seq: 100 + i });
    const blockId = wj.compressor.compress({ ids: ['m1', 'm2'], summary: 's', sumTok: 3, seqSpan: [101, 102] });
    wj.ledger.compactNow();
    const block = wj.ledger.getBlock(blockId);
    assert.deepEqual(ctx._wj.blockSeqAnchors(wj, block), [101, 102], '应回退 seqSpan（旧代码恒 null → 永久失桥）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.7 P0-3(D)：表面部分读取失败/形态漂移 → 零驱逐（evict 不可逆）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-d7-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 1; i <= 3; i++) wj.ledger.recordMsg({ id: 'u' + i, at: i, tok: 5, content: 'x', seq: i });
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 1, reason: { kind: 'completed' } },
      surface: { nodes: [1, 2, 3] }, eventAt: (q) => (q === 2 ? undefined : { type: 'user/message', data: { id: 'u' + q } }) });
    for (let i = 1; i <= 3; i++) assert.equal(wj.ledger.messages.get('u' + i).status, 'active', '部分读取失败下 u' + i + ' 不得误驱逐');
    ctx._wj._lastFpProbeMap = new Map(); // 重置 10 分钟限流，让第二轮真正走到护栏
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 100, time: 10000, data: { turn: 2, reason: { kind: 'completed' } },
      surface: { nodes: [1, 2, 3] }, eventAt: () => ({ type: 'user/message', data: {} }) });
    for (let i = 1; i <= 3; i++) assert.equal(wj.ledger.messages.get('u' + i).status, 'active', '形态漂移下 u' + i + ' 不得误驱逐');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.7 P1-3(D)：25 万元素锚提取不崩（旧 Math.min(...a) 在 20 万即抛 RangeError）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-d7-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const fakeWj = { ledger: { messages: new Map() } };
    for (let i = 1; i <= 250000; i++) fakeWj.ledger.messages.set('k' + i, { status: 'folded', blockId: 'bX', ev: { seq: i } });
    assert.deepEqual(ctx._wj.blockSeqAnchors(fakeWj, { id: 'bX' }), [1, 250000], '单趟循环求极值不崩');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.7 P1-1(D)：normalizeUsage 按形态显式分支——OpenAI 总数不双计，Anthropic cache_read 计入', async () => {
  const { normalizeUsage } = await import('../src/dsh.mjs');
  assert.deepEqual(normalizeUsage({ inputTokens: 100, cacheReadTokens: 40 }), { input: 140, cached: 40 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 } }), { input: 100, cached: 40 });
  assert.deepEqual(normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 40 }), { input: 140, cached: 40 });
  assert.equal(normalizeUsage({ foo: 1 }).degraded, 'usage-shape-unknown');
});

test('v0.7.7 P1-6(D)：tokenizer 区间表——韩文/假名/全角标点不再按 0.25 低估', async () => {
  const { estimateTok } = await import('../src/tokenizer.mjs');
  assert.ok(estimateTok('한국어텍스트') >= 10, '谚文 5 字 ×2.0');
  assert.ok(estimateTok('カタカナ') >= 4, '假名 4 字 ×1.2');
  assert.ok(estimateTok('，。') >= 2, '全角标点 2 字 ×1.2（旧口径 0.5）');
  assert.ok(estimateTok('你好') >= 2, '汉字口径不变');
});

test('v0.7.7 P2-2(D)：wj_compress 缺 ids/range → 明确报错而非裸 TypeError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-d7-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const wj = ctx._wj.getOrCreate('s1').wj;
    assert.throws(() => wj.compressor.compress({ summary: '只有摘要' }), /ids 与 range 至少提供一个/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.7 P2-4(D)：config.dir 缺失 → 影子模式而非每事件崩', async () => {
  const { ctx } = freshCtx(join(tmpdir(), 'wj-d7-nodir'));
  try {
    apply(ctx, {});
    assert.equal(ctx._wj.config.shadowMode, true, '应进入影子模式');
    assert.ok(String(ctx._wj.config.dir).length > 0, '应有兜底目录');
  } finally { try { rmSync(ctx._wj.config.dir, { recursive: true, force: true }); } catch {} }
});

test('v0.7.7 E1-1：seq 缺失的遗留账本在 nudge 带不崩（reduce 空数组守卫）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-e1-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: i <= 4 ? 25000 : 10 } });
    }
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 5, reason: { kind: 'completed' } } });
    assert.ok(!ctx._wj.logs.some((l) => l.msg.startsWith('session/event turn/end fail')), '处理器不得抛错（旧 reduce 在此崩空数组）');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('nudge')), '水位带内应正常产出/过滤 nudge');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.7 E2-1：降频压制清旧 pending——pre-step 不再重注入 stale 消息', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-e2-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => ({ ok: true }) };
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: i <= 4 ? 25000 : 10 } });
    }
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 5, reason: { kind: 'completed' } } });
    assert.ok(ctx._wj._pendingNudge.get('s1'), '前置：pending 已产出');
    await ctx._wj._preStepHandler({ agent: { id: 's1' }, turn: 5 }, async () => ({ messages: [{ id: 'm' }] }));
    for (const t of [6, 7, 8]) {
      eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 98 + t, time: 9000 + t, data: { turn: t, reason: { kind: 'completed' } } });
      await ctx._wj._preStepHandler({ agent: { id: 's1' }, turn: t }, async () => ({ messages: [{ id: 'm' }] }));
    }
    assert.ok(ctx._wj._pendingNudge.get('s1'), '前置：T8 后 pending 仍在（rejects 刚到 3）');
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 107, time: 9107, data: { turn: 9, reason: { kind: 'completed' } } });
    assert.equal(ctx._wj._pendingNudge.has('s1'), false, '压制时旧 pending 应被清（静默 3 轮的实现前提）');
    await ctx._wj._preStepHandler({ agent: { id: 's1' }, turn: 9 }, async () => ({ messages: [{ id: 'm' }] }));
    assert.equal(ctx._wj._pendingNudge.has('s1'), false, 'pre-step 无 pending 可注入');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('已清未消费的旧 pending')), '应记清账日志');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.7 E2-2：孤儿时龄护栏——新 start 拒补偿防双 end，超龄/无时间戳照常补偿', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-e3-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._repairWaitMs = 1;
    const mk = (time) => ({
      appended: [], get seq() { return 5; },
      append(type, data) { this.appended.push([type, data]); },
      eventAt(q) { if (q === 4) return { type: 'compaction/start', seq: 4, time, data: { compactionId: 'old' } }; return undefined; },
    });
    const fresh = mk(Date.now() - 30000);
    assert.equal(await ctx._wj.busyLockRepair(fresh, 's1'), false, '新 start 拒绝补偿（宽限窗过期≠孤儿已死）');
    assert.equal(fresh.appended.length, 0, '不得补 end');
    const old = mk(Date.now() - 16 * 60 * 1000);
    assert.equal(await ctx._wj.busyLockRepair(old, 's1'), true, '超龄照常补偿（M4.4 主路径）');
    assert.equal(old.appended.length, 1, '补偿 end 已写');
    const noTime = mk(undefined);
    assert.equal(await ctx._wj.busyLockRepair(noTime, 's1'), true, '无时间戳不误伤');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.7 E2-4：指纹探针配额按会话隔离——s1 探测后 s2 同轮仍评估', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-e4-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const wj1 = ctx._wj.getOrCreate('s1').wj;
    wj1.ledger.recordMsg({ id: 'a1', at: 1, tok: 5, content: 'x', seq: 1 });
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 1, time: 1, data: { turn: 1 },
      surface: { nodes: [1] }, eventAt: () => ({ type: 'user/message', data: { id: 'a1' } }) });
    const wj2 = ctx._wj.getOrCreate('s2').wj;
    wj2.ledger.recordMsg({ id: 'v1', at: 1, tok: 5, content: 'x', seq: 1 });
    wj2.ledger.recordMsg({ id: 'v2', at: 2, tok: 5, content: 'x', seq: 2 });
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's2', seq: 2, time: 2, data: { turn: 1 },
      surface: { nodes: [4] }, eventAt: () => ({ type: 'user/message', data: { id: 'vX' } }) });
    assert.equal(wj2.ledger.messages.get('v1').status, 'evicted', 's2 的漂移应被独立评估并驱逐');
    assert.equal(wj2.ledger.messages.get('v2').status, 'evicted', 'v2 同步驱逐');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.7 E1-P2-1：Anthropic cache_creation 计入 input（漏计 → 水位低估 98%）', async () => {
  const { normalizeUsage } = await import('../src/dsh.mjs');
  assert.deepEqual(normalizeUsage({ input_tokens: 100, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 }), { input: 5100, cached: 0 });
  assert.deepEqual(normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 40 }), { input: 140, cached: 40 });
});

test('v0.7.7 E1-P2-2：image 块按常量计入（纯图消息不再按 1 tok）', async () => {
  const { estimateTok } = await import('../src/tokenizer.mjs');
  assert.ok(estimateTok([{ type: 'image' }]) >= 1000, '纯图消息 ≥1000 tok');
  assert.ok(estimateTok([{ type: 'text', text: 'hi' }, { type: 'image' }]) >= 1001, '图文混合计入图片');
  assert.ok(estimateTok([{ type: 'tool-result', content: [{ type: 'image' }] }]) >= 1000, '嵌套 image 也计入');
});

test('v0.7.9 P1-2：k̂/baseline/lastRealInput 持久化——重启不再冷启动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-p12-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 0; i < 6; i++) wj.estimator.observeUsage({ provider: 'p', model: 'm', usageInputTokens: 2000, estRaw: 1000, baseline: 0 });
    wj.estimator._calibLastSave = 0; // 重置 30s 节流，强制末次状态落盘
    wj.estimator.observeUsage({ provider: 'p', model: 'm', usageInputTokens: 2000, estRaw: 1000, baseline: 0 });
    const { existsSync: ex } = await import('node:fs');
    assert.ok(ex(join(dir, 'models-calib.json')), 'k̂ calib 应落盘（首写不受 30s 节流限制）');
    const sdir = ctx._wj.getOrCreate('s1').sid;
    const { writeFileSync: wf } = await import('node:fs');
    wf(join(sdir, 'calib.json'), JSON.stringify({ baseline: { baseline: 4200, t: 1 }, lastRealInput: { input: 50000, t: 2 } }), 'utf8');
    const { ctx: ctx2 } = freshCtx(dir);
    apply(ctx2, { dir, shadowMode: false });
    const wj2 = ctx2._wj.getOrCreate('s1').wj;
    assert.equal(ctx2._wj._sessionBaseline.get('s1')?.baseline, 4200, 'baseline 应回灌');
    assert.equal(ctx2._wj._lastRealInput.get('s1')?.input, 50000, 'lastRealInput 应回灌');
    assert.equal(wj2.estimator.getCalibrationState('p', 'm').n, 7, 'k̂ 样本数应回灌');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.9 N-1：自压缩保留元数据 msg 事件——unfold 计数与状态重放不再失真', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-n1-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 1; i <= 3; i++) wj.ledger.recordMsg({ id: 'm' + i, at: i, tok: 5, content: 'x' + i, seq: 10 + i });
    const blockId = wj.compressor.compress({ ids: ['m1', 'm2'], summary: 's', sumTok: 3 });
    wj.ledger.recordEvict({ ids: ['m3'], why: 'reconcile' });
    wj.ledger.compactNow();
    assert.equal(wj.ledger.messages.get('m1').status, 'folded', '折叠消息元数据存活');
    assert.equal(wj.ledger.messages.get('m1').ev.content, undefined, 'content 已剥离');
    assert.equal(wj.ledger.messages.get('m3').status, 'evicted', '驱逐状态随流恢复');
    let count = 0;
    for (const m of wj.ledger.messages.values()) if (m.status === 'folded' && m.blockId === blockId) count += 1;
    assert.equal(count, 2, 'wj_unfold 计数恢复（旧代码计 0）');
    const { ctx: ctx2 } = freshCtx(dir);
    apply(ctx2, { dir, shadowMode: false });
    const wj2 = ctx2._wj.getOrCreate('s1').wj;
    assert.equal(wj2.ledger.messages.get('m1').status, 'folded', '重放后折叠状态一致');
    assert.equal(wj2.ledger.messages.get('m3').status, 'evicted', '重放后驱逐状态一致');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.9 N-3：normalizeUsage 未知 input 语义 → 丢遥测 + degraded（绝不猜加法）', async () => {
  const { normalizeUsage } = await import('../src/dsh.mjs');
  assert.deepEqual(normalizeUsage({ input: 500, cached: 5 }), { input: 0, cached: 0, degraded: 'usage-input-semantics-unknown' });
});

test('v0.7.9 P2-6：会话目录碰撞防护——dirmapping 单射且重启稳定', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-p26-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const sA = ctx._wj.getOrCreate('a/b').sid;
    const sB = ctx._wj.getOrCreate('a:b').sid;
    assert.notEqual(sA, sB, '同形清洗名必须分开');
    const { ctx: ctx2 } = freshCtx(dir);
    apply(ctx2, { dir, shadowMode: false });
    assert.equal(ctx2._wj.getOrCreate('a/b').sid, sA, '映射重启稳定');
    assert.equal(ctx2._wj.getOrCreate('a:b').sid, sB, '映射重启稳定');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.7.9 P2-10：补桥单次预算——最多 3 块，超出下轮继续', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-p210-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    let calls = 0;
    ctx.compaction = { compactRegion: async () => { calls += 1; return { ok: true }; } };
    apply(ctx, { dir, shadowMode: false });
    // 注册当前会话（_toolReconcile 按 _currentSessionId 取块与宿主引用）
    eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: 99, time: 99, data: { id: 'x0', role: 'user', content: 'x', tok: 1 } });
    await new Promise((r2) => setTimeout(r2, 50)); // 冷启动链（回溯+autoReconcile）先跑完，避免与被测调用并发
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 1; i <= 10; i++) wj.ledger.recordMsg({ id: 'm' + i, at: i, tok: 5, content: 'x', seq: i });
    for (let b = 1; b <= 5; b++) {
      wj.compressor.compress({ ids: ['m' + (2 * b - 1), 'm' + (2 * b)], summary: 's' + b, sumTok: 3 });
    }
    const out = await ctx._wj._toolReconcile();
    assert.ok(out.includes('孤儿已归档'), '应报告回收数');
    assert.equal(calls, 3, '单次最多 3 块');
    assert.ok(out.includes('预算用尽'), '应提示下轮继续');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.0 根锁：第二实例降级只读——Store.append 拒绝、首实例不受影响', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-lock-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    assert.equal(ctx._wj.readOnly, false, '首个实例应持有根锁');
    // 同进程第二个实例：锁被本进程持有（pid 存活）→ 降级只读
    const { ctx: ctx2 } = freshCtx(dir);
    apply(ctx2, { dir, shadowMode: false });
    assert.equal(ctx2._wj.readOnly, true, '第二实例应降级只读');
    const wj2 = ctx2._wj.getOrCreate('s9').wj;
    assert.throws(() => wj2.ledger.recordMsg({ id: 'z1', at: 1, tok: 1 }), /只读/, 'Store.append 应拒绝写入');
    assert.equal(ctx._wj.readOnly, false, '首实例不受影响');
    // 首实例照常可写
    const wj1 = ctx._wj.getOrCreate('s1').wj;
    wj1.ledger.recordMsg({ id: 'ok1', at: 1, tok: 1, content: 'x' });
    assert.equal(wj1.ledger.messages.get('ok1').status, 'active', '持锁实例写入正常');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.0 根锁：持有者死亡 → 抢锁；半截锁 → 宁可只读', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-lock2-'));
  try {
    const { LockManager } = await import('../src/lock.mjs');
    const { writeFileSync: wf } = await import('node:fs');
    // 死 pid（近 32 位上限，几乎不可能存活）→ 应抢锁
    wf(join(dir, 'wanjuan.lock'), JSON.stringify({ pid: 2147483000, boot: 'dead', at: Date.now() }), 'utf8');
    const lm = new LockManager({ dir, bootId: 'me' });
    lm.acquire();
    assert.equal(lm.acquired, true, '持有者已死应抢锁');
    // 半截锁（故意截断的 JSON）→ 无法确认持有者死亡 → 宁可只读
    wf(join(dir, 'wanjuan.lock'), '{"pid":123,"boot":', 'utf8');
    const lm2 = new LockManager({ dir, bootId: 'me2', readRetryMs: 1 });
    lm2.acquire();
    assert.equal(lm2.readOnly, true, '半截锁应降级只读');
    assert.equal(lm2.reason, 'lock-unreadable');
    // 活 pid（本进程）→ 只读
    wf(join(dir, 'wanjuan.lock'), JSON.stringify({ pid: process.pid, boot: 'live', at: Date.now() }), 'utf8');
    const lm3 = new LockManager({ dir, bootId: 'me3' });
    lm3.acquire();
    assert.equal(lm3.readOnly, true, '活进程持锁应只读');
    assert.equal(lm3.holder.pid, process.pid);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.0-phase1a：只读实例执行全部工具——会话目录逐文件 SHA-256 零变化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ro-'));
  try {
    // writer：正常实例，产生账本/遥测/日志/锁
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: i <= 4 ? 25000 : 10 } });
    }
    eventHandlers['session/event']({ type: 'turn/end', sessionId: 's1', seq: 99, time: 9999, data: { turn: 5, reason: { kind: 'completed' } } });
    await new Promise((r) => setTimeout(r, 120)); // writer 异步链落定
    // reader：同目录只读实例
    const { ctx: ctx2, registered, eventHandlers: eh2 } = freshCtx(dir);
    apply(ctx2, { dir, shadowMode: false });
    assert.equal(ctx2._wj.readOnly, true, '前置：reader 应只读');
    // reader 也接收事件流（真实宿主下两实例都会收到）：跟踪先行（纯内存），处理闸死
    eh2['session/event']({ type: 'user/message', sessionId: 's1', seq: 100, time: 12000,
      data: { id: 'x9', role: 'user', content: 'x', tok: 1 } });
    assert.equal(ctx2._wj._currentSessionId, 's1', 'P0 本体：跟踪先行——只读实例的会话路由保持正确');
    const { createHash } = await import('node:crypto');
    const { readdirSync, readFileSync } = await import('node:fs');
    const snap = () => {
      const out = {};
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          out[p.slice(dir.length)] = createHash('sha256').update(readFileSync(p)).digest('hex');
        }
      };
      walk(dir);
      return out;
    };
    const before = snap();
    const invoke = (name, args) => {
      const t = registered.find((x) => x.name === name);
      assert.ok(t, `工具 ${name} 应已注册`);
      return t.handler(args);
    };
    // 全部工具：写类应被闸住并返回只读原因；读类正常工作
    for (const [name, args] of [
      ['wj_report', {}],
      ['wj_search', { query: 'm' }],
      ['wj_decompress', { blockId: 'b1' }],
      ['wj_unfold', { blockId: 'b1' }],
      ['wj_compress', { ids: ['u01'], summary: 'x' }],
      ['wj_reconcile', {}],
    ]) {
      const r = await invoke(name, args);
      const text = typeof r === 'string' ? r : (r?.content?.[0]?.text ?? JSON.stringify(r));
      if (['wj_compress', 'wj_reconcile', 'wj_unfold', 'wj_decompress'].includes(name)) {
        assert.ok(text.includes('只读'), `${name} 应返回只读原因（实际：${String(text).slice(0, 60)}）`);
      }
    }
    await ctx2._wj._toolCompress({ ids: ['u01'], summary: 'x' });
    await ctx2._wj._toolReconcile();
    const after = snap();
    assert.deepEqual(after, before, '只读实例执行全部工具前后：会话目录必须逐文件零变化');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.0：wj_report 常驻锁状态行（周度哨兵观察点⑤）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-lockline-'));
  try {
    const { buildReport } = await import('../src/report.mjs');
    const { writeFileSync: wf } = await import('node:fs');
    wf(join(dir, 'wanjuan.lock'), JSON.stringify({ pid: 424242, boot: 'bt', at: Date.now() - 60000 }), 'utf8');
    const fakeDiag = { summarize: () => ({ total: 0, hitRate: 0, coreHitRate: 0, byOwner: { host: 0, upstream: 0, wanjuan: 0, unattributed: 0 } }) };
    const out = buildReport({ dir, ledger: null, diagnoser: fakeDiag });
    assert.ok(out.includes('根锁：pid=424242'), '应含锁状态行');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.2 方案③：wj_decompress 档案免责声明——原文包装在说明对象里，file 模式不包装', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-v82d-'));
  try {
    const { ctx, registered } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => ({ ok: true }) };
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._currentSessionId = 's1';
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 1; i <= 2; i++) wj.ledger.recordMsg({ id: 'm' + i, at: i, tok: 5, content: '内容' + i, seq: i });
    const blockId = wj.compressor.compress({ ids: ['m1', 'm2'], summary: 's', sumTok: 3 });
    const t = registered.find((x) => x.name === 'wj_decompress');
    assert.ok(t, '前置：wj_decompress 已注册');
    // file 模式先测（无副作用）；context 模式会 recordUnfold 删除块记录，必须放最后
    const resFile = await t.handler({ blockId, mode: 'file' });
    const textFile = resFile.content[0].text;
    assert.ok(!textFile.includes('说明'), 'file 模式（路径字符串）不包装');
    assert.ok(textFile.includes('.raw.jsonl'), 'file 模式返回路径');
    const res = await t.handler({ blockId });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(String(parsed.说明).includes('档案'), '应带档案免责声明');
    assert.ok(String(parsed.说明).includes('不在当前上下文中'), '应说明非当前上下文');
    assert.equal(parsed.恢复条数, 2, '恢复条数正确');
    assert.ok(Array.isArray(parsed.原文) && parsed.原文.length === 2, '原文数组完整');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.2 方案①：手动折叠 summary 补自述脚注（ids 与 range 两种形态）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-v82m-'));
  try {
    const { ctx } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => ({ ok: true }) };
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._currentSessionId = 's1';
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 1; i <= 4; i++) wj.ledger.recordMsg({ id: 'm' + i, at: i, tok: 5, content: '内容' + i, seq: i });
    const out1 = await ctx._wj._toolCompress({ ids: ['m1', 'm2'], summary: '手工摘要一' });
    assert.ok(out1.includes('✅'), 'ids 折叠成功');
    const b1 = wj.ledger.listBlocks().find((b) => b.ids && b.ids.length === 2 && b.ids.includes('m1'));
    const meta1 = wj.blocks.readBlockMeta(b1.id);
    assert.ok(meta1.summary.includes('手工摘要一'), '原摘要保留');
    assert.ok(meta1.summary.includes('【折叠产物】'), '应有自述脚注');
    assert.ok(meta1.summary.includes('原文共 2 条'), '应含原文条数');
    assert.ok(meta1.summary.includes('不在当前上下文'), '应说明非当前上下文');
    const out2 = await ctx._wj._toolCompress({ range: ['m3', 'm4'], summary: '手工摘要二' });
    assert.ok(out2.includes('✅'), 'range 折叠成功');
    const b2 = wj.ledger.listBlocks().find((b) => !(b.ids && b.ids.includes('m1')) && b.id !== b1.id);
    const meta2 = wj.blocks.readBlockMeta(b2.id);
    assert.ok(meta2.summary.includes('原文共 2 条'), 'range 形态也计数');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.3 F1a：compact tmp 残留（未 rename）——重放不受影响', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-f1a-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const { writeFileSync: wf } = await import('node:fs');
    const store1 = new Store({ dir });
    const ledger1 = new Ledger({ store: store1 });
    for (let i = 1; i <= 3; i++) ledger1.recordMsg({ id: 'm' + i, at: i, tok: 5, content: 'x' + i, seq: i });
    ledger1.recordFold({ block: 'b1', ids: ['m1'], range: ['m1', 'm1'], srcTok: 5, sumTok: 2, tier: 0, rawRef: 'block.b1.raw.jsonl' });
    // 注入：compact 的 tmp 已写、rename 未发生（进程被杀的中间态）
    wf(join(dir, 'ledger.0000.jsonl.tmp-1795000000000-ab3d9f'), '{"k":"msg","id":"m1",', 'utf8');
    const ledger2 = new Ledger({ store: new Store({ dir }) });
    assert.deepEqual(ledger2.getActiveMessages().map((m) => m.id), ['m2', 'm3'], '重放与中断前一致');
    assert.equal(ledger2.messages.get('m1').status, 'folded', '折叠状态保留');
    assert.ok(ledger2.getBlock('b1'), '块重建');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.3 F1b：compact 归档中断（部分旧卷已移）——重放收敛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-f1b-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const { writeFileSync: wf, mkdirSync: mkd, renameSync: rn, readdirSync: rds } = await import('node:fs');
    const store1 = new Store({ dir, segBytes: 1 }); // 每 append 一卷 → 0001..N
    const ledger1 = new Ledger({ store: store1 });
    for (let i = 1; i <= 4; i++) ledger1.recordMsg({ id: 'm' + i, at: i, tok: 5, content: 'x' + i, seq: i });
    ledger1.recordFold({ block: 'b1', ids: ['m1', 'm2'], range: ['m1', 'm2'], srcTok: 10, sumTok: 4, tier: 0, rawRef: 'block.b1.raw.jsonl' });
    ledger1.recordEvict({ ids: ['m3'], why: 'reconcile' });
    // 注入：0000 已写、归档中途——只移第一卷，其余残留
    const events = ledger1._compactionEvents();
    wf(join(dir, 'ledger.0000.jsonl'), events.map((ev) => JSON.stringify(ev) + '\n').join(''), 'utf8');
    const segs = rds(dir).filter((f) => /^ledger\.\d{4}\.jsonl$/.test(f) && f !== 'ledger.0000.jsonl').sort();
    assert.ok(segs.length >= 2, '前置：多卷存在（实际 ' + segs.length + '）');
    const adir = join(dir, 'archive', '1000');
    mkd(adir, { recursive: true });
    rn(join(dir, segs[0]), join(adir, segs[0]));
    const ledger2 = new Ledger({ store: new Store({ dir }) });
    assert.deepEqual(ledger2.getActiveMessages().map((m) => m.id), ['m4'], '活跃集收敛');
    assert.equal(ledger2.messages.get('m1').status, 'folded', '折叠状态收敛');
    assert.equal(ledger2.messages.get('m3').status, 'evicted', '驱逐状态收敛');
    assert.ok(ledger2.getBlock('b1'), '块重建');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.3 F2：meta 撕裂——search 显式排除不再静默、decompress raw 兜底、id 跳号不撞', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-f2-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const { BlocksManager } = await import('../src/blocks.mjs');
    const { Compressor } = await import('../src/compress.mjs');
    const { Restorer } = await import('../src/restore.mjs');
    const { writeFileSync: wf } = await import('node:fs');
    const store = new Store({ dir });
    const ledger = new Ledger({ store });
    const blocks = new BlocksManager({ store });
    const compressor = new Compressor({ ledger, blocks });
    const restorer = new Restorer({ ledger, blocks });
    for (let i = 1; i <= 2; i++) ledger.recordMsg({ id: 'm' + i, at: i, tok: 5, content: 'hello ' + i, seq: i });
    const b1 = compressor.compress({ ids: ['m1', 'm2'], summary: 'greeting block', sumTok: 3 });
    // 注入：meta 撕裂（半截 JSON——v0.8.3 之前的裸写窗口产物）
    wf(join(dir, `block.${b1}.json`), '{"summary":"trunc', 'utf8');
    // search：显式排除名单（修复前静默 continue，该块从搜索宇宙消失）
    const res = restorer.search('hello');
    assert.deepEqual(res.metaErrors, [b1], 'meta 撕裂块进排除名单');
    assert.equal(res.matches.length, 0, '撕裂块不参与匹配');
    // decompress context：raw 兜底，不砖
    const msgs = restorer.decompress(b1, 'context');
    assert.equal(msgs.length, 2, 'raw 兜底完整');
    // readBlockMeta 裸抛（撕裂事实本身）
    assert.throws(() => blocks.readBlockMeta(b1), /JSON/);
    // id 生成跳号不撞（复审意见 5 定稿断言）：新块 = 孤儿 id + 1
    ledger.recordMsg({ id: 'm3', at: 3, tok: 5, content: 'x3', seq: 3 });
    const b2 = compressor.compress({ ids: ['m3'], summary: 'next', sumTok: 2 });
    assert.equal(b2, 'b2', '撕裂 meta 文件名仍占号 → 新块跳到 b2（不撞号）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.4 ①：锚点重解析——宿主编辑后按 id 重解析当前表面，用新 seq 发桥', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-v84a-'));
  try {
    const { ctx } = freshCtx(dir);
    let captured = null;
    ctx.compaction = { compactRegion: async (s0, e0) => { captured = [s0, e0]; return { ok: true }; } };
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._currentSessionId = 's1';
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 1; i <= 2; i++) wj.ledger.recordMsg({ id: 'm' + i, at: i, tok: 5, content: 'x' + i, seq: i });
    const b1 = wj.compressor.compress({ ids: ['m1', 'm2'], summary: 's', sumTok: 3, seqSpan: [1, 2] });
    // 宿主编辑：表面 seq 变为 20/21，顺序正常（m1@20、m2@21）——旧 seq 1/2 已不在表面
    const sess = { surface: { nodes: [20, 21] }, eventAt: (q) => (q === 20 ? { type: 'user/message', seq: 20, data: { id: 'm1' } } : { type: 'user/message', seq: 21, data: { id: 'm2' } }) };
    await ctx._wj.tryHostCompaction(sess, 1, 2, b1, 's1');
    assert.deepEqual(captured, [20, 21], '应按重解析后的当前表面 seq 发桥（旧值 1/2 已失准）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.4 ①：锚点顺序颠倒（b24 案）——诚实 skip，不进 failed 冷却循环', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-v84b-'));
  try {
    const { ctx } = freshCtx(dir);
    let called = 0;
    ctx.compaction = { compactRegion: async () => { called += 1; return { ok: true }; } };
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._currentSessionId = 's1';
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 1; i <= 2; i++) wj.ledger.recordMsg({ id: 'm' + i, at: i, tok: 5, content: 'x' + i, seq: i });
    const b1 = wj.compressor.compress({ ids: ['m1', 'm2'], summary: 's', sumTok: 3, seqSpan: [1, 2] });
    // 表面 m1@位置1、m2@位置0——起始锚在终锚之后（宿主重排致颠倒）
    const sess = { surface: { nodes: [20, 21] }, eventAt: (q) => (q === 20 ? { type: 'user/message', seq: 20, data: { id: 'm2' } } : { type: 'user/message', seq: 21, data: { id: 'm1' } }) };
    await ctx._wj.tryHostCompaction(sess, 1, 2, b1, 's1');
    assert.equal(called, 0, '顺序颠倒时不得发起任何 compactRegion');
    const st = ctx._wj.getOrCreate('s1').bridgeStatus?.[b1];
    assert.equal(st.status, 'skip', '应诚实 skip（非 failed）');
    assert.ok(String(st.error).includes('颠倒'), 'skip 原因应写明顺序颠倒');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.4 ②：宿主真在途压缩（already in progress）——挂起 pending，不再终态 failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-v84c-'));
  try {
    const { ctx } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => { throw new Error('compaction already in progress'); } };
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._currentSessionId = 's1';
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 1; i <= 2; i++) wj.ledger.recordMsg({ id: 'm' + i, at: i, tok: 5, content: 'x' + i, seq: i });
    const b1 = wj.compressor.compress({ ids: ['m1', 'm2'], summary: 's', sumTok: 3 });
    const sess = { surface: { nodes: [1, 2] }, eventAt: (q) => ({ type: 'user/message', seq: q, data: { id: 'm' + q } }) };
    await ctx._wj.tryHostCompaction(sess, 1, 2, b1, 's1');
    const st = ctx._wj.getOrCreate('s1').bridgeStatus?.[b1];
    assert.equal(st.status, 'pending', '在途撞锁应挂起（f5803a07 案曾被标 failed 终态）');
    assert.ok(String(st.error).includes('deferred: 宿主压缩在途'), '应写明挂起原因');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.4 ④：桥接超时随块规模动态放大（801K 表面 180s 摘不完的 b4/b6 案）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-v84d-'));
  try {
    const { ctx } = freshCtx(dir);
    ctx.compaction = { compactRegion: () => new Promise(() => {}) }; // 永不返回（模拟大摘要）
    apply(ctx, { dir, shadowMode: false, bridgeTimeoutMs: 300, bridgeTimeoutPerTokMs: 0.001, bridgeTimeoutMaxMs: 1200 });
    ctx._wj._currentSessionId = 's1';
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 1; i <= 2; i++) wj.ledger.recordMsg({ id: 'm' + i, at: i, tok: 5, content: 'x' + i, seq: i });
    const b1 = wj.compressor.compress({ ids: ['m1', 'm2'], summary: 's', sumTok: 500000, srcTok: 500000 });
    const sess = { surface: { nodes: [1, 2] }, eventAt: (q) => ({ type: 'user/message', seq: q, data: { id: 'm' + q } }) };
    ctx._wj.tryHostCompaction(sess, 1, 2, b1, 's1');
    assert.equal(ctx._wj._lastBridgeTimeout, 1200, '应按 srcTok 放大并截断到上限（60000+500=60500 → min(1200)）；静态 300ms 会注定失败');
    wj.ledger.messages.clear(); // 防 unref 定时器外的状态干扰（定时器已 unref，不阻塞退出）
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.5 P2-5：孤儿 raw/meta 回收——reconcile 移入 archive/orphan-*，正常块不动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-v85-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._currentSessionId = 's1';
    const wj = ctx._wj.getOrCreate('s1').wj;
    for (let i = 1; i <= 2; i++) wj.ledger.recordMsg({ id: 'm' + i, at: i, tok: 5, content: 'x' + i, seq: i });
    const b1 = wj.compressor.compress({ ids: ['m1', 'm2'], summary: 's', sumTok: 3 });
    // 注入：折叠中断残留——b9 的 raw + meta（账本无此块）
    const { writeFileSync: wf, existsSync: ex, readdirSync: rds } = await import('node:fs');
    wf(join(dir, 'block.b9.raw.jsonl'), '{"id":"z1"}\n', 'utf8');
    wf(join(dir, 'block.b9.json'), '{"id":"b9"}', 'utf8');
    // 注册会话事件（reconcile 按 _currentSessionId 路由）
    eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: 99, time: 99, data: { id: 'x0', role: 'user', content: 'x', tok: 1 } });
    await new Promise((r2) => setTimeout(r2, 30));
    // 冷启动链的 autoReconcile 可能已抢先回收（30ms 等待期）——断言走日志与文件系统事实
    const out = await ctx._wj._toolReconcile();
    console.error('[V85-FULL] logs=' + JSON.stringify(ctx._wj.logs.map((l) => l.msg), null, 1));
    assert.equal(ex(join(dir, 'block.b9.raw.jsonl')), false, '孤儿 raw 应已移走');
    assert.equal(ex(join(dir, 'block.b9.json')), false, '孤儿 meta 应已移走');
    const odir = rds(join(dir, 'archive')).find((d) => d.startsWith('orphan-'));
    assert.ok(odir, 'archive/orphan-* 应存在');
    assert.ok(ex(join(dir, 'archive', odir, 'block.b9.raw.jsonl')), '原文仍可达（只是归档）');
    assert.ok(ex(join(dir, `block.${b1}.raw.jsonl`)), '正常块 raw 不动');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('档案回收')), '应记 loud 日志');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.5 P2-5：wj_report 孤儿档案计数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-v85r-'));
  try {
    const { buildReport } = await import('../src/report.mjs');
    const { writeFileSync: wf } = await import('node:fs');
    wf(join(dir, 'block.b7.raw.jsonl'), '{"id":"z1"}\n', 'utf8');
    wf(join(dir, 'block.b7.json'), '{"id":"b7"}', 'utf8');
    const fakeLedger = { getBlock: () => undefined, getActiveMessages: () => [], listBlocks: () => [], getLeafBlocks: () => [] };
    const fakeDiag = { summarize: () => ({ total: 0, hitRate: 0, coreHitRate: 0, byOwner: { host: 0, upstream: 0, wanjuan: 0, unattributed: 0 } }) };
    const out = buildReport({ dir, ledger: fakeLedger, diagnoser: fakeDiag });
    assert.ok(out.includes('孤儿档案：2 个'), '应计数孤儿（raw + meta）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P0-5：已折叠消息重投递不再污染日志', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const ledger = new Ledger({ store: new Store({ dir }) });
    for (let i = 1; i <= 3; i++) ledger.recordMsg({ id: `m${i}`, at: i, tok: 10, seq: i });
    ledger.recordFold({ block: 'b1', ids: ['m1', 'm2'], range: ['m1', 'm2'], srcTok: 20, sumTok: 5, tier: 1, rawRef: 'block.b1.raw.jsonl' });
    const before = ledger.store.replay().events.length;
    // 宿主重投递一条已折叠消息：P0-5 修复前会重复 append 污染日志
    ledger.recordMsg({ id: 'm1', at: 999, tok: 99, seq: 999 });
    assert.equal(ledger.store.replay().events.length, before, '重投递不应追加事件');
    assert.deepEqual(ledger.getActiveMessages().map((m) => m.id), ['m3'], '活跃集不变');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P0-6：Windows 二次对数压缩不再 EEXIST（时间戳归档子目录）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const ledger = new Ledger({ store: new Store({ dir }) });
    for (let i = 1; i <= 4; i++) ledger.recordMsg({ id: `m${i}`, at: i, tok: 10, seq: i });
    ledger.compactNow();
    // 二次压缩前又有新追加 → dir 下出现新的 ledger.0001+，旧方案 Windows 必现 EEXIST
    ledger.recordMsg({ id: 'm9', at: 9, tok: 10, seq: 9 });
    ledger.compactNow();
    const { readdirSync: rd, existsSync: ex } = await import('node:fs');
    const arc = rd(join(dir, 'archive'));
    assert.ok(arc.length >= 2, '两次压缩应产生两个时间戳归档子目录');
    assert.ok(ex(join(dir, 'ledger.0000.jsonl')), '压缩流正常');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P0-7：ids 路径 fold 的 unfold 精确展开（乱序 ids 不再静默空转）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const ledger = new Ledger({ store: new Store({ dir }) });
    for (let i = 1; i <= 4; i++) ledger.recordMsg({ id: `m${i}`, at: i, tok: 10, seq: i });
    // 乱序 ids（UUID 主机常态）：range 端点 [m3, m1] 字典序倒挂
    ledger.recordFold({ block: 'b1', ids: ['m3', 'm1', 'm2'], range: ['m3', 'm1'], srcTok: 30, sumTok: 8, tier: 1, rawRef: 'block.b1.raw.jsonl' });
    assert.deepEqual(ledger.getActiveMessages().map((m) => m.id), ['m4'], '折叠生效');
    ledger.recordUnfold({ block: 'b1', why: 'context' });
    assert.deepEqual(ledger.getActiveMessages().map((m) => m.id), ['m1', 'm2', 'm3', 'm4'], 'unfold 应精确展开全部块内消息（修复前静默空转）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P0-8：手动折叠 sumTok 生产路径非零（estimate 只读 tok）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 4; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `消息${i}`.repeat(30), tok: 10 } });
    }
    const compress = (await import('../src/dsh.mjs'), ctx);
    await ctx._wj._toolCompress({ ids: ['u01', 'u02', 'u03'], summary: '一段足够长的摘要文本用来验证 sumTok 估算非零，长度必须超过两个字符。' });
    const wj = ctx._wj.getOrCreate('s1').wj;
    const meta = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'block.b1.json'), 'utf8'));
    assert.ok(meta.sumTok > 0, `sumTok 应非零（实际 ${meta.sumTok}，修复前恒 0）`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.14：崩溃半行隔离——追加前补 \n，新事件不陪葬', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const { writeFileSync: wf, readFileSync: rf } = await import('node:fs');
    // 手工制造崩溃现场：一条完整事件 + 一条无换行符的半行 JSON
    const seg = join(dir, 'ledger.0001.jsonl');
    wf(seg, '{"k":"msg","id":"m1","tok":5}' + '\n' + '{"k":"msg","id":"m2","to', 'utf8');
    const store = new Store({ dir });
    const ledger = new Ledger({ store });
    ledger.recordMsg({ id: 'm3', at: 3, tok: 5, seq: 3 });
    const text = rf(seg, 'utf8');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 3, '半行应被隔离，新事件独立成行');
    const state = new Ledger({ store: new Store({ dir }) });
    const ids = state.getActiveMessages().map((m) => m.id);
    assert.ok(ids.includes('m3'), '新事件必须存活（不与半行陪葬）');
    assert.ok(ids.includes('m1'), '完好的历史事件不受影响');
    assert.ok(state.store.degraded.length >= 1, '半行应被记为 degraded 并跳过（loud，不静默）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.14：状态文件原子写——无 .tmp 残留，内容完整', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => ({ ok: true }) };
    ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 1000000 } }) };
    apply(ctx, { dir, shadowMode: false });
    // 带 usage 的 assistant 消息：触发窗口学习落盘（models.learned.json）
    eventHandlers['session/event']({ type: 'assistant/message', sessionId: 's1', seq: 1, time: 1000,
      data: { message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'nvmine', model: 'glm' }, content: [] }, usage: { inputTokens: 100, cacheReadTokens: 0 } } });
    await new Promise((r) => setImmediate(r));
    const { existsSync: ex, readFileSync: rf } = await import('node:fs');
    assert.ok(ex(join(dir, 'models.learned.json')), 'models.learned.json 应存在');
    assert.ok(!ex(join(dir, 'models.learned.json.tmp')), '不应残留 .tmp');
    JSON.parse(rf(join(dir, 'models.learned.json'), 'utf8')); // 必须是完整 JSON
    // 桥接：markBridge 发起即写 host-bridge.json（pending）
    ctx._wj.tryHostCompaction(ctx._wj._lastHostSession ?? { id: 's1' }, 1, 5, 'bt', 's1');
    await new Promise((r) => setImmediate(r));
    assert.ok(ex(join(dir, 'host-bridge.json')), 'host-bridge.json 应存在');
    assert.ok(!ex(join(dir, 'host-bridge.json.tmp')), '不应残留 .tmp');
    JSON.parse(rf(join(dir, 'host-bridge.json'), 'utf8')); // 必须是完整 JSON
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.12：fold 携带 seqSpan——块保存、对数压缩延续、宿主区间可追溯', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const store = new Store({ dir });
    const ledger = new Ledger({ store });
    for (let i = 1; i <= 6; i++) ledger.recordMsg({ id: `m${i}`, at: i, tok: 10, seq: i });
    ledger.recordFold({ block: 'b1', ids: ['m1', 'm2', 'm3'], range: ['m1', 'm3'], srcTok: 30, sumTok: 8, tier: 1, rawRef: 'block.b1.raw.jsonl', seqSpan: [1, 3] });
    assert.deepEqual(ledger.getBlock('b1').seqSpan, [1, 3], '块应保存 seqSpan');
    ledger.compactNow();
    const ledger2 = new Ledger({ store: new Store({ dir }) });
    assert.deepEqual(ledger2.getBlock('b1').seqSpan, [1, 3], '对数压缩后 seqSpan 应延续');
    // 被折叠消息的 msg 事件虽被丢弃，宿主区间仍可从 fold.seqSpan 追溯
    const evs = ledger2.store.replay().events.filter((e) => e.k === 'fold');
    assert.deepEqual(evs[0].seqSpan, [1, 3], '极简流 fold 事件应携带宿主区间');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4.1 回归：大量 mut 交织时对数压缩等价性（含幂等、最新值、重放一致）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const store = new Store({ dir });
    const ledger = new Ledger({ store });
    for (let i = 1; i <= 6; i++) ledger.recordMsg({ id: `m${i}`, at: i, tok: 10, seq: i });
    // 活跃消息 m4 交织两次突变（取最新值）
    ledger.recordMut({ id: 'm4', at: 100, bytes: 50, content: '第一版突变', tok: 25 });
    ledger.recordMut({ id: 'm4', at: 200, bytes: 80, content: '第二版突变更长', tok: 40 });
    // 折叠块内的 m1 也突变（效果应烘进 fold，不影响等价性）
    ledger.recordMut({ id: 'm1', at: 150, bytes: 30, content: '被折叠后又改', tok: 15 });
    ledger.recordFold({ block: 'b1', ids: ['m1', 'm2', 'm3'], range: ['m1', 'm3'], srcTok: 30, sumTok: 8, tier: 1, rawRef: 'block.b1.raw.jsonl' });
    ledger.recordEvict({ ids: ['m5'], why: 'reconcile' });
    const r = ledger.compactNow();
    assert.ok(r.after < r.before, `压缩应缩减 ${r.before} → ${r.after}`);
    // 等价性 1：活跃集正确（m4 活跃、m1-m3 已折、m5 已逐）
    assert.deepEqual(ledger.getActiveMessages().map((m) => m.id), ['m4', 'm6']);
    // 等价性 2：交织突变的活跃消息取最新值（内容 + tok）
    const active4 = ledger.getActiveMessages().find((m) => m.id === 'm4');
    assert.ok(JSON.stringify(active4.content).includes('第二版'), '应取最新突变内容');
    assert.equal(active4.tok, 40, 'tok 应为最新突变值');
    // 等价性 3：重放一致
    const ledger2 = new Ledger({ store: new Store({ dir }) });
    assert.deepEqual(ledger2.getActiveMessages().map((m) => m.id), ['m4', 'm6']);
    const replay4 = ledger2.getActiveMessages().find((m) => m.id === 'm4');
    assert.ok(JSON.stringify(replay4.content).includes('第二版'), '重放后突变最新值保持');
    assert.equal(ledger2.getBlock('b1').ids.length, 3, '重放后块保持');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4 战役二：窗口缓存 30 分钟 TTL——宿主配置突变可被嗅探', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    let resolveCalls = 0;
    ctx.llm = { resolveModelInfo: async () => { resolveCalls += 1; return { context: { contextWindow: 1000000 } }; } };
    apply(ctx, { dir, shadowMode: false, windowTtlMs: 50 });
    const emitUsage = () => eventHandlers['session/event']({
      type: 'assistant/message', sessionId: 's1', seq: 1, time: 1000,
      data: { message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'nvmine', model: 'glm' }, content: [] }, usage: { inputTokens: 100, cacheReadTokens: 0 } },
    });
    emitUsage();
    await new Promise((r) => setImmediate(r));
    emitUsage();
    await new Promise((r) => setImmediate(r));
    assert.equal(resolveCalls, 1, 'TTL 内不重复解析');
    // 等真实 TTL（50ms）过期后再次投递 → 应重新解析（嗅探配置突变）
    await new Promise((r) => setTimeout(r, 70));
    emitUsage();
    await new Promise((r) => setImmediate(r));
    assert.equal(resolveCalls, 2, 'TTL 过期后应重新解析（嗅探配置突变）');
    assert.equal(ctx._wj._windowCache.get('nvmine/glm').w, 1000000, '刷新后窗口更新');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M4 战役三：compactionThreshold 可配——超阈值重启即压缩', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-ledger-'));
  try {
    const { Store } = await import('../src/store.mjs');
    const { Ledger } = await import('../src/ledger.mjs');
    const store1 = new Store({ dir });
    const ledger1 = new Ledger({ store: store1, compactionThreshold: 5 });
    for (let i = 1; i <= 8; i++) ledger1.recordMsg({ id: `m${i}`, at: i, tok: 10, seq: i });
    ledger1.recordFold({ block: 'b1', ids: ['m1', 'm2'], range: ['m1', 'm2'], srcTok: 20, sumTok: 5, tier: 1, rawRef: 'block.b1.raw.jsonl' });
    // 重启（新 Ledger 实例，阈值 5 < 9 事件）→ 构造期自动压缩
    const ledger2 = new Ledger({ store: new Store({ dir }), compactionThreshold: 5 });
    const { existsSync: ex } = await import('node:fs');
    assert.ok(ex(join(dir, 'ledger.0000.jsonl')), '超阈值重启应触发对数压缩');
    // v0.7.9 N-1：+折叠消息元数据条数（m1/m2 两条）
    assert.ok(ledger2._lastReplayEventCount <= 9, `重放事件数应有界（实际 ${ledger2._lastReplayEventCount}）`);
    assert.deepEqual(ledger2.getActiveMessages().map((m) => m.id), ['m3', 'm4', 'm5', 'm6', 'm7', 'm8'], '活跃集保持');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.5：requests.jsonl 超 5MB 轮转保留尾 2000 行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    const wj = ctx._wj.getOrCreate('s1').wj;
    const { writeFileSync: wf, readFileSync: rf } = await import('node:fs');
    // 预置 >5MB 的历史记录（约 260 行 × 20KB）
    const big = Array.from({ length: 260 }, (_, i) => JSON.stringify({ t: i, provider: 'p', model: 'm', input: 1, cached: 0, new: 1, estBy: 0, khat: 1, calibrating: false, missKind: 'unattributed', missTok: 1, degraded: [], divergeAt: null, pad: 'y'.repeat(20000) })).join('\n');
    wf(join(dir, 'requests.jsonl'), big + '\n', 'utf8');
    eventHandlers['session/event']({ type: 'assistant/message', sessionId: 's1', seq: 1, time: 1000,
      data: { message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'nvmine', model: 'glm' }, content: [] }, usage: { inputTokens: 100, cacheReadTokens: 0 } } });
    const lines = rf(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n');
    assert.ok(lines.length <= 2001, `轮转后应 ≤2001 行，实际 ${lines.length}`);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.input, 100, '最新记录应在轮转后保留');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.6.5：桥接超时——宿主挂死时转 failed 而非永远等待', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    ctx.compaction = { compactRegion: () => new Promise(() => {}) }; // 永不返回
    apply(ctx, { dir, shadowMode: false, bridgeTimeoutMs: 40 });
    ctx._wj.tryHostCompaction(ctx._wj._lastHostSession ?? { id: 's1' }, 1, 5, 'bt');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(ctx._wj.getOrCreate('default').bridgeStatus.bt.status, 'failed', '超时应标记 failed（瞬态，下轮重试）');
    assert.ok(ctx._wj.getOrCreate('default').bridgeStatus.bt.error.includes('桥接超时'), '错误信息应注明超时');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('桥接超时')), '日志环应记录超时');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ===== v0.8.1：M3.5 end 边界回退 + nudge 空转步骤保留（bb00f425 实测回归）=====

test('v0.8.1：M3.5 end 边界不平衡——回退到最近平衡切线重试成功，不再终态 skip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir);
    const nodes = [1, 2, 3, 4, 5, 6];
    const evAt = (q) => ({
      1: { type: 'user/message', seq: 1, data: {} },
      2: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'tool-call', id: 't1' }] } } },
      3: { type: 'tool/result', seq: 3, data: {} },
      4: { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'tool-call', id: 't2' }] } } },
      5: { type: 'tool/result', seq: 5, data: {} },
      6: { type: 'user/message', seq: 6, data: {} },
    }[q]);
    const fakeSession = { surface: { nodes }, eventAt: evAt };
    const calls = [];
    ctx.compaction = { compactRegion: async (start, end) => {
      calls.push([start, end]);
      if (end === 4) throw new Error('compactRegion: end seq 4 is not a balanced boundary (would split a step, or the step is still open)');
      return { ok: true };
    } };
    apply(ctx, { dir, shadowMode: false });
    await ctx._wj.tryHostCompaction(fakeSession, 1, 4, 'b1', 's1');
    assert.deepEqual(calls, [[1, 4], [1, 3]], 'end 应回退 4→3 后成功');
    assert.equal(ctx._wj.getOrCreate('s1').bridgeStatus?.b1?.status, 'ok', '桥接应落 ok 而非 skip');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('end 边界不平衡')), '应有边界回退日志');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('宿主原生压缩完成（seq 1→3）')), '完成日志应报告真实终点');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.1：M3.5 end 边界回退耗尽仍不平衡——终态 skip 保持（防御上限不失效）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir);
    const nodes = [1, 2, 3, 4, 5, 6];
    const evAt = (q) => ({
      1: { type: 'user/message', seq: 1, data: {} },
      2: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'tool-call', id: 't1' }] } } },
      3: { type: 'tool/result', seq: 3, data: {} },
      4: { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'tool-call', id: 't2' }] } } },
      5: { type: 'tool/result', seq: 5, data: {} },
      6: { type: 'user/message', seq: 6, data: {} },
    }[q]);
    const fakeSession = { surface: { nodes }, eventAt: evAt };
    let calls = 0;
    ctx.compaction = { compactRegion: async () => { calls += 1; throw new Error('compactRegion: end seq 4 is not a balanced boundary (would split a step, or the step is still open)'); } };
    apply(ctx, { dir, shadowMode: false });
    await ctx._wj.tryHostCompaction(fakeSession, 1, 4, 'b2', 's1');
    assert.ok(calls >= 2 && calls <= 4, `重试应有上限（实际 ${calls} 次）`);
    assert.equal(ctx._wj.getOrCreate('s1').bridgeStatus?.b2?.status, 'skip', '重试耗尽仍应终态 skip');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.1：空 messages 的空转 pre-step 保留 pending，不吞 nudge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._pendingNudge.set('s1', {
      message: { id: 'wj-nudge-5', cls: 'sys', tok: 42, content: '【测试 nudge】' },
      turn: 5,
      candidateIds: [],
    });
    // 空转 pre-step（驱动器重踢/桥接唤醒形态）：messages 空
    const r1 = await ctx._wj._preStepHandler({ agent: { id: 's1' }, turn: 5 }, async () => ({ messages: [] }));
    assert.equal(r1.messages.length, 0);
    assert.equal(ctx._wj._pendingNudge.has('s1'), true, '空转步骤不得吞掉 pending（旧版在此 delete → nudge 永远到不了模型）');
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('空转步骤')), '应留诊断日志');
    // 下一个真正载有用户消息的 pre-step：注入成功
    const r2 = await ctx._wj._preStepHandler({ agent: { id: 's1' }, turn: 5 }, async () => ({ messages: [{ id: 'u' }] }));
    assert.equal(r2.messages.length, 2);
    assert.equal(r2.messages[1].source.kind, 'wanjuan-nudge');
    assert.equal(ctx._wj._pendingNudge.get('s1').injectedAt, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.1：冻结的 decision.messages 照样注入（toSpliced 非变异，原数组不被改动）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx } = freshCtx(dir);
    apply(ctx, { dir, shadowMode: false });
    ctx._wj._pendingNudge.set('s2', {
      message: { id: 'wj-nudge-3', cls: 'sys', tok: 42, content: '【冻结注入测试】' },
      turn: 3,
      candidateIds: [],
    });
    const frozenDecision = Object.freeze({ kind: 'enter', messages: Object.freeze([{ id: 'u' }]) });
    const r = await ctx._wj._preStepHandler({ agent: { id: 's2' }, turn: 3 }, async () => frozenDecision);
    assert.equal(r.messages.length, 2);
    assert.equal(r.messages[1].source.kind, 'wanjuan-nudge');
    assert.equal(r.messages[1].content[0].text, '【冻结注入测试】');
    assert.ok(Object.isFrozen(frozenDecision.messages), '原冻结数组不得被改动');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v0.8.1：不平衡类 skip 块重新可补桥（其余 skip 维持终态）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wj-dsh-'));
  try {
    const { ctx, eventHandlers } = freshCtx(dir);
    ctx.compaction = { compactRegion: async () => ({ ok: true }) };
    apply(ctx, { dir, shadowMode: false });
    for (let i = 1; i <= 25; i++) {
      eventHandlers['session/event']({ type: 'user/message', sessionId: 's1', seq: i, time: 1000 + i,
        data: { id: `u${String(i).padStart(2, '0')}`, role: 'user', content: `m${i}`, tok: 10 } });
    }
    // 折两块：bA（将被标成不平衡 skip）、bB（其他原因 skip）
    await ctx._wj._toolCompress({ ids: ['u01', 'u02', 'u03'], summary: '块A摘要' });
    await ctx._wj._toolCompress({ ids: ['u04', 'u05', 'u06'], summary: '块B摘要' });
    const blocks = ctx._wj.getOrCreate('s1').wj.ledger.listBlocks();
    assert.ok(blocks.length >= 2, '前置：两个块已折叠');
    const [bA, bB] = blocks;
    const srec = ctx._wj.getOrCreate('s1');
    srec.bridgeStatus[bA.id] = { status: 'skip', at: Date.now(), error: 'compactRegion: end seq 3 is not a balanced boundary (would split a step, or the step is still open)' };
    srec.bridgeStatus[bB.id] = { status: 'skip', at: Date.now(), error: 'summary is not smaller than the original span' };
    ctx._wj._lastHostSession = {
      surface: { nodes: Array.from({ length: 25 }, (_, k) => k + 1) },
      eventAt: (q) => ({ type: 'user/message', seq: q, data: {} }),
    };
    const out = await ctx._wj._toolReconcile();
    assert.ok(out.includes(`${bA.id}: seq`) && out.includes('→ ok'), '不平衡 skip 块应被重试并打通');
    assert.ok(out.includes(`${bB.id}: 已终态`), '其他 skip 维持终态');
    assert.equal(srec.bridgeStatus[bA.id].status, 'ok', 'bA 桥接应落 ok');
    assert.equal(srec.bridgeStatus[bB.id].status, 'skip', 'bB 保持 skip');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});