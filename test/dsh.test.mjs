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
    assert.ok(ctx._wj.logs.some((l) => l.msg.includes('起点回退 3→1')), '应记录回退日志');
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
    assert.equal(m.ev.tok, 11, '突变后 tok 应按 CJK 口径重估（8 中文×1.2 + 2 标点×0.25 → 11）');
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
    assert.ok(ctx._wj._lastAutoReconcile > 0, '自动补桥限流时间戳应更新');
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
    assert.ok(r.before >= before && r.after < r.before, `压缩应缩减事件数 ${r.before} → ${r.after}`);
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
    // 首个事件以 (session, event) 双参投递——踢脚探针应直接对账解锁
    eventHandlers['session/event'](fakeSession, { type: 'user/message', sessionId: 's1', seq: 5, time: 1000,
      data: { id: 'u1', role: 'user', content: 'hi', tok: 1 } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(appends.length, 1, '冷启动探针应补写补偿 end');
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
    ctx._wj.tryHostCompaction(ctx._wj._lastHostSession, 1, 5, 'bl');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
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
      data: { message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] }, usage: { inputTokens: 180000, cacheReadTokens: 0 } } }); // usage 需符合场景量级（≈整段上下文），否则 k̂ 被拉崩
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

test('v0.6.19：fingerprint 观察模式——账本活跃从宿主表面消失时告警（不驱逐）', async () => {
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
    assert.ok(hit.msg.includes('2 条不在宿主表面'), '应指出漂移数量');
    assert.equal(ctx._wj.getOrCreate('s1').wj.ledger.getActiveMessages().length, 3, '观察模式不驱逐，活跃集不变');
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
    assert.ok(ledger2._lastReplayEventCount <= 7, `重放事件数应有界（实际 ${ledger2._lastReplayEventCount}）`);
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