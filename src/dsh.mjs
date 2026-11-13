// src/dsh.mjs
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createWanjuan } from './index.mjs';
import { PHILOSOPHY_KEEP_DROP } from './philosophy.mjs';

// DSH 原生消息 {role, content}，派生稳定 id
function deriveMsgId({ role, content }) {
  const h = createHash('sha256').update(`${role}\u0000${content || ''}`).digest('hex').slice(0, 12);
  return `m-${h}`;
}

function estimateTok(content) {
  if (!content) return 0;
  let cjk = 0, other = 0;
  for (const ch of content) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.0 + other * 0.25);
}

function roleToCls(role) {
  if (role === 'system') return 'sys';
  if (role === 'developer') return 'dev';
  if (role === 'tool') return 'tool';
  return 'text';
}

function toLedgerMsg(m) {
  if (!m || typeof m.content !== 'string' || !m.role) return null;
  return {
    id: deriveMsgId(m),
    tok: estimateTok(m.content),
    bytes: m.content.length,
    cls: roleToCls(m.role),
    content: m.content,
  };
}

// ============================================================
// 内脏：跨宿主通用逻辑（M2 启用 onRequest 折叠钩子）
// ============================================================
export class WanjuanPlugin {
  constructor({ name = 'wanjuan-native', config = {} } = {}) {
    this.name = name;
    this.config = config;
    this.wj = null;
    this._lastFoldEstRaw = 0;
    this._currentProvider = 'deepseek';
    this._currentModel = 'deepseek-chat';
  }

  async _toolCompress({ range, summary, topics = [] }) {
    // P2 修复：M1 影子模式拒绝实际压缩（避免账本 fold 与宿主全量渲染发散）
    if (this.config.shadowMode !== false) {
      return '🕵️ 影子模式：当前不执行压缩，只观察记账。切到 M2 后会启用。';
    }
    try {
      const blockId = this.wj.compressor.compress({ range, summary, topics });
      const active = this.wj.ledger.getActiveMessages();
      const est = this.wj.observer.beforeRequest({ provider: this._currentProvider, model: this._currentModel, messages: active });
      this._lastFoldEstRaw = est.estRaw;
      return `✅ 压缩成功，生成块 ${blockId}`;
    } catch (e) { return `❌ 压缩失败: ${e.message}`; }
  }

  async _toolDecline({ range, reason }) {
    this.wj.nudge.recordReject(range, this.wj.diagnoser.size() + 1);
    return `已记录拒绝区间 ${range[0]} ~ ${range[1]}，理由：${reason || '未说明'}`;
  }

  async _toolDecompress({ blockId, mode = 'context' }) {
    try {
      const res = this.wj.restorer.decompress(blockId, mode);
      if (mode === 'context') return res.map((m) => `[${m.id}] ${m.content}`).join('\n');
      return `恢复成功：${res}`;
    } catch (e) { return `❌ 恢复失败: ${e.message}`; }
  }

  async _toolSearch({ query }) {
    const res = this.wj.restorer.search(query);
    if (res.length === 0) return '未找到相关摘要块。';
    return res.map((b) => `[${b.id}] ${b.summary} (${b.srcTok} tok)`).join('\n');
  }
}

// ============================================================
// 脸面：DSH apply(ctx) 方言（M1 影子期只观察）
// ============================================================
export const name = 'wanjuan';
export const inject = ['tools', 'connection', 'tokenMeter', 'webServer'];

