// src/dsh.mjs
// 万卷 DSH 插件。2026-11-14 真机契约最终修正：
//  - 不注册 ctx.on('llm/stream')。
//  - 工具定义使用 parameters 字段。
//  - render 签名修正为 (_args, value) => value，防止宿主把 args 误当返回值处理导致 content.some 崩溃。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWanjuan, PHILOSOPHY_KEEP_DROP } from './index.mjs';

export const name = 'wanjuan';
// compaction：M3.5 真实上下文接管必需。宿主访问控制要求先声明 inject
// （2026-11-14 真机实测：直接属性访问抛 "cannot get property without inject"）。
// 若 profile 未挂 compaction 实现导致加载失败，需在插件管理里启用原生 compaction-basic。
export const inject = ['tools', 'connection', 'tokenMeter', 'webServer', 'compaction', 'llm'];

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

function recordOne(wj, message, at, seq) {
  if (!message) return;
  wj.ledger.recordMsg({
    id: message.id ?? nextMsgId(),
    tok: message.tok ?? estimateTok(message.content),
    content: message.content,
    role: message.role,
    at: at ?? message.at ?? 0,
    seq,  // M3.5：宿主会话日志序号，供 compactRegion 做区间映射
  });
}

export class WanjuanPlugin {
  constructor({ config = {} } = {}) {
    this.config = config;
    this.dir = config.dir;
    this.shadowMode = !!config.shadowMode;
    this._sessions = new Map();
    this.wj = config.dir ? createWanjuan({ dir: config.dir }) : null;
    // 日志环：Electron 主进程的 console 在 Windows 双击启动时不可见，
    // 文件日志也不收插件的 console 输出——所以内存留一份最近 30 条，wj_report 展示。
    this.logs = [];
  }

  pushLog(level, msg) {
    this.logs.push({ t: Date.now(), level, msg: String(msg) });
    if (this.logs.length > 30) this.logs.shift();
    // 原 console 行为保留：终端启动时仍然实时可见
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    try { fn(`[wanjuan] ${msg}`); } catch {}
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
    const before = new Set(this.wj.ledger.listBlocks().map((b) => b.id));
    this.wj.compressor.compress({
      ...args,
      // 手动路径也补 sumTok（此前只有自动折叠路径传了）
      sumTok: this.wj.estimator.estimate({ messages: [{ bytes: Buffer.byteLength(args.summary ?? ''), cls: 'text' }] }, { provider: '', model: '' }).estRaw,
    });
    // M3.5：手动折叠后同样桥接宿主原生压缩（1M 大窗口下自然折叠稀少，
    // 手动路径同时是 M3.5 的实时验证通路）。
    const newBlock = this.wj.ledger.listBlocks().find((b) => !before.has(b.id));
    if (newBlock && typeof this.tryHostCompaction === 'function') {
      const seqs = [];
      for (const m of this.wj.ledger.messages.values()) {
        if (m.status === 'folded' && m.blockId === newBlock.id && typeof m.ev.seq === 'number') seqs.push(m.ev.seq);
      }
      if (seqs.length > 0) {
        const p = this.tryHostCompaction(this._lastHostSession, Math.min(...seqs), Math.max(...seqs));
        if (p) await p; // 等宿主压缩完成再返回——工具结果消息必须落在压缩之后，表面稳定性才成立
      }
    }
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
        range: { type: 'array', items: { type: 'string' }, description: '要折叠的消息 ID 区间（与 ids 二选一）' },
        ids: { type: 'array', items: { type: 'string' }, description: '显式消息 ID 集合（UUID 主机推荐，优先于 range）' },
        summary: { type: 'string', description: '摘要内容' },
      },
      ['summary'],
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
        // 日志环：附最近 10 条，聊天里直接看水位/折叠/桥接动态
        let logTail = '';
        const logs = Array.isArray(plugin.logs) ? plugin.logs.slice(-10) : [];
        if (logs.length > 0) {
          const fmtT = (t) => (typeof t === 'number' ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '?');
          logTail = '\n最近日志：\n' + logs.map((l) => `  [${fmtT(l.t)}] ${l.level} ${l.msg}`).join('\n');
        }
        return `万卷报告：requests.jsonl 累计 ${total} 条${span}${warn}。${logTail}`;
      }
    ),
  ];
}

