// src/nudge.mjs
// 受控提示词（Nudge）管理。
// 核心功能：切分候选区间、管理拒绝次数、降频控制。
// 严格遵守 §6：nudge 只追加在尾部，内容不包含填充比例。

import { Philosophy } from './philosophy.mjs';

export class NudgeManager {
  constructor({ philosophy = new Philosophy(), minSize = 10_000 } = {}) {
    this.philosophy = philosophy;
    this.minSize = minSize; // 推荐的区间最小 token 数
    // 状态：记录每个区间的拒绝次数 { "m1-m5": { rejects: 1, lastTurn: 2 } }
    this.rangeStates = new Map();
  }

  // 根据活跃消息切分候选区间
  // 策略：累积 token，达到 minSize 且遇到天然断点（或者直接达到）就切分。
  // 为了简化 M3 的测试，这里直接按 token 数量切分，不强求语义断点。
  findCandidates(activeMessages) {
    const candidates = [];
    let currentMsgs = [];
    let currentTok = 0;

    for (const m of activeMessages) {
      currentMsgs.push(m);
      currentTok += (m.tok || 0);

      if (currentTok >= this.minSize) {
        candidates.push({
          range: [currentMsgs[0].id, currentMsgs[currentMsgs.length - 1].id],
          msgCount: currentMsgs.length,
          srcTok: currentTok,
          topics: '',
        });
        currentMsgs = [];
        currentTok = 0;
      }
    }

    // 尾部不足 minSize 的也作为一个候选（可选）
    if (currentMsgs.length > 0 && currentTok > 0) {
      candidates.push({
        range: [currentMsgs[0].id, currentMsgs[currentMsgs.length - 1].id],
        msgCount: currentMsgs.length,
        srcTok: currentTok,
        topics: '',
      });
    }

    return candidates;
  }

  // 获取区间 key
  _key(range) {
    return `${range[0]}-${range[1]}`;
  }

  // 记录一次拒绝（显式或隐式）
  recordReject(range, turn) {
    const k = this._key(range);
    const state = this.rangeStates.get(k) || { rejects: 0, lastTurn: 0 };
    state.rejects += 1;
    state.lastTurn = turn;
    this.rangeStates.set(k, state);
  }

  // 记录一次接受（或者成功压缩，重置该区间状态）
  recordAccept(range) {
    this.rangeStates.delete(this._key(range));
  }

  // 判断当前是否应该对该区间发出 nudge（降频逻辑）
  // 规则：如果连续被拒 >= 3 次，则每 3 轮才提醒一次。
  shouldNudge(range, currentTurn) {
    const k = this._key(range);
    const state = this.rangeStates.get(k);
    if (!state) return true;

    if (state.rejects >= 3) {
      const turnsSinceLast = currentTurn - state.lastTurn;
      return turnsSinceLast >= 3;
    }
    return true; // 拒绝未满 3 次，继续提醒
  }

  // 组装最终要注入的 nudge 消息对象
  // 宿主拿到后追加到 messages 尾部。
  buildNudgeMessage(candidates, currentTurn) {
    const validCandidates = candidates.filter(c => this.shouldNudge(c.range, currentTurn));
    
    if (validCandidates.length === 0) return null;

    const text = this.philosophy.buildNudge({ candidates: validCandidates });
    
    return {
      id: `wj-nudge-${currentTurn}`,
      cls: 'sys', // 作为系统消息注入
      tok: Math.ceil(text.length / 3), // 粗略估算 nudge 自身的 token
      content: text,
    };
  }
}