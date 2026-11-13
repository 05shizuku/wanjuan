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
    this._currentProvider = 'deepseek';
    this._currentModel = 'deepseek-chat';
  }

  async bind(dshCtx) {
    const dir = this.config.dir || join(dshCtx.dshHome || '.', '.wanjuan', 'sessions', dshCtx.sessionId || 'default');
    this.wj = createWanjuan({ dir, ...this.config });

    // 注入 Schema 与描述
    dshCtx.registerTools({
      compress: {
        description: `压缩一段消息为摘要块。\n${this.wj.nudge.philosophy.getKeepDropRules()}`,
        parameters: {
          type: 'object',
          properties: {
            range: { type: 'array', items: { type: 'string' }, description: '要压缩的起始和结束消息 ID' },
            summary: { type: 'string', description: '依据指南生成的摘要' },
            topics: { type: 'array', items: { type: 'string' }, description: '检索关键词' }
          },
          required: ['range', 'summary']
        },
        handler: this._toolCompress.bind(this)
      },
      decline_compress: {
        description: '拒绝本次压缩建议。',
        parameters: { type: 'object', properties: { range: { type: 'array' }, reason: { type: 'string' } } },
        handler: this._toolDecline.bind(this)
      },
      decompress: {
        description: '恢复指定块的原文。',
        parameters: { type: 'object', properties: { blockId: { type: 'string' }, mode: { type: 'string', enum: ['context', 'file'] } }, required: ['blockId'] },
        handler: this._toolDecompress.bind(this)
      },
      search_context: {
        description: '按关键词检索块摘要。',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        handler: this._toolSearch.bind(this)
      },
      wj_status: {
        description: '查看万卷当前状态。',
        parameters: { type: 'object', properties: {} },
        handler: this._toolStatus.bind(this)
      },
      wj_report: {
        description: '生成使用报告（月报）。',
        parameters: { type: 'object', properties: {} },
        handler: this._toolReport.bind(this)
      }
    });
  }

  async onRequest(req, next) {
    const messages = req.messages || [];
    this._currentProvider = req.provider || 'deepseek';
    this._currentModel = req.model || 'deepseek-chat';

    // 1. 对账
    const fpResult = this.wj.fingerprinter.check(messages);
    
    // 如果发生宿主重写（mutated 非空），挂锚点
    if (fpResult.action === 'full' && fpResult.mutated && fpResult.mutated.length > 0) {
      const mIds = fpResult.mutated.join(', ');
      const content = `[万卷锚点说明] 宿主在历史 ${mIds} 处修改了上下文。请基于当前最新的上下文继续任务。`;
      const noteMsg = {
        id: `wj-anchor-${Date.now()}`,
        cls: 'sys',
        tok: Math.ceil(content.length / 3),
        ephemeral: true,
        content
      };
      req.messages = [...messages, noteMsg];
      this._currentNudgeReserve += noteMsg.tok;
      
      this.wj.diagnoser.record({
        n: this.wj.diagnoser.size() + 1,
        provider: req.provider,
        model: req.model,
        usage: { input_tokens: 0, cached: 0 },
        est: { estFinal: 0 },
        overrideMissKind: 'host-rewrite'
      });
    }

    // 2. 估算
    this._nativeEst = this.wj.observer.beforeRequest({ provider: req.provider, model: req.model, messages: req.messages });
    if (this._lastFoldEst === 0) {
      this._lastFoldEst = this._nativeEst.estFinal;
    }

    // 3. 门判定与 Nudge
    const gateRes = this.wj.gate.check({ currentEst: this._nativeEst.estFinal, lastFoldEst: this._lastFoldEst, window: this._nativeEst.window });

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
    const est = this._nativeEst || this.wj.observer.beforeRequest({ provider: req.provider, model: req.model, messages: req.messages });
    this.wj.observer.afterRequest({ provider: req.provider, model: req.model, est, usage: res.usage });
    this.wj.diagnoser.record({
      n: this.wj.diagnoser.size() + 1,
      provider: req.provider,
      model: req.model,
      usage: res.usage,
      est,
      degraded: this.wj.estimator.getDegraded(),
    });
    this._currentNudgeReserve = 0; // 归零
    return next(res);
  }

  async _toolCompress({ range, summary, topics = [] }) {
    try {
      const blockId = this.wj.compressor.compress({ range, summary, topics });
      
      // 用当前会话真实的 provider/model 更新基线
      const active = this.wj.ledger.getActiveMessages();
      this._lastFoldEst = this.wj.observer.beforeRequest({ 
        provider: this._currentProvider, 
        model: this._currentModel, 
        messages: active 
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

  async _toolStatus() {
    const active = this.wj.ledger.getActiveMessages();
    return `状态：运行中\n活跃消息数：${active.length}\n账本块数：${this.wj.ledger.listBlocks().length}`;
  }

  async _toolReport() {
    const { buildReport } = await import('./index.mjs');
    return buildReport({ dir: this.wj.dir, ledger: this.wj.ledger, diagnoser: this.wj.diagnoser });
  }
}