export function apply(ctx, config = {}) {
  const plugin = new WanjuanPlugin({ config });
  ctx._wj = plugin;

  // ===== M3 水位配置 =====
  const CONTEXT_WINDOW = 128000;     // 兜底窗口（模型未知时；优先用 estimator 的 est.window）
  const FORCE_FOLD_THRESHOLD = 0.95; // 强折阈值：95%
  const TAIL_RETENTION = 20;         // 尾部保护窗：永远不折叠最新的 N 条消息

  const recordUsage = (wj, usage, provider, model) => {
    const u = normalizeUsage(usage);
    if (!u) return;
    warmupModelWindow(wj, provider, model); // M3.6：顺手预热当前模型的窗口解析（并自学习落盘）
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
      plugin.pushLog('warn', `diagnoser.record fail: ${e.message}`);
    }
    // k̂ 校准接线：observe.mjs 里的 observeUsage 此前无人喂真实 usage，
    // k̂ 永远停在先验 1.0，字符估算的膨胀无法收敛（真机实测水位虚高到 544%）。
    // 用「账本活跃消息的 estRaw vs 真实 input」喂 EMA；账本不含 system prompt，
    // 这部分开销会被 k̂ 一并吸收——对水位预测反而更准。
    try {
      const active = wj.ledger.getActiveMessages();
      if (active.length > 0 && u.input > 0) {
        const est = wj.estimator.estimate({ messages: active }, { provider, model });
        wj.estimator.observeUsage({ provider, model, usageInputTokens: u.input, estRaw: est.estRaw });
      }
    } catch {}
  };

  // ===== M3.6：动态窗口感知（跟随实际服务模型自适应）=====
  // 窗口取值链：宿主注册表 ctx.llm.resolveModelInfo（权威，含 patch 层配置的
  // contextWindow）→ models.json + 已学习窗口（estimator）→ 128K 兜底。
  // 换模型即时自适应：每次真实 usage 到达时按 provider/model 异步预热缓存。
  // M3.6b 自学习：解析成功的窗口持久化到 <数据目录>/models.learned.json，
  // 下次加载合并进 estimator——别人用任何模型都零配置、自愈、无需发版。
  const _windowCache = new Map(); // 'provider/model' -> number（解析失败不缓存，下次重试）
  const mergeLearned = (wj, provider, model, info) => {
    try {
      const models = wj.estimator.models;
      const p = (models[provider] ??= {});
      p[model] = {
        ...p[model],
        ...(typeof info?.context?.contextWindow === 'number' ? { window: info.context.contextWindow } : {}),
        ...(typeof info?.defaultMaxTokens === 'number' ? { output: info.defaultMaxTokens } : {}),
      };
    } catch {}
  };
  const persistLearned = (wj, provider, model, info) => {
    try {
      const path = join(wj.blocks.dir, 'models.learned.json');
      let disk = {};
      try { disk = JSON.parse(readFileSync(path, 'utf8')); } catch {}
      const m = (disk[provider] ??= {});
      m[model] = {
        ...(m[model] ?? {}),
        ...(typeof info?.context?.contextWindow === 'number' ? { window: info.context.contextWindow } : {}),
        ...(typeof info?.defaultMaxTokens === 'number' ? { output: info.defaultMaxTokens } : {}),
      };
      writeFileSync(path, JSON.stringify(disk, null, 2), 'utf8');
    } catch (e) {
      plugin.pushLog('warn', `M3.6：学习窗口落盘失败：${e.message}`);
    }
  };
  const loadLearned = (wj) => {
    try {
      const disk = JSON.parse(readFileSync(join(wj.blocks.dir, 'models.learned.json'), 'utf8'));
      for (const [provider, models] of Object.entries(disk)) {
        const p = (wj.estimator.models[provider] ??= {});
        Object.assign(p, models);
      }
    } catch {}
  };
  const warmupModelWindow = (wj, provider, model) => {
    if (!provider) return;
    const key = `${provider}/${model ?? ''}`;
    if (_windowCache.has(key)) return;
    _windowCache.set(key, NaN); // 占位防并发重复解析
    try {
      const llm = ctx.llm;
      if (!llm || typeof llm.resolveModelInfo !== 'function') {
        _windowCache.delete(key);
        return;
      }
      Promise.resolve()
        .then(() => llm.resolveModelInfo(provider, model ?? ''))
        .then((info) => {
          const w = info?.context?.contextWindow;
          if (typeof w === 'number' && w > 0) {
            _windowCache.set(key, w);
            if (wj) { mergeLearned(wj, provider, model ?? '', info); persistLearned(wj, provider, model ?? '', info); }
            plugin.pushLog('log', `M3.6：模型窗口已解析 ${key} = ${w}`);
          } else {
            _windowCache.delete(key); // 注册表没给窗口，留待重试/走兜底
          }
        })
        .catch((err) => {
          _windowCache.delete(key);
          plugin.pushLog('warn', `M3.6：模型窗口解析失败 ${key}：${err?.message ?? err}（退回 models.json/兜底）`);
        });
    } catch (e) {
      _windowCache.delete(key);
      plugin.pushLog('warn', `M3.6：窗口解析调用异常：${e.message}`);
    }
  };

  // ===== M3.5：真实上下文接管（桥接宿主原生 compaction 服务）=====
  // 宿主契约（2026-11-14 Inspect 实查）：
  //   agent/pre-step 只给本轮 UserMessage[]；agent/request 明文 "cannot mutate messages"；
  //   llm/stream 的 LOOP 请求深度冻结（reconstructability）。
  // 唯一合法的「动刀」入口是 ctx.compaction.compactRegion(startSeq, endSeq, agent)：
  // 成功后真实会话日志的那段区间被替换成一个摘要节点，模型可见、缓存责任归宿主。
  let _compactUnavailableWarned = false;
  const tryHostCompaction = (session, startSeq, endSeq) => {
    try {
      // inject 已声明 'compaction'，正常走属性访问；万一访问控制仍拦截，退回契约可选路径 ctx.get
      let svc = null;
      try {
        svc = ctx.compaction;
      } catch {
        if (typeof ctx.get === 'function') svc = ctx.get('compaction');
      }
      if (!svc || typeof svc.compactRegion !== 'function') {
        if (!_compactUnavailableWarned) {
          _compactUnavailableWarned = true;
          plugin.pushLog('warn', 'M3.5：宿主 compaction 服务不可用（inject 后仍取不到实现），真实上下文暂不会收缩');
        }
        return null;
      }
      // 返回 promise 供手动路径 await：宿主 compactRegion 硬编码 whole-surface 稳定性，
      // 工具结果消息若落在摘要期间必然触发 "session surface changed"（2026-11-14 实测），
      // 所以手动折叠必须等压缩完成后再返回工具结果。
      return Promise.resolve()
        .then(() => {
          // 宿主契约（2026-11-14 真机实测）：第三参是 agent 包装 { session, options }，
          // 不是裸 Session——宿主内部走 agent.session.surface，裸传必抛 reading 'surface'。
          const agent = session && typeof session === 'object' ? { session, options: {} } : undefined;
          return svc.compactRegion(startSeq, endSeq, agent);
        })
        .then((res) => {
          plugin.pushLog('log', `M3.5：宿主原生压缩完成（seq ${startSeq}→${endSeq}）${res ? JSON.stringify(res).slice(0, 120) : ''}`);
        })
        .catch((err) => {
          plugin.pushLog('warn', `M3.5：宿主压缩失败：${err?.message ?? err}`);
        });
    } catch (e) {
      plugin.pushLog('warn', `M3.5：宿主压缩调用异常：${e.message}`);
    }
  };
  plugin.tryHostCompaction = tryHostCompaction; // 手动折叠路径复用同一桥接

  ctx.on('session/event', (a0, a1) => {
    // 宿主签名：'session/event'(session, event) —— a0 是 Session 对象（有 .id），
    // a1 才是 SessionEvent（有 .type/.data/.time）。
    const ev = a1 && a1.type ? a1 : a0;
    if (!ev || !ev.type) return;
    const sessionId = ev.sessionId ?? a0?.id ?? 'default';
    try {
      const { wj } = plugin.getOrCreate(sessionId);
      plugin._lastHostSession = a0; // M3.5：手动折叠桥接用的宿主 session 引用（最近一次事件流）

      // 宿主 SessionEventMap 的真实词汇（没有 'message'/'step'）：
      //   user/message      → data 就是 UserMessage 本体
      //   assistant/message  → data.message + data.usage（provider/model 在 message.source）
      //   tool/result        → data.message（ToolResultMessage）
      if (ev.type === 'user/message') {
        recordOne(wj, ev.data, ev.time, ev.seq);
      } else if (ev.type === 'assistant/message') {
        recordOne(wj, ev.data?.message, ev.time, ev.seq);
        if (ev.data?.usage) {
          const src = ev.data.message?.source ?? {};
          recordUsage(wj, ev.data.usage, src.provider, src.model);
        }
      } else if (ev.type === 'tool/result') {
        recordOne(wj, ev.data?.message, ev.time, ev.seq);
      } else if (ev.type === 'turn/end') {
        // ==========================================
        // M3 核心引擎：在一轮对话彻底结束后，进行水位检查
        // ==========================================
        if (plugin.shadowMode || !wj.estimator || typeof wj.estimator.estimate !== 'function') return;

        // 注意：Estimator 没有 estRaw 方法（那是 estimate() 返回值的字段）；
        // 且宿主消息 id 是 UUID，字典序≠时间序（2026-11-14 实测），必须按 at 排出真实时间序。
        const activeMsgs = wj.ledger.getActiveMessages();
        if (activeMsgs.length <= TAIL_RETENTION) return;
        const byTime = [...activeMsgs].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

        let provider = '', model = '';
        try {
          const last = wj.diagnoser.readAll().at(-1);
          if (last?.provider) { provider = last.provider; model = last.model ?? ''; }
        } catch {}

        const est = wj.estimator.estimate({ messages: byTime }, { provider, model });
        // M3.6：窗口三级取值——宿主注册表（动态预热缓存）→ models.json → 128K 兜底
        const hostWindow = _windowCache.get(`${provider}/${model ?? ''}`);
        const window = (typeof hostWindow === 'number' && hostWindow > 0)
          ? hostWindow
          : (est.window && est.window > 0 ? est.window : CONTEXT_WINDOW);
        // 用 estFinal（k̂ 校准 + 5% 偏置）做水位，比 estRaw 更保守
        const usageRatio = est.estFinal / window;

        if (usageRatio >= FORCE_FOLD_THRESHOLD) {
          plugin.pushLog('warn', `🚨 水位达到 ${(usageRatio * 100).toFixed(1)}%（模型 ${provider || '?'}/${model || '?'}，窗口 ${window}）！正在强制执行后台保护性折叠...`);
          const toFold = byTime.slice(0, byTime.length - TAIL_RETENTION);
          try {
            // 关键：按显式 id 列表折叠。传 range 端点在 UUID id 下会按字典序
            // 折出一段随机邻域，保尾 20 条完全不成立。
            const n = toFold.length;
            const summary = `【万卷引擎自动折叠】水位已达 ${(usageRatio * 100).toFixed(1)}%，最老的 ${n} 条消息已折叠为本摘要；如需原文可用 wj_decompress 恢复。`;
            const blockId = wj.compressor.compress({
              ids: toFold.map((m) => m.id),
              summary,
              // 摘要自身的 token 成本（此前漏传，块元数据 sumTok 恒为 0）
              sumTok: wj.estimator.estimate({ messages: [{ bytes: Buffer.byteLength(summary), cls: 'text' }] }, { provider, model }).estRaw,
            });
            plugin.pushLog('log', `✅ 自动折叠完成：块 ${blockId}，账本释放 ${n} 条消息。`);
            // M3.5：账本折完，桥接宿主原生压缩，把真实会话日志的同段区间也收掉
            const seqs = toFold.map((m) => m.seq).filter((s) => typeof s === 'number');
            if (seqs.length > 0) {
              tryHostCompaction(a0, Math.min(...seqs), Math.max(...seqs));
            }
          } catch (err) {
            plugin.pushLog('error', `自动折叠失败: ${err.message}`);
          }
        } else if (usageRatio >= 0.80) {
          // 只是警告（Nudge），留给下一个 turn 模型自己决定
          plugin.pushLog('warn', `⚠️ 水位达到 ${(usageRatio * 100).toFixed(1)}%，建议模型主动调用 wj_compress。`);
        }
      }
    } catch (e) {
      plugin.pushLog('warn', `session/event ${ev.type} fail: ${e.message}`);
    }
  });

  for (const t of buildTools(plugin)) {
    try {
      ctx.tools.register(t);
    } catch (e) {
      plugin.pushLog('warn', `tool register fail ${t.name}: ${e.message}`);
    }
  }

  if (plugin.wj) loadLearned(plugin.wj); // M3.6b：启动时合并已学习的模型窗口
}