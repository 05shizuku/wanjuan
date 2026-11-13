// src/dsh.mjs
import { join, isAbsolute } from 'node:path';
import { createWanjuan } from './index.mjs';
import { PHILOSOPHY_KEEP_DROP } from './philosophy.mjs';

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

  async bind(dshCtx) {
    const sid = dshCtx.sessionId || `pid-${process.pid}`;
    const configDir = this.config.dir || '.wanjuan';
    const baseDir = isAbsolute(configDir) ? configDir : join(dshCtx.dshHome || '.', configDir);
    const dir = join(baseDir, 'sessions', sid);
    this.wj = createWanjuan({ ...this.config, dir });
  }

  async _toolCompress({ range, summary, topics = [] }) {
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

  function resolveSid(ev, fallback) {
    return (ev && (ev.sessionId || ev.sid)) || fallback || ctx.sessionId || 'default';
  }

  // 观测句柄挂到 ctx 上：便于测试 / wj_status HTTP 端点 / 真机调试
  ctx._wj = {
    getOrCreate,
    get plugins() { return [...pluginCache.values()]; },
    get pluginCount() { return pluginCache.size; },
  };

  // 1) 工具注册（DSH 形状：ctx.effect + ctx.tools.register(def)）
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
          execute: async (args, exec) => {
            const sid = resolveSid(exec, exec?.sessionId);
            return getOrCreate(sid)._toolCompress(args);
          }
        },
        {
          name: 'decline_compress',
          description: '显式拒绝本次压缩建议。',
          parameters: { type: 'object', properties: { range: { type: 'array' }, reason: { type: 'string' } }, required: ['range'] },
          execute: async (args, exec) => {
            const sid = resolveSid(exec, exec?.sessionId);
            return getOrCreate(sid)._toolDecline(args);
          }
        },
        {
          name: 'decompress',
          description: '恢复指定块的原文。',
          parameters: { type: 'object', properties: { blockId: { type: 'string' }, mode: { type: 'string', enum: ['context', 'file'] } }, required: ['blockId'] },
          execute: async (args, exec) => {
            const sid = resolveSid(exec, exec?.sessionId);
            return getOrCreate(sid)._toolDecompress(args);
          }
        },
        {
          name: 'search_context',
          description: '按关键词检索块摘要。',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          execute: async (args, exec) => {
            const sid = resolveSid(exec, exec?.sessionId);
            return getOrCreate(sid)._toolSearch(args);
          }
        }
      ];
      for (const def of defs) ctx.tools.register(def);
    });
  }

  // 2) 消息面（M1 只记账 + 指纹对账，绝不动 req.messages）
  const onMessage = (ev) => {
    try {
      const sid = resolveSid(ev);
      const { wj } = getOrCreate(sid);
      if (ev && ev.id) {
        wj.ledger.recordMsg({
          id: ev.id,
          tok: ev.tok ?? 0,
          bytes: ev.bytes ?? 0,
          cls: ev.cls || 'text',
          content: ev.content,
        });
      }
      if (Array.isArray(ev?.messages)) {
        wj.fingerprinter.check(ev.messages);
      }
    } catch (e) {
      ctx.logger?.warn?.(`[wanjuan] onMessage 失败: ${e.message}`);
    }
  };

  if (ctx.connection && typeof ctx.connection.on === 'function') {
    ctx.connection.on('message', onMessage);
  } else if (typeof ctx.on === 'function') {
    ctx.on('connection:message', onMessage);
  }

  // 3) 用量面（M1 只更新 k̂ + 落 requests.jsonl）
  if (ctx.tokenMeter) {
    try {
      const keys = Object.keys(ctx.tokenMeter);
      ctx.logger?.info?.(`[wanjuan] tokenMeter 可用方法: ${keys.join(', ')}`);
    } catch (e) { /* 忽略 */ }

    const onUsage = (ev) => {
      try {
        const sid = resolveSid(ev);
        const { wj } = getOrCreate(sid);
        const messages = ev?.messages || [];
        const est = wj.observer.beforeRequest({
          provider: ev?.provider || 'deepseek',
          model: ev?.model || 'deepseek-chat',
          messages,
        });
        wj.observer.afterRequest({
          provider: ev?.provider || 'deepseek',
          model: ev?.model || 'deepseek-chat',
          est,
          usage: ev?.usage,
        });
        wj.diagnoser.record({
          n: wj.diagnoser.size() + 1,
          provider: ev?.provider || 'deepseek',
          model: ev?.model || 'deepseek-chat',
          usage: ev?.usage,
          est,
          degraded: wj.estimator.getDegraded(),
        });
      } catch (e) {
        ctx.logger?.warn?.(`[wanjuan] onUsage 失败: ${e.message}`);
      }
    };

    if (typeof ctx.tokenMeter.on === 'function') {
      ctx.tokenMeter.on('usage', onUsage);
    } else if (typeof ctx.tokenMeter.subscribe === 'function') {
      ctx.tokenMeter.subscribe(onUsage);
    } else if (typeof ctx.tokenMeter.observe === 'function') {
      ctx.tokenMeter.observe(onUsage);
    } else {
      ctx.logger?.warn?.(`[wanjuan] tokenMeter 未暴露 on/subscribe/observe，M1 期间暂无法自动校准 k̂`);
    }
  }

  // 4) M1 不挂 onRequest/onResponse：mut 锚点、nudge 注入、折叠渲染整段不启用（等 M2 + A1 改完）
  // class 里的 onRequest/onResponse 代码仍在（M2 启用），但 apply 不接线。
}