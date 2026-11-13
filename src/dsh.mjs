// src/dsh.mjs
// L4 宿主集成（DSH 插件入口）。
// 负责把 createWanjuan 返回的内核包装成 DSH 认识的插件形状。
// 暴露工具：compress, decline_compress, decompress, search_context。
// 暴露钩子：onRequest（注入 nudge、对账）、onResponse（更新 usage）。

import { join } from 'node:path';
import { createWanjuan } from './index.mjs';

export class WanjuanPlugin {
  constructor({ name = 'wanjuan-native', config = {} } = {}) {
    this.name = name;
    this.config = config;
    this.wj = null; // 延迟初始化，在 bind 或 request 时按需创建
  }

  // DSH 生命周期：插件挂载时调用
  async bind(dshCtx) {
    // 从宿主环境变量或配置获取数据目录，默认放 ~/.dsh/.wanjuan
    const dir = this.config.dir || join(dshCtx.dshHome || '.', '.wanjuan', 'sessions', dshCtx.sessionId || 'default');
    this.wj = createWanjuan({ dir, ...this.config });

    // 向 DSH 注册工具
    dshCtx.registerTools({
      compress: this._toolCompress.bind(this),
      decline_compress: this._toolDecline.bind(this),
      decompress: this._toolDecompress.bind(this),
      search_context: this._toolSearch.bind(this),
    });
  }

  // DSH 生命周期：每次请求发出前调用
  // 用于注入 nudge 和进行指纹对账
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
    // 注意：M5 阶段先写死上次折叠点为 0，实际接入应持久化或从账本推算
    const lastFoldEst = 0; 
    const gateRes = this.wj.gate.check({ currentEst: est.estFinal, lastFoldEst, window: est.window });

    // 4. 注入 Nudge（只追加在尾部）
    if (gateRes.shouldNudge) {
      const active = this.wj.ledger.getActiveMessages();
      const candidates = this.wj.nudge.findCandidates(active);
      // 假设用请求次数作为 turn 计数
      const turn = messages.length; 
      const nudgeMsg = this.wj.nudge.buildNudgeMessage(candidates, turn);
      
      if (nudgeMsg) {
        // 将 nudge 消息追加到请求尾部（DSH 会自动将其放在 wire 末尾）
        req.messages = [...messages, nudgeMsg];
        // 记录 nudgeReserve，供后续 fits 检查
        this._currentNudgeReserve = nudgeMsg.tok;
      }
    }

    // 继续后续请求流程
    return next(req);
  }

  // DSH 生命周期：请求返回后调用
  async onResponse(req, res, next) {
    // 记录 usage，更新 k̂
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
      n: Date.now(),
      provider: req.provider,
      model: req.model,
      usage: res.usage,
      est,
      degraded: this.wj.estimator.getDegraded(),
    });

    return next(res);
  }

  // ---- 工具实现 ----
  
  async _toolCompress({ range, summary, topics = [] }) {
    try {
      const blockId = this.wj.compressor.compress({ range, summary, topics });
      return `✅ 压缩成功，生成块 ${blockId}，范围 ${range[0]} ~ ${range[1]}`;
    } catch (e) {
      return `❌ 压缩失败: ${e.message}`;
    }
  }

  async _toolDecline({ range, reason }) {
    // 记录拒绝，触发降频
    this.wj.nudge.recordReject(range, Date.now());
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