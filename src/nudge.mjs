// src/nudge.mjs
// ═══════════════════════════════════════════════════════════════════
// M5.2 探针实证（v0.6.28 真机，2026-11-16）：nudge 合法送达路径
//
// ctx.on('agent/pre-step', async (payload, next) => {
//   const decision = await next();                  // 官方 waterfall：先放行下游
//   if (decision?.kind !== 'enter' || !decision.messages?.length) return decision;
//   const lastClaimedIndex = decision.messages.findLastIndex((m) => (payload?.messages ?? []).includes(m));
//   const nudgeMsg = {
//     id: crypto.randomUUID(),                      // 建议自带（宿主 createMessage 会赋，但注入对象需自足）
//     role: 'user',
//     content: [{ type: 'text', text: nudgeText }],
//     source: { kind: 'wanjuan-nudge', form: 'nudge' }  // ★ 必填！无 source = 宿主 'reading kind' 崩溃
//   };
//   return { ...decision, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, nudgeMsg) };
// });
//
// 实证记录：裸消息（无 source）→ 'Cannot read properties of undefined (reading kind)'；
// 带 source 后：无报错 + 模型原样引用探针文本（一字不动）。注入位置在 claimed 之后 = 缓存友好。
// ═══════════════════════════════════════════════════════════════════
import { Philosophy } from './philosophy.mjs';
import { estimateTok } from './tokenizer.mjs'; // M5.4：统一口径（旧本地实现 1.0 低估 17%，已删除）

export class NudgeManager {
  constructor({ philosophy = new Philosophy(), minSize = 10_000, tailKeepTok = 30_000 } = {}) {
    this.philosophy = philosophy;
    this.minSize = minSize;
    this.tailKeepTok = tailKeepTok;
    this.rangeStates = new Map();
  }

  findCandidates(activeMessages, { tailKeepTok } = {}) {
    const keep = tailKeepTok ?? this.tailKeepTok;

    // 修：tailKeepTok ≤ 0 时整段都当候选，不设尾部保留窗
    let tailStart = activeMessages.length;
    if (keep > 0) {
      const totalTok = activeMessages.reduce((s, m) => s + (m.tok || 0), 0);
      const actualKeep = Math.min(keep, totalTok);
      let tailAcc = 0;
      for (let i = activeMessages.length - 1; i >= 0; i--) {
        tailAcc += activeMessages[i].tok || 0;
        if (tailAcc >= actualKeep) { tailStart = i; break; }
      }
    }

    const candidates = [];
    let currentMsgs = [];
    let currentTok = 0;
    for (let i = 0; i < tailStart; i++) {
      const m = activeMessages[i];
      currentMsgs.push(m);
      currentTok += (m.tok || 0);
      if (currentTok >= this.minSize) {
        candidates.push({
          range: [currentMsgs[0].id, currentMsgs[currentMsgs.length - 1].id],
          msgCount: currentMsgs.length, srcTok: currentTok, topics: '',
        });
        currentMsgs = []; currentTok = 0;
      }
    }
    if (currentMsgs.length > 0 && currentTok > 0) {
      candidates.push({
        range: [currentMsgs[0].id, currentMsgs[currentMsgs.length - 1].id],
        msgCount: currentMsgs.length, srcTok: currentTok, topics: '',
      });
    }
    return candidates;
  }

  _key(range) { return `${range[0]}-${range[1]}`; }

  recordReject(range, turn) {
    const k = this._key(range);
    const state = this.rangeStates.get(k) || { rejects: 0, lastTurn: 0 };
    state.rejects += 1;
    state.lastTurn = turn;
    this.rangeStates.set(k, state);
  }

  recordAccept(range) { this.rangeStates.delete(this._key(range)); }

  shouldNudge(range, currentTurn) {
    const k = this._key(range);
    const state = this.rangeStates.get(k);
    if (!state) return true;
    if (state.rejects >= 3) {
      return (currentTurn - state.lastTurn) >= 3;
    }
    return true;
  }

  buildNudgeMessage(candidates, currentTurn) {
    const validCandidates = candidates.filter(c => this.shouldNudge(c.range, currentTurn));
    if (validCandidates.length === 0) return null;
    const text = this.philosophy.buildNudge({ candidates: validCandidates });
    return {
      id: `wj-nudge-${currentTurn}`,
      cls: 'sys',
      tok: estimateTok(text),
      content: text,
    };
  }
}