// src/dsh.mjs
// 万卷 DSH 插件。2026-11-14 真机契约最终修正：
//  - 不注册 ctx.on('llm/stream')。
//  - 工具定义使用 parameters 字段。
//  - render 签名修正为 (_args, value) => value，防止宿主把 args 误当返回值处理导致 content.some 崩溃。
import { createWanjuan, PHILOSOPHY_KEEP_DROP } from './index.mjs';

export const name = 'wanjuan';
export const inject = ['tools', 'connection', 'tokenMeter', 'webServer'];

let _seq = 0;
function nextMsgId() { return `m${++_seq}`; }

function estimateTok(content) {
  if (typeof content === 'string' && content.length > 0) {
    return Math.max(1, Math.ceil(content.length / 2));
  }
  if (Array.isArray(content)) {
    // 宿主消息的 content 是 ContentBlock 数组（text/reasoning/tool-call…）
    let n = 0;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (typeof b.text === 'string') n += b.text.length;
      else if (b.type === 'tool-call') n += (b.name ?? '').length + (b.arguments ?? '').length;
    }
    return Math.max(1, Math.ceil(n / 2));
  }
  return 1;
}

function normalizeUsage(usage) {
  if (!usage) return null;

  // 宿主的 inputTokens 是 miss 部分，cacheReadTokens 是 cached 部分
  const miss = usage.inputTokens ?? usage.input_tokens ?? usage.input ?? usage.prompt_tokens ?? 0;
  const cached = usage.cacheReadTokens ?? usage.cached_tokens ?? usage.cached ?? usage.prompt_tokens_details?.cached_tokens ?? 0;

  // 万卷底层的 input 语义是总输入，必须把 miss 和 cached 加起来。
  // 为了兼容老版本（可能直接传 prompt_tokens 是总数的情况），做个保护：
  let totalInput = miss;
  if (usage.cacheReadTokens !== undefined || usage.cached_tokens !== undefined) {
    totalInput = miss + cached;
  }

  return { input: totalInput, cached };
}

function recordOne(wj, message, at) {
  if (!message) return;
  wj.ledger.recordMsg({
    id: message.id ?? nextMsgId(),
    tok: message.tok ?? estimateTok(message.content),
    content: message.content,
    role: message.role,
    at: at ?? message.at ?? 0,
  });
}

export class WanjuanPlugin {
  constructor({ config = {} } = {}) {
    this.config = config;
    this.dir = config.dir;
    this.shadowMode = !!config.shadowMode;
    this._sessions = new Map();
    this.wj = config.dir ? createWanjuan({ dir: config.dir }) : null;
  }

  getOrCreate(sessionId) {
    if (!this._sessions.has(sessionId)) {
      const wj = this.wj ?? createWanjuan({ dir: this.dir });
      this._sessions.set(sessionId, { wj });
    }
    return this._sessions.get(sessionId);
  }

  async _toolCompress(args) {
    if (this.shadowMode) {
      return '影子模式：只提示，不真的折叠。把 shadowMode 设为 false 才生效。';
    }
    this.wj.compressor.compress(args);
    return '✅ 已折叠';
  }
}

