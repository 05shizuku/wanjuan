// src/dsh.mjs
// L4 宿主集成（DSH 插件入口）。
// 适配 DSH 的 apply(ctx) 方言。

import { join, isAbsolute } from 'node:path';
import { createWanjuan } from './index.mjs';

// 暴露给 DSH 宿主的入口函数
export function apply(ctx, config = {}) {
  const sid = ctx.sessionId || `pid-${process.pid}`;
  const configDir = config.dir || '.wanjuan';
  const baseDir = isAbsolute(configDir) ? configDir : join(ctx.dshHome || '.', configDir);
  const dir = join(baseDir, 'sessions', sid);

  const wj = createWanjuan({ ...config, dir });

  let lastFoldEstRaw = 0;
  let currentProvider = 'deepseek';
  let currentModel = 'deepseek-chat';

  // 1. 注册工具（假设 DSH 的注册方法是 ctx.registerTool 或 ctx.tools.set）
  // TODO: 如果 DSH 是 ctx.registerTool(name, schema, handler)，请调整调用方式
  const keepDropRules = wj.nudge.philosophy.getKeepDropRules();
  const tools = {
    compress: {
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
      handler: async ({ range, summary, topics = [] }) => {
        try {
          const blockId = wj.compressor.compress({ range, summary, topics });
          const active = wj.ledger.getActiveMessages();
          const est = wj.observer.beforeRequest({ provider: currentProvider, model: currentModel, messages: active });
          lastFoldEstRaw = est.estRaw;
          return `✅ 压缩成功，生成块 ${blockId}`;
        } catch (e) { return `❌ 压缩失败: ${e.message}`; }
      }
    },
    decline_compress: {
      description: '显式拒绝本次压缩建议。',
      parameters: { type: 'object', properties: { range: { type: 'array' }, reason: { type: 'string' } }, required: ['range'] },
      handler: async ({ range, reason }) => {
        wj.nudge.recordReject(range, wj.diagnoser.size() + 1);
        return `已记录拒绝区间 ${range[0]} ~ ${range[1]}`;
      }
    },
    decompress: {
      description: '恢复指定块的原文。',
      parameters: { type: 'object', properties: { blockId: { type: 'string' }, mode: { type: 'string', enum: ['context', 'file'] } }, required: ['blockId'] },
      handler: async ({ blockId, mode = 'context' }) => {
        try {
          const res = wj.restorer.decompress(blockId, mode);
          if (mode === 'context') return res.map((m) => `[${m.id}] ${m.content}`).join('\n');
          return `恢复成功：${res}`;
        } catch (e) { return `❌ 恢复失败: ${e.message}`; }
      }
    },
    search_context: {
      description: '按关键词检索块摘要。',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: async ({ query }) => {
        const res = wj.restorer.search(query);
        if (res.length === 0) return '未找到相关摘要块。';
        return res.map((b) => `[${b.id}] ${b.summary} (${b.srcTok} tok)`).join('\n');
      }
    }
  };

  // 假设 DSH 有注册工具的 API (如 ctx.registerTool 或 ctx.tools.register)
  if (ctx.registerTool) {
    for (const [name, tool] of Object.entries(tools)) {
      ctx.registerTool(name, tool);
    }
  } else if (ctx.tools && ctx.tools.set) {
    for (const [name, tool] of Object.entries(tools)) {
      ctx.tools.set(name, tool);
    }
  }

  // 2. 拦截请求（渲染钩子 + Nudge）
  // TODO: 需替换为 DSH 真实的前置请求拦截事件（如 ctx.onBeforeRequest / ctx.middleware）
  const onRequest = async (req, next) => {
    currentProvider = req.provider || 'deepseek';
    currentModel = req.model || 'deepseek-chat';

    const fpResult = wj.fingerprinter.check(req.messages);
    if (fpResult.action === 'full' && fpResult.mutated && fpResult.mutated.length > 0) {
      wj.diagnoser.record({
        n: wj.diagnoser.size() + 1,
        provider: req.provider, model: req.model,
        usage: { input_tokens: 0, cached: 0 }, est: { estFinal: 0 },
        overrideMissKind: 'host-rewrite'
      });
    }

    // 折叠渲染
    const activeMessages = wj.ledger.getActiveMessages();
    const activeIds = new Set(activeMessages.map(m => m.id));
    const renderedMessages = [];
    const foldedBlocks = new Set();

    for (const m of req.messages) {
      if (activeIds.has(m.id)) {
        renderedMessages.push(m);
      } else {
        const ledgerMsg = wj.ledger.messages.get(m.id);
        if (ledgerMsg && ledgerMsg.status === 'folded' && ledgerMsg.blockId) {
          foldedBlocks.add(ledgerMsg.blockId);
        }
      }
    }

    const blockSummaries = [];
    for (const bId of foldedBlocks) {
      try {
        const meta = wj.blocks.readBlockMeta(bId);
        blockSummaries.push({
          id: `block-${bId}`,
          cls: 'sys',
          tok: meta.sumTok || 0,
          content: `[摘要块 ${bId}] ${meta.summary || ''}`
        });
      } catch (e) {}
    }
    req.messages = [...blockSummaries, ...renderedMessages];

    // 原生估算与门限
    const nativeEst = wj.observer.beforeRequest({ provider: req.provider, model: req.model, messages: req.messages });
    if (lastFoldEstRaw === 0) lastFoldEstRaw = nativeEst.estRaw;

    const gateRes = wj.gate.check({
      currentEstRaw: nativeEst.estRaw,
      lastFoldEstRaw: lastFoldEstRaw,
      estFinal: nativeEst.estFinal,
      window: nativeEst.window
    });

    // 瞬态 Nudge 注入
    if (gateRes.shouldNudge) {
      const candidates = wj.nudge.findCandidates(activeMessages);
      const turn = wj.diagnoser.size() + 1;
      const nudgeMsg = wj.nudge.buildNudgeMessage(candidates, turn);
      if (nudgeMsg) {
        req.messages.push(nudgeMsg);
        req._wjInjectedNudge = nudgeMsg;
      }
    }

    if (typeof next === 'function') return next(req);
    return req;
  };

  // 3. 拦截响应（清理瞬态 + 记账）
  const onResponse = async (req, res, next) => {
    if (req._wjInjectedNudge) {
      const idx = req.messages.lastIndexOf(req._wjInjectedNudge);
      if (idx !== -1) req.messages.splice(idx, 1);
      delete req._wjInjectedNudge;
    }

    const est = wj.observer.beforeRequest({ provider: req.provider, model: req.model, messages: req.messages });
    wj.observer.afterRequest({ provider: req.provider, model: req.model, est, usage: res?.usage });
    wj.diagnoser.record({
      n: wj.diagnoser.size() + 1, provider: req.provider, model: req.model,
      usage: res?.usage, est, degraded: wj.estimator.getDegraded(),
    });
    
    if (typeof next === 'function') return next(res);
    return res;
  };

  // 假设 DSH 的事件监听 API (如 ctx.on, ctx.middleware, ctx.hooks)
  if (ctx.middleware) {
    ctx.middleware(onRequest); // 假设 DSH 使用单一中间件模式
  } else if (ctx.on) {
    ctx.on('before:request', onRequest);
    ctx.on('after:response', onResponse);
  }

  // 暴露一个只读 API 供外部查看状态
  return { wj, onRequest, onResponse };
}