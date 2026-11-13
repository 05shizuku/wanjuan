// src/dsh.mjs
// L4 宿主集成（DSH 插件入口）。
// 负责把 createWanjuan 返回的内核包装成 DSH 认识的插件形状。

import { join } from 'node:path';
import { createWanjuan } from './index.mjs';

export class WanjuanPlugin {
  constructor({ name = 'wanjuan-native', config = {} } = {}) {
    this.name = name;
    this.config = config;
    this.wj = null;
  }

  async bind(dshCtx) {
    const dir = this.config.dir || join(dshCtx.dshHome || '.', '.wanjuan', 'sessions', dshCtx.sessionId || 'default');
    this.wj = createWanjuan({ dir, ...this.config });

    dshCtx.registerTools({
      compress: this._toolCompress.bind(this),
      decline_compress: this._toolDecline.bind(this),
      decompress: this._toolDecompress.bind(this),
      search_context: this._toolSearch.bind(this),
    });
  }

  async onRequest(req, next) {
    const messages = req.messages || [];
    
    // 1. 轻指纹对账
    const fpResult = this.wj.fingerprinter.check(messages);
    if (fpResult.action === 'full') {
      console.log(`[万卷] 触发全量对账，原因：${fpResult.reason}`);
    }

    // 2. 估算当前上下文
    const est = this.wj.observer.beforeRequest({
      provider: req.provider,
      model: req.model,
      messages,
    });

    // 3. 增速门判定
    // TODO(M4): 真实环境中，lastFoldEst 应该通过查询账本最后一条 fold 事件时的估算值来得出。
    // 目前 M5 阶段暂用 0 代替。
    const lastFoldEst = 0; 
    const gateRes = this.wj.gate.check({ currentEst: est.estFinal, lastFoldEst, window: est.window });

    // 4. 注入 Nudge（只追加在尾部）
    if (gateRes.shouldNudge) {
      const active = this.wj.ledger.getActiveMessages();
      const candidates = this.wj.nudge.findCandidates(active);
      
      // 用当前已经记录的请求数作为轮次，代替 messages.length（防止宿主压缩后数量突变）
      const turn = this.wj.diagnoser.size() + 1;
      const nudgeMsg = this.wj.nudge.buildNudgeMessage(candidates, turn);
      
      if (nudgeMsg) {
        req.messages = [...messages, nudgeMsg];
        this._currentNudgeReserve = nudgeMsg.tok;
      }
    }

    return next(req);
  }

  async onResponse(req, res, next) {
    // 复用 beforeRequest 来复现估算状态，或者可以从上下文缓存里拿
    const est = this.wj.observer.beforeRequest({
      provider: req.provider,
      model: req.model,
      messages: req.messages,
    });
    
    this.wj.observer.afterRequest({
      provider: req.provider,
      model: req.model,
      est,
      usage: res.usage,
    });

    this.wj.diagnoser.record({
      n: this.wj.diagnoser.size() + 1,
      provider: req.provider,
      model: req.model,
      usage: res.usage,
      est,
      degraded: this.wj.estimator.getDegraded(),
    });

    return next(res);
  }

  async _toolCompress({ range, summary, topics = [] }) {
    try {
      const blockId = this.wj.compressor.compress({ range, summary, topics });
      return `✅ 压缩成功，生成块 ${blockId}，范围 ${range[0]} ~ ${range[1]}`;
    } catch (e) {
      return `❌ 压缩失败: ${e.message}`;
    }
  }

  async _toolDecline({ range, reason }) {
    this.wj.nudge.recordReject(range, this.wj.diagnoser.size() + 1);
    return `已记录拒绝区间 ${range[0]} ~ ${range[1]}，理由：${reason || '未说明'}`;
  }

  async _toolDecompress({ blockId, mode = 'context' }) {
    try {
      const res = this.wj.restorer.decompress(blockId, mode);
      if (mode === 'context') {
        return res.map((m) => `[${m.id}] ${m.content}`).join('\n');
      }
      return `恢复成功，已写入：${res}`;
    } catch (e) {
      return `❌ 恢复失败: ${e.message}`;
    }
  }

  async _toolSearch({ query }) {
    const res = this.wj.restorer.search(query);
    if (res.length === 0) return '未找到相关摘要块。';
    return res.map((b) => `[${b.id}] ${b.summary} (${b.srcTok} tok)`).join('\n');
  }
}

export default WanjuanPlugin;