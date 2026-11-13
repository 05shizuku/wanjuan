// src/dsh.mjs
import { join } from 'node:path';
import { createWanjuan } from './index.mjs';

export class WanjuanPlugin {
  constructor({ name = 'wanjuan-native', config = {} } = {}) {
    this.name = name;
    this.config = config;
    this.wj = null;
    this._currentNudgeReserve = 0;
    this._lastFoldEst = 0;
    this._nativeEst = null;
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
    if (fpResult.action === 'full' && fpResult.divergenceKind === 'content-mismatch') {
      const noteMsg = {
        id: `wj-anchor-${Date.now()}`,
        cls: 'sys',
        tok: 50,
        ephemeral: true,
        content: `[万卷锚点说明] 宿主在历史 ${fpResult.divergedAt} 处修改了上下文。请基于当前最新的上下文继续任务。`
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

    // 2. 原生估算（在注入任何 nudge 之前）
    this._nativeEst = this.wj.observer.beforeRequest({ 
      provider: req.provider, model: req.model, messages: req.messages 
    });
    
    if (this._lastFoldEst === 0) {
      this._lastFoldEst = this._nativeEst.estFinal;
    }

    // 3. 门判定与 Nudge 注入
    const gateRes = this.wj.gate.check({ 
      currentEst: this._nativeEst.estFinal, 
      lastFoldEst: this._lastFoldEst, 
      window: this._nativeEst.window 
    });

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
    // Bug ⑤ 修复：用未包含注入的 nativeEst 来校准
    const est = this._nativeEst || this.wj.observer.beforeRequest({ 
      provider: req.provider, model: req.model, messages: req.messages 
    });
    
    this.wj.observer.afterRequest({ 
      provider: req.provider, model: req.model, est, usage: res.usage 
    });
    
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
      
      // Bug ⑥ 修复：压缩成功后，更新 _lastFoldEst 防止下一轮立刻再次触发
      const active = this.wj.ledger.getActiveMessages();
      this._lastFoldEst = this.wj.observer.beforeRequest({ 
        provider: 'deepseek', model: 'deepseek-chat', messages: active 
      }).estFinal;

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