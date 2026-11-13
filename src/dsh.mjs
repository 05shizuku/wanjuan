// src/dsh.mjs
import { join } from 'node:path';
import { createWanjuan } from './index.mjs';

export class WanjuanPlugin {
  constructor({ name = 'wanjuan-native', config = {} } = {}) {
    this.name = name;
    this.config = config;
    this.wj = null;
    this._currentNudgeReserve = 0;
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
    
    // 1. 对账与锚点吸收
    const fpResult = this.wj.fingerprinter.check(messages);
    if (fpResult.action === 'full' && fpResult.divergedAt) {
      const noteMsg = {
        id: `wj-anchor-${Date.now()}`,
        cls: 'sys',
        tok: 50,
        content: `[万卷锚点说明] 宿主在历史 ${fpResult.divergedAt} 处修改了上下文。由于前缀纪律，我们不重写历史。请基于当前最新的上下文继续任务。`
      };
      req.messages = [...messages, noteMsg];
      this._currentNudgeReserve += 50;
      
      this.wj.diagnoser.record({
        n: this.wj.diagnoser.size() + 1,
        provider: req.provider,
        model: req.model,
        usage: { input_tokens: 0, cached: 0 },
        est: { estFinal: 0 },
        overrideMissKind: 'host-rewrite'
      });
    }

    // 2. 估算与门判定
    const est = this.wj.observer.beforeRequest({ provider: req.provider, model: req.model, messages: req.messages });
    const lastFoldEst = 0; 
    const gateRes = this.wj.gate.check({ currentEst: est.estFinal, lastFoldEst, window: est.window });

    // 3. Nudge 注入
    if (gateRes.shouldNudge) {
      const active = this.wj.ledger.getActiveMessages();
      const candidates = this.wj.nudge.findCandidates(active);
      const turn = this.wj.diagnoser.size() + 1;
      const nudgeMsg = this.wj.nudge.buildNudgeMessage(candidates, turn);
      if (nudgeMsg) {
        req.messages = [...req.messages, nudgeMsg];
        this._currentNudgeReserve += nudgeMsg.tok;
      }
    }

    return next(req);
  }

  async onResponse(req, res, next) {
    const est = this.wj.observer.beforeRequest({ provider: req.provider, model: req.model, messages: req.messages });
    this.wj.observer.afterRequest({ provider: req.provider, model: req.model, est, usage: res.usage });
    this.wj.diagnoser.record({
      n: this.wj.diagnoser.size() + 1,
      provider: req.provider,
      model: req.model,
      usage: res.usage,
      est,
      degraded: this.wj.estimator.getDegraded(),
    });
    this._currentNudgeReserve = 0;
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