function buildTools(plugin) {
  const makeTool = (name, description, properties, required, rawHandler) => {
    const wrappedHandler = async (args) => {
      try {
        const result = await rawHandler(args);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { 
          isError: true, 
          content: [{ type: 'text', text: `执行失败: ${err.message}` }] 
        };
      }
    };

    return {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        required,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array' },
            isError: { type: 'boolean' }
          },
          required: ['content']
        },
        render: (_args, value) =>
          Array.isArray(value) ? value :
          Array.isArray(value?.content) ? value.content :
          [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      handler: wrappedHandler,
      execute: wrappedHandler,
    };
  };

  return [
    makeTool(
      'wj_compress',
      `${PHILOSOPHY_KEEP_DROP}\n把指定区间的消息折叠为摘要。summary 必须丢弃可恢复细节，只保留因果与结论。`,
      {
        range: { type: 'array', items: { type: 'string' }, description: '要折叠的消息 ID 区间' },
        summary: { type: 'string', description: '摘要内容' },
      },
      ['range', 'summary'],
      (args) => plugin._toolCompress(args)
    ),
    makeTool(
      'wj_decompress',
      '把已折叠的块恢复为原文。',
      {
        blockId: { type: 'string', description: '块 ID' },
        mode: { type: 'string', description: '恢复模式' },
      },
      ['blockId'],
      (args) => {
        const { wj } = plugin.getOrCreate(args.sessionId ?? 'default');
        return wj.restorer.decompress(args.blockId, args.mode ?? 'context');
      }
    ),
    makeTool(
      'wj_search',
      '在折叠块中检索。',
      { query: { type: 'string', description: '检索词' } },
      ['query'],
      (args) => {
        const { wj } = plugin.getOrCreate(args.sessionId ?? 'default');
        return wj.restorer.search(args.query);
      }
    ),
    makeTool(
      'wj_report',
      '生成缓存命中率与责任归属报告。',
      {},
      [],
      () => {
        const { wj } = plugin.getOrCreate('default');
        if (!wj || !wj.diagnoser || typeof wj.diagnoser.readAll !== 'function') {
          throw new Error('诊断器尚未初始化');
        }
        // Diagnoser.size() 在 diagnose.mjs 里就是 readAll().length——每次从磁盘
        // requests.jsonl 现数，并非内存态。以磁盘为唯一数据源，报总数、时间跨度，
        // 并在用量字段全为零时给出校准提示。
        let rs;
        try {
          rs = wj.diagnoser.readAll();
        } catch (e) {
          return `万卷报告：requests.jsonl 读取失败：${e.message}`;
        }
        const total = rs.length;
        let span = '';
        if (total > 0) {
          const fmt = (t) => (typeof t === 'number' ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '?');
          span = `，时间跨度 ${fmt(rs[0].t)} → ${fmt(rs[total - 1].t)}`;
        }
        const zeroUsage = rs.filter((r) => !(r.input > 0)).length;
        const warn = zeroUsage === total && total > 0 ? '；⚠️ 全部记录 input=0，用量钩子还没取到真实 token 数（M1 校准未接通）' : '';
        return `万卷报告：requests.jsonl 累计 ${total} 条${span}${warn}。`;
      }
    ),
  ];
}

export function apply(ctx, config = {}) {
  const plugin = new WanjuanPlugin({ config });
  ctx._wj = plugin;

  const recordUsage = (wj, usage, provider, model) => {
    const u = normalizeUsage(usage);
    if (!u) return;
    const usageObj = {
      input_tokens: u.input,
      input: u.input,
      cached: u.cached,
      cached_tokens: u.cached,
    };
    try {
      wj.diagnoser.record({
        usage: usageObj,
        input: u.input,
        cached: u.cached,
        provider,
        model,
      });
    } catch (e) {
      console.warn(`[wanjuan] diagnoser.record fail: ${e.message}`);
    }
  };

  ctx.on('session/event', (a0, a1) => {
    // 宿主签名：'session/event'(session, event) —— a0 是 Session 对象（有 .id），
    // a1 才是 SessionEvent（有 .type/.data/.time）。
    const ev = a1 && a1.type ? a1 : a0;
    if (!ev || !ev.type) return;
    const sessionId = ev.sessionId ?? a0?.id ?? 'default';
    try {
      const { wj } = plugin.getOrCreate(sessionId);

      // 宿主 SessionEventMap 的真实词汇（没有 'message'/'step'）：
      //   user/message      → data 就是 UserMessage 本体
      //   assistant/message  → data.message + data.usage（provider/model 在 message.source）
      //   tool/result        → data.message（ToolResultMessage）
      if (ev.type === 'user/message') {
        recordOne(wj, ev.data, ev.time);
      } else if (ev.type === 'assistant/message') {
        recordOne(wj, ev.data?.message, ev.time);
        if (ev.data?.usage) {
          const src = ev.data.message?.source ?? {};
          recordUsage(wj, ev.data.usage, src.provider, src.model);
        }
      } else if (ev.type === 'tool/result') {
        recordOne(wj, ev.data?.message, ev.time);
      }
    } catch (e) {
      console.warn(`[wanjuan] session/event ${ev.type} fail: ${e.message}`);
    }
  });

  for (const t of buildTools(plugin)) {
    try {
      ctx.tools.register(t);
    } catch (e) {
      console.warn(`[wanjuan] tool register fail ${t.name}: ${e.message}`);
    }
  }
}