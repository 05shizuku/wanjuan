// src/dsh.mjs
import { join, isAbsolute } from 'node:path';
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
    // 会话隔离 + 目录锚定：相对路径强制锚到 dshHome，绝不落到 CWD
    const sid = dshCtx.sessionId || `pid-${process.pid}`;
    const configDir = this.config.dir || '.wanjuan';
    const baseDir = isAbsolute(configDir) ? configDir : join(dshCtx.dshHome || '.', configDir);
    const dir = join(baseDir, 'sessions', sid);

    // 修复：将 dir 放在展开之后，防止被 this.config 里的旧 dir 覆盖
    this.wj = createWanjuan({ ...this.config, dir });

    // 工具注册：完整 schema，KEEP/DROP 嵌进 compress 描述（模型生成摘要时能看到规则）
    const keepDropRules = this.wj.nudge.philosophy.getKeepDropRules();
    dshCtx.registerTools({
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
        handler: this._toolCompress.bind(this)
      },
      decline_compress: {
        description: '显式拒绝本次压缩建议，并记录拒绝次数用于降频。',
        parameters: {
          type: 'object',
          properties: {
            range: { type: 'array', items: { type: 'string' }, description: '要拒绝的区间' },
            reason: { type: 'string', description: '拒绝理由' }
          },
          required: ['range']
        },
        handler: this._toolDecline.bind(this)
      },
      decompress: {
        description: '恢复指定块的原文。context 模式返回消息数组（尾部追加），file 模式落文件。',
        parameters: {
          type: 'object',
          properties: {
            blockId: { type: 'string', description: '块 ID（如 b1）' },
            mode: { type: 'string', enum: ['context', 'file'], description: '恢复模式' }
          },
          required: ['blockId']
        },
        handler: this._toolDecompress.bind(this)
      },
      search_context: {
        description: '按关键词检索块摘要（仅搜 summary 和 topics，不做原文 grep）。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '关键词' } },
          required: ['query']
        },
        handler: this._toolSearch.bind(this)
      },
      wj_status: {
        description: '查看万卷当前状态（活跃消息数、账本块数）。',
        parameters: { type: 'object', properties: {} },
        handler: this._toolStatus.bind(this)
      },
      wj_report: {
        description: '生成万卷使用报告（命中率、责任归属、块统计）。',
        parameters: { type: 'object', properties: {} },
        handler: this._toolReport.bind(this)
      }
    });
  }

  async onRequest(req, next) {
    const messages = req.messages || [];
    this._currentProvider = req.provider || 'deepseek';
    this._currentModel = req.model || 'deepseek-chat';

    const fpResult = this.wj.fingerprinter.check(messages);

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
        provider: req.provider, model: req.model,
        usage: { input_tokens: 0, cached: 0 }, est: { estFinal: 0 },
        overrideMissKind: 'host-rewrite'
      });
    }

    this._nativeEst = this.wj.observer.beforeRequest({ provider: req.provider, model: req.model, messages: req.messages });
    if (this._lastFoldEst === 0) this._lastFoldEst = this._nativeEst.estFinal;

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
      n: this.wj.diagnoser.size() + 1, provider: req.provider, model: req.model,
      usage: res.usage, est, degraded: this.wj.estimator.getDegraded(),
    });
    this._currentNudgeReserve = 0;
    return next(res);
  }

  async _toolCompress({ range, summary, topics = [] }) {
    try {
      const blockId = this.wj.compressor.compress({ range, summary, topics });
      const active = this.wj.ledger.getActiveMessages();
      this._lastFoldEst = this.wj.observer.beforeRequest({ provider: this._currentProvider, model: this._currentModel, messages: active }).estFinal;
      return `✅ 压缩成功，生成块 ${blockId}，范围 ${range[0]} ~ ${range[1]}`;
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
      return `恢复成功，已写入：${res}`;
    } catch (e) { return `❌ 恢复失败: ${e.message}`; }
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