export function apply(ctx, baseConfig = {}) {
  const dshHome = baseConfig.dshHome || ctx.dshHome || process.env.DSH_HOME || process.cwd();
  const configDir = baseConfig.dir || '.wanjuan';
  const baseDir = isAbsolute(configDir) ? configDir : join(dshHome, configDir);

  // 挂载时探测宿主形状，一次日志定生死
  try {
    ctx.logger?.info?.(
      `[wanjuan] host shape: on=${typeof ctx.on}, waterfall=${typeof ctx.waterfall}, ` +
      `effect=${typeof ctx.effect}, tools=${typeof ctx.tools}, ` +
      `connection.on=${typeof ctx.connection?.on}, tokenMeter=${typeof ctx.tokenMeter}`
    );
    if (ctx.tokenMeter) {
      ctx.logger.info(`[wanjuan] tokenMeter 可用方法: ${Object.keys(ctx.tokenMeter).join(', ')}`);
    }
  } catch { /* 忽略 */ }

  const pluginCache = new Map();

  function getOrCreate(sid) {
    const key = sid || 'default';
    if (pluginCache.has(key)) return pluginCache.get(key);
    const dir = join(baseDir, 'sessions', key);
    const plugin = new WanjuanPlugin({ config: { ...baseConfig, dir } });
    plugin.wj = createWanjuan({ ...baseConfig, dir });
    pluginCache.set(key, plugin);
    return plugin;
  }

  function resolveSid(ev) {
    return ev?.session?.id || ev?.sessionId || ev?.sid
      || ctx.sessionProjections?.current?.id
      || ctx.session?.id
      || 'default';
  }

  ctx._wj = {
    getOrCreate,
    get plugins() { return [...pluginCache.values()]; },
    get pluginCount() { return pluginCache.size; },
  };

  // 1) 工具注册
  if (ctx.tools && typeof ctx.tools.register === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const keepDropRules = PHILOSOPHY_KEEP_DROP;
      const defs = [
        {
          name: 'compress',
          description: `压缩一段连续消息为摘要块。生成摘要时必须严格遵循以下折叠规则：\n${keepDropRules}`,
          parameters: {
            type: 'object',
            properties: {
              range: { type: 'array', items: { type: 'string' }, description: '起始和结束消息 ID（含）' },
              summary: { type: 'string', description: '依据折叠规则生成的摘要' },
              topics: { type: 'array', items: { type: 'string' }, description: '检索关键词' }
            },
            required: ['range', 'summary']
          },
          execute: async (args, exec) => getOrCreate(resolveSid(exec))._toolCompress(args)
        },
        {
          name: 'decline_compress',
          description: '显式拒绝本次压缩建议。',
          parameters: { type: 'object', properties: { range: { type: 'array' }, reason: { type: 'string' } }, required: ['range'] },
          execute: async (args, exec) => getOrCreate(resolveSid(exec))._toolDecline(args)
        },
        {
          name: 'decompress',
          description: '恢复指定块的原文。',
          parameters: { type: 'object', properties: { blockId: { type: 'string' }, mode: { type: 'string', enum: ['context', 'file'] } }, required: ['blockId'] },
          execute: async (args, exec) => getOrCreate(resolveSid(exec))._toolDecompress(args)
        },
        {
          name: 'search_context',
          description: '按关键词检索块摘要。',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          execute: async (args, exec) => getOrCreate(resolveSid(exec))._toolSearch(args)
        }
      ];
      for (const def of defs) ctx.tools.register(def);
    });
  }

  // 2) 消息面 —— 真挂点：session/event（Post-commit, fire-and-forget append feed）
  function handleMsgBatch(msgs, sid) {
    try {
      const wj = getOrCreate(sid).wj;
      const ledgerMsgs = msgs.map(toLedgerMsg).filter(Boolean);
      if (ledgerMsgs.length === 0) return;
      for (const m of ledgerMsgs) wj.ledger.recordMsg(m);
      wj.fingerprinter.check(ledgerMsgs);
    } catch (e) {
      ctx.logger?.warn?.(`[wanjuan] handleMsgBatch 失败: ${e.message}`);
    }
  }

  function handleSessionEvent(event) {
    try {
      const sid = resolveSid(event);
      // 探测可能的结构：
      //   {type:'message', message:{role,content}}
      //   {type:'step', messages:[...]}
      //   {message:{role,content}} 直接
      if (event?.type === 'message' && event?.message) {
        handleMsgBatch([event.message], sid);
      } else if (event?.type === 'step' && Array.isArray(event?.messages)) {
        handleMsgBatch(event.messages, sid);
      } else if (Array.isArray(event?.messages)) {
        handleMsgBatch(event.messages, sid);
      } else if (event?.message?.role) {
        handleMsgBatch([event.message], sid);
      }
    } catch (e) {
      ctx.logger?.warn?.(`[wanjuan] handleSessionEvent 失败: ${e.message}`);
    }
  }

  if (typeof ctx.on === 'function') {
    try { ctx.on('session/event', handleSessionEvent); } catch (e) {
      ctx.logger?.warn?.(`[wanjuan] 挂 session/event 失败: ${e.message}`);
    }
  }

  // 3) 用量面 —— 真挂点：llm/stream waterfall，包住流，从 finish chunk 拿 usage
  function handleUsage(usage, meta) {
    try {
      if (!usage) return;
      const sid = meta?.sessionId || 'default';
      const wj = getOrCreate(sid).wj;
      const messages = meta?.messages || [];
      const provider = meta?.provider || 'deepseek';
      const model = meta?.model || 'deepseek-chat';
      const est = wj.observer.beforeRequest({ provider, model, messages });
      wj.observer.afterRequest({ provider, model, est, usage });
      wj.diagnoser.record({
        n: wj.diagnoser.size() + 1,
        provider, model, usage, est,
        degraded: wj.estimator.getDegraded(),
      });
    } catch (e) {
      ctx.logger?.warn?.(`[wanjuan] handleUsage 失败: ${e.message}`);
    }
  }

  function extractUsageFromChunk(chunk) {
    if (!chunk) return null;
    // 常见形状探测
    return chunk.usage || chunk.stats?.usage || chunk.finish?.usage || null;
  }

  if (typeof ctx.waterfall === 'function') {
    try {
      ctx.waterfall('llm/stream', async (request, next) => {
        const result = await next(request);

        // 情况 1：result 是 async iterable → wrap 并拿最后 chunk 的 usage
        if (result && typeof result[Symbol.asyncIterator] === 'function') {
          const stream = result;
          return (async function* () {
            let lastChunk = null;
            for await (const chunk of stream) {
              lastChunk = chunk;
              yield chunk;
            }
            const usage = extractUsageFromChunk(lastChunk);
            if (usage) {
              handleUsage(usage, {
                sessionId: request?.session?.id || request?.sessionId,
                provider: request?.provider,
                model: request?.model,
                messages: request?.messages,
              });
            }
          })();
        }

        // 情况 2：result 直接带 usage（一次性返回）
        const usage = extractUsageFromChunk(result);
        if (usage) {
          handleUsage(usage, {
            sessionId: request?.session?.id || request?.sessionId,
            provider: request?.provider,
            model: request?.model,
            messages: request?.messages,
          });
        }
        return result;
      });
    } catch (e) {
      ctx.logger?.warn?.(`[wanjuan] 挂 llm/stream 失败: ${e.message}`);
    }
  }

  // 4) M1 不挂 agent/pre-step（折叠渲染钩子 M2 再启用）

  ctx.logger?.info?.('[wanjuan] M1 影子期已挂载：session/event + llm/stream');
}